"""Data/service-layer message catalog.

Holds user-facing strings emitted by the export renderers (markdown/HTML
thread exports), repository-side dashboard labels, and service-layer
errors/logs (auth, dataverse, consumption browser sign-in).

Kept separate from the other catalog modules so it can be maintained
independently; ``messages.py`` merges this dict in.

Format: ``key -> {language_code: template}`` using ``str.format`` placeholders.
``ko_KR`` is the source language and the fallback.
"""
from __future__ import annotations

DATA_MESSAGES: dict[str, dict[str, str]] = {
    # ---- Thread exports (export/markdown.py, export/service.py) ----
    "export.untitled": {
        "ko_KR": "(제목 없음)",
        "en_US": "(Untitled)",
    },
    "export.user": {
        "ko_KR": "사용자",
        "en_US": "User",
    },
    "export.app": {
        "ko_KR": "앱",
        "en_US": "App",
    },
    "export.period": {
        "ko_KR": "기간 (KST)",
        "en_US": "Period (KST)",
    },
    "export.turns": {
        "ko_KR": "턴: {turns} (질문 {prompts} / 응답 {responses})",
        "en_US": "Turns: {turns} ({prompts} prompts / {responses} responses)",
    },
    "export.turnUser": {
        "ko_KR": "사용자",
        "en_US": "User",
    },
    "export.copilotResponseHeading": {
        "ko_KR": "Copilot 응답",
        "en_US": "Copilot response",
    },
    # ---- Insight / enablement opportunities (db/repository.py) ----
    "insight.licensedInactive": {
        "ko_KR": "라이선스 보유 미활성 사용자",
        "en_US": "Licensed but inactive users",
    },
    "insight.licensedInactiveDesc": {
        "ko_KR": "라이선스는 있지만 수집된 대화가 없는 사용자입니다.",
        "en_US": "Users who hold a license but have no collected conversations.",
    },
    "insight.singleAppPowerUsers": {
        "ko_KR": "단일 앱 집중 사용자",
        "en_US": "Single-app-focused users",
    },
    "insight.singleAppPowerUsersDesc": {
        "ko_KR": "사용량은 있으나 한 앱에 치우쳐 있어 활용 확장 교육 후보입니다.",
        "en_US": "They have usage but are concentrated on a single app, making them candidates for adoption-expansion training.",
    },
    "insight.lowFollowUp": {
        "ko_KR": "후속 질문 비율 낮음",
        "en_US": "Low follow-up question rate",
    },
    "insight.lowFollowUpDesc": {
        "ko_KR": "단발성 사용이 많아 질문 정교화/반복 활용 교육이 필요할 수 있습니다.",
        "en_US": "Usage is mostly one-off; training on refining prompts and repeated use may be needed.",
    },
    "insight.searchHeavy": {
        "ko_KR": "질문/찾기 편중",
        "en_US": "Skewed toward search/lookup",
    },
    "insight.searchHeavyDesc": {
        "ko_KR": "검색형 사용이 높아 초안 작성, 요약, 분석 시나리오 확장 여지가 있습니다.",
        "en_US": "Search-style usage is high, so there is room to expand into drafting, summarization, and analysis scenarios.",
    },
    "insight.riskReview": {
        "ko_KR": "보안/민감 자료 검토",
        "en_US": "Security / sensitive-data review",
    },
    "insight.riskReviewDesc": {
        "ko_KR": "차단/거부 이벤트 또는 민감 label이 포함된 grounding 참조가 있습니다.",
        "en_US": "There are blocked/denied events or grounding references containing sensitive labels.",
    },
    "insight.healthyBaseline": {
        "ko_KR": "즉시 조치 항목 없음",
        "en_US": "No immediate action items",
    },
    "insight.healthyBaselineDesc": {
        "ko_KR": "현재 수집 범위에서는 뚜렷한 운영 조치 후보가 없습니다.",
        "en_US": "Within the current collection scope, there are no clear operational-action candidates.",
    },
    # ---- Delegated auth (services/auth.py) ----
    "auth.delegatedExpired": {
        "ko_KR": "위임 로그인 토큰이 만료되었거나 캐시에 없습니다. 설정 → 권한 재등록을 실행해 다시 로그인하세요.",
        "en_US": "The delegated sign-in token has expired or is not in the cache. Go to Settings → re-grant permissions and sign in again.",
    },
    # ---- Dataverse service (services/dataverse.py) ----
    "dataverse.bapNotJson": {
        "ko_KR": "BAP 환경 목록 응답이 JSON이 아닙니다. 토큰/권한을 확인하세요.",
        "en_US": "The BAP environment list response is not JSON. Check the token/permissions.",
    },
    "dataverse.shapeEmptyString": {
        "ko_KR": "빈 문자열",
        "en_US": "empty string",
    },
    "dataverse.shapeNonJsonString": {
        "ko_KR": "비 JSON 문자열(앞부분: {prefix})",
        "en_US": "non-JSON string (prefix: {prefix})",
    },
    "dataverse.shapeNoKeys": {
        "ko_KR": "(키 없음)",
        "en_US": "(no keys)",
    },
    "dataverse.shapeDict": {
        "ko_KR": "dict(키: {keys})",
        "en_US": "dict (keys: {keys})",
    },
    "dataverse.shapeList": {
        "ko_KR": "list(길이 {length})",
        "en_US": "list (length {length})",
    },
    "dataverse.shapeNone": {
        "ko_KR": "없음(None)",
        "en_US": "None",
    },
    "dataverse.unknownUser": {
        "ko_KR": "알 수 없는 사용자",
        "en_US": "Unknown user",
    },
    "dataverse.attributionDone": {
        "ko_KR": "Dataverse 귀속 보정 완료: 상호작용 {interactions}건, 사용자 {users}명 갱신",
        "en_US": "Dataverse attribution correction complete: updated {interactions} interactions and {users} users.",
    },
    "dataverse.unexpectedNonJson": {
        "ko_KR": "예상치 못한 응답(비 JSON)입니다. Dataverse 토큰/권한을 확인하세요.",
        "en_US": "Unexpected response (non-JSON). Check the Dataverse token/permissions.",
    },
    # ---- Consumption browser sign-in (services/consumption_browser_download.py) ----
    "consumption.playwrightMissing": {
        "ko_KR": "playwright가 설치되어 있지 않습니다. `pip install playwright` 및 `python -m playwright install chromium`을 실행하세요.",
        "en_US": "playwright is not installed. Run `pip install playwright` and `python -m playwright install chromium`.",
    },
    "consumption.noCredentials": {
        "ko_KR": "headless 브라우저 로그인 계정/비밀번호가 없습니다.",
        "en_US": "No account/password for headless browser sign-in.",
    },
    "consumption.tryAutoLogin": {
        "ko_KR": "• PPAC 자동 로그인으로 소비량 리포트 접근을 시도합니다.",
        "en_US": "• Attempting to access the consumption report via PPAC automatic sign-in.",
    },
    "consumption.licensingEndpoints": {
        "ko_KR": "• PPAC가 호출한 라이선싱 엔드포인트 {count}개:",
        "en_US": "• {count} licensing endpoints called by PPAC:",
    },
    "consumption.licensingResponsesSaved": {
        "ko_KR": "• 라이선싱 응답 {count}건을 디버그 파일에 저장했습니다: {path}",
        "en_US": "• Saved {count} licensing responses to the debug file: {path}",
    },
    "consumption.tokenFromSession": {
        "ko_KR": "• PPAC 세션에서 라이선싱 토큰을 확보했습니다.",
        "en_US": "• Obtained the licensing token from the PPAC session.",
    },
    "consumption.tokenFromCache": {
        "ko_KR": "• PPAC 토큰 캐시에서 라이선싱 토큰을 확보했습니다.",
        "en_US": "• Obtained the licensing token from the PPAC token cache.",
    },
    "consumption.tokenNotFound": {
        "ko_KR": "PPAC 세션에서 라이선싱 토큰을 찾지 못했습니다. 저장된 계정이 Power Platform/전역 관리자 권한을 가지고 있는지 확인하세요.",
        "en_US": "Could not find a licensing token in the PPAC session. Check that the saved account has Power Platform / Global Administrator permissions.",
    },
    "consumption.signInIncomplete": {
        "ko_KR": "PPAC 자동 로그인을 완료하지 못했습니다(로그인 페이지에 머물러 있음). 저장된 계정의 비밀번호가 정확한지, 다단계 인증(MFA)이 요구되지 않는지 확인하세요. MFA가 필요한 계정은 헤드리스 자동 로그인을 사용할 수 없습니다.",
        "en_US": "Couldn't complete the headless PPAC sign-in (still on the sign-in page). Check the saved account's password and whether multi-factor auth (MFA) is required — MFA accounts can't use headless auto sign-in.",
    },
    # ---- Short duration / ETA fragments (services/ediscovery.py) ----
    "duration.seconds": {
        "ko_KR": "{secs}초",
        "en_US": "{secs}s",
    },
    "duration.minutesSeconds": {
        "ko_KR": "{minutes}분 {secs}초",
        "en_US": "{minutes}m {secs}s",
    },
    "duration.hoursMinutes": {
        "ko_KR": "{hours}시간 {minutes}분",
        "en_US": "{hours}h {minutes}m",
    },
    # ---- eDiscovery pipeline progress/errors (services/ediscovery.py) ----
    "ediscovery.downloadProgress": {
        "ko_KR": "다운로드 {done} / {total} ({pct}%)",
        "en_US": "Download {done} / {total} ({pct}%)",
    },
    "ediscovery.downloadProgressNoTotal": {
        "ko_KR": "다운로드 {done}",
        "en_US": "Download {done}",
    },
    "ediscovery.eta": {
        "ko_KR": "남은 시간 {duration}",
        "en_US": "ETA {duration}",
    },
    "ediscovery.phaseEstimate": {
        "ko_KR": "추정",
        "en_US": "Estimate",
    },
    "ediscovery.phaseExport": {
        "ko_KR": "내보내기",
        "en_US": "Export",
    },
    "ediscovery.pollRunning": {
        "ko_KR": "{label} 진행 중 · 경과 {elapsed} (서버 상태={status}, {attempt}회 확인)",
        "en_US": "{label} in progress · elapsed {elapsed} (server status={status}, checked {attempt}×)",
    },
    "ediscovery.pollDone": {
        "ko_KR": "{label} 완료 · 경과 {elapsed}",
        "en_US": "{label} complete · elapsed {elapsed}",
    },
    "ediscovery.reselectItemsPackage": {
        "ko_KR": "저장된 다운로드 URL이 Reports 메타 ZIP이라 operation metadata에서 Items 패키지를 다시 선택합니다",
        "en_US": "The saved download URL is the Reports meta ZIP, so re-selecting the Items package from the operation metadata",
    },
    "ediscovery.downloadStart": {
        "ko_KR": "내보내기 패키지 다운로드를 시작합니다",
        "en_US": "Starting the export package download",
    },
    "ediscovery.directProxyFailed": {
        "ko_KR": "Direct Download Proxy 자동 브라우저 다운로드가 실패했습니다.",
        "en_US": "The Direct Download Proxy automatic browser download failed.",
    },
    "ediscovery.proxyInteractiveOnly": {
        "ko_KR": "내보내기는 완료됐지만 다운로드 프록시가 브라우저 대화형 id_token 세션만 허용합니다. 자동 브라우저 다운로드가 설정되지 않았거나 실패했습니다.",
        "en_US": "The export finished, but the download proxy only accepts an interactive browser id_token session. The automatic browser download is not configured or failed.",
    },
    "ediscovery.proxyBackendRejected": {
        "ko_KR": "내보내기는 완료됐지만 다운로드 링크가 브라우저 전용 프록시 링크입니다(Direct Download Proxy). 앱의 백엔드 토큰 후보가 모두 거부되었고 자동 브라우저 다운로드도 실패했습니다.",
        "en_US": "The export finished, but the download link is a browser-only proxy link (Direct Download Proxy). All of the app's backend token candidates were rejected and the automatic browser download also failed.",
    },
    "ediscovery.linkExpiredReexport": {
        "ko_KR": "내보내기 링크가 만료되어 다시 내보냅니다",
        "en_US": "The export link expired, so re-exporting",
    },
    "ediscovery.downloadDoneParsing": {
        "ko_KR": "다운로드 완료 ({size}) · 패키지 해석을 시작합니다",
        "en_US": "Download complete ({size}) · starting package parsing",
    },
    "ediscovery.proxyAutoLoginDirect": {
        "ko_KR": "다운로드 링크가 브라우저 전용 프록시라 headless 브라우저 자동 로그인으로 바로 진행합니다",
        "en_US": "The download link is a browser-only proxy, so proceeding directly with headless browser automatic sign-in",
    },
    "ediscovery.proxyAutoLoginRetry": {
        "ko_KR": "백엔드 토큰 다운로드가 거부되어 headless 브라우저 자동 로그인으로 다시 시도합니다",
        "en_US": "The backend token download was rejected, so retrying with headless browser automatic sign-in",
    },
    "ediscovery.browserAutoDownloadFailed": {
        "ko_KR": "headless 브라우저 자동 다운로드가 실패했습니다.",
        "en_US": "The headless browser automatic download failed.",
    },
    "ediscovery.browserDownloadDoneParsing": {
        "ko_KR": "브라우저 다운로드 완료 ({size}) · 패키지 해석을 시작합니다",
        "en_US": "Browser download complete ({size}) · starting package parsing",
    },
    "ediscovery.parseDone": {
        "ko_KR": "해석 완료 · {items}개 항목에서 상호작용 {rows}건을 추출했습니다",
        "en_US": "Parsing complete · extracted {rows} interactions from {items} items",
    },
    # ---- eDiscovery export package parsing (services/ediscovery_export.py) ----
    "ediscovery.packageEmpty": {
        "ko_KR": "내려받은 패키지가 비어 있습니다.",
        "en_US": "The downloaded package is empty.",
    },
    "ediscovery.parseSinglePayload": {
        "ko_KR": "ZIP이 아닌 단일 페이로드({size})를 해석합니다.",
        "en_US": "Parsing a single non-ZIP payload ({size}).",
    },
    "ediscovery.jsonPayloadRead": {
        "ko_KR": "JSON 페이로드에서 {count}개 항목을 읽었습니다.",
        "en_US": "Read {count} items from the JSON payload.",
    },
    "ediscovery.emlPayloadParsed": {
        "ko_KR": "EML 페이로드 1건을 해석했습니다.",
        "en_US": "Parsed 1 EML payload.",
    },
    "ediscovery.noParseableItems": {
        "ko_KR": "해석 가능한 항목이 없습니다.",
        "en_US": "No parseable items.",
    },
    "ediscovery.zipOpened": {
        "ko_KR": "ZIP 열기 완료 ({size}) · 항목 {total}개 압축 해제 시작",
        "en_US": "ZIP opened ({size}) · starting to extract {total} items",
    },
    "ediscovery.unzipFailed": {
        "ko_KR": "  ✗ 압축 해제 실패: {name}",
        "en_US": "  ✗ Extraction failed: {name}",
    },
    "ediscovery.zipEntryJson": {
        "ko_KR": "  [{idx}/{total}] JSON {name} → {count}개 항목 ({size})",
        "en_US": "  [{idx}/{total}] JSON {name} → {count} items ({size})",
    },
    "ediscovery.unzipDone": {
        "ko_KR": "압축 해제/해석 완료 · msg={msg} eml={eml} json={json} 건너뜀={skipped} 실패={failed} → 메시지 항목 {items}개",
        "en_US": "Unzip/parse complete · msg={msg} eml={eml} json={json} skipped={skipped} failed={failed} → {items} message items",
    },
    # ---- eDiscovery browser download (services/ediscovery_browser_download.py) ----
    "ediscovery.browserDownloadTimeout": {
        "ko_KR": "headless 브라우저 다운로드 이벤트가 시간 초과되었습니다.",
        "en_US": "The headless browser download event timed out.",
    },
    "ediscovery.browserDownloadFailed": {
        "ko_KR": "headless 브라우저 다운로드 실패: {error}",
        "en_US": "Headless browser download failed: {error}",
    },
    "ediscovery.browserHtmlResponse": {
        "ko_KR": "내보내기 다운로드가 실제 파일 대신 로그인(HTML) 페이지를 반환했습니다. eDiscovery 브라우저 세션 인증이 만료되었을 수 있습니다 — 설정에서 다시 로그인하세요.",
        "en_US": "The export download returned a sign-in (HTML) page instead of the export file. The eDiscovery browser session may have expired — re-authenticate in settings.",
    },
    "ediscovery.htmlPayloadRejected": {
        "ko_KR": "내보내기 응답이 로그인(HTML) 페이지로 보여 대화로 가져오지 않았습니다(세션 인증 필요).",
        "en_US": "The export response looks like a sign-in (HTML) page; skipped it instead of importing (re-authentication needed).",
    },
    # ---- Dataverse browser token capture (services/dataverse_browser_download.py) ----
    "dataverseDl.addSelfTrying": {
        "ko_KR": "  ↳ {label}: 관리 센터에서 나를 시스템 관리자로 추가 시도 중…",
        "en_US": "  ↳ {label}: trying to add myself as a system administrator in the admin center…",
    },
    "dataverseDl.adminCenterOpenFailed": {
        "ko_KR": "  • {label}: 관리 센터 페이지를 열지 못했습니다(건너뜁니다).",
        "en_US": "  • {label}: couldn't open the admin center page (skipping).",
    },
    "dataverseDl.addSelfButtonNotFound": {
        "ko_KR": "  • {label}: '나 추가' 버튼을 찾지 못했습니다. 관리 센터 화면이 바뀌었거나 권한이 없을 수 있습니다(건너뜁니다).",
        "en_US": "  • {label}: couldn't find the 'Add me' button. The admin center screen may have changed or you may not have permission (skipping).",
    },
    "dataverseDl.addSelfDone": {
        "ko_KR": "  ✓ {label}: 나를 시스템 관리자로 추가했습니다(권한 반영을 기다립니다).",
        "en_US": "  ✓ {label}: added myself as a system administrator (waiting for permissions to propagate).",
    },
    "dataverseDl.tokenNotFoundForHost": {
        "ko_KR": "'{host}' 호스트에 대한 Dataverse 토큰을 찾지 못했습니다.",
        "en_US": "Couldn't find a Dataverse token for the '{host}' host.",
    },
    "dataverseDl.tryAutoLogin": {
        "ko_KR": "• 메이커 포털 자동 로그인으로 Dataverse 접근을 시도합니다.",
        "en_US": "• Attempting to access Dataverse via Maker portal automatic sign-in.",
    },
    "dataverseDl.envEnumFailed": {
        "ko_KR": "• 환경 목록 열거에 실패했습니다: {error}",
        "en_US": "• Failed to enumerate the environment list: {error}",
    },
    "dataverseDl.mintingTokens": {
        "ko_KR": "• 환경 {count}개의 토큰을 발급받는 중입니다…",
        "en_US": "• Obtaining tokens for {count} environments…",
    },
    "dataverseDl.tokenObtained": {
        "ko_KR": "  ✓ {label} 토큰을 발급받았습니다.",
        "en_US": "  ✓ Obtained the {label} token.",
    },
    "dataverseDl.tokenObtainedAfterAdmin": {
        "ko_KR": "  ✓ {label} 토큰을 발급받았습니다(관리자 추가 후).",
        "en_US": "  ✓ Obtained the {label} token (after adding as administrator).",
    },
    "dataverseDl.tokenFailedSkip": {
        "ko_KR": "  • {label} 토큰을 발급받지 못했습니다(이 환경은 건너뜁니다). 대상 호스트: {host}",
        "en_US": "  • Couldn't obtain the {label} token (skipping this environment). Target host: {host}",
    },
    "dataverseDl.tokensSecured": {
        "ko_KR": "• Dataverse 토큰 {count}개를 확보했습니다: ",
        "en_US": "• Secured {count} Dataverse token(s): ",
    },
    "dataverseDl.noTokensFound": {
        "ko_KR": "Dataverse 토큰을 찾지 못했습니다. 저장된 계정이 하나 이상의 Power Platform 환경에 접근할 수 있는지 확인하세요.",
        "en_US": "Couldn't find any Dataverse tokens. Check that the saved account can access at least one Power Platform environment.",
    },
    "dataverseDl.signInIncomplete": {
        "ko_KR": "메이커 포털 자동 로그인을 완료하지 못했습니다(로그인 페이지에 머물러 있음). 저장된 계정의 비밀번호가 정확한지, 다단계 인증(MFA)이 요구되지 않는지 확인하세요. MFA가 필요한 계정은 헤드리스 자동 로그인을 사용할 수 없습니다.",
        "en_US": "Couldn't complete the headless maker-portal sign-in (still on the sign-in page). Check the saved account's password and whether multi-factor auth (MFA) is required — MFA accounts can't use headless auto sign-in.",
    },
    # ---- Admin-consent callback page (services/consent_server.py) ----
    "consent.htmlLang": {
        "ko_KR": "ko",
        "en_US": "en",
    },
    "consent.successHeading": {
        "ko_KR": "관리자 동의 완료",
        "en_US": "Admin consent complete",
    },
    "consent.successBody": {
        "ko_KR": "이 창은 닫아도 됩니다. CopilotWatchTower 창으로 돌아가세요.",
        "en_US": "You can close this window. Return to the CopilotWatchTower window.",
    },
    "consent.failureHeading": {
        "ko_KR": "관리자 동의 실패",
        "en_US": "Admin consent failed",
    },
    "consent.errorLabel": {
        "ko_KR": "오류:",
        "en_US": "Error:",
    },
    # ---- Graph eDiscovery errors (services/graph.py) ----
    "graph.ediscoveryForbidden": {
        "ko_KR": "eDiscovery 접근이 거부되었습니다(403). 로그인한 계정이 Microsoft Purview의 eDiscovery Manager/Administrator 역할 그룹 멤버인지, 그리고 테넌트에 eDiscovery(Premium) 기능이 있는지 확인하세요.",
        "en_US": "eDiscovery access was denied (403). Check that the signed-in account is a member of the eDiscovery Manager/Administrator role group in Microsoft Purview and that the tenant has the eDiscovery (Premium) capability.",
    },
    "graph.ediscoveryUnauthorized": {
        "ko_KR": "eDiscovery 인증에 실패했습니다(401). delegated 스코프 'eDiscovery.ReadWrite.All' 동의가 되었는지 확인하세요.",
        "en_US": "eDiscovery authentication failed (401). Check that the delegated scope 'eDiscovery.ReadWrite.All' has been consented.",
    },
    "graph.ediscoveryLoginRedirect": {
        "ko_KR": "eDiscovery 다운로드가 로그인 페이지로 리디렉션되었습니다. 위임 로그인이 만료되었을 수 있습니다 (호스트={host}, content-type={contentType}).",
        "en_US": "The eDiscovery download was redirected to the sign-in page. The delegated sign-in may have expired (host={host}, content-type={contentType}).",
    },
    # ---- Licensing API (services/licensing.py) ----
    "licensing.unexpectedNonJson": {
        "ko_KR": "예상치 못한 응답(비 JSON)입니다. 라이선싱 API 권한/토큰을 확인하세요.",
        "en_US": "Unexpected response (non-JSON). Check the licensing API permissions/token.",
    },
    # ---- Usage report privacy settings (services/report_settings.py) ----
    "reportSettings.alreadyVisible": {
        "ko_KR": "사용량 보고서가 이미 사용자 이름/UPN을 표시하도록 설정되어 있습니다.",
        "en_US": "The usage report is already configured to show user names/UPNs.",
    },
    "reportSettings.updated": {
        "ko_KR": "사용량 보고서 익명화 설정을 해제했습니다. 다음 수집부터 실제 사용자 정보가 표시됩니다.",
        "en_US": "Turned off usage report anonymization. Real user information will be shown starting from the next collection.",
    },
    "reportSettings.notConfirmed": {
        "ko_KR": "사용량 보고서 설정 변경을 요청했지만 결과를 확인하지 못했습니다. 잠시 후 다시 수집해 보세요.",
        "en_US": "Requested the usage report setting change but couldn't confirm the result. Try collecting again shortly.",
    },
    "reportSettings.graphError": {
        "ko_KR": "사용량 보고서 실명 표시 설정을 변경하지 못했습니다. ReportSettings.ReadWrite.All 권한과 적절한 관리자 역할이 필요합니다.\nGraph 응답: {detail}",
        "en_US": "Couldn't change the usage report real-name display setting. The ReportSettings.ReadWrite.All permission and an appropriate admin role are required.\nGraph response: {detail}",
    },
    "reportSettings.unexpectedError": {
        "ko_KR": "사용량 보고서 실명 표시 설정 중 예기치 못한 오류: {error}",
        "en_US": "Unexpected error while changing the usage report real-name display setting: {error}",
    },
    # ---- Update check (services/version_check.py) ----
    "versionCheck.networkError": {
        "ko_KR": "네트워크 오류로 최신 버전을 확인하지 못했습니다: {error}",
        "en_US": "Couldn't check the latest version due to a network error: {error}",
    },
    "versionCheck.noReleases": {
        "ko_KR": "아직 등록된 릴리스가 없습니다.",
        "en_US": "No releases have been published yet.",
    },
    "versionCheck.fetchFailed": {
        "ko_KR": "최신 버전 정보를 가져오지 못했습니다 (HTTP {status}).",
        "en_US": "Couldn't fetch the latest version information (HTTP {status}).",
    },
    "versionCheck.parseFailed": {
        "ko_KR": "릴리스 응답을 해석하지 못했습니다.",
        "en_US": "Couldn't parse the release response.",
    },
    # ---- Purview audit RBAC automation (services/purview_rbac.py) ----
    "purviewRbac.graphQueryForbidden": {
        "ko_KR": "Microsoft Graph 조회가 거부되었습니다 (status={status}).\n토큰에 RoleManagement.ReadWrite.Exchange 권한이 있는지, 관리자 동의가 완료됐는지 확인하세요.",
        "en_US": "The Microsoft Graph query was denied (status={status}).\nCheck that the token has the RoleManagement.ReadWrite.Exchange permission and that admin consent has been granted.",
    },
    "purviewRbac.graphQueryFailed": {
        "ko_KR": "Microsoft Graph 조회 실패 (status={status}).\n\n{detail}",
        "en_US": "Microsoft Graph query failed (status={status}).\n\n{detail}",
    },
    "purviewRbac.graphQueryNotJson": {
        "ko_KR": "Microsoft Graph 조회 응답이 JSON이 아닙니다.",
        "en_US": "The Microsoft Graph query response is not JSON.",
    },
    "purviewRbac.availableRoleDefs": {
        "ko_KR": "\n\nGraph에 보이는 audit/log 관련 roleDefinition: {available}",
        "en_US": "\n\nAudit/log-related roleDefinitions visible in Graph: {available}",
    },
    "purviewRbac.roleDefNotFound": {
        "ko_KR": "Microsoft Graph에서 감사 로그 읽기 roleDefinition을 찾을 수 없습니다.\n찾은 이름 후보: {expected}{availableLine}",
        "en_US": "Couldn't find an audit-log read roleDefinition in Microsoft Graph.\nName candidates searched: {expected}{availableLine}",
    },
    "purviewRbac.addedViaGraph": {
        "ko_KR": "서비스 주체를 '{name}' 역할에 추가했습니다 (Microsoft Graph).",
        "en_US": "Added the service principal to the '{name}' role (Microsoft Graph).",
    },
    "purviewRbac.alreadyInRole": {
        "ko_KR": "서비스 주체가 이미 '{name}' 역할에 부여되어 있습니다.",
        "en_US": "The service principal is already granted the '{name}' role.",
    },
    "purviewRbac.graphGrantForbidden": {
        "ko_KR": "Microsoft Graph 역할 부여가 거부되었습니다 (status={status}).\n토큰에 RoleManagement.ReadWrite.Exchange 권한이 있는지, 관리자 동의가 완료됐는지 확인하세요.",
        "en_US": "The Microsoft Graph role grant was denied (status={status}).\nCheck that the token has the RoleManagement.ReadWrite.Exchange permission and that admin consent has been granted.",
    },
    "purviewRbac.graphGrantFailed": {
        "ko_KR": "Microsoft Graph 역할 부여 실패 (status={status}).\n\n{detail}",
        "en_US": "Microsoft Graph role grant failed (status={status}).\n\n{detail}",
    },
    "purviewRbac.graphException": {
        "ko_KR": "Microsoft Graph 호출 중 예외가 발생했습니다: {error}",
        "en_US": "An exception occurred during the Microsoft Graph call: {error}",
    },
    "purviewRbac.graphUnreachable": {
        "ko_KR": "Microsoft Graph 엔드포인트에 도달할 수 없습니다.\n네트워크 연결과 프록시 설정을 확인한 뒤 다시 시도하세요.",
        "en_US": "The Microsoft Graph endpoint is unreachable.\nCheck your network connection and proxy settings, then try again.",
    },
    "purviewRbac.powershellMissing": {
        "ko_KR": "PowerShell이 설치되어 있지 않습니다. Windows PowerShell 5.1 또는 PowerShell 7 (pwsh)을 설치한 뒤 다시 시도하세요.",
        "en_US": "PowerShell is not installed. Install Windows PowerShell 5.1 or PowerShell 7 (pwsh), then try again.",
    },
    "purviewRbac.powershellTimeout": {
        "ko_KR": "PowerShell 명령 시간 초과 ({timeout}s)",
        "en_US": "PowerShell command timed out ({timeout}s)",
    },
    "purviewRbac.powershellRunFailed": {
        "ko_KR": "PowerShell 실행 실패: {error}",
        "en_US": "PowerShell execution failed: {error}",
    },
    "purviewRbac.addedViaPowershell": {
        "ko_KR": "서비스 주체를 '{roleGroup}' 역할 그룹에 추가했습니다.",
        "en_US": "Added the service principal to the '{roleGroup}' role group.",
    },
    "purviewRbac.alreadyMemberPowershell": {
        "ko_KR": "서비스 주체가 이미 '{roleGroup}' 역할 그룹의 구성원입니다.",
        "en_US": "The service principal is already a member of the '{roleGroup}' role group.",
    },
    "purviewRbac.moduleInstallFailed": {
        "ko_KR": "ExchangeOnlineManagement 모듈 설치에 실패했습니다.\n관리자 권한으로 PowerShell을 열고 다음을 실행하세요:\n  Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force",
        "en_US": "Failed to install the ExchangeOnlineManagement module.\nOpen PowerShell as an administrator and run:\n  Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force",
    },
    "purviewRbac.signinFailed": {
        "ko_KR": "Exchange Online 로그인이 취소되었거나 실패했습니다.\n테넌트 관리자 계정으로 다시 시도하세요.",
        "en_US": "Exchange Online sign-in was cancelled or failed.\nTry again with a tenant administrator account.",
    },
    "purviewRbac.candidateRoleGroups": {
        "ko_KR": "\n\n이 테넌트의 IPPS 세션에 보이는 유사 이름 역할 그룹: {candidates}",
        "en_US": "\n\nSimilarly named role groups visible in this tenant's IPPS session: {candidates}",
    },
    "purviewRbac.roleGroupNotAutoGranted": {
        "ko_KR": "'Audit Reader' 역할 그룹이 이 테넌트의 Security & Compliance 카탈로그에서 자동 부여되지 않았습니다.\nstale session 정리 후 재시도했지만 역량 그룹을 찾을 수 없었습니다. '다시 시도' 버튼을 눌러 새 PowerShell 세션으로 재시도하거나 '건너뛰기' 버튼으로 계속하세요.{candLine}",
        "en_US": "The 'Audit Reader' role group was not auto-granted in this tenant's Security & Compliance catalog.\nAfter clearing the stale session and retrying, the role group still couldn't be found. Click 'Retry' to retry with a new PowerShell session, or click 'Skip' to continue.{candLine}",
    },
    "purviewRbac.roleGroupNotInCatalog": {
        "ko_KR": "'Audit Reader' 역할 그룹을 서비스 카탈로그에서 찾을 수 없습니다.\nstale session 정리 후 재시도했지만 실패했습니다. '다시 시도' 또는 '건너뛰기' 버튼으로 진행하세요.\n\n세부 오류:\n{detail}",
        "en_US": "Couldn't find the 'Audit Reader' role group in the service catalog.\nAfter clearing the stale session and retrying, it still failed. Proceed with the 'Retry' or 'Skip' button.\n\nDetails:\n{detail}",
    },
    "purviewRbac.roleGroupAddDenied": {
        "ko_KR": "역할 그룹 추가가 거부되었습니다. 로그인한 계정에 Organization Management 또는 Role Management 권한이 있는지 확인하세요.\n\n세부 오류:\n{detail}",
        "en_US": "Adding the role group was denied. Check that the signed-in account has Organization Management or Role Management permissions.\n\nDetails:\n{detail}",
    },
    "purviewRbac.powershellFailed": {
        "ko_KR": "PowerShell 명령이 실패했습니다 (exit={rc}).\n\n{detail}",
        "en_US": "The PowerShell command failed (exit={rc}).\n\n{detail}",
    },
}
