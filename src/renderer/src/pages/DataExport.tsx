import { useEffect, useState } from 'react'
import { FileDown, FileJson, FileSpreadsheet } from 'lucide-react'
import { invoke } from '../lib/api'

interface Stat {
  tables: Array<{ name: string; rows: number }>
}
interface ExportResult {
  ok: boolean
  error?: string
  path?: string
  rows?: number
}

const LABELS: Record<string, string> = {
  interactions: '상호작용',
  conversation_threads: '대화 스레드',
  audit_events: '감사 이벤트',
  copilot_usage_snapshots: '사용량 스냅샷',
  power_platform_consumption: '크레딧 소비',
  copilot_agents: '에이전트',
  copilot_admin_diagnostics: '관리 진단',
  users: '사용자'
}

export function DataExport(): JSX.Element {
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
    setMsg('저장 위치를 선택하세요…')
    try {
      const r = await invoke<ExportResult>('export_table', table, fmt)
      setMsg(
        r.ok
          ? `${LABELS[table] || table} ${r.rows}행 내보냄 → ${r.path}`
          : r.error === 'canceled'
            ? '취소됨'
            : `오류: ${r.error}`
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="content">
      <div className="page-actions">
        <span className="muted">형식</span>
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
          <h2>테이블 내보내기</h2>
          <span className="hint">{fmt.toUpperCase()}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>테이블</th>
              <th>레코드</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(stat?.tables ?? []).map((t) => (
              <tr key={t.name}>
                <td className="ttl">{LABELS[t.name] || t.name}</td>
                <td className="muted">{t.rows.toLocaleString('ko-KR')}</td>
                <td>
                  <button className="btn" onClick={() => exportTable(t.name)} disabled={busy === t.name || t.rows === 0}>
                    <FileDown size={14} /> 내보내기
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
