import { useEffect, useRef, useState } from 'react'
import { Workflow, XCircle, Boxes, CloudDownload, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { RawJsonButton } from '../components/RawJsonModal'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface Recent {
  time: string
  flow: string
  status: string
  statusRaw: string
  env: string
  error?: string
  raw?: string
}
interface DTO {
  kpis: { runs: number; failed: number; flows: number; environments: number }
  recent: Recent[]
}

const FALLBACK: DTO = { kpis: { runs: 0, failed: 0, flows: 0, environments: 0 }, recent: [] }

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function FlowRunsCollect(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('flowruns')

  function load(): void {
    invoke<DTO | null>('flow_runs_status')
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
        <button className="btn primary" onClick={() => startRun('flowruns')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />} 포털에서 플로우 실행 수집
        </button>
      </div>
      <p className="ediscovery-desc">
        설정의 <strong>다운로드 계정</strong>(eDiscovery 서비스 계정)으로 메이커 포털에 자동 로그인합니다. 계정이
        없으면 로그인 창이 표시됩니다.
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('flowruns')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Workflow />} label="총 실행" value={n(d.kpis.runs)} foot="flow_runs" />
        <Kpi icon={<XCircle />} label="실패" value={n(d.kpis.failed)} foot="failed" />
        <Kpi icon={<Workflow />} label="플로우" value={n(d.kpis.flows)} foot="distinct" />
        <Kpi icon={<Boxes />} label="환경" value={n(d.kpis.environments)} foot="environments" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>최근 플로우 실행</h2>
          <span className="hint">최신 {d.recent.length}건</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>시각</th>
              <th>플로우</th>
              <th>환경</th>
              <th>상태</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            {d.recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  아직 수집된 플로우 실행이 없습니다. 위 버튼으로 메이커 포털에 로그인해 수집하세요.
                </td>
              </tr>
            ) : (
              d.recent.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{r.time}</td>
                  <td className="ttl">{r.flow}</td>
                  <td className="muted">{r.env}</td>
                  <td>
                    <span className={`stat ${r.status}`}>{r.statusRaw}</span>
                  </td>
                  <td className="muted fr-reason">
                    {r.error ? <span title={r.error}>{r.error}</span> : '—'}
                    {r.raw ? <RawJsonButton data={r.raw} title="플로우 실행 원본 JSON" /> : null}
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
