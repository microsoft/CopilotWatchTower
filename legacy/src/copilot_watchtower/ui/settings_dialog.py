"""Settings dialog — permissions and danger-zone (device-code) actions.

Everyday settings (collection scope, poll interval, language) are edited in
the web Settings page. This native dialog is reserved for operations that
require a device-code sign-in or a destructive confirmation flow — Graph
permission re-consent, collected-data wipe, and full factory reset — which
are awkward or unsafe to drive from inside the embedded web view.
"""
from __future__ import annotations

from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QLabel,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..config import RuntimeOptions
from ..db import Repository
from ..i18n import translate
from ..logging_setup import audit
from ..profiles import ProfileRegistry


class SettingsDialog(QDialog):
    def __init__(
        self,
        repo: Repository,
        options: RuntimeOptions,
        parent: QWidget | None = None,
        *,
        registry: ProfileRegistry | None = None,
        profile_id: str | None = None,
    ) -> None:
        super().__init__(parent)
        self.repo = repo
        self.options = options
        self.registry = registry
        self.profile_id = profile_id
        # Set by ``_reset`` when the factory-reset dialog drops the
        # current profile entry — the caller (MainWindow) reads this
        # to decide whether to close and return to the picker.
        self.profile_removed: bool = False
        self.setWindowTitle(translate("settingsDlg.title"))
        self.resize(560, 320)

        intro = QLabel(translate("settingsDlg.intro"))
        intro.setWordWrap(True)

        self.permissions_btn = QPushButton(translate("settingsDlg.permissionsBtn"))
        self.permissions_btn.clicked.connect(self._open_permissions_upgrade)

        # Reset section
        self.wipe_data_btn = QPushButton(translate("settingsDlg.wipeDataBtn"))
        self.wipe_data_btn.clicked.connect(self._wipe_data)
        self.reset_btn = QPushButton(translate("settingsDlg.resetBtn"))
        self.reset_btn.clicked.connect(self._reset)

        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        buttons.rejected.connect(self.reject)
        close_btn = buttons.button(QDialogButtonBox.Close)
        if close_btn is not None:
            close_btn.clicked.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(intro)
        layout.addWidget(QLabel(translate("settingsDlg.sectionPermissions")))
        layout.addWidget(self.permissions_btn)
        layout.addStretch(1)
        layout.addWidget(QLabel(translate("settingsDlg.sectionDanger")))
        layout.addWidget(self.wipe_data_btn)
        layout.addWidget(self.reset_btn)
        layout.addWidget(buttons)

    def _open_permissions_upgrade(self) -> None:
        from .permissions_upgrade_dialog import PermissionsUpgradeDialog

        dlg = PermissionsUpgradeDialog(self.repo, self)
        dlg.exec()

    def _wipe_data(self) -> None:
        ans = QMessageBox.warning(
            self,
            translate("settingsDlg.wipeDataTitle"),
            translate("settingsDlg.wipeDataConfirm"),
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if ans != QMessageBox.Yes:
            return
        audit("settings.wipe_data_requested")
        try:
            counts = self.repo.wipe_collected_data()
        except Exception as e:
            QMessageBox.critical(
                self,
                translate("settingsDlg.wipeDataTitle"),
                translate("settingsDlg.deleteFailed", error=e),
            )
            return
        audit("settings.wipe_data_completed", **counts)
        QMessageBox.information(
            self,
            translate("settingsDlg.wipeDataTitle"),
            translate(
                "settingsDlg.wipeDataDone",
                interactions=f"{counts.get('interactions', 0):,}",
                users=f"{counts.get('users', 0):,}",
                runs=f"{counts.get('collection_runs', 0):,}",
                state=f"{counts.get('collection_state', 0):,}",
            ),
        )

    def _reset(self) -> None:
        """Open the full factory-reset flow (Entra app + local state).

        The actual confirmation, sign-in, delete, and wipe steps live
        inside :class:`FactoryResetDialog` so the entire destructive
        sequence is gated behind one explicit "계속 진행" click after
        the operator sees what's about to happen.
        """
        # Local import — the dialog pulls in MSAL/httpx only when
        # the user actually opens it.
        from .factory_reset_dialog import FactoryResetDialog

        audit("settings.reset_requested")
        dlg = FactoryResetDialog(
            self.repo, self, registry=self.registry, profile_id=self.profile_id
        )
        dlg.exec()
        if dlg.was_completed():
            if dlg.profile_was_removed():
                # Multi-profile mode — let the caller bounce us back to
                # the picker without forcing a process restart.
                self.profile_removed = True
                QMessageBox.information(
                    self,
                    translate("settingsDlg.resetCompleteTitle"),
                    translate("settingsDlg.resetProfileRemoved"),
                )
                # Close the settings dialog so the shell can react.
                self.accept()
            else:
                QMessageBox.information(
                    self,
                    translate("settingsDlg.resetCompleteTitle"),
                    translate("settingsDlg.resetRestartHint"),
                )
