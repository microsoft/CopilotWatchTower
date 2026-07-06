import { useEffect, useState } from 'react'
import { FileSearch, Download, Inbox, RefreshCw, Play, Square, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { RawJsonButton } from '../components/RawJsonModal'
import {
  useEdiscoveryRun,
  edBeginRun,
  edLog,
  edEndRun,
  edClearRun,
  getEdiscoveryRun
} from '../lib/collectRuns'
import { invoke, subscribe } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface JobRow {
  id: string
  target: string
  status: string
  window: string
  added: number
  updated: string
  error: string | null
  running: boolean
  raw?: Record<string, unknown>
}
interface EdiscoveryData {
  kpis: { jobs: number; items: number; running: number; failed: number }
  jobs: JobRow[]
}

function stageClass(s: string): string {
  if (s === 'done') return 'ok'
  if (s === 'error') return 'err'
  return 'run'
}

export function Ediscovery(): JSX.Element {
  const { t } = useTranslation('ediscovery')
  const n = useNumberFormat()
  const STAGE_LABEL: Record<string, string> = {
    pending: t('stage.pending'),
    preflight: t('stage.preflight'),
    case: t('stage.case'),
    searching: t('stage.searching'),
    exporting: t('stage.exporting'),
    downloading: t('stage.downloading'),
    parsing: t('stage.parsing'),
    done: t('stage.done'),
    error: t('stage.error')
  }
  function startErr(e?: string): string {
    if (e === 'no-tenant' || e === 'no-upn' || e === 'already-running') return t(`errors.${e}`)
    return e ?? 'unknown'
  }
  const [data, setData] = useState<EdiscoveryData | null>(null)
  const [upn, setUpn] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const run = useEdiscoveryRun()
  const running = run.running
  const lines = run.lines

  // ME3 unattended-download service account (DPAPI-stored in the profile).
  const [credUser, setCredUser] = useState('')
  const [credPw, setCredPw] = useState('')
  const [credConfigured, setCredConfigured] = useState(false)
  const [credBusy, setCredBusy] = useState(false)
  const [credMsg, setCredMsg] = useState<string | null>(null)

  function load(): void {
    invoke<EdiscoveryData | null>('ediscovery_overview')
      .then((d) => {
        if (d) setData(d)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
    invoke<{ user: string; configured: boolean }>('ediscovery_creds_status')
      .then((s) => {
        setCredUser(s.user || '')
        setCredConfigured(s.configured)
      })
      .catch(() => {})
  }, [])

  async function startCollection(jobId?: string): Promise<void> {
    if (getEdiscoveryRun().running) return
    if (!jobId && !upn.trim()) return
    edBeginRun(!jobId)
    edLog(jobId ? t('log.resuming') : t('log.starting', { upn: upn.trim() }))
    const unsub = subscribe<{ stage?: string; message?: string }>('ediscovery_progress', (p) => {
      edLog(p.message ?? '', p.stage === 'error' ? 'error' : p.stage === 'done' ? 'success' : undefined)
    })
    try {
      const r = await invoke<{ ok: boolean; error?: string; added?: number }>(
        'ediscovery_collect_start',
        jobId ? { jobId } : { upn: upn.trim(), start: start || undefined, end: end || undefined }
      )
      if (r.ok) edLog(t('log.done', { count: r.added ?? 0 }), 'success')
      else edLog(t('log.error', { message: startErr(r.error) }), 'error')
    } catch (e) {
      edLog(t('log.error', { message: e instanceof Error ? e.message : String(e) }), 'error')
    } finally {
      unsub()
      edEndRun()
      load()
    }
  }

  async function stopCollection(): Promise<void> {
    await invoke('ediscovery_collect_stop').catch(() => {})
    edLog(t('log.stopRequested'), 'warn')
  }

  async function deleteJob(id: string): Promise<void> {
    if (running) return
    try {
      const r = await invoke<{
        ok: boolean
        error?: string
        canceled?: boolean
        deletedConversations?: boolean
        removed?: { interactions: number; threads: number }
      }>('ediscovery_job_delete', id)
      if (r.canceled) return
      if (r.ok) {
        if (r.deletedConversations && r.removed) {
          edLog(t('log.jobAndConvDeleted', { interactions: r.removed.interactions, threads: r.removed.threads }), 'success')
        } else {
          edLog(t('log.jobOnlyDeleted'), 'success')
        }
        load()
      } else {
        edLog(t('log.jobDeleteFailed', { message: r.error === 'collecting' ? t('log.jobDeleteFailedWhileCollecting') : (r.error ?? 'unknown') }), 'error')
      }
    } catch (e) {
      edLog(t('log.jobDeleteError', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  async function saveCreds(): Promise<void> {
    if (!credUser.trim() || !credPw) {
      setCredMsg(t('credentials.messages.missingInput'))
      return
    }
    setCredBusy(true)
    try {
      const r = await invoke<{ ok: boolean; error?: string }>('ediscovery_creds_set', {
        user: credUser.trim(),
        password: credPw
      })
      if (r.ok) {
        setCredConfigured(true)
        setCredPw('')
        setCredMsg(t('credentials.messages.saved'))
      } else {
        setCredMsg(t('credentials.messages.saveFailed', { error: r.error ?? t('stage.error') }))
      }
    } catch {
      setCredMsg(t('credentials.messages.saveError'))
    } finally {
      setCredBusy(false)
    }
  }
  async function clearCreds(): Promise<void> {
    setCredBusy(true)
    try {
      await invoke('ediscovery_creds_clear')
      setCredConfigured(false)
      setCredUser('')
      setCredPw('')
      setCredMsg(t('credentials.messages.cleared'))
    } catch {
      setCredMsg(t('credentials.messages.clearError'))
    } finally {
      setCredBusy(false)
    }
  }

  const k = data?.kpis
  const jobs = data?.jobs ?? []

  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <h2>{t('startCard.title')}</h2>
          <span className="hint">{t('startCard.subtitle')}</span>
        </div>
        <div className="card-body">
          <p className="muted ediscovery-desc">{t('startCard.desc')}</p>
          <div className="ediscovery-form">
            <input
              className="field"
              value={upn}
              onChange={(e) => setUpn(e.target.value)}
              placeholder={t('startCard.upnPlaceholder')}
            />
            <input
              type="date"
              className="field"
              value={start}
              max={end || undefined}
              onChange={(e) => setStart(e.target.value)}
              title={t('startCard.startDateTitle')}
            />
            <span className="filter-dash">~</span>
            <input
              type="date"
              className="field"
              value={end}
              min={start || undefined}
              onChange={(e) => setEnd(e.target.value)}
              title={t('startCard.endDateTitle')}
            />
            {running ? (
              <button className="btn" onClick={stopCollection}>
                <Square size={14} /> {t('startCard.stop')}
              </button>
            ) : (
              <button className="btn primary" onClick={() => startCollection()} disabled={!upn.trim()}>
                <Play size={15} /> {t('startCard.start')}
              </button>
            )}
          </div>
        </div>
      </div>

      {(running || lines.length > 0) && (
        <>
          <div className="section-gap" />
          <LiveLog lines={lines} running={running} onClear={() => edClearRun()} />
        </>
      )}

      <div className="section-gap" />

      <div className="kpi-row">
        <Kpi icon={<Download />} label={t('kpis.jobs')} value={k ? n(k.jobs) : '0'} foot={t('kpis.jobsFoot')} />
        <Kpi icon={<RefreshCw />} label={t('kpis.running')} value={k ? n(k.running) : '0'} foot={t('kpis.runningFoot')} />
        <Kpi icon={<Inbox />} label={t('kpis.items')} value={k ? n(k.items) : '0'} foot={t('kpis.itemsFoot')} />
        <Kpi icon={<FileSearch />} label={t('kpis.failed')} value={k ? n(k.failed) : '0'} foot={t('kpis.failedFoot')} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('jobHistory.title')}</h2>
          <span className="hint">{t('jobHistory.count', { count: n(jobs.length) })}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('jobHistory.columns.target')}</th>
              <th>{t('jobHistory.columns.status')}</th>
              <th>{t('jobHistory.columns.window')}</th>
              <th>{t('jobHistory.columns.added')}</th>
              <th>{t('jobHistory.columns.updated')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  {t('jobHistory.empty')}
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr key={j.id}>
                  <td className="ttl">{j.target}</td>
                  <td title={j.error ?? undefined}>
                    <span className={`stat ${stageClass(j.status)}`}>{STAGE_LABEL[j.status] || j.status}</span>
                  </td>
                  <td className="muted">{j.window}</td>
                  <td className="muted">{n(j.added)}</td>
                  <td className="muted">{j.updated}</td>
                  <td className="right">
                    <div className="row-actions">
                      {j.status !== 'done' && (
                        <button className="btn-sm" disabled={running} onClick={() => startCollection(j.id)}>
                          {t('jobHistory.resume')}
                        </button>
                      )}
                      <RawJsonButton data={j.raw ?? j} title={t('jobHistory.rawTitle', { target: j.target })} />
                      <button
                        className="btn-sm danger"
                        disabled={running}
                        title={t('jobHistory.deleteTitle')}
                        onClick={() => deleteJob(j.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>{t('credentials.title')}</h2>
          <span className={`hint stat ${credConfigured ? 'ok' : 'idle'}`}>{credConfigured ? t('credentials.configured') : t('credentials.notConfigured')}</span>
        </div>
        <div className="card-body">
          <p className="muted ediscovery-desc">{t('credentials.desc')}</p>
          <div className="ediscovery-form">
            <input
              className="field"
              value={credUser}
              onChange={(e) => setCredUser(e.target.value)}
              placeholder={t('credentials.userPlaceholder')}
              autoComplete="username"
            />
            <input
              className="field"
              type="password"
              value={credPw}
              onChange={(e) => setCredPw(e.target.value)}
              placeholder={t('credentials.passwordPlaceholder')}
              autoComplete="current-password"
            />
            <button className="btn primary" onClick={saveCreds} disabled={credBusy}>
              {t('credentials.save')}
            </button>
            {credConfigured && (
              <button className="btn" onClick={clearCreds} disabled={credBusy}>
                {t('credentials.delete')}
              </button>
            )}
          </div>
          {credMsg && <span className="muted action-status">{credMsg}</span>}
        </div>
      </div>
    </div>
  )
}
