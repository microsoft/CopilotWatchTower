"""Integration tests for the loopback WebServer transport.

These spin up the real ASGI server (on a random loopback port) backed by a
real :class:`Bridge` over a seeded SQLite store, then drive it over HTTP.

RPC handlers marshal work onto the Qt main thread, so each blocking HTTP
call runs on a helper thread while the test pumps the Qt event loop.
"""
from __future__ import annotations

import http.cookiejar
import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

import pytest

from copilot_watchtower.db import Repository, initialize
from copilot_watchtower.webshell.bridge import Bridge, BridgeContext
from copilot_watchtower.webshell.server import WebServer


def _pump(app, fn: Callable[[], object]):
    """Run a blocking call off-thread while spinning the Qt event loop."""
    box: dict = {}

    def worker() -> None:
        try:
            box["result"] = fn()
        except Exception as exc:  # noqa: BLE001 - re-raised below
            box["error"] = exc

    thread = threading.Thread(target=worker)
    thread.start()
    deadline = time.monotonic() + 10.0
    while thread.is_alive() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.005)
    thread.join(timeout=5.0)
    if "error" in box:
        raise box["error"]
    return box["result"]


def _opener() -> tuple[urllib.request.OpenerDirector, http.cookiejar.CookieJar]:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def _post(opener, base: str, method: str) -> urllib.response.addinfourl:
    req = urllib.request.Request(
        f"{base}/api/{method}",
        data=b"[]",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        return opener.open(req)
    except urllib.error.HTTPError as exc:
        return exc


@pytest.fixture
def server(qtbot, tmp_path: Path):
    db = tmp_path / "store.db"
    initialize(db)
    repo = Repository(db)
    bridge = Bridge(BridgeContext(repo=repo))
    srv = WebServer(bridge)
    srv.start()
    try:
        yield srv
    finally:
        srv.stop()


def test_index_sets_cookie_and_rpc_roundtrips(qtbot, server):
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    opener, jar = _opener()
    base = f"http://127.0.0.1:{server._port}"

    resp = _pump(app, lambda: opener.open(server.index_url()))
    assert resp.status == 200
    assert any(c.name == "cwt_token" for c in jar)

    resp = _pump(app, lambda: _post(opener, base, "app_version"))
    assert resp.status == 200
    payload = json.loads(resp.read())
    assert payload["ok"] is True
    assert "version" in payload


def test_rpc_without_cookie_is_forbidden(qtbot, server):
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    opener, _ = _opener()  # never visits index -> no session cookie
    base = f"http://127.0.0.1:{server._port}"

    resp = _pump(app, lambda: _post(opener, base, "app_version"))
    assert resp.status == 403


def test_unknown_method_is_rejected(qtbot, server):
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    opener, _ = _opener()
    base = f"http://127.0.0.1:{server._port}"

    _pump(app, lambda: opener.open(server.index_url()))  # acquire cookie
    resp = _pump(app, lambda: _post(opener, base, "__danger__"))
    assert resp.status == 404


@pytest.mark.parametrize(
    "method",
    [
        "system_info",
        "app_version",
        "operations_summary",
        "operations_audit_state",
        "settings_summary",
        "capabilities",
        "usage_periods_summary",
        "credit_alerts_overview",
        "admin_diagnostics_list",
    ],
)
def test_read_endpoints_return_valid_json(qtbot, server, method):
    """Contract regression: representative read RPCs round-trip over HTTP and
    return the same JSON the bridge slot produces (no controller needed)."""
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    opener, _ = _opener()
    base = f"http://127.0.0.1:{server._port}"

    _pump(app, lambda: opener.open(server.index_url()))  # acquire cookie
    resp = _pump(app, lambda: _post(opener, base, method))
    assert resp.status == 200
    json.loads(resp.read())  # must be valid JSON
