"""Backend message catalog and process-wide active language.

The desktop app generates a number of user-facing strings on the Python
side — collection run-log lines and summaries, audit/diagnostics outcome
details, backup progress, and error messages returned over the web bridge.
Those strings need to follow the user's chosen language just like the React
UI does.

Rather than thread a ``language`` argument through every worker and service
signature, we keep a single *process-wide active language* (the app is a
single-user desktop tool). It is set at startup from the profile's persisted
setting and updated whenever the user changes the language in Settings. All
string generation goes through :func:`translate`, which renders against the
active language (or an explicit override).

Strings persisted to the database (run-log lines, diagnostic summaries) are
rendered at generation time and therefore reflect the language that was
active then — switching language affects new collections, not historical
rows. This matches the product's "frozen history" behavior.
"""
from __future__ import annotations

import threading

from ..config import DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, normalize_language
from .messages_credit import CREDIT_MESSAGES
from .messages_data import DATA_MESSAGES
from .messages_dialogs import DIALOG_MESSAGES
from .messages_dialogs_misc import DIALOG_MISC_MESSAGES
from .messages_extra import EXTRA_MESSAGES
from .messages_workers import WORKER_MESSAGES

# ``str`` assignment is atomic under the GIL, but a lock keeps set/get
# unambiguous and future-proofs against more complex state.
_lock = threading.Lock()
_active_language = DEFAULT_LANGUAGE


def set_active_language(language: str | None) -> None:
    """Set the process-wide active language (normalized to a supported code)."""
    global _active_language
    with _lock:
        _active_language = normalize_language(language)


def get_active_language() -> str:
    """Return the current process-wide active language code."""
    with _lock:
        return _active_language


# Message catalog: ``key -> {language_code: template}``. Templates use
# ``str.format`` placeholders. ``ko_KR`` is the source language and the
# fallback for any missing translation.
MESSAGES: dict[str, dict[str, str]] = {
    # ---- Audit collection outcomes (services/audit_query.py) ----
    "audit.purview403": {
        "ko_KR": "403 — 서비스 주체가 Purview 감사 로그 권한을 아직 갖고 있지 않음.",
        "en_US": "403 — the service principal does not yet have Purview audit-log permissions.",
    },
    "audit.purviewPermissionHint": {
        "ko_KR": (
            "Purview Unified Audit Log API에 액세스하려면 Microsoft Graph 애플리케이션 권한 "
            "AuditLogsQuery.Read.All과 Exchange/Purview roleManagement의 "
            "'View-Only Audit Logs' 역할 부여가 모두 필요합니다.\n"
            "권한 업데이트에서 관리자 동의를 다시 받은 뒤, 온보딩의 Purview 감사 역할 자동 부여를 "
            "다시 실행하세요. 이 역할 부여는 Microsoft Graph roleManagement/exchange API만 사용합니다."
        ),
        "en_US": (
            "Accessing the Purview Unified Audit Log API requires both the Microsoft Graph "
            "application permission AuditLogsQuery.Read.All and the 'View-Only Audit Logs' "
            "role in Exchange/Purview roleManagement.\n"
            "Re-grant admin consent under Permission update, then re-run the onboarding "
            "automatic Purview audit-role grant. That grant uses only the Microsoft Graph "
            "roleManagement/exchange APIs."
        ),
    },
    "audit.windowDetail": {
        "ko_KR": "범위: {start} ~ {end}",
        "en_US": "Range: {start} ~ {end}",
    },
    "audit.countItem": {
        "ko_KR": "{name} {count}건",
        "en_US": "{name} \u00d7{count}",
    },
    "audit.topOperations": {
        "ko_KR": "상위 작업",
        "en_US": "Top operations",
    },
    "audit.topApps": {
        "ko_KR": "상위 앱",
        "en_US": "Top apps",
    },
    "audit.queryId": {
        "ko_KR": "쿼리 ID: {query_id}",
        "en_US": "Query ID: {query_id}",
    },
    "audit.queryStatus": {
        "ko_KR": "쿼리 상태: {status}",
        "en_US": "Query status: {status}",
    },
    "audit.operationFilter": {
        "ko_KR": "작업 필터: {operations}",
        "en_US": "Operation filter: {operations}",
    },
    "audit.affectedUsers": {
        "ko_KR": "영향 사용자: {count}명",
        "en_US": "Affected users: {count}",
    },
    "audit.filteredNoise": {
        "ko_KR": "디렉터리 동기화 노이즈 제외: {count}건",
        "en_US": "Filtered directory-sync noise: {count}",
    },
    # ---- Admin diagnostics summaries (services/admin_diagnostics.py) ----
    "diag.label.limitedMode": {
        "ko_KR": "Copilot 제한 모드",
        "en_US": "Copilot limited mode",
    },
    "diag.label.policySettings": {
        "ko_KR": "Copilot 정책 설정",
        "en_US": "Copilot policy settings",
    },
    "diag.label.catalog": {
        "ko_KR": "Copilot 패키지/Agent 카탈로그",
        "en_US": "Copilot packages / agent catalog",
    },
    "diag.label.agentRegistrations": {
        "ko_KR": "Copilot Agent 등록",
        "en_US": "Copilot agent registrations",
    },
    "diag.persistStep": {
        "ko_KR": "진단 결과 저장",
        "en_US": "Saving diagnostic results",
    },
    "diag.unit.policy": {
        "ko_KR": "정책",
        "en_US": "Policies",
    },
    "diag.unit.package": {
        "ko_KR": "패키지",
        "en_US": "Packages",
    },
    "diag.unit.registration": {
        "ko_KR": "등록",
        "en_US": "Registrations",
    },
    "diag.delegatedExpired": {
        "ko_KR": "위임 로그인 만료 (설정 > 권한 재등록 필요)",
        "en_US": "Delegated sign-in expired (Settings > re-grant permissions)",
    },
    "diag.responseReceived": {
        "ko_KR": "응답 수신",
        "en_US": "Response received",
    },
    "diag.limitedModeOn": {
        "ko_KR": "그룹 제한 모드 사용 중 ({group})",
        "en_US": "Group limited mode on ({group})",
    },
    "diag.groupUnknown": {
        "ko_KR": "group 미상",
        "en_US": "group unknown",
    },
    "diag.limitedModeOff": {
        "ko_KR": "그룹 제한 모드 꺼짐",
        "en_US": "Group limited mode off",
    },
    "diag.limitedModeResponse": {
        "ko_KR": "제한 모드 설정 응답 수신",
        "en_US": "Limited-mode settings response received",
    },
    "diag.collectionCount": {
        "ko_KR": "{label} {count}건 조회",
        "en_US": "{label}: {count} retrieved",
    },
    "diag.collectionResponse": {
        "ko_KR": "{label} 응답 수신",
        "en_US": "{label} response received",
    },
    "diag.agent365": {
        "ko_KR": "Agent 365 라이선스 미보유 테넌트 (에이전트 카탈로그 사용 불가)",
        "en_US": "Tenant without an Agent 365 license (agent catalog unavailable)",
    },
    "diag.forbidden": {
        "ko_KR": "권한 또는 관리자 정책으로 접근 거부 (동의 대기 가능)",
        "en_US": "Access denied by permissions or admin policy (consent may be pending)",
    },
    "diag.notFound": {
        "ko_KR": "API 미배포 또는 리소스 없음 (테넌트 미지원)",
        "en_US": "API not deployed or resource missing (tenant unsupported)",
    },
    "diag.callFailed": {
        "ko_KR": "진단 호출 실패",
        "en_US": "Diagnostic call failed",
    },
    "diag.unexpectedError": {
        "ko_KR": "진단 호출 중 오류",
        "en_US": "Error during diagnostic call",
    },
    "diag.unexpectedErrorDetail": {
        "ko_KR": "진단 호출 중 오류: {message}",
        "en_US": "Error during diagnostic call: {message}",
    },
    # ---- Run-log lines & summaries (webshell/actions.py) ----
    "runlog.cycleStarted": {
        "ko_KR": "\u25b6 수집 시작 ({trigger})",
        "en_US": "\u25b6 Collection started ({trigger})",
    },
    "runlog.cycleStartedNoTrigger": {
        "ko_KR": "\u25b6 수집 시작",
        "en_US": "\u25b6 Collection started",
    },
    "runlog.summaryConversation": {
        "ko_KR": "사용자 {users} · 대화 {interactions} · 오류 {errors}",
        "en_US": "Users {users} · Conversations {interactions} · Errors {errors}",
    },
    "runlog.summaryAudit": {
        "ko_KR": "이벤트 {events} · 사용량 {usage} · 진단 {diagnostics} · 오류 {errors}",
        "en_US": "Events {events} · Usage {usage} · Diagnostics {diagnostics} · Errors {errors}",
    },
    "runlog.summaryRows": {
        "ko_KR": "추가 {rows} · 오류 {errors}",
        "en_US": "Added {rows} · Errors {errors}",
    },
    "runlog.summaryErrors": {
        "ko_KR": "오류 {errors}",
        "en_US": "Errors {errors}",
    },
    # ---- Bridge error messages (webshell/actions.py) ----
    "error.alreadyRunning": {
        "ko_KR": "이미 진행 중입니다: {kind}",
        "en_US": "Already running: {kind}",
    },
    "error.noTokenProvider": {
        "ko_KR": "앱 등록이 완료되지 않아 토큰을 만들 수 없습니다.",
        "en_US": "Can't create a token because app registration isn't complete.",
    },
    "error.licenseRequired": {
        "ko_KR": "현재 라이선스 구성에서는 사용할 수 없는 수집입니다. 설정에서 라이선스 구성을 확인하세요. (필요: {capability})",
        "en_US": "This collection isn't available for the current license configuration. Check the license configuration in Settings. (requires: {capability})",
    },
    "error.noRunningJob": {
        "ko_KR": "실행 중인 작업이 없습니다: {kind}",
        "en_US": "No running job: {kind}",
    },
    "error.pollIntervalMin": {
        "ko_KR": "poll_interval_minutes는 1 이상이어야 합니다.",
        "en_US": "poll_interval_minutes must be at least 1.",
    },
    "error.pollIntervalInt": {
        "ko_KR": "poll_interval_minutes는 정수여야 합니다.",
        "en_US": "poll_interval_minutes must be an integer.",
    },
    "error.scopeUpnsList": {
        "ko_KR": "scope_upns는 문자열 리스트여야 합니다.",
        "en_US": "scope_upns must be a list of strings.",
    },
    "error.autoBackupMode": {
        "ko_KR": "auto_backup_mode는 new 또는 overwrite 여야 합니다.",
        "en_US": "auto_backup_mode must be new or overwrite.",
    },
    "error.registryNotConnected": {
        "ko_KR": "프로필 레지스트리가 연결되지 않았습니다.",
        "en_US": "Profile registry is not connected.",
    },
    "error.unknownProfileId": {
        "ko_KR": "알 수 없는 프로필 ID 입니다.",
        "en_US": "Unknown profile ID.",
    },
    "error.cannotDeleteCurrentProfile": {
        "ko_KR": "현재 사용 중인 프로필은 삭제할 수 없습니다.",
        "en_US": "You can't delete the profile that's currently in use.",
    },
    "profile.newTenantDefault": {
        "ko_KR": "새 테넌트",
        "en_US": "New tenant",
    },
    # ---- Backup / restore (export/backup.py) ----
    "backup.progressBackup": {
        "ko_KR": "백업 중: {table}",
        "en_US": "Backing up: {table}",
    },
    "backup.progressRestore": {
        "ko_KR": "복원 중: {table}",
        "en_US": "Restoring: {table}",
    },
    "backup.recomputeThreads": {
        "ko_KR": "스레드 재계산 중",
        "en_US": "Recomputing threads",
    },
    "backup.invalidFormat": {
        "ko_KR": "백업 파일 형식이 올바르지 않습니다.",
        "en_US": "The backup file format is invalid.",
    },
    "backup.versionTooNew": {
        "ko_KR": "이 백업은 더 최신 버전에서 생성되어 복원할 수 없습니다. 최신 버전으로 업데이트하세요.",
        "en_US": "This backup was created by a newer version and can't be restored. Please update to the latest version.",
    },
    # ---- Wipe profile data (webshell/actions.py) ----
    "wipe.inProgress": {
        "ko_KR": "데이터 삭제 중…",
        "en_US": "Deleting data…",
    },
    "wipe.done": {
        "ko_KR": "데이터 삭제 완료",
        "en_US": "Data deleted",
    },
    # ---- Display labels (app_labels.py, db/repository.py) ----
    "label.copilotStudioWeb": {
        "ko_KR": "Copilot Studio (웹)",
        "en_US": "Copilot Studio (web)",
    },
    "label.environmentUnit": {
        "ko_KR": "(환경 단위)",
        "en_US": "(environment-level)",
    },
}

# Worker operational-log strings and additional non-core strings live in
# separate modules so they can be maintained independently. Core keys win on
# any accidental collision.
for _extra in (
    WORKER_MESSAGES,
    EXTRA_MESSAGES,
    DATA_MESSAGES,
    DIALOG_MESSAGES,
    DIALOG_MISC_MESSAGES,
    CREDIT_MESSAGES,
):
    for _key, _langs in _extra.items():
        MESSAGES.setdefault(_key, _langs)


def translate(key: str, language: str | None = None, /, **params: object) -> str:
    """Render the catalog entry ``key`` in the active (or given) language.

    Falls back to Korean (the source language) when a translation is missing,
    and returns the raw key if the entry is unknown. ``params`` are applied
    via :meth:`str.format`.
    """
    lang = normalize_language(language) if language else get_active_language()
    entry = MESSAGES.get(key)
    if entry is None:
        return key
    template = entry.get(lang) or entry.get(DEFAULT_LANGUAGE) or key
    if params:
        try:
            return template.format(**params)
        except (KeyError, IndexError):
            return template
    return template


__all__ = [
    "SUPPORTED_LANGUAGES",
    "set_active_language",
    "get_active_language",
    "translate",
    "MESSAGES",
]
