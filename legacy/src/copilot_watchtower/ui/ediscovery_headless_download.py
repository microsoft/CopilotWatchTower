"""Headless embedded-browser downloader for eDiscovery export packages.

The eDiscovery *direct download proxy* URL
(``*.proxyservice.ediscovery.svc.cloud.microsoft/.../exportaedblobFileResult(...)``)
is **browser-only**: it demands an interactive ``id_token`` sign-in, so an
app/bearer token 401s every time.

This downloader hosts the URL inside an *invisible* :class:`QWebEngineView`
backed by a **persistent** profile. When the profile already holds a valid
session cookie the proxy streams the ZIP straight into a
:class:`QWebEngineDownloadRequest` — the whole thing happens in the
background with **no visible window at all**. A window is only surfaced if the
proxy redirects to a sign-in page (i.e. the one-time interactive login); once
the operator signs in the cookie persists and every later run is silent again.
"""
from __future__ import annotations

import contextlib
import json
import logging
from pathlib import Path

from PySide6.QtCore import QEvent, QObject, QTimer, QUrl, Signal
from PySide6.QtWebEngineCore import (
    QWebEngineDownloadRequest,
    QWebEnginePage,
    QWebEngineProfile,
)
from PySide6.QtWebEngineWidgets import QWebEngineView

log = logging.getLogger(__name__)

_LOGIN_HOST_MARKERS = (
    "login.microsoftonline.com",
    "login.microsoft.com",
    "login.windows.net",
    "login.live.com",
    "microsoftonline",
    "msauth",
    "msftauth",
)


def _is_login_host(host: str) -> bool:
    host = (host or "").lower()
    return any(marker in host for marker in _LOGIN_HOST_MARKERS)


class EdiscoveryHeadlessDownloader(QObject):
    """Downloads the browser-only export URL with no UI unless login is needed.

    Emits :attr:`finished` exactly once with the downloaded file path, or an
    empty string if the download was cancelled / failed.

    A persistent :class:`QWebEngineProfile` can be passed in via ``profile``.
    Reusing a single profile across calls (instead of constructing a new
    instance per download) is what actually lets Chromium flush sign-in
    cookies to disk — two profile instances racing on the same storage path
    end up with a locked / never-flushed cookies DB, which is why the
    interactive passkey prompt would otherwise reappear on every run.
    """

    finished = Signal(str)  # downloaded path, or "" on failure/cancel

    def __init__(
        self,
        url: str,
        *,
        storage_dir: Path | str,
        download_dir: Path | str,
        parent: QObject | None = None,
        profile: QWebEngineProfile | None = None,
        username: str | None = None,
        password: str | None = None,
        timeout_ms: int = 300_000,
    ) -> None:
        super().__init__(parent)
        self._url = url
        self._download_dir = Path(download_dir)
        self._download_dir.mkdir(parents=True, exist_ok=True)
        Path(storage_dir).mkdir(parents=True, exist_ok=True)

        self.downloaded_path: str | None = None
        self._download_started = False
        self._done = False
        self._username = (username or "").strip()
        self._password = password or ""

        if profile is None:
            # No external profile (mainly the test / ad-hoc path): create a
            # self-owned named profile and set the persistence policies
            # explicitly so cookies are actually written to disk.
            profile = QWebEngineProfile("ediscovery-download", self)
            profile.setPersistentStoragePath(str(storage_dir))
            profile.setCachePath(str(Path(storage_dir) / "cache"))
            profile.setPersistentCookiesPolicy(
                QWebEngineProfile.PersistentCookiesPolicy.AllowPersistentCookies
            )
            profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.DiskHttpCache)
            self._owns_profile = True
        else:
            self._owns_profile = False
        profile.setDownloadPath(str(self._download_dir))
        self._profile = profile
        self._profile.downloadRequested.connect(self._on_download_requested)
        log.info(
            "Headless eDiscovery downloader: profile storage=%s, owns_profile=%s "
            "(sign-in cookies persist in that directory)",
            storage_dir,
            self._owns_profile,
        )

        # The view is created hidden; it is only shown if a sign-in page loads.
        self._view = QWebEngineView()
        self._view.setWindowTitle("eDiscovery 로그인")
        self._view.resize(960, 720)
        self._page = QWebEnginePage(self._profile, self._view)
        self._view.setPage(self._page)
        self._view.installEventFilter(self)
        self._page.loadFinished.connect(self._on_load_finished)

        self._login_timer = QTimer(self)
        self._login_timer.setInterval(1200)
        self._login_timer.timeout.connect(self._try_auto_login)
        self._timeout_timer = QTimer(self)
        self._timeout_timer.setSingleShot(True)
        self._timeout_timer.timeout.connect(lambda: self._emit_once(""))
        self._timeout_timer.start(timeout_ms)

    # ----------------------------------------------------------------

    def start(self) -> None:
        log.info("Headless eDiscovery download: navigating to export URL")
        self._view.setUrl(QUrl(self._url))
        self._login_timer.start()

    # -- download capture --------------------------------------------

    def _on_download_requested(self, item: QWebEngineDownloadRequest) -> None:
        if self._download_started:
            item.cancel()
            return
        self._download_started = True
        item.setDownloadDirectory(str(self._download_dir))
        item.isFinishedChanged.connect(lambda it=item: self._on_item_finished(it))
        item.accept()
        log.info("Headless eDiscovery download started (silent)")

    def _on_item_finished(self, item: QWebEngineDownloadRequest) -> None:
        state = item.state()
        if state == QWebEngineDownloadRequest.DownloadState.DownloadCompleted:
            path = str(Path(item.downloadDirectory()) / item.downloadFileName())
            log.info("Headless eDiscovery download completed: %s", path)
            self._emit_once(path)
        elif state in (
            QWebEngineDownloadRequest.DownloadState.DownloadCancelled,
            QWebEngineDownloadRequest.DownloadState.DownloadInterrupted,
        ):
            log.warning("Headless eDiscovery download failed: state=%s", state)
            self._download_started = False
            self._emit_once("")

    # -- login fallback ----------------------------------------------

    def _on_load_finished(self, ok: bool) -> None:
        if self._done or self._download_started:
            return
        host = self._page.url().host()
        if _is_login_host(host):
                        self._try_auto_login()

        def _try_auto_login(self) -> None:
                if self._done or self._download_started:
                        self._login_timer.stop()
                        return
                if not self._username or not self._password:
                        return
                host = self._page.url().host()
                if not _is_login_host(host):
                        return
                username = json.dumps(self._username)
                password = json.dumps(self._password)
                script = f"""
(function() {{
    const username = {username};
    const password = {password};
    function visible(el) {{
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    }}
    function click(el) {{ if (el) {{ el.click(); return true; }} return false; }}
    function byText(words) {{
        const all = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], a, div[role=button]'));
        return all.find(el => visible(el) && words.some(w => ((el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase()).includes(w)));
    }}
    const email = Array.from(document.querySelectorAll('input[type=email], input[name=loginfmt], input#i0116')).find(visible);
    if (email && !email.value) {{
        email.focus(); email.value = username; email.dispatchEvent(new Event('input', {{bubbles:true}}));
        click(document.querySelector('#idSIButton9, input[type=submit], button[type=submit]'));
        return 'filled-username';
    }}
    const usePassword = byText(['password', '암호', '비밀번호']);
    if (usePassword) {{ click(usePassword); return 'clicked-password-option'; }}
    const pwd = Array.from(document.querySelectorAll('input[type=password], input[name=passwd], input#i0118')).find(visible);
    if (pwd && !pwd.value) {{
        pwd.focus(); pwd.value = password; pwd.dispatchEvent(new Event('input', {{bubbles:true}}));
        click(document.querySelector('#idSIButton9, input[type=submit], button[type=submit]'));
        return 'filled-password';
    }}
    const submit = document.querySelector('#idSIButton9, input[type=submit], button[type=submit]');
    if (submit && visible(submit)) {{ click(submit); return 'clicked-submit'; }}
    const no = document.querySelector('#idBtn_Back');
    if (no && visible(no)) {{ click(no); return 'clicked-back'; }}
    return 'noop:' + location.href;
}})();
"""
                self._page.runJavaScript(script, lambda result: log.debug("Auto eDiscovery login step: %s", result))

    # -- lifecycle ---------------------------------------------------

    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802
        # User closed the sign-in window without completing the download.
        if obj is self._view and event.type() == QEvent.Type.Close and not self._done:
            log.info("Headless eDiscovery download window closed by user")
            self._emit_once("")
        return super().eventFilter(obj, event)

    def _emit_once(self, path: str) -> None:
        if self._done:
            return
        self._done = True
        self.downloaded_path = path or None
        self._login_timer.stop()
        self._timeout_timer.stop()
        # When the profile is shared across calls (the normal path), this
        # downloader's downloadRequested handler must be detached — otherwise
        # the next download would deliver the file to a destroyed instance.
        with contextlib.suppress(RuntimeError, TypeError):  # never connected, or already gone
            self._profile.downloadRequested.disconnect(self._on_download_requested)
        try:
            self._view.close()
            self._view.deleteLater()
        except Exception:  # noqa: BLE001
            pass
        self.finished.emit(path or "")
