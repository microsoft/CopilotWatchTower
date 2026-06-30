import { useEffect, useRef, useState } from 'react'
import { Stethoscope, CheckCircle2, ShieldAlert, HelpCircle, Radio, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface Row {
  label: string
  endpoint: string
  status: string
  summary: string
  capturedAt: string
}
interface DTO {
  kpis: { total: number; ok: number; forbidden: number; notFound: number }
  rows: Row[]
}

const FALLBACK: DTO = {
  kpis: { total: 0, ok: 0, forbidden: 0, notFound: 0 },
  rows: []
}

function statClass(status: string): string {
  if (status === 'ok') return 'ok'
  if (status === 'forbidden' || status === 'error') return 'err'
  return 'idle'
}
function statLabel(status: string): string {
  return (
    { ok: '정상', forbidden: '권한 없음', not_found: '없음', error: '오류' }[status] ?? status
  )
}

export function DiagnosticsCollect(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('diagnostics')

  function load(): void {
    invoke<DTO | null>('diagnostics_status')
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
        <button className="btn primary" onClick={() => startRun('diagnostics')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} 수집 시작
        </button>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('diagnostics')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Stethoscope />} label="진단 항목" value={String(d.kpis.total)} foot="admin API 프로브" />
        <Kpi icon={<CheckCircle2 />} label="정상" value={String(d.kpis.ok)} foot="접근 가능" />
        <Kpi icon={<ShieldAlert />} label="권한 없음" value={String(d.kpis.forbidden)} foot="동의 필요" />
        <Kpi icon={<HelpCircle />} label="미제공" value={String(d.kpis.notFound)} foot="엔드포인트 없음" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Copilot 관리 API 진단</h2>
          <span className="hint">{d.rows.length}개 엔드포인트</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>항목</th>
              <th>엔드포인트</th>
              <th>상태</th>
              <th>요약</th>
              <th>수집 시각</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  아직 진단 데이터가 없습니다. 수집 시작을 눌러주세요.
                </td>
              </tr>
            ) : (
              d.rows.map((r, i) => (
                <tr key={i}>
                  <td className="ttl">{r.label}</td>
                  <td className="muted mono">{r.endpoint}</td>
                  <td>
                    <span className={`stat ${statClass(r.status)}`}>{statLabel(r.status)}</span>
                  </td>
                  <td className="muted">{r.summary}</td>
                  <td className="muted">{r.capturedAt}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
