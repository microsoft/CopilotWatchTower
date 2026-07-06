import { useEffect, useRef, useState } from 'react'
import { Stethoscope, CheckCircle2, ShieldAlert, HelpCircle, Radio, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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

export function DiagnosticsCollect(): JSX.Element {
  const { t } = useTranslation('diagnosticsCollect')
  function statLabel(status: string): string {
    return t(`status.${status}`, { defaultValue: status })
  }
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
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} {t('collectStart')}
        </button>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('diagnostics')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Stethoscope />} label={t('kpis.total')} value={String(d.kpis.total)} foot={t('kpis.totalFoot')} />
        <Kpi icon={<CheckCircle2 />} label={t('kpis.ok')} value={String(d.kpis.ok)} foot={t('kpis.okFoot')} />
        <Kpi icon={<ShieldAlert />} label={t('kpis.forbidden')} value={String(d.kpis.forbidden)} foot={t('kpis.forbiddenFoot')} />
        <Kpi icon={<HelpCircle />} label={t('kpis.notFound')} value={String(d.kpis.notFound)} foot={t('kpis.notFoundFoot')} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('table.title')}</h2>
          <span className="hint">{t('table.subtitle', { count: d.rows.length })}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('table.columns.label')}</th>
              <th>{t('table.columns.endpoint')}</th>
              <th>{t('table.columns.status')}</th>
              <th>{t('table.columns.summary')}</th>
              <th>{t('table.columns.capturedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  {t('table.empty')}
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
