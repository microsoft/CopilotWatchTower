"""Embedded-browser dialog that downloads an eDiscovery export package.

The eDiscovery *direct download proxy* URL
(``*.proxyservice.ediscovery.svc.cloud.microsoft/.../exportaedblobFileResult(...)``)
is **browser-only**: it demands an interactive ``id_token`` sign-in, so an
app/bearer token 401s every time. Instead of asking the operator to download
the file in an external browser and re-import it, we host the URL inside a
:class:`QWebEngineView` with a *persistent* profile. The operator signs in
once (interactively); the proxy then streams the ZIP straight into a
:class:`QWebEngineDownloadRequest`, which we capture and expose via
:attr:`downloaded_path` for immediate import.
"""
from __future__ import annotations

import logging
from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtWebEngineCore import (
    QWebEngineDownloadRequest,
    QWebEnginePage,
    QWebEngineProfile,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

log = logging.getLogger(__name__)


class EdiscoveryDownloadDialog(QDialog):
    """Hosts the browser-only export URL and captures its download."""

    def __init__(
        self,
        url: str,
        *,
        storage_dir: Path | str,
        download_dir: Path | str,
        parent: QWidget | None = None,
        profile: QWebEngineProfile | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("eDiscovery 내보내기 다운로드")
        self.resize(1024, 760)

        self._download_dir = Path(download_dir)
        self._download_dir.mkdir(parents=True, exist_ok=True)
        Path(storage_dir).mkdir(parents=True, exist_ok=True)

        # Result surfaced to the caller once the download completes.
        self.downloaded_path: str | None = None
        self._download_started = False

        layout = QVBoxLayout(self)
        self._status = QLabel(
            "로그인이 필요하면 진행한 뒤, 내보내기 패키지가 자동으로 다운로드됩니다…"
        )
        self._status.setWordWrap(True)
        layout.addWidget(self._status)

        self._progress = QProgressBar(self)
        self._progress.setRange(0, 100)
        self._progress.setVisible(False)
        layout.addWidget(self._progress)

        if profile is None:
            # A *named* profile is persistent: cookies/storage survive across
            # runs, but Chromium only actually flushes them when the profile
            # is reused — and only with the persistence policies set
            # explicitly. The caller can also share the controller's
            # singleton profile via ``profile=`` to avoid two instances
            # racing on the same storage path.
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

        self._page = QWebEnginePage(self._profile, self)
        self.view = QWebEngineView(self)
        self.view.setPage(self._page)
        layout.addWidget(self.view, 1)

        button_row = QHBoxLayout()
        button_row.addStretch(1)
        self._cancel_btn = QPushButton("취소", self)
        self._cancel_btn.clicked.connect(self.reject)
        button_row.addWidget(self._cancel_btn)
        layout.addLayout(button_row)

        log.info(
            "Embedded eDiscovery download: navigating to export URL "
            "(profile storage=%s, owns_profile=%s)",
            storage_dir,
            self._owns_profile,
        )
        self.view.setUrl(QUrl(url))

    # ----------------------------------------------------------------

    def _on_download_requested(self, item: QWebEngineDownloadRequest) -> None:
        # Only one package per dialog; ignore stray secondary requests.
        if self._download_started:
            item.cancel()
            return
        self._download_started = True
        item.setDownloadDirectory(str(self._download_dir))

        self._progress.setVisible(True)
        self._status.setText("내보내기 패키지를 다운로드하는 중…")
        item.receivedBytesChanged.connect(lambda it=item: self._update_progress(it))
        item.isFinishedChanged.connect(lambda it=item: self._on_finished(it))
        item.accept()

    def _update_progress(self, item: QWebEngineDownloadRequest) -> None:
        total = item.totalBytes()
        received = item.receivedBytes()
        if total > 0:
            self._progress.setValue(int(received * 100 / total))
        else:
            # Unknown size — show indeterminate motion.
            self._progress.setRange(0, 0)

    def _on_finished(self, item: QWebEngineDownloadRequest) -> None:
        state = item.state()
        if state == QWebEngineDownloadRequest.DownloadState.DownloadCompleted:
            self.downloaded_path = str(
                Path(item.downloadDirectory()) / item.downloadFileName()
            )
            log.info("Embedded eDiscovery download completed: %s", self.downloaded_path)
            self._status.setText("다운로드 완료. 가져오기를 시작합니다…")
            self.accept()
        elif state in (
            QWebEngineDownloadRequest.DownloadState.DownloadCancelled,
            QWebEngineDownloadRequest.DownloadState.DownloadInterrupted,
        ):
            log.warning("Embedded eDiscovery download failed: state=%s", state)
            self._progress.setVisible(False)
            self._status.setText("다운로드에 실패했습니다. 다시 시도하거나 로그인을 확인하세요.")
            self._download_started = False
