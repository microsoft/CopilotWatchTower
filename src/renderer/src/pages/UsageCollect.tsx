import { useEffect, useRef, useState } from 'react'
import { BarChart3, CalendarDays, Users, Clock, Radio, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

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

export function UsageCollect(): JSX.Element {
  const { t } = useTranslation('usageCollect')
  const n = useNumberFormat()
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
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} {t('collectStart')}
        </button>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('usage')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<BarChart3 />} label={t('kpis.rows')} value={n(d.kpis.rows)} foot="copilot_usage_snapshots" />
        <Kpi icon={<CalendarDays />} label={t('kpis.latest')} value={d.kpis.latest} foot="report refresh" />
        <Kpi icon={<Users />} label={t('kpis.users')} value={n(d.kpis.users)} foot="distinct" />
        <Kpi icon={<Clock />} label={t('kpis.period')} value={d.kpis.period} foot="period" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('table.title')}</h2>
          <span className="hint">{t('table.subtitle', { count: d.top.length })}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('table.columns.user')}</th>
              <th>{t('table.columns.overall')}</th>
              <th>{t('table.columns.teams')}</th>
              <th>{t('table.columns.word')}</th>
              <th>{t('table.columns.excel')}</th>
            </tr>
          </thead>
          <tbody>
            {d.top.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  {t('table.empty')}
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
