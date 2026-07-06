import { useEffect, useRef, useState } from 'react'
import { MessagesSquare, Users, GitBranch, CloudDownload, Loader2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { RawJsonButton } from '../components/RawJsonModal'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface RunRow {
  id: number
  started: string
  trigger: string
  environments: number
  transcripts: number
  rows: number
  errors: number
  status: string
  log: string
}
interface DTO {
  kpis: { interactions: number; users: number; threads: number; apps: number }
  runs: RunRow[]
}

const FALLBACK: DTO = { kpis: { interactions: 0, users: 0, threads: 0, apps: 0 }, runs: [] }

export function TranscriptsCollect(): JSX.Element {
  const { t } = useTranslation('transcriptsCollect')
  const n = useNumberFormat()
  const [d, setD] = useState<DTO>(FALLBACK)
  const [addAdmin, setAddAdmin] = useState(false)
  const [teamsOnly, setTeamsOnly] = useState(false)
  const run = useCollectionRun('transcripts')

  function load(): void {
    invoke<DTO | null>('dataverse_status')
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
        <button
          className="btn primary"
          onClick={() => startRun('transcripts', { teamsOnly, addSelfAsAdmin: addAdmin })}
          disabled={run.running}
        >
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />} {t('collectButton')}
        </button>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={teamsOnly}
            onChange={(e) => setTeamsOnly(e.target.checked)}
            disabled={run.running}
          />
          {t('teamsOnly')}
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={addAdmin}
            onChange={(e) => setAddAdmin(e.target.checked)}
            disabled={run.running}
          />
          {t('addAdmin')}
        </label>
      </div>
      <p className="ediscovery-desc">
        <Trans i18nKey="transcriptsCollect:autoLoginDesc" components={{ strong1: <strong />, strong2: <strong /> }} />
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('transcripts')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<MessagesSquare />} label={t('kpis.interactions')} value={n(d.kpis.interactions)} foot={t('kpis.interactionsFoot')} />
        <Kpi icon={<Users />} label={t('kpis.users')} value={n(d.kpis.users)} foot="distinct" />
        <Kpi icon={<GitBranch />} label={t('kpis.threads')} value={n(d.kpis.threads)} foot="conversation_threads" />
        <Kpi icon={<MessagesSquare />} label={t('kpis.apps')} value={n(d.kpis.apps)} foot="apps" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('history.title')}</h2>
          <span className="hint">{t('history.subtitle', { count: d.runs.length })}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('history.columns.started')}</th>
              <th>{t('history.columns.trigger')}</th>
              <th>{t('history.columns.environments')}</th>
              <th>{t('history.columns.transcripts')}</th>
              <th>{t('history.columns.rows')}</th>
              <th>{t('history.columns.status')}</th>
              <th>{t('history.columns.log')}</th>
            </tr>
          </thead>
          <tbody>
            {d.runs.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  {t('history.empty')}
                </td>
              </tr>
            ) : (
              d.runs.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.started}</td>
                  <td className="muted">{r.trigger}</td>
                  <td className="muted">{n(r.environments)}</td>
                  <td className="muted">{n(r.transcripts)}</td>
                  <td>{n(r.rows)}</td>
                  <td>
                    <span className={`stat ${r.status}`}>
                      {r.status === 'ok' ? t('history.status.done') : r.status === 'err' ? t('history.status.errorCount', { count: r.errors }) : t('history.status.running')}
                    </span>
                  </td>
                  <td>{r.log ? <RawJsonButton data={r.log} title={t('history.logTitle')} /> : <span className="muted">—</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
