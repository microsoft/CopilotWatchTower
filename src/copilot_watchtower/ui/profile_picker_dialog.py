"""Profile selection dialog shown at startup when more than one tenant
profile exists, or when the user explicitly invokes "프로필 관리".

The dialog also supports adding, renaming, and deleting profiles so
the user can manage tenants without leaving the picker.
"""
from __future__ import annotations

import logging

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..db import Repository, initialize
from ..profiles import Profile, ProfileRegistry

log = logging.getLogger(__name__)


class ProfilePickerDialog(QDialog):
    """Lets the user pick (and optionally manage) which profile to load.

    ``selected_profile_id`` is set when the user accepts. ``add_requested``
    is True if the user clicked "새 프로필 추가" — the outer loop then
    creates a fresh empty profile and runs onboarding.
    """

    def __init__(self, registry: ProfileRegistry, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.registry = registry
        self.selected_profile_id: str | None = None
        self.add_requested: bool = False

        self.setWindowTitle("프로필 선택 — CopilotWatchTower")
        self.resize(560, 420)

        header = QLabel(
            "<p><b>프로필을 선택하세요.</b> 각 프로필은 별도의 테넌트에"
            " 연결되며 자체 데이터베이스에 데이터를 보관합니다.</p>"
        )
        header.setWordWrap(True)

        self.list = QListWidget()
        self.list.itemDoubleClicked.connect(self._on_accept)
        self._refresh_list()

        # Side buttons
        self.add_btn = QPushButton("새 프로필 추가...")
        self.add_btn.clicked.connect(self._on_add)
        self.rename_btn = QPushButton("이름 변경...")
        self.rename_btn.clicked.connect(self._on_rename)
        self.delete_btn = QPushButton("삭제...")
        self.delete_btn.clicked.connect(self._on_delete)

        side = QVBoxLayout()
        side.addWidget(self.add_btn)
        side.addWidget(self.rename_btn)
        side.addWidget(self.delete_btn)
        side.addStretch(1)

        body = QHBoxLayout()
        body.addWidget(self.list, 1)
        body.addLayout(side)

        self.buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        ok = self.buttons.button(QDialogButtonBox.Ok)
        ok.setText("열기")
        cancel = self.buttons.button(QDialogButtonBox.Cancel)
        cancel.setText("취소")
        self.buttons.accepted.connect(self._on_accept)
        self.buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(header)
        layout.addLayout(body, 1)
        layout.addWidget(self.buttons)

        # Preselect the active profile (if any) so the default action
        # is "open the one I was using last".
        active_id = registry.active_profile_id
        if active_id:
            for i in range(self.list.count()):
                item = self.list.item(i)
                if item.data(Qt.UserRole) == active_id:
                    self.list.setCurrentRow(i)
                    break
        if self.list.currentRow() < 0 and self.list.count() > 0:
            self.list.setCurrentRow(0)

    # ------------------------------------------------------------------

    def _refresh_list(self) -> None:
        self.list.clear()
        for profile in self.registry.profiles:
            self._hydrate_profile_metadata(profile)
            label = self._format_label(profile)
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, profile.id)
            self.list.addItem(item)

    def _hydrate_profile_metadata(self, profile: Profile) -> None:
        if profile.tenant_domain:
            return
        db_path = self.registry.profile_db_path(profile.id)
        if not db_path.exists():
            return
        try:
            repo = Repository(db_path)
            tenant_id = repo.get_text_setting("tenant_id")
            tenant_domain = repo.get_text_setting("tenant_domain")
            display_name = repo.get_text_setting("display_name")
            bootstrap_complete = repo.get_text_setting("bootstrap_complete") == "1"
        except Exception:
            log.exception("Failed to hydrate profile metadata for %s", profile.id)
            return
        if tenant_id or tenant_domain or display_name:
            self.registry.update_metadata(
                profile.id,
                tenant_id=tenant_id,
                tenant_domain=tenant_domain,
                display_name=display_name,
                bootstrap_complete=bootstrap_complete,
            )

    @staticmethod
    def _format_label(profile: Profile) -> str:
        bits = [profile.name]
        tenant_label = profile.tenant_domain or _human_tenant_display_name(profile.display_name)
        if tenant_label:
            bits.append(f"테넌트 {tenant_label}")
        elif profile.tenant_id:
            bits.append(f"테넌트 {profile.tenant_id[:8]}…")
        if not profile.bootstrap_complete:
            bits.append("(미완료)")
        return " — ".join(bits)

    def _current_profile(self) -> Profile | None:
        item = self.list.currentItem()
        if item is None:
            return None
        return self.registry.get(str(item.data(Qt.UserRole)))

    # ------------------------------------------------------------------

    def _on_add(self) -> None:
        name, ok = QInputDialog.getText(
            self, "새 프로필", "표시 이름:", text="새 테넌트"
        )
        if not ok:
            return
        name = name.strip()
        if not name:
            return
        # Don't create the registry entry here — let the caller drive
        # onboarding first. We just signal that the user wants to add.
        self.add_requested = True
        self._pending_name = name
        self.accept()

    def _on_rename(self) -> None:
        profile = self._current_profile()
        if profile is None:
            return
        name, ok = QInputDialog.getText(
            self, "이름 변경", "표시 이름:", text=profile.name
        )
        if not ok:
            return
        self.registry.update_metadata(profile.id, name=name)
        self._refresh_list()

    def _on_delete(self) -> None:
        profile = self._current_profile()
        if profile is None:
            return
        ans = QMessageBox.warning(
            self,
            "프로필 삭제",
            f"'{profile.name}' 프로필의 로컬 데이터와 연결된 Entra ID 앱 등록을 삭제합니다.\n"
            "다음 단계에서 관리자 로그인이 필요할 수 있습니다.\n\n"
            "정말 진행하시겠습니까?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if ans != QMessageBox.Yes:
            return
        db_path = self.registry.profile_db_path(profile.id)
        try:
            initialize(db_path)
            repo = Repository(db_path)
        except Exception as e:  # noqa: BLE001
            log.exception("Failed to open profile database before delete")
            QMessageBox.critical(self, "프로필 삭제", f"프로필 DB 열기 실패: {e}")
            return

        from .factory_reset_dialog import FactoryResetDialog

        dlg = FactoryResetDialog(
            repo,
            self,
            registry=self.registry,
            profile_id=profile.id,
            delete_profile_data=True,
        )
        dlg.exec()
        self._refresh_list()

    def _on_accept(self, *_args) -> None:
        profile = self._current_profile()
        if profile is None and not self.add_requested:
            QMessageBox.information(self, "프로필", "프로필을 선택하세요.")
            return
        if profile is not None:
            self.selected_profile_id = profile.id
        self.accept()

    # ------------------------------------------------------------------

    def pending_new_name(self) -> str | None:
        """Returns the requested name if the user clicked '새 프로필 추가'."""
        return getattr(self, "_pending_name", None) if self.add_requested else None


def _human_tenant_display_name(display_name: str | None) -> str | None:
    if not display_name:
        return None
    # The app registration display name is not useful for tenant
    # disambiguation; prefer it only when it looks user-provided.
    if display_name.startswith("CopilotWatchTower-"):
        return None
    return display_name
