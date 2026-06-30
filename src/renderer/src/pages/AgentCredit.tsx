import { useEffect, useState } from 'react'
import { Bot, Coins, Boxes, Crown } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { invoke } from '../lib/api'

interface AgentRow {
  name: string
  env: string
  messages: number
  share: number
}
interface DTO {
  kpis: { agents: number; messages: number; environments: number; top: string }
  agents: AgentRow[]
}

const FALLBACK: DTO = {
  kpis: { agents: 0, messages: 0, environments: 0, top: '—' },
  agents: []
}

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function AgentCredit(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  useEffect(() => {
    invoke<DTO | null>('agent_credit_overview')
      .then((x) => {
        if (x) setD(x)
      })
      .catch(() => {})
  }, [])

  return (
    <div className="content">
      <div className="kpi-row">
        <Kpi icon={<Bot />} label="소비 에이전트" value={n(d.kpis.agents)} foot="MCSMessages" />
        <Kpi icon={<Coins />} label="총 메시지" value={n(d.kpis.messages)} foot="소비량" />
        <Kpi icon={<Boxes />} label="환경" value={n(d.kpis.environments)} foot="environments" />
        <Kpi icon={<Crown />} label="최다 소비" value={d.kpis.top} foot="top agent" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>에이전트별 메시지 소비</h2>
          <span className="hint">상위 {d.agents.length}개</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>에이전트</th>
              <th>환경</th>
              <th>메시지</th>
              <th>비중</th>
            </tr>
          </thead>
          <tbody>
            {d.agents.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  에이전트 소비 데이터가 없습니다. 크레딧 데이터 수집(포털)을 먼저 실행하세요.
                </td>
              </tr>
            ) : (
              d.agents.map((a, i) => (
                <tr key={i}>
                  <td className="ttl">{a.name}</td>
                  <td className="muted mono">{a.env}</td>
                  <td className="muted">{n(a.messages)}</td>
                  <td>
                    <div className="minimeter">
                      <span style={{ width: `${Math.min(100, a.share)}%` }} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
