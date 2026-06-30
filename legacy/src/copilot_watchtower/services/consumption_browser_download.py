"""Browser-driven access to the Power Platform consumption (licensing) reports.

Consumption collection used to mint a *standalone* delegated token for the
unofficial licensing audience. That token expired independently of the rest of
the app and surfaced as ``DelegatedAuthExpiredError`` ("위임 로그인 토큰이
만료되었습니다") even when the signed-in admin was perfectly able to open the
Power Platform Admin Center.

This module replaces that path: it drives a real PPAC sign-in with headless
Chromium (the same flow eDiscovery downloads use) and reuses the licensing
bearer token that the admin-center SPA already acquires. The captured token
then authorises the existing request → poll → download report lifecycle in
:class:`~copilot_watchtower.services.licensing.LicensingClient`. There is no
separate token cache to expire — collection works whenever the stored admin
can sign into PPAC.

The heavy lifting (Microsoft login flow, HTML-sniffing) is shared with
:mod:`copilot_watchtower.services.ediscovery_browser_download`.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import (
    LICENSING_API_HOST,
    PPAC_CONSUMPTION_URL,
)
from ..i18n import translate
from .ediscovery_browser_download import _complete_microsoft_login, current_page_is_sign_in

log = logging.getLogger(__name__)

LogCb = Callable[[str], None]


def _debug_dump_path() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    folder = Path(base) / "CopilotWatchTower"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "licensing_api_capture.jsonl"


class ConsumptionBrowserError(RuntimeError):
    """Raised when the headless browser cannot obtain a licensing token."""


class CapturedTokenProvider:
    """Adapts a captured bearer token to the ``LicensingClient`` provider API.

    ``LicensingClient`` only calls ``acquire()``; the token captured from the
    authenticated PPAC session is static for the lifetime of one collection
    cycle, so we simply return it.
    """

    def __init__(self, token: str) -> None:
        self._token = token

    def acquire(self) -> str:
        return self._token

    def acquire_for_scopes(self, _scopes: Any) -> str:  # pragma: no cover - parity
        return self._token


def extract_bearer_token(headers: dict[str, str]) -> str | None:
    """Return the raw bearer token from a request's ``Authorization`` header."""
    for key, value in headers.items():
        if key.lower() != "authorization":
            continue
        text = (value or "").strip()
        if text.lower().startswith("bearer "):
            token = text[7:].strip()
            return token or None
    return None


def extract_token_from_storage(storage: dict[str, str], *, audience: str) -> str | None:
    """Scan an MSAL-style localStorage dump for a token of the given audience.

    PPAC persists acquired access tokens in ``localStorage`` as JSON blobs
    whose value carries a ``secret`` (the access token) and a ``target`` /
    ``realm`` describing the scope. We match the audience substring
    case-insensitively and return the first usable secret.
    """
    needle = audience.lower()
    for key, value in storage.items():
        haystack = f"{key} {value}".lower()
        if needle not in haystack:
            continue
        if not value:
            continue
        try:
            blob = json.loads(value)
        except (ValueError, TypeError):
            continue
        if not isinstance(blob, dict):
            continue
        secret = blob.get("secret") or blob.get("accessToken") or blob.get("access_token")
        if isinstance(secret, str) and secret.strip():
            return secret.strip()
    return None


def capture_licensing_token(
    *,
    username: str,
    password: str,
    ppac_url: str = PPAC_CONSUMPTION_URL,
    licensing_host: str = LICENSING_API_HOST,
    timeout_ms: int = 180_000,
    on_log: LogCb | None = None,
) -> str:
    """Sign into PPAC with headless Chromium and capture the licensing token.

    The token is captured two ways, in order of preference:

    1. by observing the ``Authorization`` header on any request the SPA makes
       to the licensing host while the consumption page loads;
    2. by scanning ``localStorage`` for an MSAL entry whose scope/target
       includes the licensing host (a fallback for SPAs that fetch the token
       lazily).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ConsumptionBrowserError(
            translate("consumption.playwrightMissing")
        ) from exc

    if not username or not password:
        raise ConsumptionBrowserError(translate("consumption.noCredentials"))

    def _log(message: str) -> None:
        if on_log is not None:
            on_log(message)

    captured: list[str] = []
    seen_requests: list[str] = []
    dump_path = _debug_dump_path()
    with contextlib.suppress(Exception):
        dump_path.write_text("", encoding="utf-8")  # start fresh each run
    dumped = {"count": 0}

    with sync_playwright() as playwright:
        # Use the lightweight headless-shell build (the only Chromium variant
        # bundled in the packaged app) instead of the full Chromium binary.
        browser = playwright.chromium.launch(
            headless=True, channel="chromium-headless-shell"
        )
        context = browser.new_context()
        page = context.new_page()

        def _on_request(request: Any) -> None:
            try:
                if licensing_host not in request.url:
                    return
                # Record the real endpoint shape so the guessed REST paths in
                # LicensingClient can be corrected against what PPAC actually
                # calls. De-duplicate by method+path (drop query string noise).
                path = request.url.split("?", 1)[0]
                marker = f"{request.method} {path}"
                if marker not in seen_requests:
                    seen_requests.append(marker)
                token = extract_bearer_token(dict(request.headers))
                if token:
                    captured.append(token)
            except Exception:  # pragma: no cover - listener must never raise
                pass

        def _on_response(response: Any) -> None:
            # Persist the real licensing response bodies so the actual JSON
            # contract can be inspected (the report paths are unofficial and
            # undocumented). Bounded to avoid unbounded log growth.
            try:
                if licensing_host not in response.url:
                    return
                if dumped["count"] >= 40:
                    return
                try:
                    body = response.text()
                except Exception:
                    body = ""
                try:
                    request_body = response.request.post_data or ""
                except Exception:
                    request_body = ""
                record = {
                    "method": response.request.method,
                    "url": response.url,
                    "status": response.status,
                    "request_body": request_body[:8_000],
                    "body": body[:20_000],
                }
                with dump_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                dumped["count"] += 1
            except Exception:  # pragma: no cover - listener must never raise
                pass

        page.on("request", _on_request)
        page.on("response", _on_response)

        try:
            _log(translate("consumption.tryAutoLogin"))
            # Login redirect may interrupt the initial navigation.
            with contextlib.suppress(Exception):
                page.goto(ppac_url, timeout=60_000, wait_until="domcontentloaded")
            _complete_microsoft_login(page, username=username, password=password)

            # Give the SPA a moment to settle on the consumption page and mint
            # the licensing-audience token.
            with contextlib.suppress(Exception):
                page.wait_for_url(f"**{licensing_host.split('.')[0]}**", timeout=2_000)
            page.wait_for_timeout(6_000)

            if seen_requests:
                _log(translate("consumption.licensingEndpoints", count=len(seen_requests)))
                for marker in seen_requests[:12]:
                    _log(f"    ↳ {marker}")
            if dumped["count"]:
                _log(
                    translate("consumption.licensingResponsesSaved", count=dumped["count"], path=dump_path)
                )

            if captured:
                _log(translate("consumption.tokenFromSession"))
                return captured[0]

            # Fallback: scrape MSAL token cache from localStorage.
            try:
                storage = page.evaluate(
                    "() => { const o = {};"
                    " for (let i = 0; i < localStorage.length; i++) {"
                    " const k = localStorage.key(i); o[k] = localStorage.getItem(k); }"
                    " return o; }"
                )
            except Exception:
                storage = {}
            token = extract_token_from_storage(
                {str(k): str(v) for k, v in (storage or {}).items()},
                audience=licensing_host,
            )
            if token:
                _log(translate("consumption.tokenFromCache"))
                return token

            if current_page_is_sign_in(page):
                raise ConsumptionBrowserError(translate("consumption.signInIncomplete"))
            raise ConsumptionBrowserError(
                translate("consumption.tokenNotFound")
            )
        finally:
            with contextlib.suppress(Exception):  # pragma: no cover - defensive
                browser.close()
