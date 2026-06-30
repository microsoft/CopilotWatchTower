import { useEffect, useRef, useState } from 'react'
import { BarChart3, CalendarDays, Users, Clock, Radio, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface TopRow {
  user: string
  overall: string
  teams: string
  word: string
  excel: string
}
interface DTO {
  kpis: { rows: number; latest: string; users: number; period: string }
  top: TopRow[]
}

const FALLBACK: DTO = {
  kpis: { rows: 0, latest: '—', users: 0, period: '—' },
  top: []
}

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function UsageCollect(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('usage')

  function load(): void {
    invoke<DTO | null>('usage_collect_status')
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
        <button className="btn primary" onClick={() => startRun('usage')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} 수집 시작
        </button>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('usage')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<BarChart3 />} label="스냅샷 행" value={n(d.kpis.rows)} foot="copilot_usage_snapshots" />
        <Kpi icon={<CalendarDays />} label="최신 스냅샷" value={d.kpis.latest} foot="report refresh" />
        <Kpi icon={<Users />} label="사용자" value={n(d.kpis.users)} foot="distinct" />
        <Kpi icon={<Clock />} label="기간" value={d.kpis.period} foot="period" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>사용자별 마지막 활동 (Copilot)</h2>
          <span className="hint">최신 스냅샷 · 상위 {d.top.length}명</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>사용자</th>
              <th>전체</th>
              <th>Teams</th>
              <th>Word</th>
              <th>Excel</th>
            </tr>
          </thead>
          <tbody>
            {d.top.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  아직 수집된 사용량 스냅샷이 없습니다. 수집 시작을 눌러주세요.
                </td>
              </tr>
            ) : (
              d.top.map((r, i) => (
                <tr key={i}>
                  <td className="ttl">{r.user}</td>
                  <td className="muted">{r.overall}</td>
                  <td className="muted">{r.teams}</td>
                  <td className="muted">{r.word}</td>
                  <td className="muted">{r.excel}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
