"""Factory-reset dialog — fully tear down the tool's footprint.

Performs, in order:

  1. Device-code sign-in as a tenant admin (``Application.ReadWrite.All``).
  2. ``DELETE /applications/{id}`` — removes the Entra ID app reg and
     its service principal in one shot.
  3. ``Repository.wipe_collected_data()`` + ``wipe_credentials()`` —
     erases everything stored locally.
  4. Tells the user to restart and re-run onboarding.

Compared with the in-app "permission upgrade" flow, this is the
preferred way to roll forward when the app's permission set changes:
the operator just re-onboards from scratch and the new permissions are
picked up automatically because :data:`REQUIRED_RESOURCE_ACCESS` is
the source of truth for new app registrations.
"""
from __future__ import annotations

import logging

from PySide6.QtCore import QObject, Qt, QThread, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..db import Repository
from ..i18n import translate
from ..logging_setup import audit
from ..profiles import ProfileRegistry
from ..services import (
    AppRegistrar,
    BootstrapAuthenticator,
    DeviceCodePrompt,
    DeviceCodeResult,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------- workers


class _DeviceCodeWorker(QObject):
    prompt_ready = Signal(object)
    finished = Signal(object)
    failed = Signal(str)

    def __init__(self, tenant_id: str | None = None) -> None:
        super().__init__()
        # Pin the login to the profile's tenant so a multi-tenant admin
        # isn't silently signed into their home tenant (which would make
        # the subsequent app-delete target the wrong directory).
        self.auth = BootstrapAuthenticator(tenant_id=tenant_id)

    def run(self) -> None:
        try:
            prompt = self.auth.initiate()
            self.prompt_ready.emit(prompt)
            result = self.auth.poll()
            self.finished.emit(result)
        except Exception as e:  # noqa: BLE001
            log.exception("Device-code flow failed")
            self.failed.emit(str(e))


class _DeleteWorker(QObject):
    finished = Signal(bool)   # True if the app was found and deleted
    failed = Signal(str)

    def __init__(
        self,
        token: str,
        tenant_id: str,
        app_id: str,
        app_object_id: str | None,
    ) -> None:
        super().__init__()
        self.token = token
        self.tenant_id = tenant_id
        self.app_id = app_id
        self.app_object_id = app_object_id

    def run(self) -> None:
        try:
            with AppRegistrar(self.token, self.tenant_id) as reg:
                # Prefer the stored object id; fall back to a lookup
                # by appId so we recover gracefully if it was lost.
                obj_id = self.app_object_id
                if not obj_id:
                    try:
                        obj_id = reg.find_application_object_id(self.app_id)
                    except LookupError:
                        self.finished.emit(False)
                        return
                deleted = reg.delete_application(obj_id)
            self.finished.emit(deleted)
        except Exception as e:  # noqa: BLE001
            log.exception("Application delete failed")
            self.failed.emit(str(e))


# ---------------------------------------------------------------- dialog


class FactoryResetDialog(QDialog):
    """Walks the admin through a full tear-down."""

    def __init__(
        self,
        repo: Repository,
        parent: QWidget | None = None,
        *,
        registry: ProfileRegistry | None = None,
        profile_id: str | None = None,
        delete_profile_data: bool = False,
    ) -> None:
        super().__init__(parent)
        self.repo = repo
        self.registry = registry
        self.profile_id = profile_id
        self.delete_profile_data = delete_profile_data
        self.setWindowTitle(translate("factoryReset.title"))
        self.resize(620, 520)

        self._tenant_id = repo.get_text_setting("tenant_id")
        self._app_id = repo.get_text_setting("client_id")
        self._app_object_id = repo.get_text_setting("app_object_id")
        self._externally_managed = repo.get_text_setting("app_externally_managed") == "1"
        self._token: str | None = None
        self._device_thread: QThread | None = None
        self._device_worker: _DeviceCodeWorker | None = None
        self._delete_thread: QThread | None = None
        self._delete_worker: _DeleteWorker | None = None
        self._completed = False  # set True after local wipe finishes
        self._profile_removed = False  # set True if registry entry was dropped

        # --- header
        header = QLabel(translate("factoryReset.header"))
        header.setWordWrap(True)

        # --- gate: explicit confirm checkbox replacement — use a
        #     "위험: 계속 진행" button instead of a checkbox so the flow
        #     is linear and matches the wizard pattern.
        self.start_btn = QPushButton(translate("factoryReset.startBtn"))
        self.start_btn.clicked.connect(self._start_device_code)

        # --- device code area
        self.code_label = QLabel("")
        font = self.code_label.font()
        font.setPointSize(20)
        font.setBold(True)
        self.code_label.setFont(font)
        self.code_label.setTextInteractionFlags(Qt.TextSelectableByMouse)

        self.copy_btn = QPushButton(translate("dlg.copyCode"))
        self.copy_btn.clicked.connect(self._copy_code)
        self.copy_btn.setEnabled(False)

        self.open_btn = QPushButton(translate("dlg.openBrowser"))
        self.open_btn.clicked.connect(self._open_browser)
        self.open_btn.setEnabled(False)

        self.url_label = QLabel("")
        self.url_label.setOpenExternalLinks(True)

        code_row = QHBoxLayout()
        code_row.addWidget(self.code_label, 1)
        code_row.addWidget(self.copy_btn)
        code_row.addWidget(self.open_btn)

        # --- status
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)
        self.status = QLabel(translate("factoryReset.ready"))
        self.status.setWordWrap(True)

        # --- buttons
        self.buttons = QDialogButtonBox(QDialogButtonBox.Close)
        self.buttons.rejected.connect(self.reject)
        for b in self.buttons.buttons():
            b.setText(translate("dlg.close"))

        layout = QVBoxLayout(self)
        layout.addWidget(header)
        layout.addWidget(self.start_btn)
        layout.addLayout(code_row)
        layout.addWidget(self.url_label)
        layout.addWidget(self.bar)
        layout.addWidget(self.status)
        layout.addStretch(1)
        layout.addWidget(self.buttons)

        if self._externally_managed:
            # BYOA: the customer owns the Entra app, so never delete it — only
            # wipe local data/credentials.
            header.setText(translate("factoryReset.headerExternal"))
            self.start_btn.setText(translate("factoryReset.wipeLocalKeepApp"))
            self.start_btn.clicked.disconnect()
            self.start_btn.clicked.connect(self._wipe_local_only)
        elif not (self._tenant_id and self._app_id):
            # Nothing to delete in Entra — just expose a "wipe local"
            # shortcut so the operator can still clean up.
            self.start_btn.setText(translate("factoryReset.wipeLocalOnly"))
            self.start_btn.clicked.disconnect()
            self.start_btn.clicked.connect(self._wipe_local_only)

    # ------------------------------------------------------------------

    def was_completed(self) -> bool:
        """True after the local wipe finished successfully."""
        return self._completed

    def profile_was_removed(self) -> bool:
        """True if the multi-profile registry entry was dropped."""
        return self._profile_removed

    # ------------------------------------------------------------------

    def _start_device_code(self) -> None:
        self.start_btn.setEnabled(False)
        self.bar.setVisible(True)
        self.status.setText(translate("dlg.issuingDeviceCode"))
        audit(
            "settings.factory_reset_started",
            tenant_id=self._tenant_id,
            app_id=self._app_id,
        )

        thread = QThread(self)
        worker = _DeviceCodeWorker(self._tenant_id)
        worker.moveToThread(thread)
        worker.prompt_ready.connect(self._on_prompt)
        worker.finished.connect(self._on_signed_in)
        worker.failed.connect(self._on_failed)
        thread.started.connect(worker.run)
        thread.start()

        self._device_thread = thread
        self._device_worker = worker

    def _on_prompt(self, prompt: DeviceCodePrompt) -> None:
        self.code_label.setText(prompt.user_code)
        self.url_label.setText(
            f'<a href="{prompt.verification_uri}">{prompt.verification_uri}</a>'
        )
        self.copy_btn.setEnabled(True)
        self.open_btn.setEnabled(True)
        self.status.setText(translate("factoryReset.signInPrompt"))
        QDesktopServices.openUrl(QUrl(prompt.verification_uri))

    def _on_signed_in(self, result: DeviceCodeResult) -> None:
        self._token = result.access_token
        if self._device_thread is not None:
            self._device_thread.quit()
        self.copy_btn.setEnabled(False)
        self.open_btn.setEnabled(False)
        if result.tenant_id and self._tenant_id and result.tenant_id != self._tenant_id:
            self.bar.setVisible(False)
            self.status.setText(
                translate(
                    "factoryReset.tenantMismatch",
                    signed_in=result.tenant_id,
                    registered=self._tenant_id,
                )
            )
            self.start_btn.setEnabled(True)
            return
        self.status.setText(
            translate("factoryReset.signedIn", upn=result.upn or "(unknown)")
        )
        self._start_delete()

    def _start_delete(self) -> None:
        assert self._token is not None
        assert self._tenant_id is not None
        assert self._app_id is not None

        thread = QThread(self)
        worker = _DeleteWorker(
            self._token, self._tenant_id, self._app_id, self._app_object_id
        )
        worker.moveToThread(thread)
        worker.finished.connect(self._on_deleted)
        worker.failed.connect(self._on_failed)
        thread.started.connect(worker.run)
        thread.start()

        self._delete_thread = thread
        self._delete_worker = worker

    def _on_deleted(self, was_present: bool) -> None:
        if self._delete_thread is not None:
            self._delete_thread.quit()
        if was_present:
            self.status.setText(translate("factoryReset.entraDeleted"))
            audit("settings.factory_reset_entra_deleted")
        else:
            self.status.setText(translate("factoryReset.entraAlreadyGone"))
        self._wipe_local()

    def _wipe_local_only(self) -> None:
        """Skip Entra and just wipe local state."""
        self.start_btn.setEnabled(False)
        audit("settings.factory_reset_local_only")
        self._wipe_local()

    def _wipe_local(self) -> None:
        try:
            counts = self.repo.wipe_collected_data()
        except Exception as e:  # noqa: BLE001
            log.exception("wipe_collected_data failed")
            self._on_failed(translate("factoryReset.wipeDataFailed", error=e))
            return
        cred_count = 0
        try:
            cred_count = self.repo.wipe_credentials()
        except Exception as e:  # noqa: BLE001
            log.exception("wipe_credentials failed")
            self._on_failed(translate("factoryReset.wipeCredFailed", error=e))
            return
        # If we're running inside a multi-profile context, also drop
        # the profile entry from the registry. The outer ``app.run()``
        # loop will then re-show the picker (or onboarding if this
        # was the last one).
        profile_removed = False
        if self.registry is not None and self.profile_id is not None:
            try:
                self.registry.remove(
                    self.profile_id,
                    delete_data=self.delete_profile_data,
                )
                profile_removed = True
            except Exception:
                log.exception("Failed to remove profile from registry")
        self.bar.setVisible(False)
        self._completed = True
        self._profile_removed = profile_removed
        message = translate(
            "factoryReset.resetDone",
            interactions=f"{counts.get('interactions', 0):,}",
            users=f"{counts.get('users', 0):,}",
            runs=f"{counts.get('collection_runs', 0):,}",
            credentials=cred_count,
        )
        if profile_removed:
            message += "\n" + translate("factoryReset.profileRemovedNote")
        else:
            message += "\n" + translate("factoryReset.restartHint")
        self.status.setText(message)
        audit(
            "settings.factory_reset_completed",
            **counts,
            credentials=cred_count,
            profile_removed=profile_removed,
        )
        # Repurpose the Close button label so the operator knows the
        # flow is done.
        for b in self.buttons.buttons():
            b.setText(translate("factoryReset.closeWindowBtn"))

    def _on_failed(self, message: str) -> None:
        for t in (self._device_thread, self._delete_thread):
            if t is not None:
                t.quit()
        self.bar.setVisible(False)
        self.status.setText(f"❌ {message}")
        self.start_btn.setEnabled(True)
        audit("settings.factory_reset_failed", error=message[:200])

    # ------------------------------------------------------------------

    def _copy_code(self) -> None:
        QApplication.clipboard().setText(self.code_label.text())

    def _open_browser(self) -> None:
        text = self.url_label.text()
        import re

        m = re.search(r'href="([^"]+)"', text)
        if m:
            QDesktopServices.openUrl(QUrl(m.group(1)))

    # ------------------------------------------------------------------

    def closeEvent(self, event) -> None:  # noqa: N802
        for t in (self._device_thread, self._delete_thread):
            if t is None:
                continue
            try:
                if t.isRunning():
                    t.quit()
                    t.wait(2000)
            except RuntimeError:
                pass
        super().closeEvent(event)
