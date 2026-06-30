"""Top-level Qt window that hosts the web-based UI shell."""
from __future__ import annotations

import logging

from PySide6.QtCore import QUrl
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QMainWindow

from .. import __app_name__
from ..config import AppPaths, RuntimeOptions
from ..db import Repository
from ..profiles import ProfileRegistry
from .actions import OperationsController
from .bridge import Bridge, BridgeContext
from .server import WebServer

log = logging.getLogger(__name__)


class WebShellWindow(QMainWindow):
    """Hosts the embedded web UI inside ``QWebEngineView``.

    Loads, in order of preference:
    1. ``COPILOT_WATCHTOWER_WEB_DEV_URL`` if set (Vite dev server).
    2. ``web/dist/index.html`` from a built frontend (workspace root).
    3. Static fallback page shipped in ``webshell/assets/index.html``.
    """

    def __init__(
        self,
        repo: Repository,
        paths: AppPaths,
        options: RuntimeOptions,
        *,
        registry: ProfileRegistry | None = None,
        profile_id: str | None = None,
    ) -> None:
        super().__init__()
        self.repo = repo
        self.paths = paths
        self.options = options
        self.registry = registry
        self.profile_id = profile_id

        # Loop hand-off attributes mirroring the legacy MainWindow contract.
        self.requested_switch_to: str | None = None
        self.requested_add_profile: bool = False
        self.requested_add_name: str | None = None
        self.requested_pick_again: bool = False

        title = __app_name__
        if registry is not None and profile_id:
            profile = registry.get(profile_id)
            if profile is not None:
                title = f"{__app_name__} — {profile.name}"
        self.setWindowTitle(title)
        self.resize(1280, 820)

        self.view = QWebEngineView(self)
        self.setCentralWidget(self.view)

        self.controller = OperationsController(
            repo=repo,
            options=options,
            registry=registry,
            profile_id=profile_id,
            parent=self,
        )
        self.controller.profile_switch_requested.connect(self._on_profile_switch_requested)
        self.controller.profile_add_requested.connect(self._on_profile_add_requested)
        self.controller.system_dialog_requested.connect(self._on_system_dialog_requested)

        self.bridge = Bridge(
            BridgeContext(repo=repo, registry=registry, profile_id=profile_id, options=options),
            self.controller,
            self,
        )
        # Serve the web UI + Bridge RPC over a loopback HTTP/SSE server instead
        # of QWebChannel so the same surface is reachable by standard web
        # tooling (Playwright E2E). The server owns no state; it forwards RPC
        # onto this (main) thread and streams bridge_event over SSE.
        self.server = WebServer(self.bridge)
        index_url = self.server.start()
        log.info("WebShell loading %s", index_url)
        self.view.setUrl(QUrl(index_url))

    # ---- loop hand-off ------------------------------------------------

    def _on_profile_switch_requested(self, profile_id: str) -> None:
        self.requested_switch_to = profile_id
        self.close()

    def _on_profile_add_requested(self, name: str) -> None:
        self.requested_add_profile = True
        self.requested_add_name = name
        self.close()

    def _on_system_dialog_requested(self, kind: str) -> None:
        if kind == "settings":
            self._open_settings_dialog()
        elif kind == "permissions_upgrade":
            self._open_permissions_upgrade_dialog()
        elif kind == "factory_reset":
            self._open_factory_reset_dialog()
        else:
            log.warning("Unknown system dialog kind: %s", kind)

    def _open_settings_dialog(self) -> None:
        from ..ui.settings_dialog import SettingsDialog

        dlg = SettingsDialog(
            self.repo,
            self.options,
            self,
            registry=self.registry,
            profile_id=self.profile_id,
        )
        dlg.exec()
        if getattr(dlg, "profile_removed", False):
            self.requested_pick_again = True
            self.close()
            return
        self.controller._emit_event("system_dialog.closed", {"kind": "settings"})

    def _open_permissions_upgrade_dialog(self) -> None:
        from ..ui.permissions_upgrade_dialog import PermissionsUpgradeDialog

        dlg = PermissionsUpgradeDialog(self.repo, self)
        dlg.exec()
        self.controller._emit_event("system_dialog.closed", {"kind": "permissions_upgrade"})

    def _open_factory_reset_dialog(self) -> None:
        from ..ui.factory_reset_dialog import FactoryResetDialog

        dlg = FactoryResetDialog(
            self.repo,
            self,
            registry=self.registry,
            profile_id=self.profile_id,
        )
        dlg.exec()
        if getattr(dlg, "_profile_removed", False):
            self.requested_pick_again = True
            self.close()
            return
        self.controller._emit_event("system_dialog.closed", {"kind": "factory_reset"})

    def closeEvent(self, event) -> None:  # noqa: N802 — Qt API
        try:
            self.controller.stop_all(wait_ms=3000)
        except Exception:
            log.exception("Failed to stop collectors during close")
        try:
            self.server.stop()
        except Exception:
            log.exception("Failed to stop web server during close")
        super().closeEvent(event)



