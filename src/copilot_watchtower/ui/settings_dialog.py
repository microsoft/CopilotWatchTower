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
        self.setWindowTitle("권한 · 위험 영역")
        self.resize(560, 320)

        intro = QLabel(
            "일반 설정(수집 범위 · 주기 · 언어)은 설정 페이지에서 변경하세요.\n"
            "이 창은 device-code 로그인이나 파괴적 동작이 필요한 작업 전용입니다."
        )
        intro.setWordWrap(True)

        self.permissions_btn = QPushButton("Graph 권한 업데이트 / 관리자 동의 다시 받기")
        self.permissions_btn.clicked.connect(self._open_permissions_upgrade)

        # Reset section
        self.wipe_data_btn = QPushButton("수집 데이터 삭제 (대화/사용자/실행 기록)")
        self.wipe_data_btn.clicked.connect(self._wipe_data)
        self.reset_btn = QPushButton(
            "완전 초기화 — Entra 앱까지 삭제하고 처음부터 다시 (위험)"
        )
        self.reset_btn.clicked.connect(self._reset)

        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        buttons.rejected.connect(self.reject)
        close_btn = buttons.button(QDialogButtonBox.Close)
        if close_btn is not None:
            close_btn.clicked.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(intro)
        layout.addWidget(QLabel("권한"))
        layout.addWidget(self.permissions_btn)
        layout.addStretch(1)
        layout.addWidget(QLabel("위험 영역"))
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
            "수집 데이터 삭제",
            "저장된 모든 대화 기록, 사용자 목록, 실행 이력이 삭제됩니다.\n"
            "앱 등록(테넌트 ID / 클라이언트 시크릿)은 그대로 유지되며,\n"
            "다음 수집 주기부터 처음부터 다시 적재됩니다.\n\n"
            "수집이 진행 중이면 먼저 중지하세요.\n\n"
            "정말 진행하시겠습니까?",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if ans != QMessageBox.Yes:
            return
        audit("settings.wipe_data_requested")
        try:
            counts = self.repo.wipe_collected_data()
        except Exception as e:
            QMessageBox.critical(self, "수집 데이터 삭제", f"삭제 실패: {e}")
            return
        audit("settings.wipe_data_completed", **counts)
        QMessageBox.information(
            self,
            "수집 데이터 삭제",
            "삭제가 완료되었습니다.\n"
            f"- 대화: {counts.get('interactions', 0):,}건\n"
            f"- 사용자: {counts.get('users', 0):,}명\n"
            f"- 실행 이력: {counts.get('collection_runs', 0):,}건\n"
            f"- 사용자별 상태: {counts.get('collection_state', 0):,}건",
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
                    "초기화 완료",
                    "프로필이 삭제되었습니다. 프로필 선택 화면으로 돌아갑니다.",
                )
                # Close the settings dialog so the shell can react.
                self.accept()
            else:
                QMessageBox.information(
                    self,
                    "초기화 완료",
                    "프로그램을 종료한 뒤 다시 실행하세요.\n"
                    "새로 실행하면 온보딩이 시작됩니다.",
                )
