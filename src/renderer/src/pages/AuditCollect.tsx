import { useEffect, useRef, useState } from 'react'
import { Database, ShieldCheck, UserCheck, Activity, Radio, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

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
  const { t } = useTranslation('auditCollect')
  const n = useNumberFormat()
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
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} {t('collectStart')}
        </button>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('audit')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Database />} label={t('kpis.total')} value={n(d.kpis.total)} foot="audit_events" />
        <Kpi icon={<ShieldCheck />} label={t('kpis.purview')} value={n(d.kpis.purview)} foot={t('kpis.purviewFoot')} />
        <Kpi icon={<Activity />} label={t('kpis.entraAudit')} value={n(d.kpis.entraAudit)} foot={t('kpis.entraAuditFoot')} />
        <Kpi icon={<UserCheck />} label={t('kpis.entraSignin')} value={n(d.kpis.entraSignin)} foot="sign-ins" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('sourceStatus.title')}</h2>
            <span className="hint">{t('sourceStatus.count', { count: d.sources.length })}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('sourceStatus.columns.source')}</th>
                <th>{t('sourceStatus.columns.status')}</th>
                <th>{t('sourceStatus.columns.last')}</th>
                <th>{t('sourceStatus.columns.count')}</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.source}>
                  <td className="ttl">{s.label}</td>
                  <td>
                    <span className={`stat ${s.error ? 'err' : s.enabled ? 'ok' : 'idle'}`}>
                      {s.error ? t('sourceStatus.status.error') : s.enabled ? t('sourceStatus.status.active') : t('sourceStatus.status.inactive')}
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
            <h2>{t('recent.title')}</h2>
            <span className="hint">{t('recent.subtitle', { count: d.recent.length })}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('recent.columns.time')}</th>
                <th>{t('recent.columns.source')}</th>
                <th>{t('recent.columns.operation')}</th>
                <th>{t('recent.columns.actor')}</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('recent.empty')}
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
