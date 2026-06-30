import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, AlertTriangle, Zap, Boxes, CloudDownload, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface AgentRow {
  name: string
  env: string
  score: number
  band: string
  trigger: boolean
  external: number
  loops: number
}
interface DTO {
  kpis: { agents: number; high: number; triggers: number; environments: number }
  agents: AgentRow[]
}

const FALLBACK: DTO = { kpis: { agents: 0, high: 0, triggers: 0, environments: 0 }, agents: [] }

const BAND_LABEL: Record<string, string> = { critical: '심각', high: '높음', medium: '보통', low: '낮음' }
function bandSev(band: string): string {
  if (band === 'critical' || band === 'high') return 'high'
  if (band === 'medium') return 'med'
  return 'low'
}
function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function AgentDefsCollect(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('agentdefs')

  function load(): void {
    invoke<DTO | null>('agent_defs_status')
      .then((x) => {
        if (x) setD(x)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  const prevRunning = useRef(run.running)
  useEffect(() => {
    if (prevRunning.current && !run.running) load()
    prevRunning.current = run.running
  }, [run.running])

  return (
    <div className="content">
      <div className="page-actions">
        <button className="btn primary" onClick={() => startRun('agentdefs')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />} 포털에서 에이전트 위험 분석
        </button>
      </div>
      <p className="ediscovery-desc">
        설정의 <strong>다운로드 계정</strong>(eDiscovery 서비스 계정)으로 메이커 포털에 자동 로그인합니다. 계정이
        없으면 로그인 창이 표시됩니다.
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('agentdefs')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Boxes />} label="에이전트" value={n(d.kpis.agents)} foot="agent_definitions" />
        <Kpi icon={<ShieldAlert />} label="고위험" value={n(d.kpis.high)} foot="점수 ≥ 50" />
        <Kpi icon={<Zap />} label="자율 트리거" value={n(d.kpis.triggers)} foot="has trigger" />
        <Kpi icon={<Boxes />} label="환경" value={n(d.kpis.environments)} foot="environments" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>에이전트 위험 점수</h2>
          <span className="hint">위험순 상위 {d.agents.length}개</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>에이전트</th>
              <th>환경</th>
              <th>위험도</th>
              <th>신호</th>
            </tr>
          </thead>
          <tbody>
            {d.agents.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  아직 분석된 에이전트가 없습니다. 위 버튼으로 메이커 포털에 로그인해 수집하세요.
                </td>
              </tr>
            ) : (
              d.agents.map((a, i) => (
                <tr key={i}>
                  <td className="ttl">{a.name}</td>
                  <td className="muted">{a.env}</td>
                  <td>
                    <span className={`sev ${bandSev(a.band)}`}>
                      {a.score} · {BAND_LABEL[a.band] || a.band}
                    </span>
                  </td>
                  <td className="muted">
                    {a.trigger && <AlertTriangle size={13} style={{ verticalAlign: 'middle' }} />} 외부호출 {a.external} · 루프 {a.loops}
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
