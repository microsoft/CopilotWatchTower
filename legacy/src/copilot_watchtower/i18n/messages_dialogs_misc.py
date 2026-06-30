"""Misc bootstrap-dialog message catalog.

User-facing strings for the smaller PySide6 bootstrap dialogs: settings,
profile picker, permissions upgrade, and factory reset. These render in the
active language at construction time; switching language takes effect on the
next app start.

Kept separate so these can be maintained independently; ``messages.py``
merges this dict in.

Format: ``key -> {language_code: template}`` using ``str.format`` placeholders.
``ko_KR`` is the source language and the fallback.
"""
from __future__ import annotations

DIALOG_MISC_MESSAGES: dict[str, dict[str, str]] = {
    # ---- Shared generic dialog labels (used across several dialogs) ----
    "dlg.cancel": {
        "ko_KR": "취소",
        "en_US": "Cancel",
    },
    "dlg.close": {
        "ko_KR": "닫기",
        "en_US": "Close",
    },
    "dlg.copyCode": {
        "ko_KR": "코드 복사",
        "en_US": "Copy code",
    },
    "dlg.openBrowser": {
        "ko_KR": "브라우저 열기",
        "en_US": "Open browser",
    },
    "dlg.issuingDeviceCode": {
        "ko_KR": "디바이스 코드 발급 중...",
        "en_US": "Issuing device code...",
    },
    # ---- Settings dialog (ui/settings_dialog.py) ----
    "settingsDlg.title": {
        "ko_KR": "권한 · 위험 영역",
        "en_US": "Permissions · Danger zone",
    },
    "settingsDlg.intro": {
        "ko_KR": (
            "일반 설정(수집 범위 · 주기 · 언어)은 설정 페이지에서 변경하세요.\n"
            "이 창은 device-code 로그인이나 파괴적 동작이 필요한 작업 전용입니다."
        ),
        "en_US": (
            "Change general settings (collection scope · interval · language) on the "
            "Settings page.\n"
            "This window is reserved for operations that need a device-code sign-in or "
            "a destructive action."
        ),
    },
    "settingsDlg.permissionsBtn": {
        "ko_KR": "Graph 권한 업데이트 / 관리자 동의 다시 받기",
        "en_US": "Update Graph permissions / re-grant admin consent",
    },
    "settingsDlg.wipeDataBtn": {
        "ko_KR": "수집 데이터 삭제 (대화/사용자/실행 기록)",
        "en_US": "Delete collected data (conversations / users / run history)",
    },
    "settingsDlg.resetBtn": {
        "ko_KR": "완전 초기화 — Entra 앱까지 삭제하고 처음부터 다시 (위험)",
        "en_US": "Full reset — delete the Entra app and start over (dangerous)",
    },
    "settingsDlg.sectionPermissions": {
        "ko_KR": "권한",
        "en_US": "Permissions",
    },
    "settingsDlg.sectionDanger": {
        "ko_KR": "위험 영역",
        "en_US": "Danger zone",
    },
    "settingsDlg.wipeDataTitle": {
        "ko_KR": "수집 데이터 삭제",
        "en_US": "Delete collected data",
    },
    "settingsDlg.wipeDataConfirm": {
        "ko_KR": (
            "저장된 모든 대화 기록, 사용자 목록, 실행 이력이 삭제됩니다.\n"
            "앱 등록(테넌트 ID / 클라이언트 시크릿)은 그대로 유지되며,\n"
            "다음 수집 주기부터 처음부터 다시 적재됩니다.\n\n"
            "수집이 진행 중이면 먼저 중지하세요.\n\n"
            "정말 진행하시겠습니까?"
        ),
        "en_US": (
            "All saved conversation history, user lists, and run history will be deleted.\n"
            "The app registration (tenant ID / client secret) is kept,\n"
            "and collection starts over from the next cycle.\n\n"
            "If a collection is in progress, stop it first.\n\n"
            "Are you sure you want to continue?"
        ),
    },
    "settingsDlg.deleteFailed": {
        "ko_KR": "삭제 실패: {error}",
        "en_US": "Deletion failed: {error}",
    },
    "settingsDlg.wipeDataDone": {
        "ko_KR": (
            "삭제가 완료되었습니다.\n"
            "- 대화: {interactions}건\n"
            "- 사용자: {users}명\n"
            "- 실행 이력: {runs}건\n"
            "- 사용자별 상태: {state}건"
        ),
        "en_US": (
            "Deletion complete.\n"
            "- Conversations: {interactions}\n"
            "- Users: {users}\n"
            "- Run history: {runs}\n"
            "- Per-user state: {state}"
        ),
    },
    "settingsDlg.resetCompleteTitle": {
        "ko_KR": "초기화 완료",
        "en_US": "Reset complete",
    },
    "settingsDlg.resetProfileRemoved": {
        "ko_KR": "프로필이 삭제되었습니다. 프로필 선택 화면으로 돌아갑니다.",
        "en_US": "The profile has been deleted. Returning to the profile picker.",
    },
    "settingsDlg.resetRestartHint": {
        "ko_KR": (
            "프로그램을 종료한 뒤 다시 실행하세요.\n"
            "새로 실행하면 온보딩이 시작됩니다."
        ),
        "en_US": (
            "Quit and relaunch the program.\n"
            "Onboarding will start the next time you run it."
        ),
    },
    # ---- Profile picker dialog (ui/profile_picker_dialog.py) ----
    "profilePicker.title": {
        "ko_KR": "프로필 선택 — CopilotWatchTower",
        "en_US": "Select profile — CopilotWatchTower",
    },
    "profilePicker.header": {
        "ko_KR": (
            "<p><b>프로필을 선택하세요.</b> 각 프로필은 별도의 테넌트에"
            " 연결되며 자체 데이터베이스에 데이터를 보관합니다.</p>"
        ),
        "en_US": (
            "<p><b>Select a profile.</b> Each profile connects to a separate tenant"
            " and stores its data in its own database.</p>"
        ),
    },
    "profilePicker.addBtn": {
        "ko_KR": "새 프로필 추가...",
        "en_US": "Add new profile...",
    },
    "profilePicker.renameBtn": {
        "ko_KR": "이름 변경...",
        "en_US": "Rename...",
    },
    "profilePicker.deleteBtn": {
        "ko_KR": "삭제...",
        "en_US": "Delete...",
    },
    "profilePicker.openBtn": {
        "ko_KR": "열기",
        "en_US": "Open",
    },
    "profilePicker.tenantLabel": {
        "ko_KR": "테넌트 {tenant}",
        "en_US": "Tenant {tenant}",
    },
    "profilePicker.incomplete": {
        "ko_KR": "(미완료)",
        "en_US": "(incomplete)",
    },
    "profilePicker.newProfileTitle": {
        "ko_KR": "새 프로필",
        "en_US": "New profile",
    },
    "profilePicker.displayNameLabel": {
        "ko_KR": "표시 이름:",
        "en_US": "Display name:",
    },
    "profilePicker.newTenantDefault": {
        "ko_KR": "새 테넌트",
        "en_US": "New tenant",
    },
    "profilePicker.renameTitle": {
        "ko_KR": "이름 변경",
        "en_US": "Rename",
    },
    "profilePicker.deleteTitle": {
        "ko_KR": "프로필 삭제",
        "en_US": "Delete profile",
    },
    "profilePicker.deleteConfirm": {
        "ko_KR": (
            "'{name}' 프로필의 로컬 데이터와 연결된 Entra ID 앱 등록을 삭제합니다.\n"
            "다음 단계에서 관리자 로그인이 필요할 수 있습니다.\n\n"
            "정말 진행하시겠습니까?"
        ),
        "en_US": (
            "This deletes the local data for the '{name}' profile and the linked"
            " Entra ID app registration.\n"
            "The next step may require an administrator sign-in.\n\n"
            "Are you sure you want to continue?"
        ),
    },
    "profilePicker.dbOpenFailed": {
        "ko_KR": "프로필 DB 열기 실패: {error}",
        "en_US": "Failed to open the profile database: {error}",
    },
    "profilePicker.profileTitle": {
        "ko_KR": "프로필",
        "en_US": "Profile",
    },
    "profilePicker.selectPrompt": {
        "ko_KR": "프로필을 선택하세요.",
        "en_US": "Please select a profile.",
    },
    # ---- Permissions upgrade dialog (ui/permissions_upgrade_dialog.py) ----
    "permsUpgrade.title": {
        "ko_KR": "권한 업데이트",
        "en_US": "Permission update",
    },
    "permsUpgrade.header": {
        "ko_KR": (
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
        ),
        "en_US": (
            "<p>This tool adds the following permissions to your existing app"
            " registration and re-requests admin consent:</p>"
            "<ul>"
            "<li><b>AuditLog.Read.All</b> — Entra audit / sign-in logs</li>"
            "<li><b>AuditLogsQuery.Read.All</b> — Purview Copilot activity logs</li>"
            "<li><b>Reports.Read.All</b> — Microsoft 365 Copilot usage reports</li>"
            "<li><b>AgentRegistration.Read.All</b> — Copilot agent registration list</li>"
            "<li><b>CopilotPackages.Read.All</b> — Copilot packages / agent catalog</li>"
            "<li><b>CopilotPolicySettings.Read</b> — Copilot policy-settings diagnostics</li>"
            "<li><b>eDiscovery.ReadWrite.All</b> (delegated) — refresh the Purview"
            " eDiscovery collection sign-in</li>"
            "</ul>"
            "<p>Enter the code below in your browser and sign in with a"
            " <b>Cloud Application Administrator</b> (or higher) account.</p>"
        ),
    },
    "permsUpgrade.issuingCode": {
        "ko_KR": "코드 발급 중...",
        "en_US": "Issuing code...",
    },
    "permsUpgrade.preparing": {
        "ko_KR": "준비 중...",
        "en_US": "Preparing...",
    },
    "permsUpgrade.consentBtn": {
        "ko_KR": "관리자 동의 다시 받기 (브라우저 열기)",
        "en_US": "Re-grant admin consent (open browser)",
    },
    "permsUpgrade.noTenantApp": {
        "ko_KR": "⚠ 저장된 테넌트 ID 또는 앱 ID가 없습니다. 먼저 온보딩을 완료하세요.",
        "en_US": "⚠ No saved tenant ID or app ID. Complete onboarding first.",
    },
    "permsUpgrade.signingIn": {
        "ko_KR": "브라우저에서 로그인 중...",
        "en_US": "Signing in from your browser...",
    },
    "permsUpgrade.tenantMismatch": {
        "ko_KR": (
            "⚠ 로그인한 테넌트({signed_in})가 앱이 등록된"
            " 테넌트({registered})와 다릅니다."
        ),
        "en_US": (
            "⚠ The signed-in tenant ({signed_in}) differs from the tenant where the"
            " app is registered ({registered})."
        ),
    },
    "permsUpgrade.signedIn": {
        "ko_KR": "✓ 로그인 성공: {upn} — 권한 목록 업데이트 중...",
        "en_US": "✓ Signed in: {upn} — updating the permission list...",
    },
    "permsUpgrade.patched": {
        "ko_KR": (
            "✓ 권한 목록을 업데이트했습니다.\n"
            "아래 버튼을 눌러 브라우저에서 관리자 동의를 다시 받으세요."
        ),
        "en_US": (
            "✓ Permission list updated.\n"
            "Click the button below to re-grant admin consent in your browser."
        ),
    },
    "permsUpgrade.callbackNotReady": {
        "ko_KR": "⚠ 콜백 서버가 준비되지 않았습니다. 다시 시도하세요.",
        "en_US": "⚠ The callback server is not ready. Please try again.",
    },
    "permsUpgrade.waitingConsent": {
        "ko_KR": "브라우저에서 권한을 승인하세요. 승인 완료를 기다리는 중...",
        "en_US": "Approve the permissions in your browser. Waiting for approval to complete...",
    },
    "permsUpgrade.consentDone": {
        "ko_KR": "✓ 관리자 동의 완료. 다음 수집 주기(최대 15분)부터 적용됩니다.",
        "en_US": "✓ Admin consent complete. It takes effect from the next collection cycle (up to 15 minutes).",
    },
    "permsUpgrade.consentFailed": {
        "ko_KR": "❌ 관리자 동의가 완료되지 않았습니다: {error}",
        "en_US": "❌ Admin consent did not complete: {error}",
    },
    # ---- Factory reset dialog (ui/factory_reset_dialog.py) ----
    "factoryReset.title": {
        "ko_KR": "완전 초기화 (Entra 앱까지 삭제)",
        "en_US": "Full reset (also deletes the Entra app)",
    },
    "factoryReset.header": {
        "ko_KR": (
            "<p>이 작업은 <b>되돌릴 수 없습니다.</b></p>"
            "<p>다음을 순서대로 수행합니다:</p>"
            "<ol>"
            "<li>관리자 로그인 (디바이스 코드)</li>"
            "<li>Entra ID 앱 등록 <b>삭제</b> (서비스 주체도 함께 제거됨)</li>"
            "<li>로컬에 저장된 <b>대화·사용자·실행 이력·자격증명 전부 삭제</b></li>"
            "</ol>"
            "<p>완료 후 프로그램을 다시 실행하면 처음부터 온보딩을 진행합니다."
            " 새 권한도 자동으로 반영됩니다.</p>"
        ),
        "en_US": (
            "<p>This action <b>cannot be undone.</b></p>"
            "<p>It performs the following steps in order:</p>"
            "<ol>"
            "<li>Administrator sign-in (device code)</li>"
            "<li><b>Delete</b> the Entra ID app registration (its service principal is removed too)</li>"
            "<li><b>Delete all locally stored conversations, users, run history, and credentials</b></li>"
            "</ol>"
            "<p>After it finishes, relaunch the program to run onboarding from scratch."
            " New permissions are applied automatically.</p>"
        ),
    },
    "factoryReset.startBtn": {
        "ko_KR": "계속 진행 (디바이스 코드 발급)",
        "en_US": "Proceed (issue device code)",
    },
    "factoryReset.ready": {
        "ko_KR": "준비됨.",
        "en_US": "Ready.",
    },
    "factoryReset.headerExternal": {
        "ko_KR": (
            "<p>이 프로필은 고객이 직접 등록한 <b>외부 관리 앱</b>을 사용합니다.</p>"
            "<p>Entra ID 앱은 <b>삭제하지 않고</b> 로컬에 저장된 대화·사용자·실행 이력·"
            "자격증명만 삭제합니다. 앱 등록과 권한은 고객이 직접 관리하세요.</p>"
        ),
        "en_US": (
            "<p>This profile uses an <b>externally managed app</b> that the customer"
            " registered themselves.</p>"
            "<p>The Entra ID app will <b>not be deleted</b>; only the locally stored"
            " conversations, users, run history, and credentials are removed. Manage"
            " the app registration and permissions yourself.</p>"
        ),
    },
    "factoryReset.wipeLocalKeepApp": {
        "ko_KR": "로컬 데이터/자격증명만 삭제 (Entra 앱 보존)",
        "en_US": "Delete local data/credentials only (keep the Entra app)",
    },
    "factoryReset.wipeLocalOnly": {
        "ko_KR": "로컬 데이터/자격증명만 삭제",
        "en_US": "Delete local data/credentials only",
    },
    "factoryReset.signInPrompt": {
        "ko_KR": "브라우저에서 로그인하세요...",
        "en_US": "Sign in from your browser...",
    },
    "factoryReset.tenantMismatch": {
        "ko_KR": (
            "⚠ 로그인한 테넌트({signed_in})가 앱이 등록된"
            " 테넌트({registered})와 다릅니다. 중단합니다."
        ),
        "en_US": (
            "⚠ The signed-in tenant ({signed_in}) differs from the tenant where the"
            " app is registered ({registered}). Aborting."
        ),
    },
    "factoryReset.signedIn": {
        "ko_KR": "✓ 로그인 성공: {upn} — Entra 앱 삭제 중...",
        "en_US": "✓ Signed in: {upn} — deleting the Entra app...",
    },
    "factoryReset.entraDeleted": {
        "ko_KR": "✓ Entra 앱 삭제 완료 — 로컬 데이터 삭제 중...",
        "en_US": "✓ Entra app deleted — deleting local data...",
    },
    "factoryReset.entraAlreadyGone": {
        "ko_KR": "ℹ Entra 앱은 이미 없습니다 — 로컬 데이터만 삭제합니다...",
        "en_US": "ℹ The Entra app no longer exists — deleting local data only...",
    },
    "factoryReset.wipeDataFailed": {
        "ko_KR": "로컬 데이터 삭제 실패: {error}",
        "en_US": "Failed to delete local data: {error}",
    },
    "factoryReset.wipeCredFailed": {
        "ko_KR": "자격증명 삭제 실패: {error}",
        "en_US": "Failed to delete credentials: {error}",
    },
    "factoryReset.resetDone": {
        "ko_KR": (
            "✓ 초기화 완료.\n"
            "- 대화: {interactions}건\n"
            "- 사용자: {users}명\n"
            "- 실행 이력: {runs}건\n"
            "- 자격증명: {credentials}개\n"
        ),
        "en_US": (
            "✓ Reset complete.\n"
            "- Conversations: {interactions}\n"
            "- Users: {users}\n"
            "- Run history: {runs}\n"
            "- Credentials: {credentials}\n"
        ),
    },
    "factoryReset.profileRemovedNote": {
        "ko_KR": "프로필 목록에서 이 프로필이 제거되었습니다.",
        "en_US": "This profile has been removed from the profile list.",
    },
    "factoryReset.restartHint": {
        "ko_KR": "프로그램을 종료한 뒤 다시 실행하면 온보딩이 시작됩니다.",
        "en_US": "Quit and relaunch the program to start onboarding.",
    },
    "factoryReset.closeWindowBtn": {
        "ko_KR": "창 닫기",
        "en_US": "Close window",
    },
}
