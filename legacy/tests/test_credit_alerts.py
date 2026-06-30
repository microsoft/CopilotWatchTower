"""Unit tests for the agent credit-governance feature (3-tier alert engine).

Covers, without touching any live (unofficial) API:

* ``services.agent_risk.analyze_agent`` — the 5-factor static risk score;
* ``services.flow_runs.parse_flow_run_rows`` — flowrun record → row mapping;
* ``Repository`` — flow-run + agent-definition persistence/aggregation, the
  cumulative-snapshot credit DELTA helpers (LAG), and alert rule/alert CRUD;
* ``services.credit_alerts.evaluate_rules`` — all three tiers, the spike noise
  floor, severity escalation, and dedup idempotency;
* ``Bridge`` JSON surfaces for the new slots.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from copilot_watchtower.db import (
    AgentDefinitionRow,
    ConsumptionRow,
    FlowRunRow,
    Repository,
    UserRow,
    initialize,
)
from copilot_watchtower.services.agent_risk import analyze_agent
from copilot_watchtower.services.credit_alerts import evaluate_rules
from copilot_watchtower.services.flow_runs import parse_flow_run_rows
from copilot_watchtower.webshell.bridge import Bridge, BridgeContext


def _date(days_ago: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).strftime("%Y-%m-%d")


def _today() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# agent_risk: 5-factor static scoring
# --------------------------------------------------------------------------


def test_risk_autonomous_runaway_is_critical() -> None:
    components = [
        {"componenttype": 5, "data": "{\"kind\": \"Recurrence\"}"},  # trigger
        {"componenttype": 9, "data": "foreach item HttpRequest connectionReference apiId while loop"},
        {"componenttype": 15, "data": "GenerativeActions orchestration generative"},
        {"componenttype": 16, "data": "knowledge source A"},
        {"componenttype": 16, "data": "knowledge source B"},
    ]
    profile = analyze_agent(components)
    assert profile.has_trigger is True
    assert profile.external_call_count >= 1
    assert profile.loop_count >= 1
    assert profile.generative_orchestration is True
    assert profile.knowledge_count == 2
    assert profile.score >= 75
    assert profile.band == "critical"
    # Factor breakdown is JSON-serialisable and covers all 5 groups + knowledge.
    factors = json.loads(profile.factors_json())
    keys = {f["key"] for f in factors}
    assert {"autonomy", "external_calls", "tools", "loops", "generative_orchestration", "knowledge"} <= keys


def test_risk_benign_agent_is_low() -> None:
    profile = analyze_agent([{"componenttype": 0, "data": "a simple greeting topic"}])
    assert profile.has_trigger is False
    assert profile.band == "low"
    assert profile.score == 0.0


def test_risk_empty_definition_is_safe() -> None:
    profile = analyze_agent([])
    assert profile.component_count == 0
    assert profile.band == "low"


# --------------------------------------------------------------------------
# flow_runs parser
# --------------------------------------------------------------------------


def test_parse_flow_run_rows_maps_fields_and_formatted_names() -> None:
    records = [
        {
            "flowrunid": "fr1",
            "status": "Failed",
            "starttime": "2026-06-12T01:00:00Z",
            "endtime": "2026-06-12T01:00:05Z",
            "duration": 5000,
            "errorcode": "X",
            "modernflowtype": 2,
            "conversationid": "",
            "createdon": "2026-06-12T01:00:06Z",
            "_workflow_value": "wf1",
            "_workflow_value@OData.Community.Display.V1.FormattedValue": "Nightly Sync",
            "_ownerid_value": "o1",
            "_ownerid_value@OData.Community.Display.V1.FormattedValue": "Sam",
        },
        {"status": "Succeeded"},  # no id → dropped
    ]
    rows = parse_flow_run_rows(records, environment_id="e1", environment_name="Prod")
    assert len(rows) == 1
    r = rows[0]
    assert r.id == "fr1"
    assert r.workflow_name == "Nightly Sync"
    assert r.owner_name == "Sam"
    assert r.modern_flow_type == 2
    assert r.duration_ms == 5000
    assert r.run_date == "2026-06-12"


# --------------------------------------------------------------------------
# Repository fixtures
# --------------------------------------------------------------------------


@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    r = Repository(db)
    r.upsert_users([UserRow("u-1", "u1@x", "User One", True, True, True)])
    return r


def _consumption(report_type: str, day: str, product: str | None, qty: float, user_id: str | None = None) -> ConsumptionRow:
    return ConsumptionRow(
        report_type=report_type,
        usage_date=day,
        environment_id="e1",
        environment_name="Prod",
        user_id=user_id,
        product=product,
        quantity=qty,
        unit="messages",
    )


def _flow_run(run_id: str, *, status: str, day: str, autonomous: bool, error: bool = False) -> FlowRunRow:
    return FlowRunRow(
        id=run_id,
        environment_id="e1",
        environment_name="Prod",
        workflow_id="wf1",
        workflow_name="NightlyAgentFlow",
        modern_flow_type=2,
        conversation_id=None if autonomous else "conv-1",
        bot_id=None,
        owner_id="o1",
        owner_name="Sam",
        status=status,
        trigger_type="Recurrence",
        start_time=f"{day}T01:00:00Z",
        end_time=None,
        duration_ms=10,
        error_code="E" if error else None,
        error_message=None,
        run_date=day,
        created_on=f"{day}T01:00:00Z",
        raw_json="{}",
    )


# --------------------------------------------------------------------------
# Repository: flow runs
# --------------------------------------------------------------------------


def test_flow_run_upsert_counts_new_and_summary(repo: Repository) -> None:
    runs = [
        _flow_run("a", status="Failed", day=_today(), autonomous=True, error=True),
        _flow_run("b", status="Succeeded", day=_today(), autonomous=False),
        _flow_run("c", status="Failed", day=_date(1), autonomous=True, error=True),
    ]
    assert repo.upsert_flow_runs(runs) == 3
    # existing-id detection (used to count genuinely-new rows)
    assert repo.existing_flow_run_ids(["a", "b", "zzz"]) == {"a", "b"}
    summary = repo.flow_run_agent_summary(days=7)
    assert len(summary) == 1
    s = summary[0]
    assert s["workflow_id"] == "wf1"
    assert s["runs_today"] == 2
    assert s["autonomous_runs"] == 2
    assert s["fail_rate"] == pytest.approx(2 / 3)
    overview = repo.flow_run_overview(days=7)
    assert overview["total_runs"] == 3
    assert overview["runs_today"] == 2
    assert overview["flow_count"] == 1


# --------------------------------------------------------------------------
# Repository: agent definitions
# --------------------------------------------------------------------------


def test_agent_definition_upsert_list_and_high_risk(repo: Repository) -> None:
    rows = [
        AgentDefinitionRow(
            id="b1", environment_id="e1", environment_name="Prod", bot_name="Risky",
            schema_name="cr_r", state="Active", component_count=8, has_trigger=True,
            external_call_count=5, tool_count=2, loop_count=3, knowledge_count=1,
            generative_orchestration=True, risk_score=88.0, risk_band="critical",
            risk_factors_json="[]",
        ),
        AgentDefinitionRow(
            id="b2", environment_id="e1", environment_name="Prod", bot_name="Calm",
            schema_name="cr_c", state="Active", component_count=2, has_trigger=False,
            external_call_count=0, tool_count=0, loop_count=0, knowledge_count=0,
            generative_orchestration=False, risk_score=5.0, risk_band="low",
            risk_factors_json="[]",
        ),
    ]
    assert repo.upsert_agent_definitions(rows) == 2
    listed = repo.list_agent_definitions()
    assert [a.bot_name for a in listed] == ["Risky", "Calm"]  # risk_score DESC
    high = repo.high_risk_agents(min_score=75)
    assert [a.id for a in high] == ["b1"]
    assert repo.get_agent_definition("b1").risk_score == 88.0


# --------------------------------------------------------------------------
# Repository: cumulative-snapshot credit deltas
# --------------------------------------------------------------------------


def test_agent_credit_deltas_detect_spike(repo: Repository) -> None:
    # AgentB cumulative 10 -> 20 -> 5020: last delta 5000 over baseline 10.
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(2), "AgentB", 10.0),
            _consumption("MCSMessages:resource", _date(1), "AgentB", 20.0),
            _consumption("MCSMessages:resource", _today(), "AgentB", 5020.0),
        ]
    )
    deltas = repo.agent_credit_deltas(days=30)
    assert deltas[0]["name"] == "AgentB"
    assert deltas[0]["last_delta"] == 5000.0
    assert deltas[0]["baseline_daily"] == 10.0
    assert deltas[0]["spike_ratio"] == 500.0
    trend = repo.agent_credit_trend(product="AgentB", days=30)
    assert trend[-1] == (_today(), 5000.0)


def test_user_credit_deltas_resolve_names(repo: Repository) -> None:
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:user", _date(1), None, 10.0, user_id="u-1"),
            _consumption("MCSMessages:user", _today(), None, 410.0, user_id="u-1"),
        ]
    )
    deltas = repo.user_credit_deltas(days=30)
    assert deltas[0]["user_id"] == "u-1"
    assert deltas[0]["last_delta"] == 400.0
    assert deltas[0]["display_name"] == "User One"


def test_new_agent_candidates(repo: Repository) -> None:
    repo.upsert_consumption_rows(
        [_consumption("MCSMessages:resource", _today(), "FreshBot", 4000.0)]
    )
    candidates = repo.new_agent_candidates(days=7)
    assert any(c["name"] == "FreshBot" for c in candidates)


# --------------------------------------------------------------------------
# Repository: alert rules + alerts
# --------------------------------------------------------------------------


def test_default_alert_rules_seeded(repo: Repository) -> None:
    rules = {r.rule_key: r for r in repo.get_credit_alert_rules()}
    assert "agent_daily_abs" in rules
    assert "high_risk_agent" in rules
    # monthly_budget is seeded disabled (needs a real budget to be useful).
    assert rules["monthly_budget"].enabled is False
    assert rules["agent_daily_abs"].enabled is True


def test_alert_upsert_dedup_and_acknowledge(repo: Repository) -> None:
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(1), "AgentB", 20.0),
            _consumption("MCSMessages:resource", _today(), "AgentB", 5020.0),
        ]
    )
    rules = repo.get_credit_alert_rules()
    records = evaluate_rules(repo, rules)
    first = repo.upsert_credit_alerts(records)
    assert first >= 1
    # Re-evaluating the same data must not create NEW alerts (dedup).
    assert repo.upsert_credit_alerts(evaluate_rules(repo, rules)) == 0
    active_before = repo.active_credit_alert_count()
    assert active_before >= 1
    alert = repo.list_credit_alerts(status="active")[0]
    assert repo.acknowledge_credit_alert(alert.id) is True
    assert repo.active_credit_alert_count() == active_before - 1


# --------------------------------------------------------------------------
# Engine: evaluate_rules across the three tiers
# --------------------------------------------------------------------------


def test_engine_fires_all_three_tiers(repo: Repository) -> None:
    # Billing tier: agent absolute + spike, user absolute.
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(1), "AgentB", 20.0),
            _consumption("MCSMessages:resource", _today(), "AgentB", 5020.0),
            _consumption("MCSMessages:user", _date(1), None, 10.0, user_id="u-1"),
            _consumption("MCSMessages:user", _today(), None, 800.0, user_id="u-1"),
        ]
    )
    # Realtime tier: failure loop + runaway autonomous.
    runs = []
    for i in range(1200):
        runs.append(
            _flow_run(f"r{i}", status="Failed" if i % 2 == 0 else "Succeeded", day=_today(), autonomous=True, error=i % 2 == 0)
        )
    repo.upsert_flow_runs(runs)
    # Predictive tier: a high-risk agent.
    repo.upsert_agent_definitions(
        [
            AgentDefinitionRow(
                id="b1", environment_id="e1", environment_name="Prod", bot_name="Risky",
                schema_name="cr_r", state="Active", component_count=8, has_trigger=True,
                external_call_count=5, tool_count=2, loop_count=3, knowledge_count=1,
                generative_orchestration=True, risk_score=90.0, risk_band="critical",
                risk_factors_json="[]",
            )
        ]
    )
    records = evaluate_rules(repo, repo.get_credit_alert_rules())
    fired = {r.rule_key for r in records}
    tiers = {r.tier for r in records}
    assert {"agent_daily_abs", "user_daily_abs", "flow_fail_loop", "runaway_autonomous", "high_risk_agent"} <= fired
    assert {"billing", "realtime", "predictive"} <= tiers
    # Agent absolute delta is 2× threshold (5000 >= 2*500) → escalated to danger.
    agent_abs = next(r for r in records if r.rule_key == "agent_daily_abs")
    assert agent_abs.severity == "danger"


def test_spike_respects_noise_floor(repo: Repository) -> None:
    # Baseline 5 (< default secondary floor 50): the spike rule must NOT fire,
    # even though the ratio is huge — the absolute rule is the right signal here.
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(1), "TinyBot", 5.0),
            _consumption("MCSMessages:resource", _today(), "TinyBot", 205.0),
        ]
    )
    records = evaluate_rules(repo, repo.get_credit_alert_rules())
    assert not any(r.rule_key == "spike" for r in records)


def test_spike_fires_above_floor(repo: Repository) -> None:
    # Baseline 60 (>= floor 50), ratio 200/60 ≈ 3.3 (>= 3), last delta 200 (< 500 abs):
    # only the spike rule should fire.
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(2), "SubtleBot", 0.0),
            _consumption("MCSMessages:resource", _date(1), "SubtleBot", 60.0),
            _consumption("MCSMessages:resource", _today(), "SubtleBot", 260.0),
        ]
    )
    records = evaluate_rules(repo, repo.get_credit_alert_rules())
    fired = {r.rule_key for r in records}
    assert "spike" in fired
    assert "agent_daily_abs" not in fired


def test_disabled_rule_does_not_fire(repo: Repository) -> None:
    repo.update_credit_alert_rule("agent_daily_abs", enabled=False)
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(1), "AgentB", 20.0),
            _consumption("MCSMessages:resource", _today(), "AgentB", 9020.0),
        ]
    )
    records = evaluate_rules(repo, repo.get_credit_alert_rules())
    assert not any(r.rule_key == "agent_daily_abs" for r in records)


# --------------------------------------------------------------------------
# Bridge JSON surfaces
# --------------------------------------------------------------------------


@pytest.fixture
def bridge(qtbot, repo: Repository) -> Bridge:
    del qtbot  # ensures a QApplication exists
    return Bridge(BridgeContext(repo=repo))


def test_bridge_credit_and_flow_and_risk_slots(bridge: Bridge, repo: Repository) -> None:
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(1), "AgentB", 20.0),
            _consumption("MCSMessages:resource", _today(), "AgentB", 5020.0),
        ]
    )
    repo.upsert_flow_runs([_flow_run("a", status="Failed", day=_today(), autonomous=True, error=True)])
    repo.upsert_agent_definitions(
        [
            AgentDefinitionRow(
                id="b1", environment_id="e1", environment_name="Prod", bot_name="Risky",
                schema_name="cr_r", state="Active", component_count=8, has_trigger=True,
                external_call_count=5, tool_count=2, loop_count=3, knowledge_count=1,
                generative_orchestration=True, risk_score=90.0, risk_band="critical",
                risk_factors_json=json.dumps([{"key": "autonomy", "score": 30, "count": 1}]),
            )
        ]
    )

    agents = json.loads(bridge.credit_agent_analysis(json.dumps({"days": 30})))
    assert agents[0]["name"] == "AgentB"

    flow = json.loads(bridge.flow_run_overview(json.dumps({"days": 7})))
    assert set(flow.keys()) == {"overview", "trend", "agents"}

    risk = json.loads(bridge.agent_risk_list(json.dumps({})))
    assert risk[0]["bot_name"] == "Risky"
    assert risk[0]["risk_factors"][0]["key"] == "autonomy"


def test_bridge_alert_rules_update_and_list(bridge: Bridge, repo: Repository) -> None:
    # Update a rule via the bridge, then confirm it round-trips.
    result = json.loads(
        bridge.credit_alert_rules_update(json.dumps({"rule_key": "agent_daily_abs", "threshold": 123}))
    )
    assert result["ok"] is True
    rules = {r["rule_key"]: r for r in json.loads(bridge.credit_alert_rules_get())}
    assert rules["agent_daily_abs"]["threshold"] == 123

    # Fire an alert, then list + acknowledge through the bridge.
    repo.upsert_consumption_rows(
        [
            _consumption("MCSMessages:resource", _date(1), "AgentB", 20.0),
            _consumption("MCSMessages:resource", _today(), "AgentB", 5020.0),
        ]
    )
    repo.upsert_credit_alerts(evaluate_rules(repo, repo.get_credit_alert_rules()))
    listed = json.loads(bridge.credit_alerts_list(json.dumps({"status": "active"})))
    assert listed["active"] >= 1
    alert_id = listed["alerts"][0]["id"]
    ack = json.loads(bridge.credit_alert_acknowledge(json.dumps({"id": alert_id})))
    assert ack["ok"] is True
