"""Backend message catalog for the agent credit-governance feature.

Worker log lines, bridge/error strings, and alert/risk summaries for the
flow-run monitor, agent risk prediction, and multi-signal credit alert engine.
Kept in its own module (merged into :data:`MESSAGES`) so the large feature's
strings stay maintainable. ``ko_KR`` is the source language and fallback.
"""
from __future__ import annotations

CREDIT_MESSAGES: dict[str, dict[str, str]] = {
    # ---- settings validation (webshell/actions.py update_settings) ----
    "error.creditIntervalInt": {
        "ko_KR": "자동 수집 주기는 정수(시간)여야 합니다.",
        "en_US": "Auto-collect interval must be an integer number of hours.",
    },
    "error.creditIntervalMin": {
        "ko_KR": "자동 수집 주기는 최소 1시간이어야 합니다.",
        "en_US": "Auto-collect interval must be at least 1 hour.",
    },
    # ---- collection labels (webshell/actions.py error messages) ----
    "label.flowRunCollection": {
        "ko_KR": "에이전트 실행(플로우) 수집",
        "en_US": "Agent run (flow) collection",
    },
    "label.agentDefinitionCollection": {
        "ko_KR": "에이전트 정의/위험 분석",
        "en_US": "Agent definition / risk analysis",
    },
    # ---- shared Dataverse session (workers/dataverse_session.py) ----
    "worker.dvSession.noBrowserAccount": {
        "ko_KR": "브라우저 로그인 계정이 설정되어 있지 않습니다. 설정에서 등록하세요.",
        "en_US": "No browser sign-in account configured. Register one in Settings.",
    },
    "worker.dvSession.capturing": {
        "ko_KR": "Dataverse 토큰을 캡처하는 중…",
        "en_US": "Capturing Dataverse tokens…",
    },
    "worker.dvSession.envConfirmed": {
        "ko_KR": "환경 {count}개를 확인했습니다.",
        "en_US": "Confirmed {count} environment(s).",
    },
    # ---- flow-run collector (workers/flow_run_collector.py) ----
    "worker.flowRun.querying": {
        "ko_KR": "플로우 실행 이력을 조회하는 중…",
        "en_US": "Querying flow run history…",
    },
    "worker.flowRun.envCollecting": {
        "ko_KR": "{label} 환경의 플로우 실행 이력 수집 중…",
        "en_US": "Collecting flow runs in {label}…",
    },
    "worker.flowRun.envTokenSkip": {
        "ko_KR": "{label} — 토큰이 없어 건너뜁니다.",
        "en_US": "{label} — skipped (no token).",
    },
    "worker.flowRun.envFailed": {
        "ko_KR": "{label} 실패: {error}",
        "en_US": "{label} failed: {error}",
    },
    "worker.flowRun.envSaved": {
        "ko_KR": "{label}: {written}건 저장 (조회 {total}건).",
        "en_US": "{label}: saved {written} (fetched {total}).",
    },
    "worker.flowRun.noRuns": {
        "ko_KR": "{label}: 새 플로우 실행 이력이 없습니다.",
        "en_US": "{label}: no new flow runs.",
    },
    "worker.flowRun.browserLoginFailed": {
        "ko_KR": "Dataverse 브라우저 로그인 실패: {error}",
        "en_US": "Dataverse browser sign-in failed: {error}",
    },
    "worker.flowRun.aborted": {
        "ko_KR": "플로우 실행 수집이 중단되었습니다: {error}",
        "en_US": "Flow-run collection aborted: {error}",
    },
    # ---- agent-definition collector (workers/agent_definition_collector.py) ----
    "worker.agentDef.querying": {
        "ko_KR": "에이전트 정의를 조회하는 중…",
        "en_US": "Querying agent definitions…",
    },
    "worker.agentDef.envCollecting": {
        "ko_KR": "{label} 환경의 에이전트 정의 분석 중…",
        "en_US": "Analyzing agent definitions in {label}…",
    },
    "worker.agentDef.envSaved": {
        "ko_KR": "{label}: 에이전트 {written}개 분석 (컴포넌트 {components}개).",
        "en_US": "{label}: analyzed {written} agent(s) ({components} components).",
    },
    "worker.agentDef.noAgents": {
        "ko_KR": "{label}: 에이전트 정의가 없습니다.",
        "en_US": "{label}: no agent definitions.",
    },
    "worker.agentDef.envFailed": {
        "ko_KR": "{label} 실패: {error}",
        "en_US": "{label} failed: {error}",
    },
    "worker.agentDef.aborted": {
        "ko_KR": "에이전트 정의 수집이 중단되었습니다: {error}",
        "en_US": "Agent-definition collection aborted: {error}",
    },
    # ---- credit alert evaluation (webshell/actions.py) ----
    "creditAlert.evaluated": {
        "ko_KR": "크레딧 알람 평가 완료: 활성 {active}건 (신규 {new}건).",
        "en_US": "Credit alert evaluation done: {active} active ({new} new).",
    },
    # ---- alert rule labels (services/credit_alerts.py defaults) ----
    "creditAlert.rule.agentDailyAbs": {
        "ko_KR": "에이전트 일일 메시지 임계치 초과",
        "en_US": "Agent daily message threshold exceeded",
    },
    "creditAlert.rule.userDailyAbs": {
        "ko_KR": "사용자 일일 메시지 임계치 초과",
        "en_US": "User daily message threshold exceeded",
    },
    "creditAlert.rule.spike": {
        "ko_KR": "기준선 대비 사용량 급증",
        "en_US": "Usage spike vs baseline",
    },
    "creditAlert.rule.monthlyBudget": {
        "ko_KR": "월 예상 사용량(예산) 초과",
        "en_US": "Projected monthly usage over budget",
    },
    "creditAlert.rule.flowSpike": {
        "ko_KR": "플로우 실행량 급증",
        "en_US": "Flow run-volume spike",
    },
    "creditAlert.rule.flowFailLoop": {
        "ko_KR": "플로우 실패 루프 의심",
        "en_US": "Suspected flow failure loop",
    },
    "creditAlert.rule.runawayAutonomous": {
        "ko_KR": "자율 에이전트 폭주 실행",
        "en_US": "Runaway autonomous agent",
    },
    "creditAlert.rule.highRiskAgent": {
        "ko_KR": "고위험 에이전트(정적 예측)",
        "en_US": "High-risk agent (static prediction)",
    },
}
