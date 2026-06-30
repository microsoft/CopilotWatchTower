"""Onboarding wizard message catalog.

User-facing strings for the PySide6 onboarding wizard
(``ui/onboarding_wizard.py``). These dialogs render in the active language
at construction time; switching language takes effect on the next app start.

Kept separate so the (large) onboarding string set can be maintained on its
own; ``messages.py`` merges this dict in.

Format: ``key -> {language_code: template}`` using ``str.format`` placeholders.
``ko_KR`` is the source language and the fallback.
"""
from __future__ import annotations

DIALOG_MESSAGES: dict[str, dict[str, str]] = {
    # ---- shared / common ----------------------------------------------
    "onboarding.common.waiting": {
        "ko_KR": "대기 중...",
        "en_US": "Waiting...",
    },
    "onboarding.common.preparing": {
        "ko_KR": "준비 중...",
        "en_US": "Preparing...",
    },
    "onboarding.common.retry": {
        "ko_KR": "다시 시도",
        "en_US": "Retry",
    },
    "onboarding.common.errorTitle": {
        "ko_KR": "오류",
        "en_US": "Error",
    },
    # ---- welcome page -------------------------------------------------
    "onboarding.welcome.title": {
        "ko_KR": "CopilotWatchTower 시작하기",
        "en_US": "Get started with CopilotWatchTower",
    },
    "onboarding.welcome.subtitle": {
        "ko_KR": "테넌트 관리자 계정으로 한 번만 로그인하면 됩니다.",
        "en_US": "You only need to sign in once with a tenant administrator account.",
    },
    "onboarding.welcome.permAnnotationEdiscovery": {
        "ko_KR": " (위임됨 / Purview eDiscovery 수집용)",
        "en_US": " (delegated / for Purview eDiscovery collection)",
    },
    "onboarding.welcome.body": {
        "ko_KR": (
            "<p>이 프로그램은 Microsoft 365 Copilot 사용자의 대화 기록을 "
            "Microsoft Graph를 통해 수집합니다.</p>"
            "<p>설치 단계에서 다음을 자동으로 수행합니다:</p>"
            "<ol>"
            "<li>Entra ID에 전용 애플리케이션 등록 (브랜드: <b>CopilotWatchTower</b>)</li>"
            "<li>서비스 주체 생성 및 클라이언트 시크릿 발급</li>"
            "<li>다음 권한에 대한 관리자 동의 요청"
            "  <ul>"
            "{permission_items}"
            "  </ul>"
            "</li>"
            "<li>Microsoft 365 사용량 보고서의 익명화 설정 확인 및 실명 표시 설정</li>"
            "</ol>"
            "<p>필요한 관리자 역할: <b>Cloud Application Administrator</b> 이상. "
            "보고서 실명 표시 변경은 조직의 privacy 정책상 허용되는 경우에만 적용하세요.</p>"
        ),
        "en_US": (
            "<p>This program collects the conversation history of Microsoft 365 "
            "Copilot users through Microsoft Graph.</p>"
            "<p>During setup it automatically performs the following:</p>"
            "<ol>"
            "<li>Registers a dedicated application in Entra ID (brand: <b>CopilotWatchTower</b>)</li>"
            "<li>Creates a service principal and issues a client secret</li>"
            "<li>Requests admin consent for the following permissions"
            "  <ul>"
            "{permission_items}"
            "  </ul>"
            "</li>"
            "<li>Checks the anonymization setting of Microsoft 365 usage reports and enables real-name display</li>"
            "</ol>"
            "<p>Required admin role: <b>Cloud Application Administrator</b> or higher. "
            "Apply the real-name report change only if your organization's privacy policy allows it.</p>"
        ),
    },
    # ---- mode select page --------------------------------------------
    "onboarding.mode.title": {
        "ko_KR": "설정 방식 선택",
        "en_US": "Choose a setup method",
    },
    "onboarding.mode.subtitle": {
        "ko_KR": "앱 등록을 자동으로 만들지, 미리 만들어 둔 앱을 사용할지 선택하세요.",
        "en_US": "Choose whether to create the app registration automatically or use a pre-registered app.",
    },
    "onboarding.mode.autoRadio": {
        "ko_KR": "자동 등록 — 관리자 로그인으로 Entra 앱을 자동 생성합니다 (권장)",
        "en_US": "Automatic registration — create the Entra app automatically with an admin sign-in (recommended)",
    },
    "onboarding.mode.existingRadio": {
        "ko_KR": "기존 앱 사용 — 이미 등록한 Entra 앱의 자격증명을 직접 입력합니다",
        "en_US": "Use an existing app — enter the credentials of an already-registered Entra app",
    },
    "onboarding.mode.autoNote": {
        "ko_KR": (
            "테넌트 관리자(Cloud Application Administrator 이상)로 한 번 로그인하면 "
            "전용 앱 등록·서비스 주체·클라이언트 시크릿 생성과 관리자 동의를 자동으로 처리합니다."
        ),
        "en_US": (
            "Sign in once as a tenant administrator (Cloud Application Administrator or higher) and the "
            "dedicated app registration, service principal, client secret creation, and admin consent are "
            "all handled automatically."
        ),
    },
    "onboarding.mode.existingNote": {
        "ko_KR": (
            "보안 정책상 앱을 중앙에서 미리 등록해 두는 조직에 적합합니다. 다음 단계에서 "
            "필요한 권한 구성 방법을 안내하고, 테넌트 ID·클라이언트 ID·클라이언트 시크릿을 "
            "입력받아 유효성을 검사합니다."
        ),
        "en_US": (
            "Best for organizations whose security policy requires apps to be registered centrally in "
            "advance. The next step explains how to configure the required permissions, then collects and "
            "validates your tenant ID, client ID, and client secret."
        ),
    },
    # ---- device-code sign-in page ------------------------------------
    "onboarding.device.title": {
        "ko_KR": "관리자 로그인",
        "en_US": "Administrator sign-in",
    },
    "onboarding.device.subtitle": {
        "ko_KR": "아래 코드를 브라우저에 입력해 로그인하세요.",
        "en_US": "Enter the code below in your browser to sign in.",
    },
    "onboarding.device.issuingCode": {
        "ko_KR": "코드 발급 중...",
        "en_US": "Issuing code...",
    },
    "onboarding.device.copyCode": {
        "ko_KR": "코드 복사",
        "en_US": "Copy code",
    },
    "onboarding.device.openBrowser": {
        "ko_KR": "브라우저 열기",
        "en_US": "Open browser",
    },
    "onboarding.device.signingInBrowser": {
        "ko_KR": "브라우저에서 로그인 중...",
        "en_US": "Signing in via browser...",
    },
    "onboarding.device.signInSuccess": {
        "ko_KR": "로그인 성공: {upn} (tenant {tenant})",
        "en_US": "Signed in: {upn} (tenant {tenant})",
    },
    # ---- app registration page ---------------------------------------
    "onboarding.reg.creatingApp": {
        "ko_KR": "애플리케이션 생성 중...",
        "en_US": "Creating application...",
    },
    "onboarding.reg.savingCredentials": {
        "ko_KR": "자격증명 저장 중...",
        "en_US": "Saving credentials...",
    },
    "onboarding.reg.title": {
        "ko_KR": "애플리케이션 등록",
        "en_US": "Application registration",
    },
    "onboarding.reg.subtitle": {
        "ko_KR": "Entra ID에 전용 앱을 자동으로 생성합니다.",
        "en_US": "A dedicated app is created automatically in Entra ID.",
    },
    "onboarding.reg.namePlaceholder": {
        "ko_KR": "CopilotWatchTower-<호스트명>",
        "en_US": "CopilotWatchTower-<hostname>",
    },
    "onboarding.reg.startButton": {
        "ko_KR": "앱 생성 시작",
        "en_US": "Start app creation",
    },
    "onboarding.reg.displayNameLabel": {
        "ko_KR": "애플리케이션 표시 이름 (선택):",
        "en_US": "Application display name (optional):",
    },
    "onboarding.reg.created": {
        "ko_KR": "✓ 생성 완료 (appId={app_id})",
        "en_US": "✓ Created (appId={app_id})",
    },
    # ---- admin consent page ------------------------------------------
    "onboarding.consent.title": {
        "ko_KR": "관리자 동의",
        "en_US": "Admin consent",
    },
    "onboarding.consent.subtitle": {
        "ko_KR": "브라우저에서 권한을 승인하면 자동으로 다음 단계로 이동합니다.",
        "en_US": "Once you approve the permissions in your browser, the wizard advances automatically.",
    },
    "onboarding.consent.waiting": {
        "ko_KR": "관리자 동의 대기 중...",
        "en_US": "Waiting for admin consent...",
    },
    "onboarding.consent.openButton": {
        "ko_KR": "동의 페이지 열기",
        "en_US": "Open consent page",
    },
    "onboarding.consent.registeringRedirect": {
        "ko_KR": "리디렉션 URI 등록 중...",
        "en_US": "Registering redirect URI...",
    },
    "onboarding.consent.verifyingRedirect": {
        "ko_KR": "리디렉션 URI 확인 중...",
        "en_US": "Verifying redirect URI...",
    },
    "onboarding.consent.approveInBrowser": {
        "ko_KR": "브라우저에서 권한을 승인하세요. (페이지가 자동으로 열립니다)",
        "en_US": "Approve the permissions in your browser. (The page opens automatically.)",
    },
    "onboarding.consent.redirectFailed": {
        "ko_KR": "❌ 리디렉션 URI 등록 실패: {message}",
        "en_US": "❌ Failed to register redirect URI: {message}",
    },
    "onboarding.consent.waitingRedirect": {
        "ko_KR": "리디렉션 URI 등록을 기다리는 중...",
        "en_US": "Waiting for redirect URI registration...",
    },
    "onboarding.consent.done": {
        "ko_KR": "✓ 관리자 동의 완료",
        "en_US": "✓ Admin consent complete",
    },
    "onboarding.consent.redirectTimeout": {
        "ko_KR": (
            "Graph가 30초 내에 리디렉션 URI를 보고하지 않았습니다. "
            "잠시 후 '동의 페이지 열기'를 다시 누르세요."
        ),
        "en_US": (
            "Graph did not report the redirect URI within 30 seconds. "
            "Wait a moment and click 'Open consent page' again."
        ),
    },
    "onboarding.consent.propagationWait": {
        "ko_KR": "Entra 인증 엔드포인트 전파 대기 중... (10초)",
        "en_US": "Waiting for Entra auth endpoint propagation... (10s)",
    },
    # ---- existing-app (BYOA) setup guide page ------------------------
    "onboarding.appGuide.title": {
        "ko_KR": "기존 앱 구성 안내",
        "en_US": "Existing app configuration guide",
    },
    "onboarding.appGuide.subtitle": {
        "ko_KR": "아래 권한과 설정으로 Entra 앱을 구성한 뒤 다음 단계에서 자격증명을 입력하세요.",
        "en_US": "Configure the Entra app with the permissions and settings below, then enter the credentials in the next step.",
    },
    "onboarding.appGuide.body": {
        "ko_KR": (
            "<p>Microsoft Entra 관리 센터 → <b>앱 등록</b>에서 애플리케이션을 만들고 "
            "다음을 구성하세요.</p>"
            "<ol>"
            "<li><b>API 권한 → Microsoft Graph → 애플리케이션 권한</b>으로 추가:"
            "  <ul>{role_items}</ul></li>"
            "<li><b>API 권한 → Microsoft Graph → 위임된 권한</b>으로 추가:"
            "  <ul>{scope_items}</ul></li>"
            "<li><b>관리자 동의 부여</b>를 눌러 위 권한에 테넌트 전체 동의를 적용합니다.</li>"
            "<li><b>인증서 및 비밀 → 새 클라이언트 비밀</b>에서 클라이언트 시크릿을 생성하고 "
            "<u>값</u>(Value)을 복사해 둡니다. (다음 단계에서 입력)</li>"
            "<li>감사 로그 수집을 사용하려면 서비스 주체에 Exchange Online "
            "<b>View-Only Audit Logs</b> 역할을 부여합니다.</li>"
            "<li>(선택) 사용량 보고서에 실명을 표시하려면 보고서 설정에서 "
            "<code>displayConcealedNames=false</code>로 설정합니다.</li>"
            "</ol>"
            "<p>구성을 마친 뒤 다음 단계에서 자격증명을 입력하면 권한 부여 여부를 자동으로 "
            "점검합니다. (앱에 <code>Application.Read.All</code>이 있으면 자동 점검, 없으면 "
            "수동 확인 안내)</p>"
        ),
        "en_US": (
            "<p>In the Microsoft Entra admin center, go to <b>App registrations</b>, create an "
            "application, and configure the following.</p>"
            "<ol>"
            "<li>Under <b>API permissions → Microsoft Graph → Application permissions</b>, add:"
            "  <ul>{role_items}</ul></li>"
            "<li>Under <b>API permissions → Microsoft Graph → Delegated permissions</b>, add:"
            "  <ul>{scope_items}</ul></li>"
            "<li>Click <b>Grant admin consent</b> to apply tenant-wide consent to the permissions above.</li>"
            "<li>Under <b>Certificates &amp; secrets → New client secret</b>, create a client secret and "
            "copy its <u>Value</u>. (You will enter it in the next step.)</li>"
            "<li>To collect audit logs, grant the service principal the Exchange Online "
            "<b>View-Only Audit Logs</b> role.</li>"
            "<li>(Optional) To show real names in usage reports, set "
            "<code>displayConcealedNames=false</code> in report settings.</li>"
            "</ol>"
            "<p>After configuration, enter the credentials in the next step and the tool automatically "
            "checks whether the permissions are granted. (Automatic check if the app has "
            "<code>Application.Read.All</code>; otherwise manual verification guidance is shown.)</p>"
        ),
    },
    "onboarding.appGuide.copyButton": {
        "ko_KR": "권한 목록 복사",
        "en_US": "Copy permission list",
    },
    "onboarding.appGuide.copyAppHeader": {
        "ko_KR": "[애플리케이션 권한 (Application)]",
        "en_US": "[Application permissions (Application)]",
    },
    "onboarding.appGuide.copyDelegatedHeader": {
        "ko_KR": "[위임된 권한 (Delegated)]",
        "en_US": "[Delegated permissions (Delegated)]",
    },
    # ---- manual credentials page (BYOA) ------------------------------
    "onboarding.manual.authFailed": {
        "ko_KR": (
            "자격증명으로 토큰을 발급하지 못했습니다. 테넌트 ID / 클라이언트 ID / "
            "시크릿과 관리자 동의 여부를 확인하세요.\n{error}"
        ),
        "en_US": (
            "Could not obtain a token with these credentials. Check the tenant ID / client ID / "
            "secret and whether admin consent has been granted.\n{error}"
        ),
    },
    "onboarding.manual.cannotVerifyGraph": {
        "ko_KR": (
            "자격증명은 유효하지만 부여된 권한을 자동으로 점검하지 못했습니다 "
            "(Graph {status}). 앱에 Application.Read.All이 없으면 점검을 "
            "건너뜁니다. 안내된 권한이 모두 부여되었는지 직접 확인하세요."
        ),
        "en_US": (
            "The credentials are valid, but the granted permissions could not be checked "
            "automatically (Graph {status}). The check is skipped when the app lacks "
            "Application.Read.All. Please verify that all listed permissions are granted."
        ),
    },
    "onboarding.manual.cannotVerifyGeneric": {
        "ko_KR": "자격증명은 유효하지만 부여된 권한을 자동으로 점검하지 못했습니다.\n{error}",
        "en_US": "The credentials are valid, but the granted permissions could not be checked automatically.\n{error}",
    },
    "onboarding.manual.missingRoles": {
        "ko_KR": "다음 애플리케이션 권한이 아직 부여되지 않았습니다:",
        "en_US": "The following application permissions have not been granted yet:",
    },
    "onboarding.manual.ok": {
        "ko_KR": "자격증명이 유효하며 필요한 애플리케이션 권한이 모두 부여되었습니다.",
        "en_US": "The credentials are valid and all required application permissions are granted.",
    },
    "onboarding.manual.title": {
        "ko_KR": "기존 앱 자격증명",
        "en_US": "Existing app credentials",
    },
    "onboarding.manual.subtitle": {
        "ko_KR": "미리 등록한 Entra 앱의 자격증명을 입력하고 검증하세요.",
        "en_US": "Enter and validate the credentials of your pre-registered Entra app.",
    },
    "onboarding.manual.summary": {
        "ko_KR": "필요 권한 — 애플리케이션: {roles} / 위임됨: {scopes} + 관리자 동의.",
        "en_US": "Required permissions — Application: {roles} / Delegated: {scopes} + admin consent.",
    },
    "onboarding.manual.tenantPlaceholder": {
        "ko_KR": "테넌트 ID (GUID 또는 도메인)",
        "en_US": "Tenant ID (GUID or domain)",
    },
    "onboarding.manual.clientPlaceholder": {
        "ko_KR": "클라이언트(애플리케이션) ID",
        "en_US": "Client (application) ID",
    },
    "onboarding.manual.secretPlaceholder": {
        "ko_KR": "클라이언트 시크릿 값",
        "en_US": "Client secret value",
    },
    "onboarding.manual.validateButton": {
        "ko_KR": "검증",
        "en_US": "Validate",
    },
    "onboarding.manual.statusInitial": {
        "ko_KR": "자격증명을 입력하고 검증을 누르세요.",
        "en_US": "Enter the credentials and click Validate.",
    },
    "onboarding.manual.tenantLabel": {
        "ko_KR": "테넌트 ID:",
        "en_US": "Tenant ID:",
    },
    "onboarding.manual.clientLabel": {
        "ko_KR": "클라이언트 ID:",
        "en_US": "Client ID:",
    },
    "onboarding.manual.secretLabel": {
        "ko_KR": "클라이언트 시크릿:",
        "en_US": "Client secret:",
    },
    "onboarding.manual.allRequired": {
        "ko_KR": "⚠ 테넌트 ID · 클라이언트 ID · 시크릿을 모두 입력하세요.",
        "en_US": "⚠ Enter the tenant ID, client ID, and secret.",
    },
    "onboarding.manual.validating": {
        "ko_KR": "자격증명 검증 중...",
        "en_US": "Validating credentials...",
    },
    "onboarding.manual.tenantDetail": {
        "ko_KR": "테넌트: {name}",
        "en_US": "Tenant: {name}",
    },
    # ---- delegated login page (BYOA, optional) -----------------------
    "onboarding.delegated.title": {
        "ko_KR": "위임 로그인 (선택)",
        "en_US": "Delegated sign-in (optional)",
    },
    "onboarding.delegated.subtitle": {
        "ko_KR": "eDiscovery · 비용/소비량 수집을 사용하려면 위임 관리자 로그인이 한 번 필요합니다.",
        "en_US": "Using eDiscovery and cost/consumption collection requires a one-time delegated admin sign-in.",
    },
    "onboarding.delegated.info": {
        "ko_KR": (
            "이 단계는 선택입니다. eDiscovery(라이선스 없는 사용자 대화)와 비용/소비량 "
            "리포트 수집은 위임 권한이 필요하며, 아래 로그인으로 토큰을 한 번 시드해 두면 "
            "이후 백그라운드 수집이 추가 로그인 없이 동작합니다. 지금 건너뛰고 나중에 "
            "설정에서 진행할 수도 있습니다."
        ),
        "en_US": (
            "This step is optional. eDiscovery (conversations of unlicensed users) and cost/consumption "
            "report collection require delegated permissions. Signing in below seeds a token once so that "
            "later background collection runs without prompting again. You can skip this for now and "
            "complete it later in Settings."
        ),
    },
    "onboarding.delegated.loginButton": {
        "ko_KR": "지금 로그인",
        "en_US": "Sign in now",
    },
    "onboarding.delegated.skipNote": {
        "ko_KR": "로그인하지 않고 다음으로 진행하면 나중에 권한 재등록이 필요합니다.",
        "en_US": "If you continue without signing in, you will need to re-authorize the permissions later.",
    },
    "onboarding.delegated.done": {
        "ko_KR": "✓ 위임 로그인 완료: {upn}",
        "en_US": "✓ Delegated sign-in complete: {upn}",
    },
    # ---- eDiscovery browser credential page --------------------------
    "onboarding.browser.title": {
        "ko_KR": "자동 다운로드 로그인 계정",
        "en_US": "Automatic download sign-in account",
    },
    "onboarding.browser.subtitle": {
        "ko_KR": (
            "헤드리스 브라우저가 다운로드 페이지에 자동 로그인할 때 사용할 계정입니다. "
            "다음 두 가지 수집에 공통으로 사용됩니다."
        ),
        "en_US": (
            "The account the headless browser uses to sign in automatically to download pages. "
            "It is shared by the two collection tasks below."
        ),
    },
    "onboarding.browser.info": {
        "ko_KR": (
            "이 계정/암호는 아래 두 작업에서 헤드리스 브라우저 자동 로그인에 사용됩니다.\n"
            "① eDiscovery 내보내기 패키지 다운로드(Direct Download Proxy URL이 브라우저 "
            "id_token 세션을 요구함)\n"
            "② 비용/소비량 리포트 다운로드(PPAC 라이선싱 토큰 캡처)\n"
            "입력한 계정/암호는 Windows DPAPI로 보호되어 현재 Windows 사용자 프로필에만 "
            "저장되며, 다른 곳으로 전송되지 않습니다."
        ),
        "en_US": (
            "This account/password is used for headless-browser automatic sign-in in the two tasks below.\n"
            "\u2460 Downloading eDiscovery export packages (the Direct Download Proxy URL requires a "
            "browser id_token session)\n"
            "\u2461 Downloading cost/consumption reports (capturing the PPAC licensing token)\n"
            "The account/password you enter is protected with Windows DPAPI, stored only in the current "
            "Windows user profile, and is never transmitted elsewhere."
        ),
    },
    "onboarding.browser.passwordPlaceholder": {
        "ko_KR": "암호",
        "en_US": "Password",
    },
    "onboarding.browser.upnLabel": {
        "ko_KR": "로그인 UPN:",
        "en_US": "Sign-in UPN:",
    },
    "onboarding.browser.passwordLabel": {
        "ko_KR": "암호:",
        "en_US": "Password:",
    },
    "onboarding.browser.statusNote": {
        "ko_KR": (
            "이 값은 eDiscovery 패키지·비용/소비량 리포트 다운로드 시 헤드리스 브라우저 "
            "자동 로그인에만 사용됩니다."
        ),
        "en_US": (
            "This value is used only for headless-browser automatic sign-in when downloading eDiscovery "
            "packages and cost/consumption reports."
        ),
    },
    # ---- Purview audit role page -------------------------------------
    "onboarding.purview.unexpectedError": {
        "ko_KR": "예기치 못한 오류: {error}",
        "en_US": "Unexpected error: {error}",
    },
    "onboarding.purview.title": {
        "ko_KR": "Purview 감사 역할 부여",
        "en_US": "Grant Purview audit role",
    },
    "onboarding.purview.subtitle": {
        "ko_KR": (
            "Microsoft Graph로 서비스 주체에 'View-Only Audit Logs' 역할을 자동 부여합니다. "
            "추가 로그인 없이 조용히 진행됩니다."
        ),
        "en_US": (
            "Automatically grants the service principal the 'View-Only Audit Logs' role via Microsoft "
            "Graph. It runs quietly without an extra sign-in."
        ),
    },
    "onboarding.purview.skipButton": {
        "ko_KR": "건너뛰기 (수동 부여됨)",
        "en_US": "Skip (granted manually)",
    },
    "onboarding.purview.skipTooltip": {
        "ko_KR": (
            "이미 'View-Only Audit Logs' 또는 동등한 감사 로그 역할이 부여된 경우,\n"
            "이 단계를 건너뛰고 온보딩을 계속하세요."
        ),
        "en_US": (
            "If the 'View-Only Audit Logs' role (or an equivalent audit-log role) is already granted,\n"
            "skip this step and continue onboarding."
        ),
    },
    "onboarding.purview.bodyLabel": {
        "ko_KR": (
            "Microsoft Graph beta 의 roleManagement/exchange API를 호출하여\n"
            "서비스 주체를 'View-Only Audit Logs' 역할에 추가합니다. 새 로그인 창은 "
            "뜨지 않으며, 서비스 주체 전파 지연 시 자동으로 몇 초 간격으로 재시도합니다."
        ),
        "en_US": (
            "Calls the Microsoft Graph beta roleManagement/exchange API to\n"
            "add the service principal to the 'View-Only Audit Logs' role. No new sign-in window "
            "appears, and it retries automatically every few seconds if service principal propagation is delayed."
        ),
    },
    "onboarding.purview.alreadyGranted": {
        "ko_KR": (
            "이전 실행에서 이미 Purview 감사 로그 역할이 부여되어 있어 "
            "이 단계를 건너뜁니다."
        ),
        "en_US": (
            "A previous run already granted the Purview audit-log role, so this step is skipped."
        ),
    },
    "onboarding.purview.tokenMissing": {
        "ko_KR": (
            "Microsoft Graph 역할 부여에 필요한 bootstrap access token을 찾을 수 없습니다.\n"
            "디바이스 코드 로그인 단계부터 온보딩을 다시 진행해 주세요. "
            "이 단계에서는 PowerShell 대체 경로를 사용하지 않습니다."
        ),
        "en_US": (
            "Could not find the bootstrap access token required for the Microsoft Graph role grant.\n"
            "Please restart onboarding from the device-code sign-in step. "
            "This step does not use a PowerShell fallback path."
        ),
    },
    "onboarding.purview.granting": {
        "ko_KR": "Microsoft Graph으로 역할 부여 시도 중...",
        "en_US": "Attempting to grant the role via Microsoft Graph...",
    },
    "onboarding.purview.skipConfirmTitle": {
        "ko_KR": "건너뛰기 확인",
        "en_US": "Confirm skip",
    },
    "onboarding.purview.skipConfirmText": {
        "ko_KR": (
            "이 단계를 건너뛰면 Purview 감사 로그 역할 부여를 시도하지 않고\n"
            "다음 실행부터도 이 프로파일에서 자동으로 건너뛰게 됩니다.\n\n"
            "이미 'View-Only Audit Logs' 또는 동등한 감사 로그 역할이 부여된 경우에만 선택하세요.\n"
            "권한이 없으면 Purview 소스 수집이 실패합니다.\n\n"
            "건너뛰시겠습니까?"
        ),
        "en_US": (
            "If you skip this step, the Purview audit-log role grant is not attempted, and\n"
            "this profile will also skip it automatically on future runs.\n\n"
            "Choose this only if the 'View-Only Audit Logs' role (or an equivalent audit-log role) is already granted.\n"
            "Without the permission, Purview source collection will fail.\n\n"
            "Skip this step?"
        ),
    },
    "onboarding.purview.skippedByUser": {
        "ko_KR": (
            "사용자가 감사 로그 역할이 이미 부여된 것으로 표시하여 "
            "이 단계를 건너뛰었습니다."
        ),
        "en_US": (
            "You marked the audit-log role as already granted, so this step was skipped."
        ),
    },
    # ---- usage report settings page ----------------------------------
    "onboarding.usage.title": {
        "ko_KR": "사용량 보고서 실명 표시",
        "en_US": "Show real names in usage reports",
    },
    "onboarding.usage.subtitle": {
        "ko_KR": "Microsoft 365 사용량 보고서가 사용자 이름과 UPN을 표시하도록 설정합니다.",
        "en_US": "Configures Microsoft 365 usage reports to display user names and UPNs.",
    },
    "onboarding.usage.detail": {
        "ko_KR": (
            "이 설정은 테넌트 전체 Microsoft 365 보고서 privacy 설정입니다. "
            "사용자 정보 표시가 조직 정책상 허용되는 경우에만 적용하세요."
        ),
        "en_US": (
            "This is a tenant-wide Microsoft 365 report privacy setting. "
            "Apply it only if displaying user information is permitted by your organization's policy."
        ),
    },
    "onboarding.usage.bodyLabel": {
        "ko_KR": (
            "Microsoft Graph beta /admin/reportSettings API를 호출하여 "
            "displayConcealedNames=false 로 설정합니다.\n"
            "성공하면 이후 사용량 스냅샷 수집부터 실제 사용자 이름/UPN이 표시됩니다."
        ),
        "en_US": (
            "Calls the Microsoft Graph beta /admin/reportSettings API to set "
            "displayConcealedNames=false.\n"
            "On success, real user names/UPNs are shown from the next usage snapshot onward."
        ),
    },
    "onboarding.usage.tokenMissing": {
        "ko_KR": "보고서 설정 변경에 필요한 bootstrap access token을 찾을 수 없습니다.",
        "en_US": "Could not find the bootstrap access token required to change report settings.",
    },
    "onboarding.usage.checking": {
        "ko_KR": "사용량 보고서 privacy 설정 확인 중...",
        "en_US": "Checking usage report privacy settings...",
    },
    # ---- completion page ---------------------------------------------
    "onboarding.done.title": {
        "ko_KR": "설치 완료",
        "en_US": "Setup complete",
    },
    "onboarding.done.subtitle": {
        "ko_KR": "이제 대화 기록 수집을 시작할 수 있습니다.",
        "en_US": "You can now start collecting conversation history.",
    },
    "onboarding.done.body": {
        "ko_KR": "설정이 저장되었습니다. 마침을 눌러 메인 창으로 이동하세요.",
        "en_US": "Your settings have been saved. Click Finish to open the main window.",
    },
    "onboarding.done.byoaNote": {
        "ko_KR": (
            "기존 앱 모드로 설정되었습니다. 다음 항목은 고객이 직접 구성했어야 합니다:\n"
            "  • 필수 Microsoft Graph 권한에 대한 관리자 동의\n"
            "  • (감사 로그 수집 시) 서비스 주체에 Exchange Online 'View-Only Audit Logs' 역할\n"
            "  • (선택) 사용량 보고서 실명 표시 설정(displayConcealedNames=false)\n"
            "위임 로그인을 건너뛴 경우, eDiscovery · 비용/소비량 수집 전에 설정에서 "
            "권한 재등록(위임 로그인)이 필요합니다."
        ),
        "en_US": (
            "Configured in existing-app mode. The following items must have been configured by you:\n"
            "  • Admin consent for the required Microsoft Graph permissions\n"
            "  • (For audit-log collection) the Exchange Online 'View-Only Audit Logs' role on the service principal\n"
            "  • (Optional) the real-name usage report setting (displayConcealedNames=false)\n"
            "If you skipped delegated sign-in, you must re-authorize the permissions (delegated sign-in) in "
            "Settings before eDiscovery and cost/consumption collection."
        ),
    },
    "onboarding.done.usageSuccess": {
        "ko_KR": (
            "✓ 사용량 보고서 실명 표시: {state}\n"
            "다음 사용량 스냅샷부터 실제 사용자 이름/UPN이 표시됩니다."
        ),
        "en_US": (
            "✓ Usage report real-name display: {state}\n"
            "Real user names/UPNs are shown from the next usage snapshot onward."
        ),
    },
    "onboarding.done.usageFailure": {
        "ko_KR": (
            "⚠ 사용량 보고서 실명 표시 설정을 완료하지 못했습니다.\n"
            "({state}) — Microsoft 365 보고서에서 사용자가 계속 익명으로 표시될 수 있습니다.\n"
            "세부 메시지:\n{message}"
        ),
        "en_US": (
            "⚠ Could not complete the usage report real-name display setting.\n"
            "({state}) — Users may continue to appear anonymized in Microsoft 365 reports.\n"
            "Details:\n{message}"
        ),
    },
    "onboarding.done.tagAddedViaGraph": {
        "ko_KR": "added_via_graph (Microsoft Graph 자동 부여)",
        "en_US": "added_via_graph (granted automatically via Microsoft Graph)",
    },
    "onboarding.done.tagAlreadyGranted": {
        "ko_KR": "already_granted (이전 실행에서 부여됨)",
        "en_US": "already_granted (granted in a previous run)",
    },
    "onboarding.done.tagSkippedByUser": {
        "ko_KR": "skipped_by_user (수동 부여됨으로 표시)",
        "en_US": "skipped_by_user (marked as granted manually)",
    },
    "onboarding.done.purviewSuccess": {
        "ko_KR": (
            "✓ Purview 감사 로그 역할: {tag}\n"
            "다음 수집 주기부터 Purview 소스가 정상 동작합니다."
        ),
        "en_US": (
            "✓ Purview audit-log role: {tag}\n"
            "Purview sources work normally from the next collection cycle."
        ),
    },
    "onboarding.done.purviewFailure": {
        "ko_KR": (
            "⚠ Purview 감사 로그 역할 부여를 완료하지 못했습니다.\n"
            "({state}) — Purview 소스는 권한 복구 후 자동 재시도됩니다.\n"
            "권한 업데이트 또는 온보딩을 다시 진행해야 합니다.\n\n"
            "세부 메시지:\n{message}"
        ),
        "en_US": (
            "⚠ Could not complete the Purview audit-log role grant.\n"
            "({state}) — Purview sources retry automatically once the permission is restored.\n"
            "You must re-run the permission update or onboarding.\n\n"
            "Details:\n{message}"
        ),
    },
    # ---- top-level wizard --------------------------------------------
    "onboarding.wizard.windowTitle": {
        "ko_KR": "CopilotWatchTower — 초기 설정",
        "en_US": "CopilotWatchTower — Initial setup",
    },
    "onboarding.wizard.noAppResult": {
        "ko_KR": "앱 등록 결과가 없습니다.",
        "en_US": "No app registration result is available.",
    },
    "onboarding.wizard.emptyCredentials": {
        "ko_KR": "기존 앱 자격증명이 비어 있습니다.",
        "en_US": "The existing app credentials are empty.",
    },
}
