"""Additional backend message catalog (non-worker).

Holds the bulk of user-facing strings emitted outside the collection
workers: web-bridge error responses, action-controller errors and export
progress, exported file content (markdown/HTML), repository-side dashboard
labels, and service-layer errors.

Kept separate from :mod:`copilot_watchtower.i18n.messages` (core) and
:mod:`copilot_watchtower.i18n.messages_workers` so these can be maintained
independently. ``messages.py`` merges this dict in.

Format: ``key -> {language_code: template}`` using ``str.format`` placeholders.
``ko_KR`` is the source language and the fallback.
"""
from __future__ import annotations

EXTRA_MESSAGES: dict[str, dict[str, str]] = {
    # ---- Web bridge responses (webshell/bridge.py, webshell/actions.py) ----
    "bridge.testEvent": {
        "ko_KR": "⛯ test event 수신 확인",
        "en_US": "⛯ test event received",
    },
    "bridge.updateCheckError": {
        "ko_KR": "업데이트 확인 중 오류가 발생했습니다: {error}",
        "en_US": "An error occurred while checking for updates: {error}",
    },
    "bridge.urlNotAllowed": {
        "ko_KR": "허용되지 않은 URL입니다.",
        "en_US": "This URL is not allowed.",
    },
    "bridge.invalidRequestFormat": {
        "ko_KR": "잘못된 요청 형식입니다.",
        "en_US": "Invalid request format.",
    },
    "bridge.manualBrowserDownloadUnsupported": {
        "ko_KR": "수동 브라우저 다운로드는 지원하지 않습니다. 자동 백엔드 다운로드만 시도합니다.",
        "en_US": "Manual browser download isn't supported; only automatic backend download is attempted.",
    },
    "bridge.manualZipImportUnsupported": {
        "ko_KR": "수동 ZIP 가져오기는 지원하지 않습니다. 자동 백엔드 다운로드만 시도합니다.",
        "en_US": "Manual ZIP import isn't supported; only automatic backend download is attempted.",
    },
    "bridge.invalidJsonInput": {
        "ko_KR": "잘못된 JSON 입력",
        "en_US": "Invalid JSON input",
    },
    "bridge.payloadMustBeObject": {
        "ko_KR": "payload는 객체여야 합니다.",
        "en_US": "payload must be an object.",
    },
    # ---- Native file dialogs (webshell/bridge.py) ----
    "dialog.selectBackupFile": {
        "ko_KR": "백업 파일 선택",
        "en_US": "Select backup file",
    },
    "dialog.backupFileFilter": {
        "ko_KR": "CopilotWatchTower 백업 (*{suffix});;모든 파일 (*.*)",
        "en_US": "CopilotWatchTower backup (*{suffix});;All files (*.*)",
    },
    # ---- Action-controller error responses (webshell/actions.py) ----
    "error.stopRequestFailed": {
        "ko_KR": "중단 요청 중 오류가 발생했습니다.",
        "en_US": "An error occurred while requesting a stop.",
    },
    "error.enterTargetUpn": {
        "ko_KR": "대상 사용자(UPN)를 입력하세요.",
        "en_US": "Please enter a target user (UPN).",
    },
    "error.alreadyRunningNamed": {
        "ko_KR": "이미 진행 중입니다: {label}",
        "en_US": "Already running: {label}",
    },
    "error.jobNotFound": {
        "ko_KR": "작업을 찾을 수 없습니다.",
        "en_US": "Job not found.",
    },
    "error.noDownloadLink": {
        "ko_KR": "다운로드 링크가 아직 없습니다.",
        "en_US": "There's no download link yet.",
    },
    "error.selectFileToImport": {
        "ko_KR": "가져올 파일을 선택하세요.",
        "en_US": "Please select a file to import.",
    },
    "error.cannotReadProfileSettings": {
        "ko_KR": "프로필 설정을 읽을 수 없습니다: {error}",
        "en_US": "Can't read the profile settings: {error}",
    },
    "error.appDeleteAuthExpired": {
        "ko_KR": (
            "Entra 앱을 삭제할 관리자 로그인 캐시가 만료되었습니다. "
            "해당 프로필로 전환한 뒤 권한 재등록 또는 완전 초기화를 먼저 실행하세요."
        ),
        "en_US": (
            "The admin sign-in cache needed to delete the Entra app has expired. "
            "Switch to that profile, then re-grant permissions or run a full reset first."
        ),
    },
    "error.appDeleteAuthFailed": {
        "ko_KR": "Entra 앱 삭제 인증 실패: {error}",
        "en_US": "Entra app deletion authentication failed: {error}",
    },
    "error.appDeleteFailed": {
        "ko_KR": "Entra 앱 삭제 실패: {error}",
        "en_US": "Entra app deletion failed: {error}",
    },
    "error.unknownDialog": {
        "ko_KR": "알 수 없는 다이얼로그: {kind}",
        "en_US": "Unknown dialog: {kind}",
    },
    "error.noActiveProfile": {
        "ko_KR": "활성 프로필이 없어 작업을 수행할 수 없습니다.",
        "en_US": "There's no active profile, so the operation can't be performed.",
    },
    "error.maintenanceAlreadyRunning": {
        "ko_KR": "이미 진행 중인 작업이 있습니다.",
        "en_US": "A task is already running.",
    },
    "error.selectBackupFileToImport": {
        "ko_KR": "가져올 백업 파일을 선택하세요.",
        "en_US": "Please select a backup file to import.",
    },
    "error.backupFileNotFound": {
        "ko_KR": "백업 파일을 찾을 수 없습니다.",
        "en_US": "Backup file not found.",
    },
    "error.unsupportedFormat": {
        "ko_KR": "지원하지 않는 형식입니다: {fmt}",
        "en_US": "Unsupported format: {fmt}",
    },
    "error.selectThread": {
        "ko_KR": "스레드를 선택하세요.",
        "en_US": "Please select a thread.",
    },
    "error.threadNotFound": {
        "ko_KR": "스레드를 찾을 수 없습니다.",
        "en_US": "Thread not found.",
    },
    "error.cannotReadBackupFile": {
        "ko_KR": "백업 파일을 읽을 수 없습니다: {error}",
        "en_US": "Can't read the backup file: {error}",
    },
    "error.unknownError": {
        "ko_KR": "알 수 없는 오류",
        "en_US": "Unknown error",
    },
    # ---- Export progress callbacks (webshell/actions.py) ----
    "export.preparing": {
        "ko_KR": "내보내기 준비 중",
        "en_US": "Preparing export",
    },
    "export.done": {
        "ko_KR": "완료",
        "en_US": "Done",
    },
    # ---- Auto-backup event-log lines (webshell/actions.py) ----
    "backup.autoSkippedInProgress": {
        "ko_KR": "자동 백업 건너뜀: 이미 백업 작업이 진행 중입니다.",
        "en_US": "Auto-backup skipped: a backup task is already running.",
    },
    "backup.autoStartFailed": {
        "ko_KR": "자동 백업 시작 실패: {error}",
        "en_US": "Failed to start auto-backup: {error}",
    },
    "backup.autoStartOverwrite": {
        "ko_KR": "자동 백업 시작: 기존 자동 백업 파일 덮어쓰기",
        "en_US": "Starting auto-backup: overwriting the existing auto-backup file",
    },
    "backup.autoStartNew": {
        "ko_KR": "자동 백업 시작: 새 백업 파일 생성",
        "en_US": "Starting auto-backup: creating a new backup file",
    },
    # ---- Collection-kind labels used as suffixes (webshell/actions.py) ----
    "label.consumptionCollection": {
        "ko_KR": "소비량 수집",
        "en_US": "consumption collection",
    },
    "label.transcriptCollection": {
        "ko_KR": "대화 기록 수집",
        "en_US": "transcript collection",
    },
}
