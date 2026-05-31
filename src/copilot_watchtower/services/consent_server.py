"""Local HTTP listener used to receive the admin-consent redirect.

After we send the administrator to
``https://login.microsoftonline.com/{tenantId}/adminconsent`` Entra ID
redirects the browser to a redirect URI of our choice. We bind to a
random loopback port and present a small confirmation page.

The server is intentionally single-shot: it accepts exactly one valid
callback then shuts down.
"""
from __future__ import annotations

import logging
import socket
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

log = logging.getLogger(__name__)


@dataclass
class ConsentResult:
    admin_consent: bool
    tenant_id: str | None
    error: str | None
    error_description: str | None


_SUCCESS_PAGE = """<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>CopilotWatchTower</title>
<style>body{font-family:'Segoe UI',sans-serif;margin:48px;color:#1f2937}
h1{color:#16a34a}.box{max-width:520px;padding:24px;border:1px solid #e5e7eb;border-radius:8px}</style></head>
<body><div class="box"><h1>✓ 관리자 동의 완료</h1>
<p>이 창은 닫아도 됩니다. CopilotWatchTower 창으로 돌아가세요.</p></div></body></html>
"""

_FAILURE_PAGE = """<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>CopilotWatchTower</title>
<style>body{font-family:'Segoe UI',sans-serif;margin:48px;color:#1f2937}
h1{color:#dc2626}.box{max-width:520px;padding:24px;border:1px solid #e5e7eb;border-radius:8px}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="box"><h1>✕ 관리자 동의 실패</h1>
<p>오류: <code>{error}</code></p>
<p>{description}</p></div></body></html>
"""


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class ConsentCallbackServer:
    """Threaded one-shot HTTP server for the admin-consent redirect."""

    def __init__(self, expected_state: str, port: int | None = None) -> None:
        self.expected_state = expected_state
        self.port = port or pick_free_port()
        self.redirect_uri = f"http://localhost:{self.port}/consent-callback"
        self._result: ConsentResult | None = None
        self._done = threading.Event()
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:  # silence stderr
                pass

            def do_GET(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                if parsed.path != "/consent-callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                state = params.get("state")
                if state != outer.expected_state:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"state mismatch")
                    return
                error = params.get("error")
                description = params.get("error_description", "")
                if error:
                    body = _FAILURE_PAGE.format(error=error, description=description).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    outer._result = ConsentResult(
                        admin_consent=False,
                        tenant_id=params.get("tenant"),
                        error=error,
                        error_description=description,
                    )
                else:
                    body = _SUCCESS_PAGE.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    outer._result = ConsentResult(
                        admin_consent=params.get("admin_consent", "").lower() == "true",
                        tenant_id=params.get("tenant"),
                        error=None,
                        error_description=None,
                    )
                outer._done.set()

        self._server = HTTPServer(("127.0.0.1", self.port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        log.info("Consent callback listener bound to %s", self.redirect_uri)

    def wait(self, timeout: float = 300.0) -> ConsentResult:
        if not self._done.wait(timeout):
            raise TimeoutError("Timed out waiting for admin consent callback.")
        assert self._result is not None
        return self._result

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
