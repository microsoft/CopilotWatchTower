import { useEffect, useRef, useState } from 'react'
import { Database, ShieldCheck, UserCheck, Activity, Radio, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface Source {
  source: string
  label: string
  enabled: boolean
  last: string
  count: number
  error: string | null
}
interface Recent {
  time: string
  source: string
  operation: string
  actor: string
}
interface DTO {
  kpis: { total: number; purview: number; entraAudit: number; entraSignin: number }
  sources: Source[]
  recent: Recent[]
}

const FALLBACK: DTO = {
  kpis: { total: 0, purview: 0, entraAudit: 0, entraSignin: 0 },
  sources: [
    { source: 'purview', label: 'Purview 통합 감사', enabled: true, last: '—', count: 0, error: null },
    { source: 'entra_audit', label: 'Entra 디렉터리 감사', enabled: true, last: '—', count: 0, error: null },
    { source: 'entra_signin', label: 'Entra 로그인', enabled: true, last: '—', count: 0, error: null }
  ],
  recent: []
}

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function AuditCollect(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('audit')

  function load(): void {
    invoke<DTO | null>('audit_collect_status')
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
        <button className="btn primary" onClick={() => startRun('audit')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} 수집 시작
        </button>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('audit')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Database />} label="총 감사 이벤트" value={n(d.kpis.total)} foot="audit_events" />
        <Kpi icon={<ShieldCheck />} label="Purview" value={n(d.kpis.purview)} foot="통합 감사" />
        <Kpi icon={<Activity />} label="Entra 감사" value={n(d.kpis.entraAudit)} foot="디렉터리" />
        <Kpi icon={<UserCheck />} label="Entra 로그인" value={n(d.kpis.entraSignin)} foot="sign-ins" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>수집 소스 상태</h2>
            <span className="hint">{d.sources.length}개 소스</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>소스</th>
                <th>상태</th>
                <th>마지막 수집</th>
                <th>건수</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.source}>
                  <td className="ttl">{s.label}</td>
                  <td>
                    <span className={`stat ${s.error ? 'err' : s.enabled ? 'ok' : 'idle'}`}>
                      {s.error ? '오류' : s.enabled ? '활성' : '비활성'}
                    </span>
                  </td>
                  <td className="muted">{s.last}</td>
                  <td className="muted">{n(s.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>최근 감사 이벤트</h2>
            <span className="hint">최신 {d.recent.length}건</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>시각</th>
                <th>소스</th>
                <th>작업</th>
                <th>행위자</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    아직 수집된 감사 이벤트가 없습니다. 수집 시작을 눌러주세요.
                  </td>
                </tr>
              ) : (
                d.recent.map((r, i) => (
                  <tr key={i}>
                    <td className="muted">{r.time}</td>
                    <td className="muted">{r.source}</td>
                    <td className="ttl">{r.operation}</td>
                    <td className="muted">{r.actor}</td>
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
