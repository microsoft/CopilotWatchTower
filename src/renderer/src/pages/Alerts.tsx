import { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'

interface Rule {
  name: string
  cond: string
  on: boolean
}
interface CreditAlert {
  rule_key: string
  severity: string
  tier: string
  scope_type: string
  scope_label: string | null
  environment_name: string | null
  metric: number | null
  threshold: number | null
  usage_date: string | null
  last_seen: string
}

const RULES: Rule[] = [
  { name: '월 크레딧 80% 초과', cond: '사용량 ≥ 4,000 / 5,000', on: true },
  { name: '일일 급증 감지', cond: '전일 대비 +50%', on: true },
  { name: '환경별 한도 초과', cond: '환경 크레딧 ≥ 1,500', on: false },
  { name: '잔여 5% 미만', cond: '잔여 ≤ 250', on: true }
]

const RULE_LABEL_KEYS = [
  'agent_daily_abs',
  'user_daily_abs',
  'spike',
  'monthly_budget',
  'flow_spike',
  'flow_fail_loop',
  'runaway_autonomous',
  'high_risk_agent'
] as const

function n(v: number | null): string {
  return (v ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 })
}

export function Alerts(): JSX.Element {
  const { t } = useTranslation('alerts')
  const RULE_LABEL: Record<string, string> = Object.fromEntries(
    RULE_LABEL_KEYS.map((k) => [k, t(`ruleLabel.${k}`)])
  )
  const [rules, setRules] = useState<Rule[]>(RULES)
  const [alerts, setAlerts] = useState<CreditAlert[]>([])
  const [evaluating, setEvaluating] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  function load(): void {
    invoke<Rule[] | null>('alert_rules')
      .then((d) => {
        if (d && d.length) setRules(d)
      })
      .catch(() => {})
    invoke<CreditAlert[] | null>('alerts_list')
      .then((d) => {
        if (d) setAlerts(d)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  async function evaluate(): Promise<void> {
    setEvaluating(true)
    setMsg(t('evaluating'))
    try {
      const r = await invoke<{ ok: boolean; evaluated?: number; newAlerts?: number; error?: string }>('alerts_evaluate')
      setMsg(r.ok ? t('evaluated', { count: r.evaluated ?? 0, newCount: r.newAlerts ?? 0 }) : t('error', { error: r.error }))
      load()
    } finally {
      setEvaluating(false)
      setTimeout(() => setMsg(null), 5000)
    }
  }

  return (
    <div className="content">
      <div className="page-actions">
        <button className="btn primary" onClick={evaluate} disabled={evaluating}>
          {evaluating ? <Loader2 size={15} className="spin" /> : <Play size={15} />} {t('evaluateNow')}
        </button>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('rules.title')}</h2>
            <span className="hint">{t('rules.activeCount', { count: rules.filter((r) => r.on).length })}</span>
          </div>
          <div className="card-body">
            {rules.map((r) => (
              <div className="setrow" key={r.name}>
                <div>
                  <div className="setname">{r.name}</div>
                  <div className="muted">{r.cond}</div>
                </div>
                <span className={`switch${r.on ? ' on' : ''}`}>
                  <span />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('fired.title')}</h2>
            <span className="hint">{t('fired.activeCount', { count: alerts.length })}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('columns.rule')}</th>
                <th>{t('columns.target')}</th>
                <th>{t('columns.valueVsThreshold')}</th>
                <th>{t('columns.severity')}</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('fired.empty')}
                  </td>
                </tr>
              ) : (
                alerts.map((a, i) => (
                  <tr key={i}>
                    <td>{RULE_LABEL[a.rule_key] || a.rule_key}</td>
                    <td className="ttl">{a.scope_label || a.scope_type}</td>
                    <td className="muted">
                      {n(a.metric)} / {n(a.threshold)}
                    </td>
                    <td>
                      <span className={`sev ${a.severity === 'danger' ? 'high' : 'med'}`}>
                        {a.severity === 'danger' ? t('severity.danger') : t('severity.warn')}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
