"""Onboarding wizard — guides the tenant admin through bootstrap.

Pages:
    1. Welcome + scope explanation.
    2. Device code sign-in (shows user code + opens browser).
    3. App registration progress (creates application/SP/secret).
    4. Admin consent in browser + callback wait.
    5. Completion summary.

The wizard never blocks the GUI thread: each long-running step is
delegated to a ``QThread`` and reports back via signals.
"""
from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass

from PySide6.QtCore import QObject, Qt, QThread, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
    QWizard,
    QWizardPage,
)

from ..config import PURVIEW_EXPORT_SCOPE
from ..db import Repository
from ..logging_setup import audit
from ..security import protect
from ..services import (
    AppRegistrar,
    BootstrapAuthenticator,
    ConsentCallbackServer,
    DeviceCodePrompt,
    DeviceCodeResult,
    RegisteredApp,
    ReportSettingsOutcome,
    admin_consent_url,
    delegated_token_cache_path,
    ensure_usage_reports_show_user_details,
)
from ..services.audit_query import mark_purview_permissions_ready
from ..services.appreg import REQUIRED_GRAPH_PERMISSION_NAMES
from ..services.purview_rbac import RbacOutcome, ensure_audit_reader_role

log = logging.getLogger(__name__)


@dataclass
class BootstrapOutcome:
    tenant_id: str
    app_id: str
    object_id: str
    sp_object_id: str
    display_name: str


# ----- worker threads ---------------------------------------------------


class _DeviceCodeWorker(QObject):
    prompt_ready = Signal(object)   # DeviceCodePrompt
    finished = Signal(object)       # DeviceCodeResult
    failed = Signal(str)

    def __init__(self) -> None:
        super().__init__()
        self.auth = BootstrapAuthenticator()

    def run(self) -> None:
        try:
            prompt = self.auth.initiate()
            self.prompt_ready.emit(prompt)
            result = self.auth.poll()
            self.finished.emit(result)
        except Exception as e:  # noqa: BLE001
            log.exception("Device-code flow failed")
            self.failed.emit(str(e))


class _RegistrationWorker(QObject):
    finished = Signal(object)  # RegisteredApp
    failed = Signal(str)
    step = Signal(str)

    def __init__(self, token: str, tenant_id: str, display_name: str) -> None:
        super().__init__()
        self.token = token
        self.tenant_id = tenant_id
        self.display_name = display_name

    def run(self) -> None:
        try:
            with AppRegistrar(self.token, self.tenant_id) as reg:
                self.step.emit("애플리케이션 생성 중...")
                app = reg.register(self.display_name)
                self.step.emit("자격증명 저장 중...")
                self.finished.emit(app)
        except Exception as e:  # noqa: BLE001
            log.exception("App registration failed")
            self.failed.emit(str(e))


# ----- pages ------------------------------------------------------------


class WelcomePage(QWizardPage):
    def __init__(self) -> None:
        super().__init__()
        self.setTitle("CopilotWatchTower 시작하기")
        self.setSubTitle("테넌트 관리자 계정으로 한 번만 로그인하면 됩니다.")
        body = QTextBrowser()
        body.setReadOnly(True)
        body.setOpenExternalLinks(True)
        # Permission bullet list is rendered from the single source of truth
        # in appreg.REQUIRED_GRAPH_PERMISSION_NAMES so the announced scopes
        # always match what is actually requested at registration time.
        _annotations = {
            "eDiscovery.ReadWrite.All": " (위임됨 / Purview eDiscovery 수집용)",
        }
        permission_items = "".join(
            f"  <li><code>{name}</code>{_annotations.get(name, '')}</li>"
            for name in REQUIRED_GRAPH_PERMISSION_NAMES
        )
        body.setHtml(
            "<p>이 프로그램은 Microsoft 365 Copilot 사용자의 대화 기록을 "
            "Microsoft Graph를 통해 수집합니다.</p>"
            "<p>설치 단계에서 다음을 자동으로 수행합니다:</p>"
            "<ol>"
            "<li>Entra ID에 전용 애플리케이션 등록 (브랜드: <b>CopilotWatchTower</b>)</li>"
            "<li>서비스 주체 생성 및 클라이언트 시크릿 발급</li>"
            "<li>다음 권한에 대한 관리자 동의 요청"
            "  <ul>"
            f"{permission_items}"
            "  </ul>"
            "</li>"
            "<li>Microsoft 365 사용량 보고서의 익명화 설정 확인 및 실명 표시 설정</li>"
            "</ol>"
            "<p>필요한 관리자 역할: <b>Cloud Application Administrator</b> 이상. "
            "보고서 실명 표시 변경은 조직의 privacy 정책상 허용되는 경우에만 적용하세요.</p>"
        )
        layout = QVBoxLayout(self)
        layout.addWidget(body)


class DeviceCodePage(QWizardPage):
    sign_in_complete = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setTitle("관리자 로그인")
        self.setSubTitle("아래 코드를 브라우저에 입력해 로그인하세요.")
        self._token: str | None = None
        self._tenant_id: str | None = None
        self._signed_in_upn: str | None = None
        self._token_cache_blob: str | None = None

        self.code_label = QLabel("코드 발급 중...")
        font = self.code_label.font()
        font.setPointSize(20)
        font.setBold(True)
        self.code_label.setFont(font)
        self.code_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.url_label = QLabel("")
        self.url_label.setOpenExternalLinks(True)
        self.copy_btn = QPushButton("코드 복사")
        self.copy_btn.clicked.connect(self._copy_code)
        self.copy_btn.setEnabled(False)
        self.open_btn = QPushButton("브라우저 열기")
        self.open_btn.clicked.connect(self._open_browser)
        self.open_btn.setEnabled(False)
        self.status = QLabel("대기 중...")

        layout = QVBoxLayout(self)
        row = QHBoxLayout()
        row.addWidget(self.code_label, 1)
        row.addWidget(self.copy_btn)
        row.addWidget(self.open_btn)
        layout.addLayout(row)
        layout.addWidget(self.url_label)
        layout.addWidget(self.status)

        self.thread = QThread(self)
        self.worker = _DeviceCodeWorker()
        self.worker.moveToThread(self.thread)
        self.worker.prompt_ready.connect(self._on_prompt)
        self.worker.finished.connect(self._on_finished)
        self.worker.failed.connect(self._on_failed)
        self.thread.started.connect(self.worker.run)

    def initializePage(self) -> None:
        if not self.thread.isRunning():
            self.thread.start()

    def _on_prompt(self, prompt: DeviceCodePrompt) -> None:
        self.code_label.setText(prompt.user_code)
        self.url_label.setText(
            f'<a href="{prompt.verification_uri}">{prompt.verification_uri}</a>'
        )
        self.copy_btn.setEnabled(True)
        self.open_btn.setEnabled(True)
        self.status.setText("브라우저에서 로그인 중...")
        QDesktopServices.openUrl(QUrl(prompt.verification_uri))

    def _on_finished(self, result: DeviceCodeResult) -> None:
        self._token = result.access_token
        self._tenant_id = result.tenant_id
        self._signed_in_upn = result.upn
        # Warm the cache with the Purview eDiscovery export audience so later
        # export downloads can mint that second-audience token silently (the
        # device-code flow itself can only consent to one resource). Surfaces
        # a missing consent here rather than mid-download. Best-effort.
        try:
            if self.worker.auth.warm_scopes([PURVIEW_EXPORT_SCOPE]):
                log.info("Purview export token cached at onboarding")
            else:
                log.warning(
                    "Purview export audience not pre-consented; export download "
                    "may fall back to interactive sign-in"
                )
        except Exception:  # noqa: BLE001 — warm-up is best-effort
            log.exception("Purview export token warm-up failed")
        # Capture the MSAL refresh-token cache so the wizard can seed the
        # shared delegated cache. This lets later eDiscovery / catalog-sync
        # collection acquire tokens silently instead of prompting again.
        try:
            self._token_cache_blob = self.worker.auth.serialize_cache()
        except Exception:  # noqa: BLE001 — caching is best-effort
            log.exception("Failed to serialise bootstrap token cache")
            self._token_cache_blob = None
        self.status.setText(f"로그인 성공: {result.upn or '(unknown)'} (tenant {result.tenant_id})")
        self.thread.quit()
        self.completeChanged.emit()
        self.sign_in_complete.emit()

    def _on_failed(self, message: str) -> None:
        self._token = None
        self.status.setText(f"❌ {message}")
        self.thread.quit()
        self.completeChanged.emit()

    def _copy_code(self) -> None:
        QApplication.clipboard().setText(self.code_label.text())

    def _open_browser(self) -> None:
        if self.url_label.text():
            # extract href
            text = self.url_label.text()
            import re

            m = re.search(r'href="([^"]+)"', text)
            if m:
                QDesktopServices.openUrl(QUrl(m.group(1)))

    def isComplete(self) -> bool:
        return self._token is not None

    def token(self) -> str:
        assert self._token is not None
        return self._token

    def token_or_none(self) -> str | None:
        return self._token

    def tenant_id(self) -> str:
        assert self._tenant_id is not None
        return self._tenant_id

    def tenant_id_or_none(self) -> str | None:
        return self._tenant_id

    def signed_in_upn_or_none(self) -> str | None:
        return self._signed_in_upn

    def token_cache_blob_or_none(self) -> str | None:
        return self._token_cache_blob


class RegistrationPage(QWizardPage):
    def __init__(self, device_page: DeviceCodePage) -> None:
        super().__init__()
        self.setTitle("애플리케이션 등록")
        self.setSubTitle("Entra ID에 전용 앱을 자동으로 생성합니다.")
        self.device_page = device_page
        self._app: RegisteredApp | None = None

        self.name_edit = QLineEdit()
        self.name_edit.setPlaceholderText("CopilotWatchTower-<호스트명>")
        self.start_btn = QPushButton("앱 생성 시작")
        self.start_btn.clicked.connect(self._start)
        self.status = QLabel("대기 중...")
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("애플리케이션 표시 이름 (선택):"))
        layout.addWidget(self.name_edit)
        layout.addWidget(self.start_btn)
        layout.addWidget(self.bar)
        layout.addWidget(self.status)

    def initializePage(self) -> None:
        self.start_btn.setEnabled(True)
        self.bar.setVisible(False)
        self._app = None

    def _start(self) -> None:
        self.start_btn.setEnabled(False)
        self.bar.setVisible(True)
        self.status.setText("애플리케이션 생성 중...")
        self.thread = QThread(self)
        self.worker = _RegistrationWorker(
            self.device_page.token(),
            self.device_page.tenant_id(),
            self.name_edit.text().strip() or "",
        )
        self.worker.moveToThread(self.thread)
        self.worker.step.connect(self.status.setText)
        self.worker.finished.connect(self._on_done)
        self.worker.failed.connect(self._on_failed)
        self.thread.started.connect(self.worker.run)
        self.thread.start()

    def _on_done(self, app: RegisteredApp) -> None:
        self._app = app
        self.bar.setVisible(False)
        self.status.setText(f"✓ 생성 완료 (appId={app.app_id})")
        self.thread.quit()
        self.completeChanged.emit()

    def _on_failed(self, message: str) -> None:
        self.bar.setVisible(False)
        self.status.setText(f"❌ {message}")
        self.start_btn.setEnabled(True)
        self.thread.quit()

    def isComplete(self) -> bool:
        return self._app is not None

    def app(self) -> RegisteredApp:
        assert self._app is not None
        return self._app

    def app_or_none(self) -> RegisteredApp | None:
        return self._app


class ConsentPage(QWizardPage):
    def __init__(self, device_page: "DeviceCodePage", registration_page: RegistrationPage) -> None:
        super().__init__()
        self.setTitle("관리자 동의")
        self.setSubTitle("브라우저에서 권한을 승인하면 자동으로 다음 단계로 이동합니다.")
        self.device_page = device_page
        self.registration_page = registration_page
        self._consent_ok = False
        self._state = secrets.token_urlsafe(16)
        self._server: ConsentCallbackServer | None = None
        self._redirect_registered = False

        self.status = QLabel("관리자 동의 대기 중...")
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)
        self.open_btn = QPushButton("동의 페이지 열기")
        self.open_btn.clicked.connect(self._open)
        self.open_btn.setEnabled(False)

        layout = QVBoxLayout(self)
        layout.addWidget(self.status)
        layout.addWidget(self.bar)
        layout.addWidget(self.open_btn)

    def initializePage(self) -> None:
        self._consent_ok = False
        self._redirect_registered = False
        if self._server is not None:
            self._server.stop()
        self._server = ConsentCallbackServer(self._state)
        self._server.start()

        # PATCH the app to register the loopback redirect URI BEFORE
        # opening the consent prompt — Entra rejects unknown reply URLs
        # with AADSTS500113.
        self.status.setText("리디렉션 URI 등록 중...")
        self.bar.setVisible(True)
        self.open_btn.setEnabled(False)

        app = self.registration_page.app()
        self._redirect_thread = QThread(self)
        self._redirect_worker = _RedirectUriWorker(
            token=self.device_page.token(),
            tenant_id=app.tenant_id,
            object_id=app.object_id,
            redirect_uri=self._server.redirect_uri,
        )
        self._redirect_worker.moveToThread(self._redirect_thread)
        self._redirect_worker.done.connect(self._on_redirect_registered)
        self._redirect_worker.failed.connect(self._on_redirect_failed)
        self._redirect_worker.progress.connect(self.status.setText)
        self._redirect_thread.started.connect(self._redirect_worker.run)
        self._redirect_thread.start()

        # Start the consent waiter in parallel so we are ready the
        # instant the browser hits the callback URL.
        self.thread = QThread(self)
        worker = _ConsentWaiter(self._server)
        worker.moveToThread(self.thread)
        worker.done.connect(self._on_consent)
        worker.failed.connect(self._on_failed)
        self.thread.started.connect(worker.run)
        self._worker = worker
        self.thread.start()

    def _on_redirect_registered(self) -> None:
        self._redirect_registered = True
        self.bar.setVisible(False)
        self.status.setText("브라우저에서 권한을 승인하세요. (페이지가 자동으로 열립니다)")
        self.open_btn.setEnabled(True)
        self._redirect_thread.quit()
        self._open()

    def _on_redirect_failed(self, message: str) -> None:
        self.bar.setVisible(False)
        self.status.setText(f"❌ 리디렉션 URI 등록 실패: {message}")
        self.open_btn.setEnabled(False)
        self._redirect_thread.quit()

    def _open(self) -> None:
        if not self._redirect_registered:
            self.status.setText("리디렉션 URI 등록을 기다리는 중...")
            return
        app = self.registration_page.app()
        assert self._server is not None
        url = admin_consent_url(app.tenant_id, app.app_id, self._server.redirect_uri, self._state)
        log.info("Opening admin consent URL: %s", url)
        QDesktopServices.openUrl(QUrl(url))

    def _on_consent(self, ok: bool, error: str | None) -> None:
        self._consent_ok = ok
        if ok:
            self.status.setText("✓ 관리자 동의 완료")
        else:
            self.status.setText(f"❌ {error or 'consent failed'}")
        if self._server is not None:
            self._server.stop()
            self._server = None
        self.thread.quit()
        self.completeChanged.emit()

    def _on_failed(self, message: str) -> None:
        self._consent_ok = False
        self.status.setText(f"❌ {message}")
        if self._server is not None:
            self._server.stop()
            self._server = None
        self.thread.quit()
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        return self._consent_ok


class EdiscoveryBrowserCredentialPage(QWizardPage):
    """Collects the account used by Playwright for proxy download capture."""

    def __init__(self, device_page: DeviceCodePage) -> None:
        super().__init__()
        self.setTitle("eDiscovery 자동 다운로드 로그인")
        self.setSubTitle("Direct Download Proxy URL을 headless 브라우저로 받을 때 사용할 계정입니다.")
        self.device_page = device_page

        self.info = QLabel(
            "Microsoft eDiscovery 다운로드 프록시가 브라우저 id_token 세션을 요구할 수 있습니다. "
            "이 계정/암호는 Windows DPAPI로 보호되어 현재 Windows 사용자 프로필에만 저장됩니다."
        )
        self.info.setWordWrap(True)
        self.user_edit = QLineEdit()
        self.user_edit.setPlaceholderText("user@contoso.com")
        self.password_edit = QLineEdit()
        self.password_edit.setEchoMode(QLineEdit.Password)
        self.password_edit.setPlaceholderText("암호")
        self.status = QLabel("")
        self.status.setWordWrap(True)

        self.user_edit.textChanged.connect(self._on_credentials_changed)
        self.password_edit.textChanged.connect(self._on_credentials_changed)

        layout = QVBoxLayout(self)
        layout.addWidget(self.info)
        layout.addWidget(QLabel("로그인 UPN:"))
        layout.addWidget(self.user_edit)
        layout.addWidget(QLabel("암호:"))
        layout.addWidget(self.password_edit)
        layout.addWidget(self.status)
        layout.addStretch(1)

    def initializePage(self) -> None:
        if not self.user_edit.text().strip():
            self.user_edit.setText(self.device_page.signed_in_upn_or_none() or "")
        self.status.setText("이 값은 eDiscovery proxy 다운로드 자동 로그인에만 사용됩니다.")
        self.completeChanged.emit()

    def _on_credentials_changed(self, *_args: object) -> None:
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        return bool(self.user_edit.text().strip() and self.password_edit.text())

    def username(self) -> str:
        return self.user_edit.text().strip()

    def password(self) -> str:
        return self.password_edit.text()


class _RedirectUriWorker(QObject):
    """Background worker that PATCHes the reply URL onto the new app."""

    done = Signal()
    failed = Signal(str)
    progress = Signal(str)

    def __init__(self, token: str, tenant_id: str, object_id: str, redirect_uri: str) -> None:
        super().__init__()
        self.token = token
        self.tenant_id = tenant_id
        self.object_id = object_id
        self.redirect_uri = redirect_uri

    def run(self) -> None:
        try:
            with AppRegistrar(self.token, self.tenant_id) as reg:
                self.progress.emit("리디렉션 URI 등록 중...")
                reg.set_redirect_uri(self.object_id, self.redirect_uri)
                # Confirm Graph has the URI persisted (replica read).
                self.progress.emit("리디렉션 URI 확인 중...")
                if not reg.verify_redirect_uri(
                    self.object_id, self.redirect_uri, timeout=30.0
                ):
                    raise RuntimeError(
                        "Graph가 30초 내에 리디렉션 URI를 보고하지 않았습니다. "
                        "잠시 후 '동의 페이지 열기'를 다시 누르세요."
                    )
            # Even after Graph confirms the URI, the auth endpoint
            # caches independently and can still return AADSTS500113
            # for a short window.  Give it a realistic grace period.
            import time

            self.progress.emit("Entra 인증 엔드포인트 전파 대기 중... (10초)")
            time.sleep(10.0)
            self.done.emit()
        except Exception as e:  # noqa: BLE001
            log.exception("Failed to register redirect URI")
            self.failed.emit(str(e))


class _ConsentWaiter(QObject):
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


class _PurviewRbacWorker(QObject):
    """Background worker for the Exchange Online RBAC role assignment.

    Uses Microsoft Graph beta only (silent, no PowerShell, no second
    interactive sign-in). Lives on the wizard page's QThread so Graph
    retries do not lock up the Qt event loop.
    """

    finished = Signal(object)  # RbacOutcome

    def __init__(self, sp_object_id: str, access_token: str | None = None) -> None:
        super().__init__()
        self.sp_object_id = sp_object_id
        self.access_token = access_token

    def run(self) -> None:
        try:
            outcome = ensure_audit_reader_role(
                self.sp_object_id,
                access_token=self.access_token,
            )
        except Exception as e:  # noqa: BLE001 — never crash the wizard
            log.exception("Purview RBAC worker failed")
            outcome = RbacOutcome(
                success=False,
                state="error",
                message=f"예기치 못한 오류: {e!r}",
            )
        self.finished.emit(outcome)


class _UsageReportSettingsWorker(QObject):
    finished = Signal(object)  # ReportSettingsOutcome


    def __init__(self, access_token: str) -> None:
        super().__init__()
        self.access_token = access_token

    def run(self) -> None:
        outcome = ensure_usage_reports_show_user_details(self.access_token)
        self.finished.emit(outcome)


class UsageReportSettingsPage(QWizardPage):
    """Tenant report privacy setup for identifiable usage snapshots."""

    def __init__(self, device_page: "DeviceCodePage", repo: Repository | None = None) -> None:
        super().__init__()
        self.setTitle("사용량 보고서 실명 표시")
        self.setSubTitle("Microsoft 365 사용량 보고서가 사용자 이름과 UPN을 표시하도록 설정합니다.")
        self.device_page = device_page
        self.repo = repo
        self._started = False
        self._running = False
        self._outcome: ReportSettingsOutcome | None = None
        self._thread: QThread | None = None
        self._worker: _UsageReportSettingsWorker | None = None

        self.status = QLabel("준비 중...")
        self.status.setWordWrap(True)
        self.detail = QLabel(
            "이 설정은 테넌트 전체 Microsoft 365 보고서 privacy 설정입니다. "
            "사용자 정보 표시가 조직 정책상 허용되는 경우에만 적용하세요."
        )
        self.detail.setWordWrap(True)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)

        layout = QVBoxLayout(self)
        layout.addWidget(
            QLabel(
                "Microsoft Graph beta /admin/reportSettings API를 호출하여 "
                "displayConcealedNames=false 로 설정합니다.\n"
                "성공하면 이후 사용량 스냅샷 수집부터 실제 사용자 이름/UPN이 표시됩니다."
            )
        )
        layout.addWidget(self.bar)
        layout.addWidget(self.status)
        layout.addWidget(self.detail)
        layout.addStretch(1)

    def initializePage(self) -> None:
        if self._started:
            return
        self._started = True
        access_token: str | None = None
        try:
            access_token = self.device_page.token()
        except AssertionError:
            access_token = None
        if not access_token:
            self._outcome = ReportSettingsOutcome(
                success=False,
                state="graph_token_missing",
                message="보고서 설정 변경에 필요한 bootstrap access token을 찾을 수 없습니다.",
            )
            self.bar.setVisible(False)
            self.status.setText(f"⚠ {self._outcome.message}")
            self.completeChanged.emit()
            return

        self._running = True
        self.status.setText("사용량 보고서 privacy 설정 확인 중...")
        self.completeChanged.emit()
        self._thread = QThread(self)
        self._worker = _UsageReportSettingsWorker(access_token)
        self._worker.moveToThread(self._thread)
        self._worker.finished.connect(self._on_finished)
        self._worker.finished.connect(self._thread.quit)
        self._thread.finished.connect(self._worker.deleteLater)
        self._thread.finished.connect(self._thread.deleteLater)
        self._thread.started.connect(self._worker.run)
        self._thread.start()

    def _on_finished(self, outcome: ReportSettingsOutcome) -> None:
        self._outcome = outcome
        self._running = False
        self._thread = None
        self._worker = None
        self.bar.setVisible(False)
        icon = "✓" if outcome.success else "⚠"
        self.status.setText(f"{icon} {outcome.message.splitlines()[0]}")
        rest = "\n".join(outcome.message.splitlines()[1:]).strip()
        if rest:
            self.detail.setText(rest)
        if self.repo is not None:
            self.repo.set_text_setting("usage_report_identifiable", "1" if outcome.success else "0")
            self.repo.set_text_setting("usage_report_settings_state", outcome.state)
        audit(
            "bootstrap.usage_report_settings_completed",
            state=outcome.state,
            success=outcome.success,
        )
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        return self._outcome is not None and not self._running

    def outcome(self) -> ReportSettingsOutcome | None:
        return self._outcome


class PurviewRolePage(QWizardPage):
    """Final auto-step: grant the SP audit-log access via Graph RBAC.

    Runs immediately on page entry — no buttons. A soft failure (Graph
    token missing, RBAC denied, transient Graph failure) still
    marks the page complete so the wizard can advance, but a
    "다시 시도" button is exposed so the admin can re-attempt without
    going through the entire wizard again.

    If the per-profile flag ``purview_rbac_granted`` is set from a
    previous successful run, the Graph grant step is skipped entirely.
    """

    def __init__(
        self,
        registration_page: "RegistrationPage",
        repo: Repository | None = None,
        device_page: "DeviceCodePage | None" = None,
    ) -> None:
        super().__init__()
        self.setTitle("Purview 감사 역할 부여")
        self.setSubTitle(
            "Microsoft Graph\ub85c 서비스 주체에 'View-Only Audit Logs' 역할을 자동 부여합니다. "
            "추가 로그인 없이 조용히 진행됩니다."
        )
        self.registration_page = registration_page
        self.device_page = device_page
        self.repo = repo
        self._outcome: RbacOutcome | None = None
        self._started = False
        self._running = False
        self._thread: QThread | None = None
        self._worker: _PurviewRbacWorker | None = None

        self.status = QLabel("준비 중...")
        self.status.setWordWrap(True)
        self.detail = QLabel("")
        self.detail.setWordWrap(True)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)

        self.retry_btn = QPushButton("다시 시도")
        self.retry_btn.setVisible(False)
        self.retry_btn.clicked.connect(self._on_retry_clicked)

        self.skip_btn = QPushButton("건너뛰기 (수동 부여됨)")
        self.skip_btn.setToolTip(
            "이미 'View-Only Audit Logs' 또는 동등한 감사 로그 역할이 부여된 경우,\n"
            "이 단계를 건너뛰고 온보딩을 계속하세요."
        )
        self.skip_btn.clicked.connect(self._on_skip_clicked)

        layout = QVBoxLayout(self)
        layout.addWidget(
            QLabel(
                "Microsoft Graph beta 의 roleManagement/exchange API\ub97c 호\ucd9c\ud558\uc5ec\n"
                "서비스 주체를 'View-Only Audit Logs' 역할에 추가합니다. 새 로그인 창은 "
                "뜨지 않으며, 서비스 주체 전파 지연 시 자동으로 몇 초 간격으로 재시도합니다."
            )
        )
        layout.addWidget(self.bar)
        layout.addWidget(self.status)
        layout.addWidget(self.detail)
        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        btn_row.addWidget(self.skip_btn)
        btn_row.addWidget(self.retry_btn)
        layout.addLayout(btn_row)
        layout.addStretch(1)

    def initializePage(self) -> None:
        if self._started:
            return

        # Short-circuit: if a previous wizard run already granted the
        # role for this profile, skip the Graph role-assignment retry.
        if self.repo is not None and self.repo.get_text_setting(
            "purview_rbac_granted"
        ) == "1":
            log.info("Purview RBAC already granted in profile — skipping")
            audit("bootstrap.purview_rbac_skipped", reason="already_granted")
            mark_purview_permissions_ready(self.repo)
            self._started = True
            self._outcome = RbacOutcome(
                success=True,
                state="already_granted",
                message=(
                    "이전 실행에서 이미 Purview 감사 로그 역할이 부여되어 있어 "
                    "이 단계를 건너뜁니다."
                ),
            )
            self.bar.setVisible(False)
            self.status.setText(f"✓ {self._outcome.message}")
            self.retry_btn.setVisible(False)
            self.skip_btn.setEnabled(False)
            self.completeChanged.emit()
            return

        self._started = True
        self._start_run()

    def _start_run(self) -> None:
        sp_object_id = self.registration_page.app().sp_object_id
        # The delegated bootstrap token from the device-code flow carries
        # RoleManagement.ReadWrite.Exchange and is required for the Graph
        # role grant. The wizard path is Graph-only.
        access_token: str | None = None
        if self.device_page is not None:
            try:
                access_token = self.device_page.token()
            except AssertionError:
                access_token = None
        log.info(
            "Starting Purview RBAC step (sp=%s, graph_token=%s)",
            sp_object_id,
            "yes" if access_token else "no",
        )
        audit(
            "bootstrap.purview_rbac_started",
            sp_object_id=sp_object_id,
            graph_token_available=bool(access_token),
        )
        if not access_token:
            self._running = False
            self._outcome = RbacOutcome(
                success=False,
                state="graph_token_missing",
                message=(
                    "Microsoft Graph 역할 부여에 필요한 bootstrap access token을 찾을 수 없습니다.\n"
                    "디바이스 코드 로그인 단계부터 온보딩을 다시 진행해 주세요. "
                    "이 단계에서는 PowerShell 대체 경로를 사용하지 않습니다."
                ),
            )
            self.bar.setVisible(False)
            self.status.setText(f"⚠ {self._outcome.message.splitlines()[0]}")
            self.detail.setText("\n".join(self._outcome.message.splitlines()[1:]))
            self.retry_btn.setVisible(True)
            self.completeChanged.emit()
            return
        self._running = True
        self._outcome = None
        self.retry_btn.setVisible(False)
        self.bar.setVisible(True)
        self.detail.setText("")
        self.status.setText("Microsoft Graph\uc73c\ub85c \uc5ed\ud560 \ubd80\uc5ec \uc2dc\ub3c4 \uc911...")
        self.completeChanged.emit()
        self._thread = QThread(self)
        self._worker = _PurviewRbacWorker(sp_object_id, access_token=access_token)
        self._worker.moveToThread(self._thread)
        self._worker.finished.connect(self._on_finished)
        self._worker.finished.connect(self._thread.quit)
        self._thread.finished.connect(self._worker.deleteLater)
        self._thread.finished.connect(self._thread.deleteLater)
        self._thread.started.connect(self._worker.run)
        self._thread.start()

    def _on_retry_clicked(self) -> None:
        if self._running:
            return
        log.info("User requested Purview RBAC retry")
        audit("bootstrap.purview_rbac_retry")
        self._start_run()

    def _on_skip_clicked(self) -> None:
        """User opt-out: mark the step skipped and persist the flag.

        Used when the role group can't be added automatically (e.g. the
        tenant has equivalent permissions already granted out-of-band).
        Persists
        the same ``purview_rbac_granted`` flag so subsequent wizard
        runs auto-skip this step.
        """
        # No-op if the step already completed successfully — nothing to skip.
        if self._outcome is not None and self._outcome.success:
            return
        reply = QMessageBox.question(
            self,
            "건너뛰기 확인",
            (
                "이 단계를 건너뛰면 Purview 감사 로그 역할 부여를 시도하지 않고\n"
                "다음 실행부터도 이 프로파일에서 자동으로 건너뛰게 됩니다.\n\n"
                "이미 'View-Only Audit Logs' 또는 동등한 감사 로그 역할이 부여된 경우에만 선택하세요.\n"
                "권한이 없으면 Purview 소스 수집이 실패합니다.\n\n"
                "건너뛰시겠습니까?"
            ),
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply != QMessageBox.Yes:
            return
        log.info("User chose to skip Purview RBAC step")
        audit("bootstrap.purview_rbac_skipped", reason="user_choice")
        self._outcome = RbacOutcome(
            success=True,
            state="skipped_by_user",
            message=(
                "사용자가 감사 로그 역할이 이미 부여된 것으로 표시하여 "
                "이 단계를 건너뛰었습니다."
            ),
        )
        # Persist immediately so this profile auto-skips on future runs.
        if self.repo is not None:
            self.repo.set_text_setting("purview_rbac_granted", "1")
            mark_purview_permissions_ready(self.repo)
        self._running = False
        self.bar.setVisible(False)
        self.status.setText(f"✓ {self._outcome.message}")
        self.detail.setText("")
        self.retry_btn.setVisible(False)
        self.skip_btn.setEnabled(False)
        self.completeChanged.emit()

    def _on_finished(self, outcome: RbacOutcome) -> None:
        # Race guard: if the user clicked Skip while the worker was
        # still running, ignore the worker's late result so we don't
        # overwrite the user's choice.
        if (
            self._outcome is not None
            and self._outcome.state == "skipped_by_user"
        ):
            log.info(
                "Ignoring late Purview worker outcome (state=%s) — user already skipped",
                outcome.state,
            )
            return
        self._outcome = outcome
        self._running = False
        self._thread = None
        self._worker = None
        self.bar.setVisible(False)
        if outcome.success:
            icon = "✓"
        else:
            icon = "⚠"
        self.status.setText(f"{icon} {outcome.message.splitlines()[0]}")
        # Show remaining lines (if any) in a secondary label.
        rest = "\n".join(outcome.message.splitlines()[1:]).strip()
        if rest:
            self.detail.setText(rest)
        # On failure, surface the retry button so the admin can re-attempt
        # (e.g., they cancelled the sign-in popup or hit a transient error).
        retry_possible = not outcome.success
        self.retry_btn.setVisible(retry_possible)
        audit(
            "bootstrap.purview_rbac_completed",
            state=outcome.state,
            success=outcome.success,
        )
        # Mark complete regardless — failure shouldn't block onboarding.
        # The final page reads ``outcome()`` to display a clear note.
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        # Block Next while a run is in-flight; otherwise allow advance
        # (soft fail) so the admin can finish onboarding and retry later.
        return self._outcome is not None and not self._running

    def outcome(self) -> RbacOutcome | None:
        return self._outcome


class DonePage(QWizardPage):
    def __init__(
        self,
        purview_page: "PurviewRolePage | None" = None,
        usage_report_page: "UsageReportSettingsPage | None" = None,
    ) -> None:
        super().__init__()
        self.setTitle("설치 완료")
        self.setSubTitle("이제 대화 기록 수집을 시작할 수 있습니다.")
        self._purview_page = purview_page
        self._usage_report_page = usage_report_page
        self.label = QLabel("설정이 저장되었습니다. 마침을 눌러 메인 창으로 이동하세요.")
        self.label.setWordWrap(True)
        self.usage_note = QLabel("")
        self.usage_note.setWordWrap(True)
        self.usage_note.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.purview_note = QLabel("")
        self.purview_note.setWordWrap(True)
        self.purview_note.setTextInteractionFlags(Qt.TextSelectableByMouse)
        layout = QVBoxLayout(self)
        layout.addWidget(self.label)
        layout.addWidget(self.usage_note)
        layout.addWidget(self.purview_note)
        layout.addStretch(1)

    def initializePage(self) -> None:
        if self._usage_report_page is not None:
            usage_outcome = self._usage_report_page.outcome()
            if usage_outcome is not None:
                if usage_outcome.success:
                    self.usage_note.setText(
                        f"✓ 사용량 보고서 실명 표시: {usage_outcome.state}\n"
                        "다음 사용량 스냅샷부터 실제 사용자 이름/UPN이 표시됩니다."
                    )
                else:
                    self.usage_note.setText(
                        "⚠ 사용량 보고서 실명 표시 설정을 완료하지 못했습니다.\n"
                        f"({usage_outcome.state}) — Microsoft 365 보고서에서 사용자가 계속 익명으로 표시될 수 있습니다.\n"
                        "세부 메시지:\n" + usage_outcome.message
                    )
        if self._purview_page is None:
            return
        outcome = self._purview_page.outcome()
        if outcome is None:
            return
        if outcome.success:
            tag_map = {
                "added": "added",
                "added_via_graph": "added_via_graph (Microsoft Graph 자동 부여)",
                "already_member": "already_member",
                "already_granted": "already_granted (이전 실행에서 부여됨)",
                "skipped_by_user": "skipped_by_user (수동 부여됨으로 표시)",
            }
            tag = tag_map.get(outcome.state, outcome.state)
            self.purview_note.setText(
                f"✓ Purview 감사 로그 역할: {tag}\n"
                "다음 수집 주기부터 Purview 소스가 정상 동작합니다."
            )
        else:
            self.purview_note.setText(
                "⚠ Purview 감사 로그 역할 부여를 완료하지 못했습니다.\n"
                f"({outcome.state}) — Purview 소스는 권한 복구 후 자동 재시도됩니다.\n"
                "권한 업데이트 또는 온보딩을 다시 진행해야 합니다.\n\n"
                "세부 메시지:\n" + outcome.message
            )


# ----- main wizard ------------------------------------------------------


class OnboardingWizard(QWizard):
    """Top-level wizard wiring the four pages together."""

    completed = Signal(object)  # BootstrapOutcome

    def __init__(self, repo: Repository, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.repo = repo
        self.setWindowTitle("CopilotWatchTower — 초기 설정")
        self.setWizardStyle(QWizard.ModernStyle)
        self.setOption(QWizard.IndependentPages, False)
        self.resize(720, 520)

        self.welcome = WelcomePage()
        self.device = DeviceCodePage()
        self.registration = RegistrationPage(self.device)
        self.consent = ConsentPage(self.device, self.registration)
        self.ediscovery_browser = EdiscoveryBrowserCredentialPage(self.device)
        self.usage_report_settings = UsageReportSettingsPage(self.device, self.repo)
        self.purview_role = PurviewRolePage(self.registration, self.repo, device_page=self.device)
        self.done_page = DonePage(self.purview_role, self.usage_report_settings)

        self.addPage(self.welcome)
        self.addPage(self.device)
        self.addPage(self.registration)
        self.addPage(self.consent)
        self.addPage(self.ediscovery_browser)
        self.addPage(self.usage_report_settings)
        self.addPage(self.purview_role)
        self.addPage(self.done_page)

        self.finished.connect(self._on_finished)

    def registered_app_or_none(self) -> RegisteredApp | None:
        return self.registration.app_or_none()

    def bootstrap_token_or_none(self) -> str | None:
        return self.device.token_or_none()

    def bootstrap_tenant_id_or_none(self) -> str | None:
        return self.device.tenant_id_or_none()

    def _on_finished(self, result: int) -> None:
        if result != QWizard.Accepted:
            return
        try:
            app = self.registration.app()
        except Exception:
            QMessageBox.warning(self, "오류", "앱 등록 결과가 없습니다.")
            return
        # Persist credentials (DPAPI-protected secret + plain identifiers).
        self.repo.set_text_setting("tenant_id", app.tenant_id)
        self.repo.set_text_setting("client_id", app.app_id)
        self.repo.set_text_setting("app_object_id", app.object_id)
        self.repo.set_text_setting("sp_object_id", app.sp_object_id)
        self.repo.set_text_setting("display_name", app.display_name)
        self.repo.set_secret("client_secret", protect(app.client_secret))
        self.repo.set_text_setting("secret_expires_at", app.secret_expires_at)
        self.repo.set_text_setting("ediscovery_browser_user", self.ediscovery_browser.username())
        self.repo.set_secret("ediscovery_browser_password", protect(self.ediscovery_browser.password()))
        self.repo.set_text_setting("ediscovery_browser_auth_configured", "1")
        self.repo.set_text_setting("bootstrap_complete", "1")
        # Seed the shared delegated token cache with the refresh token from
        # the onboarding sign-in. Later delegated collection (Purview
        # eDiscovery, Copilot catalog sync) reuses this cache to acquire
        # tokens silently — without a second device-code prompt.
        self._seed_delegated_token_cache(app.tenant_id)
        # Persist Purview RBAC success so subsequent wizard runs on the
        # same profile skip the Graph role-assignment retry.
        purview_outcome = self.purview_role.outcome()
        if purview_outcome is not None and purview_outcome.success:
            self.repo.set_text_setting("purview_rbac_granted", "1")
            mark_purview_permissions_ready(self.repo)
        usage_outcome = self.usage_report_settings.outcome()
        if usage_outcome is not None:
            self.repo.set_text_setting("usage_report_identifiable", "1" if usage_outcome.success else "0")
            self.repo.set_text_setting("usage_report_settings_state", usage_outcome.state)
        audit(
            "bootstrap.completed",
            tenant=app.tenant_id,
            app_id=app.app_id,
            display_name=app.display_name,
            purview_rbac_state=(
                self.purview_role.outcome().state
                if self.purview_role.outcome() is not None
                else "not_attempted"
            ),
            usage_report_settings_state=(
                usage_outcome.state if usage_outcome is not None else "not_attempted"
            ),
        )
        self.completed.emit(
            BootstrapOutcome(
                tenant_id=app.tenant_id,
                app_id=app.app_id,
                object_id=app.object_id,
                sp_object_id=app.sp_object_id,
                display_name=app.display_name,
            )
        )

    def _seed_delegated_token_cache(self, tenant_id: str) -> None:
        """Write the onboarding refresh-token cache to the shared path.

        Best-effort: a failure here only means the admin may be prompted
        for a device-code login the first time delegated collection runs.
        """
        blob = self.device.token_cache_blob_or_none()
        if not blob or not tenant_id:
            return
        try:
            cache_path = delegated_token_cache_path(self.repo.db_path.parent, tenant_id)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(blob, encoding="utf-8")
            log.info("Seeded delegated token cache at %s", cache_path)
        except Exception:  # noqa: BLE001 — caching is best-effort
            log.exception("Failed to seed delegated token cache")

