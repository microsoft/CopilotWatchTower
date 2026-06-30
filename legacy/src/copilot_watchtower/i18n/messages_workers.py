"""Worker operational-log message catalog.

These are the live progress / log / error strings emitted by the collection
workers (``workers/collector.py`` and the audit, consumption, dataverse, and
eDiscovery collectors). They are streamed to the live log panel and persisted
into run-history logs, so they follow the active language like every other
backend string.

Kept separate from :mod:`copilot_watchtower.i18n.messages` so the (large,
mechanical) worker string set can be maintained without touching the core
catalog. ``messages.py`` merges this dict in.

Format: ``key -> {language_code: template}`` using ``str.format`` placeholders.
``ko_KR`` is the source language and the fallback.
"""
from __future__ import annotations

WORKER_MESSAGES: dict[str, dict[str, str]] = {
    # ---- Generic collector worker (workers/collector.py) ----
    "worker.collectionAborted": {
        "ko_KR": "수집 장애로 중단되었습니다: {error}",
        "en_US": "Collection aborted due to a failure: {error}",
    },
    "worker.started": {
        "ko_KR": "○ 수집 워커 시작 (run #{run_id}, trigger={trigger})",
        "en_US": "○ Collection worker started (run #{run_id}, trigger={trigger})",
    },
    "worker.preparing": {
        "ko_KR": "수집 준비 중...",
        "en_US": "Preparing collection...",
    },
    "worker.targetUsers": {
        "ko_KR": "• 수집 대상 사용자: {count}명",
        "en_US": "• Users to collect: {count}",
    },
    "worker.noTargetUsers": {
        "ko_KR": "  · 수집 대상 사용자가 없습니다 (scope/license 설정 확인)",
        "en_US": "  · No users to collect (check scope/license settings)",
    },
    "worker.stoppedByUser": {
        "ko_KR": "사용자 요청으로 수집을 중단했습니다.",
        "en_US": "Collection stopped at the user's request.",
    },
    "worker.userQuerying": {
        "ko_KR": "  · [{index}/{total}] {display} 조회 중...",
        "en_US": "  · [{index}/{total}] Querying {display}...",
    },
    "worker.userSyncStart": {
        "ko_KR": "• 사용자 동기화 시작 (scope mode={mode})",
        "en_US": "• User sync started (scope mode={mode})",
    },
    "worker.userSyncProgress": {
        "ko_KR": "사용자 동기화 (scope={mode})",
        "en_US": "User sync (scope={mode})",
    },
    "worker.userListFailed": {
        "ko_KR": "사용자 목록 조회 실패: {error}",
        "en_US": "Failed to query the user list: {error}",
    },
    "worker.inScopeTargets": {
        "ko_KR": "  · in-scope 대상: {count}명",
        "en_US": "  · In-scope targets: {count}",
    },
    "worker.usersDetailQuerying": {
        "ko_KR": "  · /users 상세 조회 중...",
        "en_US": "  · Querying /users details...",
    },
    "worker.usersQuerying": {
        "ko_KR": "/users 조회 중",
        "en_US": "Querying /users",
    },
    "worker.usersReceived": {
        "ko_KR": "    · /users 수신 {count}명 (in-scope {in_scope})",
        "en_US": "    · /users received: {count} (in-scope {in_scope})",
    },
    "worker.usersDetailFailed": {
        "ko_KR": "사용자 상세 조회 실패: {error}",
        "en_US": "Failed to query user details: {error}",
    },
    "worker.usersQueryDone": {
        "ko_KR": "  · /users 조회 완료: 전체 {total} 중 in-scope {in_scope}",
        "en_US": "  · /users query done: in-scope {in_scope} of {total} total",
    },
    "worker.copilotLicenseQuerying": {
        "ko_KR": "  · Copilot 라이선스 사용자 조회 중...",
        "en_US": "  · Querying Copilot-licensed users...",
    },
    "worker.copilotLicenseProgress": {
        "ko_KR": "Copilot 라이선스 조회",
        "en_US": "Querying Copilot licenses",
    },
    "worker.licensedUsers": {
        "ko_KR": "  · 라이선스 사용자: {count}명",
        "en_US": "  · Licensed users: {count}",
    },
    "worker.userSyncDone": {
        "ko_KR": "• 사용자 동기화 완료: in-scope {count}명 저장",
        "en_US": "• User sync done: stored {count} in-scope users",
    },
    "worker.userSyncDoneProgress": {
        "ko_KR": "사용자 동기화 완료",
        "en_US": "User sync done",
    },
    "worker.allActiveQuerying": {
        "ko_KR": "  · 전체 활성 사용자 조회 중 (/users)...",
        "en_US": "  · Querying all active users (/users)...",
    },
    "worker.licensedUsersShort": {
        "ko_KR": "  · 라이선스 사용자 {count}명",
        "en_US": "  · Licensed users: {count}",
    },
    "worker.groupMemberQuerying": {
        "ko_KR": "  · 그룹 멤버 조회 중 (groupId={group_id})...",
        "en_US": "  · Querying group members (groupId={group_id})...",
    },
    "worker.upnResolving": {
        "ko_KR": "  · UPN 해석: {upn}",
        "en_US": "  · Resolving UPN: {upn}",
    },
    "worker.userApiReturned": {
        "ko_KR": "  · {display}: API 반환 {fetched}건 (신규 {new}, 재확인 {rechecked}), 최신 원본 {latest}",
        "en_US": "  · {display}: API returned {fetched} items (new {new}, rechecked {rechecked}), latest source {latest}",
    },
    "worker.sinceWindow": {
        "ko_KR": "{since} 이후",
        "en_US": "since {since}",
    },
    "worker.fullBackfill": {
        "ko_KR": "전체 백필",
        "en_US": "full backfill",
    },
    "worker.userApiReturnedZero": {
        "ko_KR": "  · {display}: API 반환 0건 ({window})",
        "en_US": "  · {display}: API returned 0 items ({window})",
    },
    "worker.threadComputeFailed": {
        "ko_KR": "{user}: 스레드 계산 실패 - {error}",
        "en_US": "{user}: thread computation failed - {error}",
    },
    # ---- Shared across collectors (consumption/dataverse) ----
    "worker.stoppedByUserRequest": {
        "ko_KR": "○ 사용자 요청으로 중단되었습니다.",
        "en_US": "○ Stopped at the user's request.",
    },
    "worker.doneSaved": {
        "ko_KR": "완료: {count}건 저장",
        "en_US": "Done: stored {count} items",
    },
    "worker.errorLabel": {
        "ko_KR": "오류",
        "en_US": "error",
    },
    # ---- Audit collection (AuditCollectorWorker in collector.py) ----
    "worker.audit.collectionAborted": {
        "ko_KR": "{label} 수집 장애로 중단되었습니다: {error}",
        "en_US": "{label} collection aborted due to a failure: {error}",
    },
    "worker.audit.collectionFailed": {
        "ko_KR": "{label} 감사 수집 실패: {error}",
        "en_US": "{label} audit collection failed: {error}",
    },
    "worker.audit.outcomeError": {
        "ko_KR": "{label}: 오류 — {error}",
        "en_US": "{label}: error — {error}",
    },
    "worker.audit.outcomePending": {
        "ko_KR": "{label}: 비동기 쿼리 대기 중 (다음 사이클에서 재시도)",
        "en_US": "{label}: async query pending (will retry next cycle)",
    },
    "worker.audit.outcomeFetched": {
        "ko_KR": "{label}: {count}건 수집",
        "en_US": "{label}: collected {count} items",
    },
    "worker.audit.outcomeDetail": {
        "ko_KR": "  · {label} {detail}",
        "en_US": "  · {label} {detail}",
    },
    # ---- Admin diagnostics (collector.py) ----
    "worker.diag.stepStarted": {
        "ko_KR": "• {label} 조회 중… ({current}/{total})",
        "en_US": "• Querying {label}… ({current}/{total})",
    },
    "worker.diag.done": {
        "ko_KR": "완료",
        "en_US": "done",
    },
    "worker.diag.stepFinished": {
        "ko_KR": "  · {label}: {summary}",
        "en_US": "  · {label}: {summary}",
    },
    "worker.diag.persisting": {
        "ko_KR": "• 결과 저장 및 에이전트 사용량 재계산 중…",
        "en_US": "• Saving results and recomputing agent usage…",
    },
    "worker.diag.persistLabel": {
        "ko_KR": "관리 진단 저장",
        "en_US": "Saving management diagnostics",
    },
    "worker.diag.startTotal": {
        "ko_KR": "관리 진단 수집 시작 (총 4단계)",
        "en_US": "Started management diagnostics collection (4 steps total)",
    },
    "worker.diag.label": {
        "ko_KR": "관리 진단",
        "en_US": "Management diagnostics",
    },
    "worker.diag.delegatedExpired": {
        "ko_KR": "Copilot 카탈로그 동기화: 위임 로그인이 만료되었습니다.\n→ 설정 → 권한 재등록을 실행해 다시 로그인하세요.",
        "en_US": "Copilot catalog sync: the delegated sign-in has expired.\n→ Run Settings → Re-register permissions to sign in again.",
    },
    "worker.diag.failed": {
        "ko_KR": "Copilot 관리 진단 실패: {error}",
        "en_US": "Copilot management diagnostics failed: {error}",
    },
    "worker.diag.itemsUpdated": {
        "ko_KR": "Copilot 관리 진단: {count}개 항목 갱신",
        "en_US": "Copilot management diagnostics: updated {count} items",
    },
    "worker.diag.agentListKept": {
        "ko_KR": "  · 에이전트 목록: 모든 소스 실패 → 기존 {count}개 유지",
        "en_US": "  · Agent list: all sources failed → keeping existing {count}",
    },
    "worker.diag.agentListSaved": {
        "ko_KR": "  · 에이전트 목록: {count}개 저장",
        "en_US": "  · Agent list: stored {count}",
    },
    "worker.diag.noTenantSkip": {
        "ko_KR": "Copilot 패키지/Agent 카탈로그: 테넌트 ID가 없어 delegated sync를 건너뜁니다.",
        "en_US": "Copilot packages / agent catalog: no tenant ID, skipping delegated sync.",
    },
    # ---- Usage report snapshot (collector.py) ----
    "worker.usage.collectionFailed": {
        "ko_KR": "사용량 리포트 수집 실패 ({period}): {error}",
        "en_US": "Usage report collection failed ({period}): {error}",
    },
    "worker.usage.reportUpdated": {
        "ko_KR": "사용량 보고서 갱신: {total}행 ({detail}; snapshot={latest})",
        "en_US": "Usage report updated: {total} rows ({detail}; snapshot={latest})",
    },
    "worker.usage.reportNoRows": {
        "ko_KR": "사용량 보고서: 갱신된 행 없음 ({detail})",
        "en_US": "Usage report: no rows updated ({detail})",
    },
    "worker.usage.noPeriod": {
        "ko_KR": "period 없음",
        "en_US": "no period",
    },
    # ---- Management collection labels (collector.py) ----
    "worker.label.audit": {
        "ko_KR": "감사 이벤트",
        "en_US": "Audit events",
    },
    "worker.label.usage": {
        "ko_KR": "사용량 보고서",
        "en_US": "Usage reports",
    },
    "worker.label.diagnostics": {
        "ko_KR": "관리 진단/에이전트",
        "en_US": "Management diagnostics / agents",
    },
    # ---- Consumption collector (workers/consumption_collector.py) ----
    "worker.consumption.sourceCurrency": {
        "ko_KR": "통화 리포트",
        "en_US": "Currency report",
    },
    "worker.consumption.sourceStorage": {
        "ko_KR": "스토리지 용량",
        "en_US": "Storage capacity",
    },
    "worker.consumption.sourceMcsResource": {
        "ko_KR": "에이전트(리소스)별 메시지",
        "en_US": "Messages by agent (resource)",
    },
    "worker.consumption.sourceMcsEnvironment": {
        "ko_KR": "환경별 메시지",
        "en_US": "Messages by environment",
    },
    "worker.consumption.sourceMcsUser": {
        "ko_KR": "사용자별 메시지",
        "en_US": "Messages by user",
    },
    "worker.consumption.sourceCollecting": {
        "ko_KR": "{label} 수집 중…",
        "en_US": "Collecting {label}…",
    },
    "worker.consumption.sourceSaved": {
        "ko_KR": "⛁ {label}: {count}건 저장",
        "en_US": "⛁ {label}: stored {count} items",
    },
    "worker.consumption.sourceFailed": {
        "ko_KR": "⚠ {label} 수집 실패 ({status}){suffix}",
        "en_US": "⚠ {label} collection failed ({status}){suffix}",
    },
    "worker.consumption.fetchFailed": {
        "ko_KR": "소비량 데이터를 가져오지 못했습니다.",
        "en_US": "Could not fetch consumption data.",
    },
    "worker.consumption.browserLoginFailed": {
        "ko_KR": "소비량 수집 브라우저 로그인 실패: {error}",
        "en_US": "Consumption collection browser sign-in failed: {error}",
    },
    "worker.consumption.browserLoginRequired": {
        "ko_KR": "PPAC 브라우저 로그인이 필요합니다.",
        "en_US": "PPAC browser sign-in is required.",
    },
    "worker.consumption.aborted": {
        "ko_KR": "소비량 수집 중 오류가 발생했습니다: {error}",
        "en_US": "An error occurred during consumption collection: {error}",
    },
    "worker.consumption.failed": {
        "ko_KR": "소비량 수집 실패",
        "en_US": "Consumption collection failed",
    },
    "worker.consumption.noTenant": {
        "ko_KR": "소비량 수집: 테넌트 ID가 없어 라이선싱 API에 연결할 수 없습니다.",
        "en_US": "Consumption collection: no tenant ID, cannot connect to the licensing API.",
    },
    "worker.consumption.noBrowserAccount": {
        "ko_KR": "소비량 수집: PPAC 자동 로그인 계정이 저장되어 있지 않습니다. 설정에서 브라우저 로그인 계정을 등록하세요.",
        "en_US": "Consumption collection: no PPAC auto sign-in account is saved. Register a browser sign-in account in Settings.",
    },
    # ---- Dataverse collector (workers/dataverse_collector.py) ----
    "worker.dataverse.envListQuerying": {
        "ko_KR": "Dataverse 환경 목록 조회 중…",
        "en_US": "Querying the Dataverse environment list…",
    },
    "worker.dataverse.envConfirmedBap": {
        "ko_KR": "○ Dataverse 환경 {count}개를 확인했습니다 (BAP 환경 목록).",
        "en_US": "○ Confirmed {count} Dataverse environments (BAP environment list).",
    },
    "worker.dataverse.envConfirmedDiscovery": {
        "ko_KR": "○ Dataverse 환경 {count}개를 확인했습니다 (글로벌 디스커버리).",
        "en_US": "○ Confirmed {count} Dataverse environments (Global Discovery).",
    },
    "worker.dataverse.envConfirmedCaptured": {
        "ko_KR": "○ Dataverse 환경 {count}개를 확인했습니다 (캡처된 토큰 기준).",
        "en_US": "○ Confirmed {count} Dataverse environments (based on captured tokens).",
    },
    "worker.dataverse.envListFailed": {
        "ko_KR": "Dataverse 환경 목록 조회 실패: {error}",
        "en_US": "Failed to query the Dataverse environment list: {error}",
    },
    "worker.dataverse.envListFetchFailed": {
        "ko_KR": "환경 목록을 가져오지 못했습니다.",
        "en_US": "Could not fetch the environment list.",
    },
    "worker.dataverse.discoveryFallback": {
        "ko_KR": "○ 글로벌 디스커버리에 접근하지 못해 캡처한 환경 토큰으로 직접 수집합니다.",
        "en_US": "○ Could not reach Global Discovery; collecting directly with the captured environment tokens.",
    },
    "worker.dataverse.noEnvironments": {
        "ko_KR": "• 접근 가능한 Dataverse 환경이 없습니다.",
        "en_US": "• No accessible Dataverse environments.",
    },
    "worker.dataverse.noEnvToCollect": {
        "ko_KR": "수집할 환경이 없습니다.",
        "en_US": "No environments to collect.",
    },
    "worker.dataverse.captureLimitedHint": {
        "ko_KR": "  ↳ 글로벌 디스커버리와 BAP에 접근하지 못해 로그인 계정의 기본 환경만 보일 수 있습니다. 다른 환경의 대화까지 수집하려면 글로벌 디스커버리 접근 권한 또는 환경별 수집이 필요합니다.",
        "en_US": "  ↳ Could not reach Global Discovery or BAP, so only the sign-in account's default environment may be visible. To collect conversations from other environments, you need Global Discovery access or per-environment collection.",
    },
    "worker.dataverse.envCollecting": {
        "ko_KR": "{label} 대화 기록 수집 중…",
        "en_US": "Collecting conversation transcripts for {label}…",
    },
    "worker.dataverse.envTokenSkip": {
        "ko_KR": "• {label}: 환경 토큰을 발급받지 못해 건너뜁니다 (이 계정이 해당 환경의 메이커 권한이 없을 수 있습니다).",
        "en_US": "• {label}: skipping because no environment token was issued (this account may not have maker permissions for that environment).",
    },
    "worker.dataverse.permissionCheck": {
        "ko_KR": "  ↳ 권한 확인: https://make.powerapps.com/environments/{env_id}/home",
        "en_US": "  ↳ Check permissions: https://make.powerapps.com/environments/{env_id}/home",
    },
    "worker.dataverse.envFailed": {
        "ko_KR": "⚠ {label} 수집 실패 ({error})",
        "en_US": "⚠ {label} collection failed ({error})",
    },
    "worker.dataverse.noTranscripts": {
        "ko_KR": "• {label}: 최근 {days}일 안에 대화 기록(conversationtranscript)이 없습니다.",
        "en_US": "• {label}: no conversation transcripts (conversationtranscript) in the last {days} days.",
    },
    "worker.dataverse.detailCounts": {
        "ko_KR": "트랜스크립트 {records}건, 메시지 {activities}건",
        "en_US": "{records} transcripts, {activities} messages",
    },
    "worker.dataverse.detailSkippedNonTeams": {
        "ko_KR": ", Teams 외 채널 제외 {count}건",
        "en_US": ", {count} non-Teams channels excluded",
    },
    "worker.dataverse.detailSkippedEmpty": {
        "ko_KR": ", 본문 없는 메시지 {count}건",
        "en_US": ", {count} messages without body",
    },
    "worker.dataverse.noConvToSave": {
        "ko_KR": "• {label}: 저장할 대화가 없습니다 ({detail}).",
        "en_US": "• {label}: no conversations to store ({detail}).",
    },
    "worker.dataverse.contentShapeUnexpected": {
        "ko_KR": "  ↳ 트랜스크립트 content 구조가 예상과 다릅니다: {shape}",
        "en_US": "  ↳ Transcript content structure differs from expected: {shape}",
    },
    "worker.dataverse.teamsOnlyHint": {
        "ko_KR": "  ↳ Teams 전용 필터가 켜져 있습니다. 다른 채널 대화까지 보려면 'Teams 전용' 옵션을 끄세요.",
        "en_US": "  ↳ The Teams-only filter is on. To see conversations from other channels too, turn off the 'Teams only' option.",
    },
    "worker.dataverse.envSaved": {
        "ko_KR": "⛁ {label}: 상호작용 {written}건 신규 저장 (총 파싱 {parsed}건)",
        "en_US": "⛁ {label}: stored {written} new interactions (parsed {parsed} total)",
    },
    "worker.dataverse.convFetchFailed": {
        "ko_KR": "대화 기록을 가져오지 못했습니다.",
        "en_US": "Could not fetch conversation transcripts.",
    },
    "worker.dataverse.browserLoginFailed": {
        "ko_KR": "대화 기록 수집 브라우저 로그인 실패: {error}",
        "en_US": "Conversation transcript collection browser sign-in failed: {error}",
    },
    "worker.dataverse.makerLoginRequired": {
        "ko_KR": "메이커 포털 브라우저 로그인이 필요합니다.",
        "en_US": "Maker portal browser sign-in is required.",
    },
    "worker.dataverse.aborted": {
        "ko_KR": "대화 기록 수집 중 오류가 발생했습니다: {error}",
        "en_US": "An error occurred during conversation transcript collection: {error}",
    },
    "worker.dataverse.failed": {
        "ko_KR": "대화 기록 수집 실패",
        "en_US": "Conversation transcript collection failed",
    },
    "worker.dataverse.noBrowserAccount": {
        "ko_KR": "대화 기록 수집: 자동 로그인 계정이 저장되어 있지 않습니다. 설정에서 브라우저 로그인 계정을 등록하세요.",
        "en_US": "Conversation transcript collection: no auto sign-in account is saved. Register a browser sign-in account in Settings.",
    },
    "worker.dataverse.devEnvExcluded": {
        "ko_KR": "○ 개발자 환경 {count}개는 기록 데이터가 없어 수집 대상에서 제외했습니다.",
        "en_US": "○ Excluded {count} developer environments from collection because they have no transcript data.",
    },
    "worker.dataverse.bapEnvConfirmed": {
        "ko_KR": "○ BAP에서 환경 {count}개를 확인했습니다.",
        "en_US": "○ Confirmed {count} environments from BAP.",
    },
    # ---- eDiscovery collector (workers/ediscovery_collector.py) ----
    "worker.ediscovery.noBrowserAccount": {
        "ko_KR": "• headless 브라우저 자동 로그인 계정이 저장되어 있지 않습니다.",
        "en_US": "• No headless-browser auto sign-in account is saved.",
    },
    "worker.ediscovery.browserDownloadTry": {
        "ko_KR": "• headless 브라우저 자동 로그인으로 eDiscovery 패키지 다운로드를 시도합니다.",
        "en_US": "• Attempting eDiscovery package download via headless-browser auto sign-in.",
    },
    "worker.ediscovery.browserDownloadDone": {
        "ko_KR": "• headless 브라우저 다운로드 완료: {name}",
        "en_US": "• Headless-browser download done: {name}",
    },
    "worker.ediscovery.browserDownloadFailed": {
        "ko_KR": "• headless 브라우저 다운로드 실패: {error}",
        "en_US": "• Headless-browser download failed: {error}",
    },
    "worker.ediscovery.collectionStart": {
        "ko_KR": "○ eDiscovery 수집 시작: {target_upn}",
        "en_US": "○ eDiscovery collection started: {target_upn}",
    },
    "worker.ediscovery.resumeStage": {
        "ko_KR": "↻ 중단된 작업을 '{stage}' 단계부터 이어서 진행합니다.",
        "en_US": "↻ Resuming the stopped job from the '{stage}' stage.",
    },
    "worker.ediscovery.interactionsSaved": {
        "ko_KR": "• 상호작용 {added}건 신규 저장 (총 파싱 {total}건)",
        "en_US": "• Stored {added} new interactions (parsed {total} total)",
    },
    "worker.ediscovery.noParsedInteractions": {
        "ko_KR": "• 파싱된 상호작용이 없습니다.",
        "en_US": "• No parsed interactions.",
    },
    "worker.ediscovery.doneAdded": {
        "ko_KR": "완료: {count}건 추가",
        "en_US": "Done: added {count} items",
    },
    "worker.ediscovery.delegatedExpired": {
        "ko_KR": "eDiscovery 수집: 위임 로그인이 만료되었습니다.\n→ 설정 → 권한 재등록을 실행해 다시 로그인하세요.",
        "en_US": "eDiscovery collection: the delegated sign-in has expired.\n→ Run Settings → Re-register permissions to sign in again.",
    },
    "worker.ediscovery.delegatedExpiredShort": {
        "ko_KR": "위임 로그인 만료 — 권한 재등록 필요",
        "en_US": "Delegated sign-in expired — re-register permissions",
    },
    "worker.ediscovery.collectionFailed": {
        "ko_KR": "eDiscovery 수집 실패: {error}",
        "en_US": "eDiscovery collection failed: {error}",
    },
    "worker.ediscovery.collectionAborted": {
        "ko_KR": "eDiscovery 수집 장애로 중단되었습니다: {error}",
        "en_US": "eDiscovery collection aborted due to a failure: {error}",
    },
    "worker.ediscovery.importFileNotFound": {
        "ko_KR": "가져올 파일을 찾을 수 없습니다: {path}",
        "en_US": "Could not find the file to import: {path}",
    },
    "worker.ediscovery.importStart": {
        "ko_KR": "○ eDiscovery 가져오기 시작: {name}",
        "en_US": "○ eDiscovery import started: {name}",
    },
    "worker.ediscovery.importReading": {
        "ko_KR": "다운로드한 내보내기 파일을 읽는 중...",
        "en_US": "Reading the downloaded export file...",
    },
    "worker.ediscovery.fileLoaded": {
        "ko_KR": "파일 로드 완료 ({size}) · 패키지 해석을 시작합니다",
        "en_US": "File loaded ({size}) · starting package parsing",
    },
    "worker.ediscovery.importDoneAdded": {
        "ko_KR": "가져오기 완료: {count}건 추가",
        "en_US": "Import done: added {count} items",
    },
    "worker.ediscovery.importFailed": {
        "ko_KR": "eDiscovery 가져오기 실패: {error}",
        "en_US": "eDiscovery import failed: {error}",
    },
    "worker.ediscovery.importAborted": {
        "ko_KR": "eDiscovery 가져오기 장애로 중단되었습니다: {error}",
        "en_US": "eDiscovery import aborted due to a failure: {error}",
    },
    "worker.ediscovery.noTenant": {
        "ko_KR": "eDiscovery 수집: 테넌트 ID가 없어 delegated 로그인을 할 수 없습니다.",
        "en_US": "eDiscovery collection: no tenant ID, cannot perform delegated sign-in.",
    },
    "worker.ediscovery.authExpiredJobError": {
        "ko_KR": "위임 로그인 만료 — 설정 → 권한 재등록 필요",
        "en_US": "Delegated sign-in expired — Settings → Re-register permissions required",
    },
}
