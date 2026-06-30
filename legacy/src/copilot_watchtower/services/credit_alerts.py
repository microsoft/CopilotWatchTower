"""Multi-signal credit alert engine (pure, HTTP-free, unit-testable).

Evaluates the admin-tuned rule set across the three signal tiers the feature
collects, and returns the alerts that should be persisted. Kept free of Qt and
of any I/O beyond the repository read methods passed in, so it can be tested
exhaustively with a fake repo.

Tiers (each labelled in the UI so the lag/accuracy trade-off is explicit):

* **billing** — authoritative but lagged. Per-agent / per-user day-over-day
  deltas of the licensing MCSMessages snapshot, plus the projected monthly
  budget. Catches autonomous agents too (they are billed regardless of a human).
* **realtime** — fresh but a leading indicator (run counts ≠ billed credits).
  Flow-run volume spikes, failure loops, and runaway autonomous run counts.
* **predictive** — static, a prediction not a certainty. Agents whose definition
  scores as high-risk *before* they ever run away.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from ..db.repository import CreditAlertRecord, CreditAlertRule

TIER_BILLING = "billing"
TIER_REALTIME = "realtime"
TIER_PREDICTIVE = "predictive"

SEV_WARN = "warn"
SEV_DANGER = "danger"


class _RepoLike(Protocol):
    def agent_credit_deltas(self, *, days: int = ..., limit: int = ...) -> list[dict[str, Any]]: ...
    def user_credit_deltas(self, *, days: int = ..., limit: int = ...) -> list[dict[str, Any]]: ...
    def consumption_summary(self, *, report_type: str, days: int = ...) -> dict[str, Any]: ...
    def flow_run_agent_summary(self, *, days: int = ..., limit: int = ...) -> list[dict[str, Any]]: ...
    def high_risk_agents(self, *, min_score: float = ...) -> list[Any]: ...


@dataclass
class _Rule:
    enabled: bool
    threshold: float
    secondary: float
    severity: str


def _rules_by_key(rules: list[CreditAlertRule]) -> dict[str, _Rule]:
    out: dict[str, _Rule] = {}
    for r in rules:
        if not r.enabled:
            continue
        out[r.rule_key] = _Rule(
            enabled=r.enabled,
            threshold=float(r.threshold or 0.0),
            secondary=float(r.secondary or 0.0),
            severity=r.severity or SEV_WARN,
        )
    return out


def _severity(rule: _Rule, metric: float) -> str:
    """Escalate to danger when the metric is at least double the threshold."""
    if rule.threshold and metric >= 2.0 * rule.threshold:
        return SEV_DANGER
    return rule.severity


def _rec(
    rule_key: str,
    *,
    severity: str,
    tier: str,
    scope_type: str,
    scope_id: str | None,
    scope_label: str | None,
    environment_name: str | None,
    metric: float | None,
    threshold: float | None,
    baseline: float | None,
    usage_date: str | None,
    detail: dict[str, Any] | None = None,
) -> CreditAlertRecord:
    return CreditAlertRecord(
        rule_key=rule_key,
        severity=severity,
        tier=tier,
        scope_type=scope_type,
        scope_id=scope_id,
        scope_label=scope_label,
        environment_name=environment_name,
        metric=(round(float(metric), 2) if metric is not None else None),
        threshold=threshold,
        baseline=(round(float(baseline), 2) if baseline is not None else None),
        usage_date=usage_date,
        detail_json=json.dumps(detail, ensure_ascii=False) if detail else None,
    )


def evaluate_rules(
    repo: _RepoLike,
    rules: list[CreditAlertRule],
    *,
    now: datetime | None = None,
    window_days: int = 30,
    flow_window_days: int = 7,
) -> list[CreditAlertRecord]:
    """Evaluate every enabled rule and return the alerts to persist."""
    by_key = _rules_by_key(rules)
    if not by_key:
        return []
    moment = now or datetime.now(UTC)
    today = moment.strftime("%Y-%m-%d")
    month = moment.strftime("%Y-%m")
    out: list[CreditAlertRecord] = []

    # ---------------------------------------------------------------- billing
    agent_rule = by_key.get("agent_daily_abs")
    spike_rule = by_key.get("spike")
    if agent_rule or spike_rule:
        for a in repo.agent_credit_deltas(days=window_days):
            last_delta = float(a.get("last_delta") or 0.0)
            baseline = float(a.get("baseline_daily") or 0.0)
            ratio = a.get("spike_ratio")
            scope_id = a.get("product")
            label = a.get("name") or scope_id
            env = a.get("environment_name")
            date = a.get("last_date")
            if agent_rule and last_delta >= agent_rule.threshold:
                out.append(
                    _rec(
                        "agent_daily_abs",
                        severity=_severity(agent_rule, last_delta),
                        tier=TIER_BILLING,
                        scope_type="agent",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=env,
                        metric=last_delta,
                        threshold=agent_rule.threshold,
                        baseline=baseline,
                        usage_date=date,
                        detail={"latest_quantity": a.get("latest_quantity")},
                    )
                )
            if (
                spike_rule
                and baseline >= spike_rule.secondary
                and ratio is not None
                and ratio >= spike_rule.threshold
            ):
                out.append(
                    _rec(
                        "spike",
                        severity=_severity(spike_rule, float(ratio)),
                        tier=TIER_BILLING,
                        scope_type="agent",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=env,
                        metric=float(ratio),
                        threshold=spike_rule.threshold,
                        baseline=baseline,
                        usage_date=date,
                        detail={"last_delta": last_delta},
                    )
                )

    user_rule = by_key.get("user_daily_abs")
    if user_rule or spike_rule:
        for u in repo.user_credit_deltas(days=window_days):
            last_delta = float(u.get("last_delta") or 0.0)
            baseline = float(u.get("baseline_daily") or 0.0)
            ratio = u.get("spike_ratio")
            scope_id = u.get("user_id")
            label = u.get("display_name") or scope_id
            date = u.get("last_date")
            if user_rule and last_delta >= user_rule.threshold:
                out.append(
                    _rec(
                        "user_daily_abs",
                        severity=_severity(user_rule, last_delta),
                        tier=TIER_BILLING,
                        scope_type="user",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=None,
                        metric=last_delta,
                        threshold=user_rule.threshold,
                        baseline=baseline,
                        usage_date=date,
                        detail={"upn": u.get("upn")},
                    )
                )
            if (
                spike_rule
                and baseline >= spike_rule.secondary
                and ratio is not None
                and ratio >= spike_rule.threshold
            ):
                out.append(
                    _rec(
                        "spike",
                        severity=_severity(spike_rule, float(ratio)),
                        tier=TIER_BILLING,
                        scope_type="user",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=None,
                        metric=float(ratio),
                        threshold=spike_rule.threshold,
                        baseline=baseline,
                        usage_date=date,
                        detail={"last_delta": last_delta, "upn": u.get("upn")},
                    )
                )

    budget_rule = by_key.get("monthly_budget")
    if budget_rule:
        summary = repo.consumption_summary(report_type="MCSMessages:resource", days=window_days)
        projected = float(summary.get("projected_month") or 0.0)
        if projected >= budget_rule.threshold:
            out.append(
                _rec(
                    "monthly_budget",
                    severity=_severity(budget_rule, projected),
                    tier=TIER_BILLING,
                    scope_type="tenant",
                    scope_id="_tenant",
                    scope_label=None,
                    environment_name=None,
                    metric=projected,
                    threshold=budget_rule.threshold,
                    baseline=float(summary.get("total") or 0.0),
                    usage_date=month,
                )
            )

    # --------------------------------------------------------------- realtime
    flow_spike = by_key.get("flow_spike")
    fail_loop = by_key.get("flow_fail_loop")
    runaway = by_key.get("runaway_autonomous")
    if flow_spike or fail_loop or runaway:
        for f in repo.flow_run_agent_summary(days=flow_window_days):
            scope_id = f.get("workflow_id")
            label = f.get("workflow_name") or scope_id
            env = f.get("environment_name")
            runs_today = float(f.get("runs_today") or 0.0)
            baseline = float(f.get("baseline_daily") or 0.0)
            fail_rate = float(f.get("fail_rate") or 0.0)
            autonomous = float(f.get("autonomous_runs") or 0.0)
            if (
                flow_spike
                and baseline >= flow_spike.secondary
                and baseline > 0
                and (runs_today / baseline) >= flow_spike.threshold
            ):
                ratio = runs_today / baseline
                out.append(
                    _rec(
                        "flow_spike",
                        severity=_severity(flow_spike, ratio),
                        tier=TIER_REALTIME,
                        scope_type="flow",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=env,
                        metric=runs_today,
                        threshold=flow_spike.threshold,
                        baseline=baseline,
                        usage_date=today,
                        detail={"ratio": round(ratio, 2)},
                    )
                )
            if (
                fail_loop
                and runs_today >= fail_loop.secondary
                and fail_rate >= fail_loop.threshold
            ):
                out.append(
                    _rec(
                        "flow_fail_loop",
                        severity=_severity(fail_loop, fail_rate),
                        tier=TIER_REALTIME,
                        scope_type="flow",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=env,
                        metric=round(fail_rate, 3),
                        threshold=fail_loop.threshold,
                        baseline=runs_today,
                        usage_date=today,
                        detail={"failed_runs": f.get("failed_runs")},
                    )
                )
            if runaway and autonomous >= runaway.threshold:
                out.append(
                    _rec(
                        "runaway_autonomous",
                        severity=_severity(runaway, autonomous),
                        tier=TIER_REALTIME,
                        scope_type="flow",
                        scope_id=scope_id,
                        scope_label=label,
                        environment_name=env,
                        metric=autonomous,
                        threshold=runaway.threshold,
                        baseline=baseline,
                        usage_date=today,
                        detail={"total_runs": f.get("total_runs")},
                    )
                )

    # ------------------------------------------------------------- predictive
    risk_rule = by_key.get("high_risk_agent")
    if risk_rule:
        for agent in repo.high_risk_agents(min_score=risk_rule.threshold):
            score = float(getattr(agent, "risk_score", 0.0) or 0.0)
            out.append(
                _rec(
                    "high_risk_agent",
                    severity=_severity(risk_rule, score),
                    tier=TIER_PREDICTIVE,
                    scope_type="agent",
                    scope_id=getattr(agent, "id", None),
                    scope_label=getattr(agent, "bot_name", None),
                    environment_name=getattr(agent, "environment_name", None),
                    metric=score,
                    threshold=risk_rule.threshold,
                    baseline=None,
                    # Predictive alerts are a standing property of the agent, not
                    # a daily event — no date so re-evaluation refreshes the same
                    # alert instead of stacking one per day.
                    usage_date=None,
                    detail={
                        "band": getattr(agent, "risk_band", None),
                        "has_trigger": getattr(agent, "has_trigger", None),
                        "external_call_count": getattr(agent, "external_call_count", None),
                        "loop_count": getattr(agent, "loop_count", None),
                    },
                )
            )

    return out
