"""End-to-end smoke tests: real browser -> loopback server -> Bridge.

These verify the full transport stack introduced in Phase 1 actually works
in a real browser: the HTTP/SSE server boots, the SPA loads over http://,
the session cookie authenticates RPC, and React mounts with live data.
"""
from __future__ import annotations


def test_shell_boots_and_renders(page, harness_url):
    # NB: the SPA holds a persistent SSE connection (/api/events), so
    # ``networkidle`` never settles — wait for ``load`` + the React mount.
    page.goto(harness_url, wait_until="load")

    # The SPA mounts into #root; a mounted app has child nodes.
    root = page.locator("#root")
    root.wait_for(state="attached")
    page.locator("#root > *").first.wait_for(state="attached")
    assert page.locator("#root > *").count() > 0


def test_app_version_rpc_reaches_browser(page, harness_url):
    page.goto(harness_url, wait_until="load")

    # Drive a real RPC from inside the page context over fetch + session
    # cookie, proving the QWebChannel->HTTP swap works end to end.
    result = page.evaluate(
        """async () => {
            const res = await fetch('/api/app_version', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: '[]',
            });
            return { status: res.status, body: await res.json() };
        }"""
    )
    assert result["status"] == 200
    assert result["body"]["ok"] is True
    assert "version" in result["body"]


def test_rpc_rejected_without_session_cookie(page, harness_url):
    # A fresh context that never loaded the token page must be rejected.
    base = harness_url.split("/?", 1)[0]
    page.goto(harness_url, wait_until="load")
    status = page.evaluate(
        """async (base) => {
            const res = await fetch(base + '/api/app_version', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'omit',
                body: '[]',
            });
            return res.status;
        }""",
        base,
    )
    assert status == 403


def test_live_events_stream_over_sse(page, harness_url):
    page.goto(harness_url, wait_until="load")

    # Open the SSE channel, trigger a server-side event via diagnostics_ping,
    # and assert the browser receives it — exercising the full Qt signal ->
    # asyncio queue -> EventSource path.
    import json

    data = page.evaluate(
        """async () => {
            const es = new EventSource('/api/events', { withCredentials: true });
            await new Promise((resolve) => {
                es.onopen = resolve;
                setTimeout(resolve, 2000);
            });
            const received = new Promise((resolve) => {
                es.onmessage = (ev) => { es.close(); resolve(ev.data); };
                setTimeout(() => { es.close(); resolve(null); }, 5000);
            });
            await fetch('/api/diagnostics_ping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: '[]',
            });
            return await received;
        }"""
    )
    assert data is not None, "no SSE event received after diagnostics_ping"
    event = json.loads(data)
    assert "type" in event
    assert "payload" in event


def test_bridge_wrapper_path_makes_no_phantom_then_rpc(page, harness_url):
    """Regression guard for the loadBridge() Proxy thenable trap.

    The typed wrappers (getSystemInfo, ...) do ``await loadBridge()``, where
    loadBridge resolves to a catch-all ``Proxy``. If the Proxy exposes a
    callable ``then``, ``await``/``Promise.resolve`` mistake it for a thenable
    and invoke ``then`` as an RPC — firing ``POST /api/then`` (404) instead of
    the real method, so every wrapper silently fails and the UI shows no data
    (e.g. the profile renders as "unset"). The earlier smoke tests only drive
    raw ``fetch`` from the page, so they never exercised this path.

    On boot the SPA calls ``getSystemInfo()`` through the wrapper path, so we
    assert the real method is requested and the phantom one never is.
    """
    seen: list[str] = []
    page.on("request", lambda req: seen.append(req.url))
    # The SPA holds a persistent SSE connection, so wait for ``load`` and then
    # for the boot-time wrapper RPC rather than ``networkidle``.
    with page.expect_request(lambda r: "/api/system_info" in r.url):
        page.goto(harness_url, wait_until="load")

    api_calls = [url.split("/api/", 1)[1].split("?", 1)[0] for url in seen if "/api/" in url]
    assert "system_info" in api_calls, f"bridge wrapper path never ran; saw {api_calls}"
    assert "then" not in api_calls, (
        f"loadBridge() Proxy was treated as a thenable -> phantom /api/then RPC; saw {api_calls}"
    )
