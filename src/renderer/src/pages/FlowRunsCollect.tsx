import { useEffect, useRef, useState } from 'react'
import { Workflow, XCircle, Boxes, CloudDownload, Loader2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { RawJsonButton } from '../components/RawJsonModal'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

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

export function FlowRunsCollect(): JSX.Element {
  const { t } = useTranslation('flowRunsCollect')
  const n = useNumberFormat()
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
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />} {t('collectButton')}
        </button>
      </div>
      <p className="ediscovery-desc">
        <Trans i18nKey="flowRunsCollect:autoLoginDesc" components={{ strong: <strong /> }} />
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('flowruns')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Workflow />} label={t('kpis.runs')} value={n(d.kpis.runs)} foot="flow_runs" />
        <Kpi icon={<XCircle />} label={t('kpis.failed')} value={n(d.kpis.failed)} foot="failed" />
        <Kpi icon={<Workflow />} label={t('kpis.flows')} value={n(d.kpis.flows)} foot="distinct" />
        <Kpi icon={<Boxes />} label={t('kpis.environments')} value={n(d.kpis.environments)} foot="environments" />
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
              <th>{t('recent.columns.flow')}</th>
              <th>{t('recent.columns.env')}</th>
              <th>{t('recent.columns.status')}</th>
              <th>{t('recent.columns.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {d.recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  {t('recent.empty')}
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
                    {r.raw ? <RawJsonButton data={r.raw} title={t('recent.rawTitle')} /> : null}
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
