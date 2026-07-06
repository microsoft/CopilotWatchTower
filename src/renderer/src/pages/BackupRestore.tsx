import { useEffect, useState } from 'react'
import { Database, Download, Upload, HardDrive, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface Stat {
  path: string | null
  sizeBytes: number
  modified: string
  tables: Array<{ name: string; rows: number }>
}
interface OpResult {
  ok: boolean
  error?: string
  path?: string
  sizeBytes?: number
}
interface WipeResult {
  ok: boolean
  error?: string
  deleted?: number
}

function fmtBytes(b: number): string {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}

export function BackupRestore(): JSX.Element {
  const { t, i18n } = useTranslation('backupRestore')
  const n = useNumberFormat()
  const [stat, setStat] = useState<Stat | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function load(): void {
    invoke<Stat>('db_stat')
      .then(setStat)
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  async function backup(): Promise<void> {
    setBusy(true)
    setMsg(t('messages.chooseBackupLocation'))
    try {
      const r = await invoke<OpResult>('backup_db')
      setMsg(
        r.ok
          ? t('messages.backupDone', { path: r.path, size: fmtBytes(r.sizeBytes ?? 0) })
          : r.error === 'canceled'
            ? t('messages.canceled')
            : t('messages.error', { error: r.error })
      )
    } finally {
      setBusy(false)
    }
  }

  async function restore(): Promise<void> {
    if (!window.confirm(t('confirm.restore'))) return
    setBusy(true)
    setMsg(t('messages.chooseRestoreFile'))
    try {
      const r = await invoke<OpResult>('restore_db')
      if (r.ok) {
        setMsg(t('messages.restoreDone'))
        setTimeout(() => location.reload(), 900)
      } else {
        setMsg(r.error === 'canceled' ? t('messages.canceled') : t('messages.error', { error: r.error }))
      }
    } finally {
      setBusy(false)
    }
  }

  async function wipe(): Promise<void> {
    if (!window.confirm(t('confirm.wipe'))) return
    setBusy(true)
    setMsg(t('messages.wiping'))
    try {
      const r = await invoke<WipeResult>('db_wipe')
      if (r.ok) {
        setMsg(t('messages.wipeDone', { count: n(r.deleted ?? 0) }))
        load()
        setTimeout(() => location.reload(), 900)
      } else {
        setMsg(t('messages.error', { error: r.error }))
      }
    } finally {
      setBusy(false)
    }
  }

  const totalRows = stat?.tables.reduce((s, t2) => s + t2.rows, 0) ?? 0

  return (
    <div className="content">
      <div className="kpi-row">
        <Kpi icon={<HardDrive />} label={t('kpis.dbSize')} value={stat ? fmtBytes(stat.sizeBytes) : '—'} foot="store.db" />
        <Kpi icon={<Database />} label={t('kpis.totalRecords')} value={n(totalRows)} foot={t('kpis.totalRecordsFoot', { count: stat?.tables.length ?? 0 })} />
        <Kpi icon={<Download />} label={t('kpis.backup')} value={t('kpis.backupValue')} foot={t('kpis.backupFoot')} />
        <Kpi icon={<Upload />} label={t('kpis.restore')} value={t('kpis.restoreValue')} foot={t('kpis.restoreFoot')} />
      </div>

      <div className="page-actions">
        <button className="btn primary" onClick={backup} disabled={busy}>
          <Download size={15} /> {t('actions.backup')}
        </button>
        <button className="btn" onClick={restore} disabled={busy}>
          <Upload size={15} /> {t('actions.restore')}
        </button>
        <button className="btn danger" onClick={wipe} disabled={busy}>
          <Trash2 size={15} /> {t('actions.wipe')}
        </button>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('location.title')}</h2>
        </div>
        <div className="card-body">
          <div className="mono" style={{ wordBreak: 'break-all' }}>
            {stat?.path ?? '—'}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {t('location.lastModified', {
              date: stat?.modified ? new Date(stat.modified).toLocaleString(i18n.language) : '—'
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
