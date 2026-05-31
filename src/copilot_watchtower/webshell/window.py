"""Top-level Qt window that hosts the web-based UI shell."""
from __future__ import annotations

import logging
import os
from importlib import resources
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QMainWindow

from .. import __app_name__
from ..config import AppPaths, RuntimeOptions
from ..db import Repository
from ..profiles import ProfileRegistry
from .actions import OperationsController
from .bridge import Bridge, BridgeContext

log = logging.getLogger(__name__)

_DEV_URL_ENV = "COPILOT_WATCHTOWER_WEB_DEV_URL"


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
        self.channel = QWebChannel(self)
        self.channel.registerObject("watchtower", self.bridge)
        self.view.page().setWebChannel(self.channel)

        target = _resolve_target_url()
        log.info("WebShell loading %s", target.toString())
        self.view.setUrl(target)

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
        super().closeEvent(event)


def _resolve_target_url() -> QUrl:
    dev_url = os.environ.get(_DEV_URL_ENV)
    if dev_url:
        return QUrl(dev_url)

    dist_index = _workspace_dist_index()
    if dist_index is not None and dist_index.exists():
        return QUrl.fromLocalFile(str(dist_index))

    fallback = _package_asset("index.html")
    return QUrl.fromLocalFile(str(fallback))


def _workspace_dist_index() -> Path | None:
    # Walk a few parents up from this file to find a ``web/dist/index.html``
    # when running from a source checkout. PyInstaller bundles use the
    # packaged fallback below instead.
    here = Path(__file__).resolve()
    for parent in (here.parents[3], here.parents[2], here.parents[1]):
        candidate = parent / "web" / "dist" / "index.html"
        if candidate.exists():
            return candidate
    return None


def _package_asset(name: str) -> Path:
    resource = resources.files("copilot_watchtower.webshell.assets").joinpath(name)
    # ``resources.files`` returns a Traversable; for a real on-disk asset
    # (the only case we ship today) this resolves to a regular Path.
    return Path(str(resource))
