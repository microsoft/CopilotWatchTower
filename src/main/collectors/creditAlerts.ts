/**
 * Multi-signal credit alert engine — port of services/credit_alerts.py.
 * Pure compute over repository read methods; evaluates the admin-tuned rules
 * and persists fired alerts. Billing tier (per-agent / per-user day-over-day
 * deltas + projected monthly budget) is fully active; the realtime (flow) and
 * predictive (agent-risk) tiers are wired but inert until those collectors
 * land (flow_runs / agent_definitions are not yet populated in Node).
 */
import * as db from '../db'

const SEV_WARN = 'warn'
const TIER_BILLING = 'billing'

interface Rule {
  threshold: number
  secondary: number
  severity: string
}

function severityFor(rule: Rule, metric: number): string {
  return rule.threshold && metric >= 2 * rule.threshold ? 'danger' : rule.severity
}

interface RecOpts {
  severity: string
  tier: string
  scopeType: string
  scopeId?: string | null
  scopeLabel?: string | null
  environmentName?: string | null
  metric?: number | null
  threshold?: number | null
  baseline?: number | null
  usageDate?: string | null
  detail?: Record<string, unknown>
}
function rec(ruleKey: string, o: RecOpts): db.CreditAlertRecord {
  return {
    rule_key: ruleKey,
    severity: o.severity,
    tier: o.tier,
    scope_type: o.scopeType,
    scope_id: o.scopeId ?? null,
    scope_label: o.scopeLabel ?? null,
    environment_name: o.environmentName ?? null,
    metric: o.metric ?? null,
    threshold: o.threshold ?? null,
    baseline: o.baseline ?? null,
    usage_date: o.usageDate ?? null,
    detail_json: o.detail ? JSON.stringify(o.detail) : null
  }
}

/** Evaluate all enabled rules against current data, persist alerts. */
export function evaluateCreditAlerts(windowDays = 30): { evaluated: number; newAlerts: number } {
  const rules = db.listCreditAlertRules()
  const byKey = new Map<string, Rule>()
  for (const r of rules) {
    if (r.enabled) byKey.set(r.rule_key, { threshold: r.threshold, secondary: r.secondary, severity: r.severity || SEV_WARN })
  }
  if (!byKey.size) return { evaluated: 0, newAlerts: 0 }

  const month = new Date().toISOString().slice(0, 7)
  const out: db.CreditAlertRecord[] = []

  // ---- billing: per-agent deltas -----------------------------------------
  const agentRule = byKey.get('agent_daily_abs')
  const spikeRule = byKey.get('spike')
  if (agentRule || spikeRule) {
    for (const a of db.agentCreditDeltas(windowDays)) {
      const lastDelta = a.last_delta
      const baseline = a.baseline_daily
      const ratio = a.spike_ratio
      if (agentRule && lastDelta >= agentRule.threshold) {
        out.push(
          rec('agent_daily_abs', {
            severity: severityFor(agentRule, lastDelta),
            tier: TIER_BILLING,
            scopeType: 'agent',
            scopeId: a.product ?? null,
            scopeLabel: a.name ?? a.product ?? null,
            environmentName: a.environment_name,
            metric: lastDelta,
            threshold: agentRule.threshold,
            baseline,
            usageDate: a.last_date,
            detail: { latest_quantity: a.latest_quantity }
          })
        )
      }
      if (spikeRule && baseline >= spikeRule.secondary && ratio !== null && ratio >= spikeRule.threshold) {
        out.push(
          rec('spike', {
            severity: severityFor(spikeRule, ratio),
            tier: TIER_BILLING,
            scopeType: 'agent',
            scopeId: a.product ?? null,
            scopeLabel: a.name ?? a.product ?? null,
            environmentName: a.environment_name,
            metric: ratio,
            threshold: spikeRule.threshold,
            baseline,
            usageDate: a.last_date,
            detail: { last_delta: lastDelta }
          })
        )
      }
    }
  }

  // ---- billing: per-user deltas ------------------------------------------
  const userRule = byKey.get('user_daily_abs')
  if (userRule || spikeRule) {
    for (const u of db.userCreditDeltas(windowDays)) {
      const lastDelta = u.last_delta
      const baseline = u.baseline_daily
      const ratio = u.spike_ratio
      if (userRule && lastDelta >= userRule.threshold) {
        out.push(
          rec('user_daily_abs', {
            severity: severityFor(userRule, lastDelta),
            tier: TIER_BILLING,
            scopeType: 'user',
            scopeId: u.user_id ?? null,
            scopeLabel: u.display_name ?? u.user_id ?? null,
            metric: lastDelta,
            threshold: userRule.threshold,
            baseline,
            usageDate: u.last_date,
            detail: { upn: u.upn }
          })
        )
      }
      if (spikeRule && baseline >= spikeRule.secondary && ratio !== null && ratio >= spikeRule.threshold) {
        out.push(
          rec('spike', {
            severity: severityFor(spikeRule, ratio),
            tier: TIER_BILLING,
            scopeType: 'user',
            scopeId: u.user_id ?? null,
            scopeLabel: u.display_name ?? u.user_id ?? null,
            metric: ratio,
            threshold: spikeRule.threshold,
            baseline,
            usageDate: u.last_date,
            detail: { last_delta: lastDelta, upn: u.upn }
          })
        )
      }
    }
  }

  // ---- billing: projected monthly budget ---------------------------------
  const budgetRule = byKey.get('monthly_budget')
  if (budgetRule) {
    const summary = db.consumptionSummary('MCSMessages:resource', windowDays)
    const projected = summary.projected_month
    if (projected >= budgetRule.threshold) {
      out.push(
        rec('monthly_budget', {
          severity: severityFor(budgetRule, projected),
          tier: TIER_BILLING,
          scopeType: 'tenant',
          scopeId: '_tenant',
          metric: projected,
          threshold: budgetRule.threshold,
          baseline: summary.total,
          usageDate: month
        })
      )
    }
  }

  // realtime (flow_run_agent_summary) tier is inert until flow-run daily
  // aggregation is added; flow_runs collection exists but spike detection needs
  // a daily baseline series.

  // ---- predictive: high-risk agent definitions ---------------------------
  const riskRule = byKey.get('high_risk_agent')
  if (riskRule) {
    for (const agent of db.highRiskAgents(riskRule.threshold)) {
      out.push(
        rec('high_risk_agent', {
          severity: severityFor(riskRule, agent.risk_score),
          tier: 'predictive',
          scopeType: 'agent',
          scopeId: agent.id,
          scopeLabel: agent.bot_name,
          environmentName: agent.environment_name,
          metric: agent.risk_score,
          threshold: riskRule.threshold,
          baseline: null,
          usageDate: null,
          detail: {
            band: agent.risk_band,
            has_trigger: agent.has_trigger,
            external_call_count: agent.external_call_count,
            loop_count: agent.loop_count
          }
        })
      )
    }
  }

  const newAlerts = db.upsertCreditAlerts(out)
  return { evaluated: out.length, newAlerts }
}
