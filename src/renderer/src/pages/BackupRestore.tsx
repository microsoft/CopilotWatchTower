import { useEffect, useState } from 'react'
import { Database, Download, Upload, HardDrive, Trash2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { invoke } from '../lib/api'

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
    setMsg('백업 위치를 선택하세요…')
    try {
      const r = await invoke<OpResult>('backup_db')
      setMsg(r.ok ? `백업 완료 → ${r.path} (${fmtBytes(r.sizeBytes ?? 0)})` : r.error === 'canceled' ? '취소됨' : `오류: ${r.error}`)
    } finally {
      setBusy(false)
    }
  }

  async function restore(): Promise<void> {
    if (!window.confirm('현재 데이터베이스를 선택한 백업 파일로 덮어씁니다. 계속할까요?')) return
    setBusy(true)
    setMsg('복원할 백업 파일을 선택하세요…')
    try {
      const r = await invoke<OpResult>('restore_db')
      if (r.ok) {
        setMsg('복원 완료. 새로고침합니다…')
        setTimeout(() => location.reload(), 900)
      } else {
        setMsg(r.error === 'canceled' ? '취소됨' : `오류: ${r.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  async function wipe(): Promise<void> {
    if (!window.confirm('이 프로필에 수집된 모든 데이터를 삭제합니다. 자격 증명과 알람 규칙은 유지됩니다.\n계속할까요?')) return
    setBusy(true)
    setMsg('데이터를 삭제하는 중…')
    try {
      const r = await invoke<WipeResult>('db_wipe')
      if (r.ok) {
        setMsg(`초기화 완료: ${(r.deleted ?? 0).toLocaleString('ko-KR')}행 삭제됨. 새로고침합니다…`)
        load()
        setTimeout(() => location.reload(), 900)
      } else {
        setMsg(`오류: ${r.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const totalRows = stat?.tables.reduce((s, t) => s + t.rows, 0) ?? 0

  return (
    <div className="content">
      <div className="kpi-row">
        <Kpi icon={<HardDrive />} label="DB 크기" value={stat ? fmtBytes(stat.sizeBytes) : '—'} foot="store.db" />
        <Kpi icon={<Database />} label="총 레코드" value={totalRows.toLocaleString('ko-KR')} foot={`${stat?.tables.length ?? 0} 테이블`} />
        <Kpi icon={<Download />} label="백업" value="스냅샷" foot="안전한 복사본" />
        <Kpi icon={<Upload />} label="복원" value="교체" foot="주의 필요" />
      </div>

      <div className="page-actions">
        <button className="btn primary" onClick={backup} disabled={busy}>
          <Download size={15} /> 데이터베이스 백업
        </button>
        <button className="btn" onClick={restore} disabled={busy}>
          <Upload size={15} /> 백업에서 복원
        </button>
        <button className="btn danger" onClick={wipe} disabled={busy}>
          <Trash2 size={15} /> 데이터 초기화
        </button>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>데이터베이스 위치</h2>
        </div>
        <div className="card-body">
          <div className="mono" style={{ wordBreak: 'break-all' }}>
            {stat?.path ?? '—'}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            마지막 수정: {stat?.modified ? new Date(stat.modified).toLocaleString('ko-KR') : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}
