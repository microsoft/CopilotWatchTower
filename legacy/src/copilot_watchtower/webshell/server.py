"""Loopback HTTP + SSE server that replaces the QWebChannel transport.

The embedded web UI used to reach Python through ``QWebChannel`` (an
in-process, Qt-specific bridge). That works but is invisible to standard
web tooling, so end-to-end tests could not drive the real app.

This module exposes the exact same :class:`~.bridge.Bridge` surface over a
tiny ASGI app bound to ``127.0.0.1`` on a random port:

* ``POST /api/<method>`` mirrors every Bridge ``@Slot`` (JSON in, JSON out).
* ``GET  /api/events`` is a Server-Sent-Events stream carrying the live
  ``bridge_event`` channel.
* ``GET  /`` (and the static assets) serve the built ``web/dist`` bundle.

Security: the server binds to loopback only, rejects non-loopback ``Host``
headers, and gates every request behind a single-use session token. The
shell loads ``/?token=<token>`` once; the server then sets an ``HttpOnly``
cookie that authenticates subsequent ``/api`` and SSE requests. Because the
token never leaves the machine and the cookie is ``SameSite=Strict`` +
``HttpOnly``, other local processes and cross-site pages cannot reach it.

The Bridge / OperationsController own ``QThread`` workers and ``QTimer``
objects that must only be touched from the Qt main thread, so every RPC is
marshalled onto that thread via a queued-signal invoker and awaited through
``asyncio.wrap_future``.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import logging
import secrets
import threading
import time
from collections.abc import Callable
from importlib import resources
from pathlib import Path
from typing import Any

import uvicorn
from PySide6.QtCore import QObject, Qt, Signal, Slot
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

log = logging.getLogger(__name__)

_COOKIE_NAME = "cwt_token"

# Explicit allow-list of Bridge methods that may be invoked over RPC. This
# mirrors the ``RawBridge`` interface in ``web/src/lib/bridge.ts`` exactly and
# deliberately excludes the ``bridge_event`` signal (delivered over SSE) and
# every private/dunder attribute. Keeping it explicit avoids exposing
# arbitrary callables on the bridge object.
ALLOWED_METHODS: frozenset[str] = frozenset(
    {
        # system / context
        "system_info",
        "app_version",
        "check_for_updates",
        "open_external_url",
        # analytics
        "analytics_user_activity_overview",
        "analytics_user_daily_activity",
        "analytics_user_daily_app_usage",
        "analytics_interaction_apps",
        # users
        "users_in_scope",
        "ediscovery_users",
        # conversations
        "conversations_list",
        "conversation_apps",
        "conversations_detail",
        # agents
        "agents_list",
        "agent_identity_events",
        # audit / diagnostics
        "audit_events_list",
        "admin_diagnostics_list",
        # official usage reports
        "usage_snapshots_list",
        "usage_counts_list",
        "usage_periods_summary",
        # consumption
        "consumption_list",
        "consumption_overview",
        "consumption_collect_start",
        "consumption_collect_stop",
        # credit analysis
        "credit_agent_analysis",
        "credit_user_analysis",
        "credit_agent_trend",
        "credit_user_trend",
        "credit_new_agents",
        # flow runs
        "flow_run_list",
        "flow_run_overview",
        # agent risk
        "agent_risk_list",
        "agent_risk_detail",
        # credit alerts
        "credit_alerts_list",
        "credit_alerts_overview",
        "credit_alert_acknowledge",
        "credit_alert_rules_get",
        "credit_alert_rules_update",
        # operations
        "operations_recent_runs",
        "operations_run_logs",
        "operations_audit_state",
        "operations_summary",
        "insights_adoption_summary",
        # profiles
        "profiles_list",
        "profile_switch",
        "profile_add",
        "profile_remove",
        # settings
        "settings_summary",
        "settings_update",
        # capabilities
        "capabilities",
        "capabilities_set",
        "capabilities_suggest",
        # collection
        "collection_start",
        "collection_stop",
        "collection_status",
        # eDiscovery
        "ediscovery_collect_start",
        "ediscovery_collect_stop",
        "ediscovery_collect_status",
        "ediscovery_open_download",
        "ediscovery_import_export",
        # system dialogs
        "open_system_dialog",
        # backup / restore / export
        "backup_create",
        "backup_pick_file",
        "backup_inspect",
        "backup_restore",
        "export_interactions",
        "export_threads_all",
        "export_thread",
        "exports_open_folder",
        # diagnostics
        "diagnostics_ping",
    }
)


class _MainThreadInvoker(QObject):
    """Runs arbitrary callables on the Qt main thread.

    ASGI handlers execute on the uvicorn worker thread, but Bridge methods
    start ``QThread`` workers / ``QTimer`` instances that must be touched
    from the thread that owns them. Emitting a queued-connection signal
    hops the callable onto the main (GUI) thread; the result is delivered
    back to the caller through a ``concurrent.futures.Future``.
    """

    _invoke = Signal(object)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._invoke.connect(self._run, Qt.QueuedConnection)

    @Slot(object)
    def _run(self, fn: Callable[[], None]) -> None:
        fn()

    def submit(self, fn: Callable[[], None]) -> None:
        self._invoke.emit(fn)


def _resolve_static_dir() -> Path:
    """Locate the built web bundle (``web/dist``) or packaged fallback."""
    here = Path(__file__).resolve()
    for parent in (here.parents[3], here.parents[2], here.parents[1]):
        candidate = parent / "web" / "dist"
        if (candidate / "index.html").is_file():
            return candidate
    # Packaged builds ship the static fallback under webshell/assets.
    resource = resources.files("copilot_watchtower.webshell.assets")
    return Path(str(resource))


class WebServer:
    """Hosts the web UI + Bridge RPC over a loopback ASGI server."""

    def __init__(self, bridge: Any, *, host: str = "127.0.0.1") -> None:
        self._bridge = bridge
        self._host = host
        self._token = secrets.token_urlsafe(32)
        self._invoker = _MainThreadInvoker()
        self._static_dir = _resolve_static_dir()
        self._port: int | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._uvicorn: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        # SSE subscriber queues. Only ever mutated from the asyncio thread.
        self._subscribers: set[asyncio.Queue[str]] = set()
        # Re-broadcast the live bridge_event channel to every SSE client.
        self._bridge.bridge_event.connect(self._on_bridge_event)
        self._app = self._build_app()

    # ---- public API --------------------------------------------------

    def start(self) -> str:
        """Start the server on a background thread; return the index URL."""
        config = uvicorn.Config(
            self._app,
            host=self._host,
            port=0,  # let the OS pick a free port
            log_level="warning",
            access_log=False,
            lifespan="off",
            # Disable uvicorn's own logging dictConfig. Under pythonw.exe
            # (the packaged GUI entry) sys.stdout/stderr are None, and
            # uvicorn's default ColourizedFormatter calls sys.stdout.isatty()
            # at construction time, which raises and aborts server start —
            # leaving the web shell window blank. The app already configures
            # logging via configure_logging(); uvicorn loggers propagate to it.
            log_config=None,
        )
        self._uvicorn = uvicorn.Server(config)
        self._thread = threading.Thread(
            target=self._serve, name="cwt-webserver", daemon=True
        )
        self._thread.start()

        deadline = time.monotonic() + 10.0
        while not self._uvicorn.started and time.monotonic() < deadline:
            time.sleep(0.02)
        if not self._uvicorn.started:
            raise RuntimeError("web server failed to start within 10s")
        self._port = self._uvicorn.servers[0].sockets[0].getsockname()[1]
        log.info("WebServer listening on http://%s:%s", self._host, self._port)
        return self.index_url()

    def stop(self, timeout: float = 5.0) -> None:
        if self._uvicorn is not None:
            self._uvicorn.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def index_url(self) -> str:
        if self._port is None:
            raise RuntimeError("server not started")
        return f"http://{self._host}:{self._port}/?token={self._token}"

    # ---- server thread ----------------------------------------------

    def _serve(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(self._uvicorn.serve())
        except Exception:  # pragma: no cover - defensive
            log.exception("WebServer event loop crashed")
        finally:
            self._loop = None
            loop.close()

    # ---- live events -------------------------------------------------

    def _on_bridge_event(self, raw: str) -> None:
        """Qt main-thread slot: hand the event to the asyncio loop."""
        loop = self._loop
        if loop is None:
            return
        # Loop already closed during shutdown -> ignore.
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(self._broadcast, raw)

    def _broadcast(self, raw: str) -> None:
        """asyncio-thread: fan the event out to every SSE subscriber."""
        for queue in self._subscribers:
            # Queues are unbounded, so put_nowait does not raise in practice.
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(raw)

    # ---- ASGI app ----------------------------------------------------

    def _build_app(self) -> Starlette:
        routes = [
            Route("/api/events", self._handle_events, methods=["GET"]),
            Route("/api/{method:str}", self._handle_rpc, methods=["POST"]),
            Route("/", self._handle_index, methods=["GET"]),
            Mount("/", app=StaticFiles(directory=str(self._static_dir))),
        ]
        app = Starlette(routes=routes)
        app.add_middleware(BaseHTTPMiddleware, dispatch=self._authorize)
        return app

    # ---- auth --------------------------------------------------------

    def _cookie_ok(self, request: Request) -> bool:
        cookie = request.cookies.get(_COOKIE_NAME)
        return bool(cookie) and secrets.compare_digest(cookie, self._token)

    async def _authorize(self, request: Request, call_next):
        # Reject anything that is not loopback (defends against DNS rebinding).
        host = (request.headers.get("host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost", "[::1]"):
            return PlainTextResponse("forbidden host", status_code=403)

        set_cookie = False
        if request.url.path == "/":
            query_token = request.query_params.get("token")
            if query_token and secrets.compare_digest(query_token, self._token):
                set_cookie = True
            elif not self._cookie_ok(request):
                return PlainTextResponse("forbidden", status_code=403)
        else:
            if not self._cookie_ok(request):
                return PlainTextResponse("forbidden", status_code=403)

        response = await call_next(request)
        if set_cookie:
            response.set_cookie(
                _COOKIE_NAME,
                self._token,
                httponly=True,
                samesite="strict",
                path="/",
            )
        return response

    # ---- handlers ----------------------------------------------------

    async def _handle_index(self, request: Request) -> Response:
        index = self._static_dir / "index.html"
        if not index.is_file():
            return PlainTextResponse(
                "web UI not built (run `npm --prefix web run build`)",
                status_code=500,
            )
        return FileResponse(index)

    async def _handle_rpc(self, request: Request) -> Response:
        method = request.path_params["method"]
        if method not in ALLOWED_METHODS:
            return JSONResponse(
                {"__rpc_error": f"unknown method: {method}"}, status_code=404
            )
        body = await request.body()
        try:
            args = json.loads(body) if body else []
        except json.JSONDecodeError:
            args = []
        if not isinstance(args, list):
            args = [args]

        fn = getattr(self._bridge, method, None)
        if not callable(fn):
            return JSONResponse(
                {"__rpc_error": f"not callable: {method}"}, status_code=404
            )

        future: concurrent.futures.Future = concurrent.futures.Future()

        def task() -> None:
            try:
                future.set_result(fn(*args))
            except Exception as exc:  # noqa: BLE001 - surfaced to the client
                future.set_exception(exc)

        self._invoker.submit(task)
        try:
            result = await asyncio.wrap_future(future)
        except Exception as exc:  # noqa: BLE001
            log.exception("RPC %s failed", method)
            return JSONResponse({"__rpc_error": str(exc)}, status_code=500)

        # Bridge methods already return a JSON string; pass it through.
        if not isinstance(result, str):
            result = json.dumps(result)
        return Response(result, media_type="application/json")

    async def _handle_events(self, request: Request) -> StreamingResponse:
        queue: asyncio.Queue[str] = asyncio.Queue()
        self._subscribers.add(queue)

        async def stream():
            try:
                yield ": connected\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        raw = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield f"data: {raw}\n\n"
            finally:
                self._subscribers.discard(queue)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
