import { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
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

const RULE_LABEL: Record<string, string> = {
  agent_daily_abs: '에이전트 일일 한도',
  user_daily_abs: '사용자 일일 한도',
  spike: '급증 감지',
  monthly_budget: '월 예산 초과',
  flow_spike: '플로우 급증',
  flow_fail_loop: '플로우 실패 루프',
  runaway_autonomous: '자율 실행 폭주',
  high_risk_agent: '고위험 에이전트'
}

function n(v: number | null): string {
  return (v ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 })
}

export function Alerts(): JSX.Element {
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
    setMsg('규칙을 평가하는 중…')
    try {
      const r = await invoke<{ ok: boolean; evaluated?: number; newAlerts?: number; error?: string }>('alerts_evaluate')
      setMsg(r.ok ? `평가 완료: ${r.evaluated ?? 0}건 (신규 ${r.newAlerts ?? 0})` : `오류: ${r.error}`)
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
          {evaluating ? <Loader2 size={15} className="spin" /> : <Play size={15} />} 지금 평가
        </button>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>활성 알림 규칙</h2>
            <span className="hint">{rules.filter((r) => r.on).length}개 활성</span>
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
            <h2>발생한 알림</h2>
            <span className="hint">활성 {alerts.length}건</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>규칙</th>
                <th>대상</th>
                <th>값 / 임계</th>
                <th>심각도</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    발생한 알림이 없습니다. 데이터를 수집한 뒤 “지금 평가”를 눌러주세요.
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
                        {a.severity === 'danger' ? '위험' : '경고'}
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
