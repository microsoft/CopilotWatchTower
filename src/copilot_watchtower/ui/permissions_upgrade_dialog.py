"""Permissions upgrade dialog — adds current Graph roles to an existing app.

The onboarding wizard creates the Entra app registration with whatever
list of permissions ``REQUIRED_RESOURCE_ACCESS`` had at that moment.
When the app ships new collectors that need additional roles (e.g. the
Phase B audit + usage features added ``AuditLog.Read.All``,
``AuditLogsQuery.Read.All``, ``Reports.Read.All``; later agent inventory
features added ``AgentRegistration.Read.All`` and ``CopilotPackages.Read.All``),
tenants that onboarded earlier will see ``403`` errors until those roles are
added to the application object *and* admin-consented.

This dialog drives that upgrade entirely from inside the app:

  1. Device-code sign-in as a tenant admin (delegated token).
  2. ``PATCH /applications/{id}`` to refresh ``requiredResourceAccess``.
  3. Open the ``/adminconsent`` URL in the default browser so the admin
     can re-grant.

It deliberately re-uses ``BootstrapAuthenticator`` + ``AppRegistrar``
from the onboarding wizard so the device-code UX is consistent.
"""
from __future__ import annotations

import logging
import secrets

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
from ..logging_setup import audit
from ..services import (
    AppRegistrar,
    BootstrapAuthenticator,
    ConsentCallbackServer,
    DeviceCodePrompt,
    DeviceCodeResult,
    admin_consent_url,
    delegated_token_cache_path,
)
from ..services.audit_query import mark_purview_permissions_ready

log = logging.getLogger(__name__)


# ---------------------------------------------------------------- workers


class _DeviceCodeWorker(QObject):
    prompt_ready = Signal(object)
    finished = Signal(object)
    failed = Signal(str)

    def __init__(self, tenant_id: str | None = None) -> None:
        super().__init__()
        # Pin the login to the profile's tenant so a multi-tenant admin
        # re-authenticates against the directory the app actually lives in.
        self.auth = BootstrapAuthenticator(tenant_id=tenant_id)
        self.token_cache_blob: str | None = None

    def run(self) -> None:
        try:
            prompt = self.auth.initiate()
            self.prompt_ready.emit(prompt)
            result = self.auth.poll()
            # Capture the refresh-token cache so the dialog can re-seed the
            # shared delegated cache used by background collectors.
            try:
                self.token_cache_blob = self.auth.serialize_cache()
            except Exception:  # noqa: BLE001 — caching is best-effort
                log.exception("Failed to serialise re-register token cache")
            self.finished.emit(result)
        except Exception as e:  # noqa: BLE001
            log.exception("Device-code flow failed")
            self.failed.emit(str(e))


class _PatchWorker(QObject):
    finished = Signal(str)  # app_object_id
    failed = Signal(str)

    def __init__(
        self, token: str, tenant_id: str, app_id: str, redirect_uri: str
    ) -> None:
        super().__init__()
        self.token = token
        self.tenant_id = tenant_id
        self.app_id = app_id
        # The admin-consent endpoint refuses to redirect to URIs not on the
        # application's reply-URL allow-list (AADSTS50011). We register the
        # loopback callback URI so the browser lands on our friendly local
        # success page instead of the bare "nativeclient" blank page.
        self.redirect_uri = redirect_uri

    def run(self) -> None:
        try:
            with AppRegistrar(self.token, self.tenant_id) as reg:
                obj_id = reg.find_application_object_id(self.app_id)
                reg.patch_required_resource_access(obj_id)
                reg.add_redirect_uri(obj_id, self.redirect_uri)
            self.finished.emit(obj_id)
        except Exception as e:  # noqa: BLE001
            log.exception("Permission patch failed")
            self.failed.emit(str(e))


class _ConsentWaiter(QObject):
    """Waits for the one-shot admin-consent loopback callback."""

    done = Signal(bool, object)  # ok, error
    failed = Signal(str)

    def __init__(self, server: ConsentCallbackServer) -> None:
        super().__init__()
        self.server = server

    def run(self) -> None:
        try:
            result = self.server.wait(timeout=600)
            self.done.emit(result.admin_consent, result.error)
        except Exception as e:  # noqa: BLE001
            self.failed.emit(str(e))


# ---------------------------------------------------------------- dialog


class PermissionsUpgradeDialog(QDialog):
    """Walks the admin through adding new Graph permissions in-app."""

    def __init__(self, repo: Repository, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.repo = repo
        self.setWindowTitle("권한 업데이트")
        self.resize(560, 460)

        self._tenant_id = repo.get_text_setting("tenant_id")
        self._app_id = repo.get_text_setting("client_id")
        self._token: str | None = None
        self._device_thread: QThread | None = None
        self._device_worker: _DeviceCodeWorker | None = None
        self._patch_thread: QThread | None = None
        self._patch_worker: _PatchWorker | None = None
        self._consent_thread: QThread | None = None
        self._consent_worker: _ConsentWaiter | None = None
        self._consent_server: ConsentCallbackServer | None = None
        self._state = secrets.token_urlsafe(16)

        # --- header
        header = QLabel(
            "<p>이 도구는 기존 앱 등록에 다음 권한을 추가하고,"
            " 관리자 동의를 다시 받습니다:</p>"
            "<ul>"
            "<li><b>AuditLog.Read.All</b> — Entra 감사 / 로그인 로그</li>"
            "<li><b>AuditLogsQuery.Read.All</b> — Purview Copilot 활동 로그</li>"
            "<li><b>Reports.Read.All</b> — Microsoft 365 Copilot 사용량 리포트</li>"
            "<li><b>AgentRegistration.Read.All</b> — Copilot Agent 등록 목록</li>"
            "<li><b>CopilotPackages.Read.All</b> — Copilot 패키지/Agent 카탈로그</li>"
            "<li><b>CopilotPolicySettings.Read</b> — Copilot 정책 설정 진단</li>"
            "<li><b>eDiscovery.ReadWrite.All</b> (위임) — Purview eDiscovery 수집 로그인 갱신</li>"
            "</ul>"
            "<p>아래 코드를 브라우저에 입력해 <b>Cloud Application Administrator</b>"
            " 이상 계정으로 로그인하세요.</p>"
        )
        header.setWordWrap(True)

        # --- device code area
        self.code_label = QLabel("코드 발급 중...")
        font = self.code_label.font()
        font.setPointSize(20)
        font.setBold(True)
        self.code_label.setFont(font)
        self.code_label.setTextInteractionFlags(Qt.TextSelectableByMouse)

        self.copy_btn = QPushButton("코드 복사")
        self.copy_btn.clicked.connect(self._copy_code)
        self.copy_btn.setEnabled(False)

        self.open_btn = QPushButton("브라우저 열기")
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
        self.status = QLabel("준비 중...")
        self.status.setWordWrap(True)

        # --- consent button (shown after patch succeeds)
        self.consent_btn = QPushButton("관리자 동의 다시 받기 (브라우저 열기)")
        self.consent_btn.clicked.connect(self._open_admin_consent)
        self.consent_btn.setEnabled(False)

        # --- buttons
        self.buttons = QDialogButtonBox(QDialogButtonBox.Close)
        self.buttons.rejected.connect(self.reject)
        # Override default Close → use accept() so callers can detect
        # a "user finished the flow" case if they want to refresh.
        for b in self.buttons.buttons():
            b.setText("닫기")

        layout = QVBoxLayout(self)
        layout.addWidget(header)
        layout.addLayout(code_row)
        layout.addWidget(self.url_label)
        layout.addWidget(self.bar)
        layout.addWidget(self.status)
        layout.addStretch(1)
        layout.addWidget(self.consent_btn)
        layout.addWidget(self.buttons)

        # Sanity check before we start any threads.
        if not self._tenant_id or not self._app_id:
            self.code_label.setText("—")
            self.status.setText(
                "⚠ 저장된 테넌트 ID 또는 앱 ID가 없습니다. 먼저 온보딩을 완료하세요."
            )
            return

        # Kick off device code immediately. The dialog is modal, so it's
        # fine to start work in __init__ — the QThread won't block the
        # event loop.
        self._start_device_code()
        audit(
            "settings.permission_upgrade_started",
            tenant_id=self._tenant_id,
            app_id=self._app_id,
        )

    # ------------------------------------------------------------------

    def _start_device_code(self) -> None:
        self.bar.setVisible(True)
        self.status.setText("디바이스 코드 발급 중...")

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
        self.status.setText("브라우저에서 로그인 중...")
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
                f"⚠ 로그인한 테넌트({result.tenant_id})가 앱이 등록된"
                f" 테넌트({self._tenant_id})와 다릅니다."
            )
            return
        # Re-seed the shared delegated token cache so background collectors
        # (eDiscovery, Copilot catalog sync) can acquire tokens silently
        # again — this is what actually fixes an expired-login state.
        self._reseed_delegated_token_cache()
        self.status.setText(
            f"✓ 로그인 성공: {result.upn or '(unknown)'} — 권한 목록 업데이트 중..."
        )
        self._start_patch()

    def _reseed_delegated_token_cache(self) -> None:
        if self._device_worker is None or not self._tenant_id:
            return
        blob = self._device_worker.token_cache_blob
        if not blob:
            return
        try:
            cache_path = delegated_token_cache_path(
                self.repo.db_path.parent, self._tenant_id
            )
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(blob, encoding="utf-8")
            log.info("Re-seeded delegated token cache at %s", cache_path)
        except Exception:  # noqa: BLE001 — caching is best-effort
            log.exception("Failed to re-seed delegated token cache")

    def _start_patch(self) -> None:
        assert self._token is not None
        assert self._tenant_id is not None
        assert self._app_id is not None

        # Bind the loopback callback now so the PATCH can register its
        # redirect URI; the same server later receives the consent redirect.
        if self._consent_server is not None:
            self._consent_server.stop()
        self._consent_server = ConsentCallbackServer(self._state)
        self._consent_server.start()

        thread = QThread(self)
        worker = _PatchWorker(
            self._token,
            self._tenant_id,
            self._app_id,
            self._consent_server.redirect_uri,
        )
        worker.moveToThread(thread)
        worker.finished.connect(self._on_patched)
        worker.failed.connect(self._on_failed)
        thread.started.connect(worker.run)
        thread.start()

        self._patch_thread = thread
        self._patch_worker = worker

    def _on_patched(self, app_object_id: str) -> None:
        if self._patch_thread is not None:
            self._patch_thread.quit()
        self.bar.setVisible(False)
        self.status.setText(
            "✓ 권한 목록을 업데이트했습니다.\n"
            "아래 버튼을 눌러 브라우저에서 관리자 동의를 다시 받으세요."
        )
        self.consent_btn.setEnabled(True)
        audit(
            "settings.permission_upgrade_patched",
            app_object_id=app_object_id,
        )

    def _on_failed(self, message: str) -> None:
        if self._device_thread is not None:
            self._device_thread.quit()
        if self._patch_thread is not None:
            self._patch_thread.quit()
        self.bar.setVisible(False)
        self.status.setText(f"❌ {message}")
        audit("settings.permission_upgrade_failed", error=message[:200])

    def _open_admin_consent(self) -> None:
        if not (self._tenant_id and self._app_id):
            return
        if self._consent_server is None:
            self.status.setText("⚠ 콜백 서버가 준비되지 않았습니다. 다시 시도하세요.")
            return
        # Use the local loopback callback so the admin lands on our own
        # friendly "동의 완료" page instead of the bare nativeclient blank
        # page (which the browser flags as a possible phishing attempt).
        url = admin_consent_url(
            self._tenant_id,
            self._app_id,
            self._consent_server.redirect_uri,
            self._state,
        )
        log.info("Opening admin consent URL: %s", url)

        # Start waiting for the callback before opening the browser.
        thread = QThread(self)
        worker = _ConsentWaiter(self._consent_server)
        worker.moveToThread(thread)
        worker.done.connect(self._on_consent_done)
        worker.failed.connect(self._on_failed)
        thread.started.connect(worker.run)
        thread.start()
        self._consent_thread = thread
        self._consent_worker = worker

        QDesktopServices.openUrl(QUrl(url))
        self.consent_btn.setEnabled(False)
        self.bar.setVisible(True)
        self.status.setText("브라우저에서 권한을 승인하세요. 승인 완료를 기다리는 중...")
        audit("settings.permission_upgrade_consent_opened")

    def _on_consent_done(self, ok: bool, error: object) -> None:
        if self._consent_thread is not None:
            self._consent_thread.quit()
        if self._consent_server is not None:
            self._consent_server.stop()
            self._consent_server = None
        self.bar.setVisible(False)
        if ok:
            self.status.setText(
                "✓ 관리자 동의 완료. 다음 수집 주기(최대 15분)부터 적용됩니다."
            )
            mark_purview_permissions_ready(self.repo)
            audit("settings.permission_upgrade_consent_granted")
        else:
            self.consent_btn.setEnabled(True)
            self.status.setText(
                f"❌ 관리자 동의가 완료되지 않았습니다: {error or 'unknown'}"
            )
            audit(
                "settings.permission_upgrade_consent_denied",
                error=str(error)[:200],
            )

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
        for t in (self._device_thread, self._patch_thread, self._consent_thread):
            if t is None:
                continue
            try:
                if t.isRunning():
                    t.quit()
                    t.wait(2000)
            except RuntimeError:
                pass
        if self._consent_server is not None:
            try:
                self._consent_server.stop()
            except Exception:  # noqa: BLE001
                pass
            self._consent_server = None
        super().closeEvent(event)
