import { useEffect, useState } from 'react'
import { FileDown, FileJson, FileSpreadsheet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface Stat {
  tables: Array<{ name: string; rows: number }>
}
interface ExportResult {
  ok: boolean
  error?: string
  path?: string
  rows?: number
}

export function DataExport(): JSX.Element {
  const { t } = useTranslation('dataExport')
  const n = useNumberFormat()
  const LABELS: Record<string, string> = {
    interactions: t('tableLabels.interactions'),
    conversation_threads: t('tableLabels.conversation_threads'),
    audit_events: t('tableLabels.audit_events'),
    copilot_usage_snapshots: t('tableLabels.copilot_usage_snapshots'),
    power_platform_consumption: t('tableLabels.power_platform_consumption'),
    copilot_agents: t('tableLabels.copilot_agents'),
    copilot_admin_diagnostics: t('tableLabels.copilot_admin_diagnostics'),
    users: t('tableLabels.users')
  }
  const [stat, setStat] = useState<Stat | null>(null)
  const [fmt, setFmt] = useState<'csv' | 'json'>('csv')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    invoke<Stat>('db_stat')
      .then(setStat)
      .catch(() => {})
  }, [])

  async function exportTable(table: string): Promise<void> {
    setBusy(table)
    setMsg(t('messages.chooseLocation'))
    try {
      const r = await invoke<ExportResult>('export_table', table, fmt)
      setMsg(
        r.ok
          ? t('messages.exported', { table: LABELS[table] || table, count: r.rows, path: r.path })
          : r.error === 'canceled'
            ? t('messages.canceled')
            : t('messages.error', { error: r.error })
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="content">
      <div className="page-actions">
        <span className="muted">{t('format')}</span>
        <button className={`btn ${fmt === 'csv' ? 'primary' : ''}`} onClick={() => setFmt('csv')}>
          <FileSpreadsheet size={15} /> CSV
        </button>
        <button className={`btn ${fmt === 'json' ? 'primary' : ''}`} onClick={() => setFmt('json')}>
          <FileJson size={15} /> JSON
        </button>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('table.title')}</h2>
          <span className="hint">{fmt.toUpperCase()}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('table.columns.table')}</th>
              <th>{t('table.columns.records')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(stat?.tables ?? []).map((t2) => (
              <tr key={t2.name}>
                <td className="ttl">{LABELS[t2.name] || t2.name}</td>
                <td className="muted">{n(t2.rows)}</td>
                <td>
                  <button className="btn" onClick={() => exportTable(t2.name)} disabled={busy === t2.name || t2.rows === 0}>
                    <FileDown size={14} /> {t('table.exportButton')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
