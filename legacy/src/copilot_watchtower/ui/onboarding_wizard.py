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
    QRadioButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
    QWizard,
    QWizardPage,
)

from ..config import DELEGATED_BYOA_LOGIN_SCOPES, PURVIEW_EXPORT_SCOPE
from ..db import Repository
from ..i18n import translate
from ..logging_setup import audit
from ..security import protect
from ..services import (
    AppOnlyTokenProvider,
    AppRegistrar,
    BootstrapAuthenticator,
    ConsentCallbackServer,
    DeviceCodePrompt,
    DeviceCodeResult,
    GraphClient,
    RegisteredApp,
    ReportSettingsOutcome,
    admin_consent_url,
    delegated_token_cache_path,
    ensure_usage_reports_show_user_details,
)
from ..services.appreg import REQUIRED_GRAPH_PERMISSION_NAMES, REQUIRED_GRAPH_PERMISSIONS
from ..services.audit_query import mark_purview_permissions_ready
from ..services.graph import GraphError
from ..services.purview_rbac import RbacOutcome, ensure_audit_reader_role

log = logging.getLogger(__name__)


# ----- wizard page IDs --------------------------------------------------
#
# Explicit page IDs let the wizard branch between the default "auto register"
# path (device-code sign-in → app registration → admin consent) and the
# "existing app" (BYOA) path (setup guide → manual credentials → optional
# delegated sign-in) without relying on implicit insertion order.
PAGE_WELCOME = 0
PAGE_MODE = 1
PAGE_DEVICE = 2
PAGE_REGISTRATION = 3
PAGE_CONSENT = 4
PAGE_APP_GUIDE = 5
PAGE_MANUAL_CREDS = 6
PAGE_DELEGATED_LOGIN = 7
PAGE_BROWSER_CREDS = 8
PAGE_USAGE = 9
PAGE_PURVIEW = 10
PAGE_DONE = 11



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

    def __init__(
        self,
        scopes: list[str] | None = None,
        tenant_id: str | None = None,
    ) -> None:
        super().__init__()
        self.auth = BootstrapAuthenticator(scopes=scopes, tenant_id=tenant_id)

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
                self.step.emit(translate("onboarding.reg.creatingApp"))
                app = reg.register(self.display_name)
                self.step.emit(translate("onboarding.reg.savingCredentials"))
                self.finished.emit(app)
        except Exception as e:  # noqa: BLE001
            log.exception("App registration failed")
            self.failed.emit(str(e))


# ----- pages ------------------------------------------------------------


class WelcomePage(QWizardPage):
    def __init__(self) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.welcome.title"))
        self.setSubTitle(translate("onboarding.welcome.subtitle"))
        body = QTextBrowser()
        body.setReadOnly(True)
        body.setOpenExternalLinks(True)
        # Permission bullet list is rendered from the single source of truth
        # in appreg.REQUIRED_GRAPH_PERMISSION_NAMES so the announced scopes
        # always match what is actually requested at registration time.
        _annotations = {
            "eDiscovery.ReadWrite.All": translate(
                "onboarding.welcome.permAnnotationEdiscovery"
            ),
        }
        permission_items = "".join(
            f"  <li><code>{name}</code>{_annotations.get(name, '')}</li>"
            for name in REQUIRED_GRAPH_PERMISSION_NAMES
        )
        body.setHtml(
            translate("onboarding.welcome.body", permission_items=permission_items)
        )
        layout = QVBoxLayout(self)
        layout.addWidget(body)


class ModeSelectPage(QWizardPage):
    """Lets the admin choose automatic app registration or an existing app."""

    def __init__(self) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.mode.title"))
        self.setSubTitle(translate("onboarding.mode.subtitle"))

        self.auto_radio = QRadioButton(translate("onboarding.mode.autoRadio"))
        self.existing_radio = QRadioButton(translate("onboarding.mode.existingRadio"))
        self.auto_radio.setChecked(True)

        auto_note = QLabel(translate("onboarding.mode.autoNote"))
        auto_note.setWordWrap(True)
        existing_note = QLabel(translate("onboarding.mode.existingNote"))
        existing_note.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.addWidget(self.auto_radio)
        layout.addWidget(auto_note)
        layout.addSpacing(12)
        layout.addWidget(self.existing_radio)
        layout.addWidget(existing_note)
        layout.addStretch(1)

    def use_existing_app(self) -> bool:
        return self.existing_radio.isChecked()

    def nextId(self) -> int:
        if self.use_existing_app():
            return PAGE_APP_GUIDE
        return PAGE_DEVICE


class DeviceCodePage(QWizardPage):
    sign_in_complete = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.device.title"))
        self.setSubTitle(translate("onboarding.device.subtitle"))
        self._token: str | None = None
        self._tenant_id: str | None = None
        self._signed_in_upn: str | None = None
        self._token_cache_blob: str | None = None

        self.code_label = QLabel(translate("onboarding.device.issuingCode"))
        font = self.code_label.font()
        font.setPointSize(20)
        font.setBold(True)
        self.code_label.setFont(font)
        self.code_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.url_label = QLabel("")
        self.url_label.setOpenExternalLinks(True)
        self.copy_btn = QPushButton(translate("onboarding.device.copyCode"))
        self.copy_btn.clicked.connect(self._copy_code)
        self.copy_btn.setEnabled(False)
        self.open_btn = QPushButton(translate("onboarding.device.openBrowser"))
        self.open_btn.clicked.connect(self._open_browser)
        self.open_btn.setEnabled(False)
        self.status = QLabel(translate("onboarding.common.waiting"))

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
        self.status.setText(translate("onboarding.device.signingInBrowser"))
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
        self.status.setText(
            translate(
                "onboarding.device.signInSuccess",
                upn=result.upn or "(unknown)",
                tenant=result.tenant_id,
            )
        )
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
        self.setTitle(translate("onboarding.reg.title"))
        self.setSubTitle(translate("onboarding.reg.subtitle"))
        self.device_page = device_page
        self._app: RegisteredApp | None = None

        self.name_edit = QLineEdit()
        self.name_edit.setPlaceholderText(translate("onboarding.reg.namePlaceholder"))
        self.start_btn = QPushButton(translate("onboarding.reg.startButton"))
        self.start_btn.clicked.connect(self._start)
        self.status = QLabel(translate("onboarding.common.waiting"))
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(translate("onboarding.reg.displayNameLabel")))
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
        self.status.setText(translate("onboarding.reg.creatingApp"))
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
        self.status.setText(translate("onboarding.reg.created", app_id=app.app_id))
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
    def __init__(self, device_page: DeviceCodePage, registration_page: RegistrationPage) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.consent.title"))
        self.setSubTitle(translate("onboarding.consent.subtitle"))
        self.device_page = device_page
        self.registration_page = registration_page
        self._consent_ok = False
        self._state = secrets.token_urlsafe(16)
        self._server: ConsentCallbackServer | None = None
        self._redirect_registered = False

        self.status = QLabel(translate("onboarding.consent.waiting"))
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)
        self.open_btn = QPushButton(translate("onboarding.consent.openButton"))
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
        self.status.setText(translate("onboarding.consent.registeringRedirect"))
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
        self.status.setText(translate("onboarding.consent.approveInBrowser"))
        self.open_btn.setEnabled(True)
        self._redirect_thread.quit()
        self._open()

    def _on_redirect_failed(self, message: str) -> None:
        self.bar.setVisible(False)
        self.status.setText(
            translate("onboarding.consent.redirectFailed", message=message)
        )
        self.open_btn.setEnabled(False)
        self._redirect_thread.quit()

    def _open(self) -> None:
        if not self._redirect_registered:
            self.status.setText(translate("onboarding.consent.waitingRedirect"))
            return
        app = self.registration_page.app()
        assert self._server is not None
        url = admin_consent_url(app.tenant_id, app.app_id, self._server.redirect_uri, self._state)
        log.info("Opening admin consent URL: %s", url)
        QDesktopServices.openUrl(QUrl(url))

    def _on_consent(self, ok: bool, error: str | None) -> None:
        self._consent_ok = ok
        if ok:
            self.status.setText(translate("onboarding.consent.done"))
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

    def nextId(self) -> int:
        # The auto-registration path skips the BYOA-only pages.
        return PAGE_BROWSER_CREDS


# ----- existing-app (BYOA) pages ----------------------------------------


class AppSetupGuidePage(QWizardPage):
    """Static guide for customers configuring their own Entra app (BYOA)."""

    def __init__(self) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.appGuide.title"))
        self.setSubTitle(translate("onboarding.appGuide.subtitle"))

        self._role_names = [
            name for name, _id, typ in REQUIRED_GRAPH_PERMISSIONS if typ == "Role"
        ]
        self._scope_names = [
            name for name, _id, typ in REQUIRED_GRAPH_PERMISSIONS if typ == "Scope"
        ]
        role_items = "".join(f"<li><code>{n}</code></li>" for n in self._role_names)
        scope_items = "".join(f"<li><code>{n}</code></li>" for n in self._scope_names)

        body = QTextBrowser()
        body.setReadOnly(True)
        body.setOpenExternalLinks(True)
        body.setHtml(
            translate(
                "onboarding.appGuide.body",
                role_items=role_items,
                scope_items=scope_items,
            )
        )

        self.copy_btn = QPushButton(translate("onboarding.appGuide.copyButton"))
        self.copy_btn.clicked.connect(self._copy_permissions)

        layout = QVBoxLayout(self)
        layout.addWidget(body)
        row = QHBoxLayout()
        row.addStretch(1)
        row.addWidget(self.copy_btn)
        layout.addLayout(row)

    def _copy_permissions(self) -> None:
        lines = [translate("onboarding.appGuide.copyAppHeader")]
        lines += [f"- {n}" for n in self._role_names]
        lines.append("")
        lines.append(translate("onboarding.appGuide.copyDelegatedHeader"))
        lines += [f"- {n}" for n in self._scope_names]
        QApplication.clipboard().setText("\n".join(lines))

    def nextId(self) -> int:
        return PAGE_MANUAL_CREDS


@dataclass
class _ManualCredCheck:
    """Outcome of validating a pre-registered app's credentials."""

    ok: bool
    state: str  # "ok" | "missing_roles" | "cannot_verify" | "auth_failed"
    message: str
    display_name: str | None = None
    tenant_domain: str | None = None
    missing_roles: tuple[str, ...] = ()


class _ManualCredWorker(QObject):
    finished = Signal(object)  # _ManualCredCheck

    def __init__(self, tenant_id: str, client_id: str, client_secret: str) -> None:
        super().__init__()
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret

    def run(self) -> None:
        try:
            provider = AppOnlyTokenProvider(
                self.tenant_id, self.client_id, self.client_secret
            )
            provider.acquire()  # validates credentials + admin consent
        except Exception as e:  # noqa: BLE001
            log.exception("Manual credential validation failed")
            self.finished.emit(
                _ManualCredCheck(
                    ok=False,
                    state="auth_failed",
                    message=translate("onboarding.manual.authFailed", error=str(e)),
                )
            )
            return

        graph = GraphClient(provider, timeout=30.0)
        try:
            display_name: str | None = None
            tenant_domain: str | None = None
            try:
                org = graph.organization_summary()
                display_name = org.get("display_name")
                tenant_domain = org.get("domain")
            except Exception:  # noqa: BLE001 — org read is best-effort
                log.exception("Org summary read failed during manual validation")

            required_roles = [
                (name, guid)
                for name, guid, typ in REQUIRED_GRAPH_PERMISSIONS
                if typ == "Role"
            ]
            try:
                granted = graph.granted_app_role_ids(self.client_id)
            except GraphError as e:
                self.finished.emit(
                    _ManualCredCheck(
                        ok=True,
                        state="cannot_verify",
                        message=translate(
                            "onboarding.manual.cannotVerifyGraph", status=e.status
                        ),
                        display_name=display_name,
                        tenant_domain=tenant_domain,
                    )
                )
                return
            except Exception as e:  # noqa: BLE001
                log.exception("App-role verification failed")
                self.finished.emit(
                    _ManualCredCheck(
                        ok=True,
                        state="cannot_verify",
                        message=translate(
                            "onboarding.manual.cannotVerifyGeneric", error=str(e)
                        ),
                        display_name=display_name,
                        tenant_domain=tenant_domain,
                    )
                )
                return

            missing = tuple(
                name for name, guid in required_roles if guid not in granted
            )
            if missing:
                self.finished.emit(
                    _ManualCredCheck(
                        ok=True,
                        state="missing_roles",
                        message=translate("onboarding.manual.missingRoles"),
                        display_name=display_name,
                        tenant_domain=tenant_domain,
                        missing_roles=missing,
                    )
                )
                return

            self.finished.emit(
                _ManualCredCheck(
                    ok=True,
                    state="ok",
                    message=translate("onboarding.manual.ok"),
                    display_name=display_name,
                    tenant_domain=tenant_domain,
                )
            )
        finally:
            graph.close()


class ManualCredentialsPage(QWizardPage):
    """Collects and validates the credentials of a pre-registered (BYOA) app."""

    def __init__(self) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.manual.title"))
        self.setSubTitle(translate("onboarding.manual.subtitle"))
        self._check: _ManualCredCheck | None = None
        self._running = False
        self._thread: QThread | None = None
        self._worker: _ManualCredWorker | None = None

        summary = QLabel(
            translate(
                "onboarding.manual.summary",
                roles=", ".join(
                    n for n, _i, t in REQUIRED_GRAPH_PERMISSIONS if t == "Role"
                ),
                scopes=", ".join(
                    n for n, _i, t in REQUIRED_GRAPH_PERMISSIONS if t == "Scope"
                ),
            )
        )
        summary.setWordWrap(True)
        summary.setTextInteractionFlags(Qt.TextSelectableByMouse)

        self.tenant_edit = QLineEdit()
        self.tenant_edit.setPlaceholderText(translate("onboarding.manual.tenantPlaceholder"))
        self.client_edit = QLineEdit()
        self.client_edit.setPlaceholderText(translate("onboarding.manual.clientPlaceholder"))
        self.secret_edit = QLineEdit()
        self.secret_edit.setEchoMode(QLineEdit.Password)
        self.secret_edit.setPlaceholderText(translate("onboarding.manual.secretPlaceholder"))

        self.validate_btn = QPushButton(translate("onboarding.manual.validateButton"))
        self.validate_btn.clicked.connect(self._start)
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)
        self.status = QLabel(translate("onboarding.manual.statusInitial"))
        self.status.setWordWrap(True)
        self.detail = QLabel("")
        self.detail.setWordWrap(True)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)

        for edit in (self.tenant_edit, self.client_edit, self.secret_edit):
            edit.textChanged.connect(self._on_input_changed)

        layout = QVBoxLayout(self)
        layout.addWidget(summary)
        layout.addWidget(QLabel(translate("onboarding.manual.tenantLabel")))
        layout.addWidget(self.tenant_edit)
        layout.addWidget(QLabel(translate("onboarding.manual.clientLabel")))
        layout.addWidget(self.client_edit)
        layout.addWidget(QLabel(translate("onboarding.manual.secretLabel")))
        layout.addWidget(self.secret_edit)
        row = QHBoxLayout()
        row.addStretch(1)
        row.addWidget(self.validate_btn)
        layout.addLayout(row)
        layout.addWidget(self.bar)
        layout.addWidget(self.status)
        layout.addWidget(self.detail)
        layout.addStretch(1)

    def _on_input_changed(self, *_a: object) -> None:
        # Editing any credential invalidates a previous successful check.
        if self._check is not None:
            self._check = None
            self.completeChanged.emit()

    def _start(self) -> None:
        if self._running:
            return
        tenant = self.tenant_edit.text().strip()
        client = self.client_edit.text().strip()
        secret = self.secret_edit.text()
        if not (tenant and client and secret):
            self.status.setText(translate("onboarding.manual.allRequired"))
            return
        self._running = True
        self._check = None
        self.validate_btn.setEnabled(False)
        self.bar.setVisible(True)
        self.detail.setText("")
        self.status.setText(translate("onboarding.manual.validating"))
        self.completeChanged.emit()
        self._thread = QThread(self)
        self._worker = _ManualCredWorker(tenant, client, secret)
        self._worker.moveToThread(self._thread)
        self._worker.finished.connect(self._on_finished)
        self._worker.finished.connect(self._thread.quit)
        self._thread.finished.connect(self._worker.deleteLater)
        self._thread.finished.connect(self._thread.deleteLater)
        self._thread.started.connect(self._worker.run)
        self._thread.start()

    def _on_finished(self, check: _ManualCredCheck) -> None:
        self._check = check
        self._running = False
        self._thread = None
        self._worker = None
        self.validate_btn.setEnabled(True)
        self.bar.setVisible(False)
        if check.state == "ok":
            icon = "✓"
        elif check.state == "missing_roles":
            icon = "⚠"
        elif check.state == "cannot_verify":
            icon = "✓"
        else:
            icon = "❌"
        self.status.setText(f"{icon} {check.message}")
        if check.missing_roles:
            self.detail.setText("\n".join(f"  - {n}" for n in check.missing_roles))
        elif check.state == "ok" and check.display_name:
            self.detail.setText(
                translate("onboarding.manual.tenantDetail", name=check.display_name)
            )
        else:
            self.detail.setText("")
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        # Token validation must succeed; a missing-role warning does not block.
        return self._check is not None and self._check.ok and not self._running

    def tenant_id(self) -> str:
        return self.tenant_edit.text().strip()

    def client_id(self) -> str:
        return self.client_edit.text().strip()

    def client_secret(self) -> str:
        return self.secret_edit.text()

    def check_or_none(self) -> _ManualCredCheck | None:
        return self._check

    def nextId(self) -> int:
        return PAGE_DELEGATED_LOGIN


class DelegatedLoginPage(QWizardPage):
    """Optional one-time delegated sign-in for BYOA eDiscovery / consumption."""

    def __init__(self, manual_page: ManualCredentialsPage) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.delegated.title"))
        self.setSubTitle(translate("onboarding.delegated.subtitle"))
        self.manual_page = manual_page
        self._token_cache_blob: str | None = None
        self._done = False
        self._running = False
        self._thread: QThread | None = None
        self._worker: _DeviceCodeWorker | None = None

        self.info = QLabel(translate("onboarding.delegated.info"))
        self.info.setWordWrap(True)

        self.login_btn = QPushButton(translate("onboarding.delegated.loginButton"))
        self.login_btn.clicked.connect(self._start)
        self.skip_label = QLabel(translate("onboarding.delegated.skipNote"))
        self.skip_label.setWordWrap(True)

        self.code_label = QLabel("")
        font = self.code_label.font()
        font.setPointSize(16)
        font.setBold(True)
        self.code_label.setFont(font)
        self.code_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.url_label = QLabel("")
        self.url_label.setOpenExternalLinks(True)
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)
        self.bar.setVisible(False)
        self.status = QLabel("")
        self.status.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.addWidget(self.info)
        row = QHBoxLayout()
        row.addWidget(self.login_btn)
        row.addStretch(1)
        layout.addLayout(row)
        layout.addWidget(self.code_label)
        layout.addWidget(self.url_label)
        layout.addWidget(self.bar)
        layout.addWidget(self.status)
        layout.addWidget(self.skip_label)
        layout.addStretch(1)

    def _start(self) -> None:
        if self._running or self._done:
            return
        tenant_id = self.manual_page.tenant_id() or None
        self._running = True
        self.login_btn.setEnabled(False)
        self.bar.setVisible(True)
        self.status.setText(translate("onboarding.device.issuingCode"))
        self.completeChanged.emit()
        self._thread = QThread(self)
        self._worker = _DeviceCodeWorker(
            scopes=list(DELEGATED_BYOA_LOGIN_SCOPES), tenant_id=tenant_id
        )
        self._worker.moveToThread(self._thread)
        self._worker.prompt_ready.connect(self._on_prompt)
        self._worker.finished.connect(self._on_finished)
        self._worker.failed.connect(self._on_failed)
        self._thread.started.connect(self._worker.run)
        self._thread.start()

    def _on_prompt(self, prompt: DeviceCodePrompt) -> None:
        self.code_label.setText(prompt.user_code)
        self.url_label.setText(
            f'<a href="{prompt.verification_uri}">{prompt.verification_uri}</a>'
        )
        self.status.setText(translate("onboarding.device.signingInBrowser"))
        QDesktopServices.openUrl(QUrl(prompt.verification_uri))

    def _on_finished(self, result: DeviceCodeResult) -> None:
        self._running = False
        self._done = True
        try:
            self._token_cache_blob = (
                self._worker.auth.serialize_cache() if self._worker else None
            )
        except Exception:  # noqa: BLE001 — caching is best-effort
            log.exception("Failed to serialise BYOA delegated token cache")
            self._token_cache_blob = None
        self.bar.setVisible(False)
        self.status.setText(
            translate("onboarding.delegated.done", upn=result.upn or "(unknown)")
        )
        self.login_btn.setEnabled(False)
        if self._thread is not None:
            self._thread.quit()
        self.completeChanged.emit()

    def _on_failed(self, message: str) -> None:
        self._running = False
        self.bar.setVisible(False)
        self.status.setText(f"❌ {message}")
        self.login_btn.setEnabled(True)
        if self._thread is not None:
            self._thread.quit()
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        # Optional step: advancing is allowed whether or not the login ran,
        # but blocked while a sign-in is in flight.
        return not self._running

    def token_cache_blob_or_none(self) -> str | None:
        return self._token_cache_blob

    def nextId(self) -> int:
        return PAGE_BROWSER_CREDS


class EdiscoveryBrowserCredentialPage(QWizardPage):
    """Collects the account used by Playwright for proxy download capture."""

    def __init__(self, device_page: DeviceCodePage) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.browser.title"))
        self.setSubTitle(translate("onboarding.browser.subtitle"))
        self.device_page = device_page

        self.info = QLabel(translate("onboarding.browser.info"))
        self.info.setWordWrap(True)
        self.user_edit = QLineEdit()
        self.user_edit.setPlaceholderText("user@contoso.com")
        self.password_edit = QLineEdit()
        self.password_edit.setEchoMode(QLineEdit.Password)
        self.password_edit.setPlaceholderText(translate("onboarding.browser.passwordPlaceholder"))
        self.status = QLabel("")
        self.status.setWordWrap(True)

        self.user_edit.textChanged.connect(self._on_credentials_changed)
        self.password_edit.textChanged.connect(self._on_credentials_changed)

        layout = QVBoxLayout(self)
        layout.addWidget(self.info)
        layout.addWidget(QLabel(translate("onboarding.browser.upnLabel")))
        layout.addWidget(self.user_edit)
        layout.addWidget(QLabel(translate("onboarding.browser.passwordLabel")))
        layout.addWidget(self.password_edit)
        layout.addWidget(self.status)
        layout.addStretch(1)

    def initializePage(self) -> None:
        if not self.user_edit.text().strip():
            self.user_edit.setText(self.device_page.signed_in_upn_or_none() or "")
        self.status.setText(translate("onboarding.browser.statusNote"))
        self.completeChanged.emit()

    def _on_credentials_changed(self, *_args: object) -> None:
        self.completeChanged.emit()

    def isComplete(self) -> bool:
        return bool(self.user_edit.text().strip() and self.password_edit.text())

    def username(self) -> str:
        return self.user_edit.text().strip()

    def password(self) -> str:
        return self.password_edit.text()

    def nextId(self) -> int:
        # In the existing-app (BYOA) path the delegated usage/Purview auto-steps
        # are skipped — the customer configures those on their own app.
        wiz = self.wizard()
        if (
            wiz is not None
            and getattr(wiz, "is_existing_app_mode", None) is not None
            and wiz.is_existing_app_mode()
        ):
            return PAGE_DONE
        return PAGE_USAGE


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
                self.progress.emit(translate("onboarding.consent.registeringRedirect"))
                reg.set_redirect_uri(self.object_id, self.redirect_uri)
                # Confirm Graph has the URI persisted (replica read).
                self.progress.emit(translate("onboarding.consent.verifyingRedirect"))
                if not reg.verify_redirect_uri(
                    self.object_id, self.redirect_uri, timeout=30.0
                ):
                    raise RuntimeError(translate("onboarding.consent.redirectTimeout"))
            # Even after Graph confirms the URI, the auth endpoint
            # caches independently and can still return AADSTS500113
            # for a short window.  Give it a realistic grace period.
            import time

            self.progress.emit(translate("onboarding.consent.propagationWait"))
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
                message=translate("onboarding.purview.unexpectedError", error=repr(e)),
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

    def __init__(self, device_page: DeviceCodePage, repo: Repository | None = None) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.usage.title"))
        self.setSubTitle(translate("onboarding.usage.subtitle"))
        self.device_page = device_page
        self.repo = repo
        self._started = False
        self._running = False
        self._outcome: ReportSettingsOutcome | None = None
        self._thread: QThread | None = None
        self._worker: _UsageReportSettingsWorker | None = None

        self.status = QLabel(translate("onboarding.common.preparing"))
        self.status.setWordWrap(True)
        self.detail = QLabel(translate("onboarding.usage.detail"))
        self.detail.setWordWrap(True)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(translate("onboarding.usage.bodyLabel")))
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
                message=translate("onboarding.usage.tokenMissing"),
            )
            self.bar.setVisible(False)
            self.status.setText(f"⚠ {self._outcome.message}")
            self.completeChanged.emit()
            return

        self._running = True
        self.status.setText(translate("onboarding.usage.checking"))
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
        registration_page: RegistrationPage,
        repo: Repository | None = None,
        device_page: DeviceCodePage | None = None,
    ) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.purview.title"))
        self.setSubTitle(translate("onboarding.purview.subtitle"))
        self.registration_page = registration_page
        self.device_page = device_page
        self.repo = repo
        self._outcome: RbacOutcome | None = None
        self._started = False
        self._running = False
        self._thread: QThread | None = None
        self._worker: _PurviewRbacWorker | None = None

        self.status = QLabel(translate("onboarding.common.preparing"))
        self.status.setWordWrap(True)
        self.detail = QLabel("")
        self.detail.setWordWrap(True)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.bar = QProgressBar()
        self.bar.setRange(0, 0)

        self.retry_btn = QPushButton(translate("onboarding.common.retry"))
        self.retry_btn.setVisible(False)
        self.retry_btn.clicked.connect(self._on_retry_clicked)

        self.skip_btn = QPushButton(translate("onboarding.purview.skipButton"))
        self.skip_btn.setToolTip(translate("onboarding.purview.skipTooltip"))
        self.skip_btn.clicked.connect(self._on_skip_clicked)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(translate("onboarding.purview.bodyLabel")))
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
                message=translate("onboarding.purview.alreadyGranted"),
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
                message=translate("onboarding.purview.tokenMissing"),
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
        self.status.setText(translate("onboarding.purview.granting"))
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
            translate("onboarding.purview.skipConfirmTitle"),
            translate("onboarding.purview.skipConfirmText"),
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
            message=translate("onboarding.purview.skippedByUser"),
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
        icon = "✓" if outcome.success else "⚠"
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
        purview_page: PurviewRolePage | None = None,
        usage_report_page: UsageReportSettingsPage | None = None,
    ) -> None:
        super().__init__()
        self.setTitle(translate("onboarding.done.title"))
        self.setSubTitle(translate("onboarding.done.subtitle"))
        self._purview_page = purview_page
        self._usage_report_page = usage_report_page
        self.label = QLabel(translate("onboarding.done.body"))
        self.label.setWordWrap(True)
        self.byoa_note = QLabel("")
        self.byoa_note.setWordWrap(True)
        self.byoa_note.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.usage_note = QLabel("")
        self.usage_note.setWordWrap(True)
        self.usage_note.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.purview_note = QLabel("")
        self.purview_note.setWordWrap(True)
        self.purview_note.setTextInteractionFlags(Qt.TextSelectableByMouse)
        layout = QVBoxLayout(self)
        layout.addWidget(self.label)
        layout.addWidget(self.byoa_note)
        layout.addWidget(self.usage_note)
        layout.addWidget(self.purview_note)
        layout.addStretch(1)

    def initializePage(self) -> None:
        wiz = self.wizard()
        if (
            wiz is not None
            and getattr(wiz, "is_existing_app_mode", None) is not None
            and wiz.is_existing_app_mode()
        ):
            # BYOA: the delegated usage/Purview auto-steps were skipped because
            # the customer owns and configures their own app registration.
            self.byoa_note.setText(translate("onboarding.done.byoaNote"))
            return
        if self._usage_report_page is not None:
            usage_outcome = self._usage_report_page.outcome()
            if usage_outcome is not None:
                if usage_outcome.success:
                    self.usage_note.setText(
                        translate(
                            "onboarding.done.usageSuccess",
                            state=usage_outcome.state,
                        )
                    )
                else:
                    self.usage_note.setText(
                        translate(
                            "onboarding.done.usageFailure",
                            state=usage_outcome.state,
                            message=usage_outcome.message,
                        )
                    )
        if self._purview_page is None:
            return
        outcome = self._purview_page.outcome()
        if outcome is None:
            return
        if outcome.success:
            tag_map = {
                "added": "added",
                "added_via_graph": translate("onboarding.done.tagAddedViaGraph"),
                "already_member": "already_member",
                "already_granted": translate("onboarding.done.tagAlreadyGranted"),
                "skipped_by_user": translate("onboarding.done.tagSkippedByUser"),
            }
            tag = tag_map.get(outcome.state, outcome.state)
            self.purview_note.setText(
                translate("onboarding.done.purviewSuccess", tag=tag)
            )
        else:
            self.purview_note.setText(
                translate(
                    "onboarding.done.purviewFailure",
                    state=outcome.state,
                    message=outcome.message,
                )
            )


# ----- main wizard ------------------------------------------------------


class OnboardingWizard(QWizard):
    """Top-level wizard wiring the four pages together."""

    completed = Signal(object)  # BootstrapOutcome

    def __init__(self, repo: Repository, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.repo = repo
        self.setWindowTitle(translate("onboarding.wizard.windowTitle"))
        self.setWizardStyle(QWizard.ModernStyle)
        self.setOption(QWizard.IndependentPages, False)
        self.resize(720, 520)

        self.welcome = WelcomePage()
        self.mode = ModeSelectPage()
        self.device = DeviceCodePage()
        self.registration = RegistrationPage(self.device)
        self.consent = ConsentPage(self.device, self.registration)
        self.app_guide = AppSetupGuidePage()
        self.manual_creds = ManualCredentialsPage()
        self.delegated_login = DelegatedLoginPage(self.manual_creds)
        self.ediscovery_browser = EdiscoveryBrowserCredentialPage(self.device)
        self.usage_report_settings = UsageReportSettingsPage(self.device, self.repo)
        self.purview_role = PurviewRolePage(self.registration, self.repo, device_page=self.device)
        self.done_page = DonePage(self.purview_role, self.usage_report_settings)

        # Explicit page IDs so nextId() overrides can branch between the
        # automatic-registration path and the existing-app (BYOA) path.
        self.setPage(PAGE_WELCOME, self.welcome)
        self.setPage(PAGE_MODE, self.mode)
        self.setPage(PAGE_DEVICE, self.device)
        self.setPage(PAGE_REGISTRATION, self.registration)
        self.setPage(PAGE_CONSENT, self.consent)
        self.setPage(PAGE_APP_GUIDE, self.app_guide)
        self.setPage(PAGE_MANUAL_CREDS, self.manual_creds)
        self.setPage(PAGE_DELEGATED_LOGIN, self.delegated_login)
        self.setPage(PAGE_BROWSER_CREDS, self.ediscovery_browser)
        self.setPage(PAGE_USAGE, self.usage_report_settings)
        self.setPage(PAGE_PURVIEW, self.purview_role)
        self.setPage(PAGE_DONE, self.done_page)
        self.setStartId(PAGE_WELCOME)

        self.finished.connect(self._on_finished)

    def is_existing_app_mode(self) -> bool:
        """True when the admin chose to use a pre-registered (BYOA) app."""
        return self.mode.use_existing_app()

    def registered_app_or_none(self) -> RegisteredApp | None:
        return self.registration.app_or_none()

    def bootstrap_token_or_none(self) -> str | None:
        return self.device.token_or_none()

    def bootstrap_tenant_id_or_none(self) -> str | None:
        return self.device.tenant_id_or_none()

    def _on_finished(self, result: int) -> None:
        if result != QWizard.Accepted:
            return
        if self.is_existing_app_mode():
            self._finish_existing_app()
            return
        try:
            app = self.registration.app()
        except Exception:
            QMessageBox.warning(
                self,
                translate("onboarding.common.errorTitle"),
                translate("onboarding.wizard.noAppResult"),
            )
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
        # This app is created and owned by the tool, so it is not externally
        # managed. Clear the flag explicitly in case a prior run on this profile
        # used the existing-app (BYOA) path.
        self.repo.set_text_setting("app_externally_managed", "0")
        self.repo.set_text_setting("bootstrap_complete", "1")
        # Seed the shared delegated token cache with the refresh token from
        # the onboarding sign-in. Later delegated collection (Purview
        # eDiscovery, Copilot catalog sync) reuses this cache to acquire
        # tokens silently — without a second device-code prompt.
        self._seed_delegated_token_cache(app.tenant_id)
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

    def _seed_delegated_token_cache(self, tenant_id: str, blob: str | None = None) -> None:
        """Write a delegated refresh-token cache to the shared path.

        Best-effort: a failure here only means the admin may be prompted
        for a device-code login the first time delegated collection runs.
        When ``blob`` is omitted the automatic-path device sign-in cache is
        used; the existing-app path passes the optional delegated login cache.
        """
        if blob is None:
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

    def _finish_existing_app(self) -> None:
        """Persist settings for the existing-app (BYOA) path.

        The customer owns the Entra app, so we store only the credentials the
        app-only collectors need (tenant/client/secret) plus the shared browser
        login. We never created the app, so object/SP ids and the secret expiry
        are left empty and ``app_externally_managed`` guards later deletion.
        """
        check = self.manual_creds.check_or_none()
        tenant_id = self.manual_creds.tenant_id()
        client_id = self.manual_creds.client_id()
        client_secret = self.manual_creds.client_secret()
        if not (tenant_id and client_id and client_secret):
            QMessageBox.warning(
                self,
                translate("onboarding.common.errorTitle"),
                translate("onboarding.wizard.emptyCredentials"),
            )
            return
        display_name = (check.display_name if check is not None else None) or (
            f"CopilotWatchTower ({client_id[:8]})"
        )
        self.repo.set_text_setting("tenant_id", tenant_id)
        self.repo.set_text_setting("client_id", client_id)
        self.repo.set_text_setting("display_name", display_name)
        self.repo.set_secret("client_secret", protect(client_secret))
        # Externally-managed app: we do not own these, so leave them blank.
        self.repo.set_text_setting("app_object_id", "")
        self.repo.set_text_setting("sp_object_id", "")
        self.repo.set_text_setting("secret_expires_at", "")
        self.repo.set_text_setting("app_externally_managed", "1")
        if check is not None and check.tenant_domain:
            self.repo.set_text_setting("tenant_domain", check.tenant_domain)
        if check is not None and check.display_name:
            self.repo.set_text_setting("tenant_display_name", check.display_name)
        # eDiscovery / consumption browser-login credentials (shared).
        self.repo.set_text_setting("ediscovery_browser_user", self.ediscovery_browser.username())
        self.repo.set_secret(
            "ediscovery_browser_password", protect(self.ediscovery_browser.password())
        )
        self.repo.set_text_setting("ediscovery_browser_auth_configured", "1")
        # Seed the delegated token cache only if the optional sign-in ran.
        self._seed_delegated_token_cache(
            tenant_id, self.delegated_login.token_cache_blob_or_none()
        )
        self.repo.set_text_setting("bootstrap_complete", "1")
        audit(
            "bootstrap.completed",
            mode="existing_app",
            tenant=tenant_id,
            app_id=client_id,
            display_name=display_name,
            app_role_check=(check.state if check is not None else "unknown"),
            delegated_login=bool(self.delegated_login.token_cache_blob_or_none()),
        )
        self.completed.emit(
            BootstrapOutcome(
                tenant_id=tenant_id,
                app_id=client_id,
                object_id="",
                sp_object_id="",
                display_name=display_name,
            )
        )


