import { useEffect, useState } from 'react'
import { Search, ShieldCheck, AlertOctagon, UserCheck, Activity } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { DataTable, type Column } from '../components/DataTable'
import { RawJsonButton } from '../components/RawJsonModal'
import { invoke } from '../lib/api'

interface EventRow {
  id: string
  time: string
  source: string
  sourceLabel: string
  user: string
  operation: string
  workload: string
  app: string
  result: string | null
  raw: string
}
interface SecurityData {
  kpis: { total: number; blocked: number; uniqueUsers: number; topOperation: string | null; topOperationCount: number }
  events: EventRow[]
}
interface DiagRow {
  label: string
  endpoint: string
  status: string
  summary: string
  capturedAt: string
}
interface DiagnosticsData {
  kpis: { total: number; ok: number; forbidden: number; notFound: number }
  rows: DiagRow[]
}
interface Filters {
  source: string
  dateFrom: string
  dateTo: string
  search: string
}

const EMPTY_DATA: SecurityData = {
  kpis: { total: 0, blocked: 0, uniqueUsers: 0, topOperation: null, topOperationCount: 0 },
  events: []
}
const EMPTY_FILTERS: Filters = { source: '', dateFrom: '', dateTo: '', search: '' }
const SOURCES = [
  { value: '', label: '모든 소스' },
  { value: 'purview', label: 'Purview 통합 감사' },
  { value: 'entra_audit', label: 'Entra 디렉터리 감사' },
  { value: 'entra_signin', label: 'Entra 로그인' }
]

function n(value: number): string {
  return value.toLocaleString('ko-KR')
}
function dt(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const mm = d.getMonth() + 1
  const dd = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}
function resultClass(result: string | null): string {
  if (!result) return ''
  const x = result.toLowerCase()
  if (x.includes('success')) return 'ok'
  if (x.includes('denied') || x.includes('blocked') || x === 'failure') return 'err'
  return 'warn'
}

const DIAG_COLUMNS: Column<DiagRow>[] = [
  { key: 'label', header: '진단', cell: (r) => r.label, sortValue: (r) => r.label.toLowerCase() },
  { key: 'endpoint', header: '엔드포인트', cell: (r) => <span className="mono">{r.endpoint}</span> },
  {
    key: 'status',
    header: '상태',
    cell: (r) => <span className={`stat ${r.status === 'ok' ? 'ok' : r.status === 'not_found' ? 'idle' : 'err'}`}>{r.status}</span>,
    sortValue: (r) => r.status
  },
  { key: 'summary', header: '요약', cell: (r) => r.summary || '—' },
  { key: 'capturedAt', header: '수집 시각', cell: (r) => dt(r.capturedAt), sortValue: (r) => r.capturedAt }
]

const EVENT_COLUMNS: Column<EventRow>[] = [
  { key: 'time', header: '시각', cell: (r) => dt(r.time), sortValue: (r) => r.time },
  { key: 'source', header: '소스', cell: (r) => r.sourceLabel, sortValue: (r) => r.source },
  { key: 'user', header: '사용자', cell: (r) => r.user, sortValue: (r) => r.user.toLowerCase() },
  { key: 'operation', header: '작업', cell: (r) => r.operation, sortValue: (r) => r.operation.toLowerCase() },
  { key: 'workload', header: '워크로드', cell: (r) => r.workload },
  { key: 'app', header: '앱', cell: (r) => r.app, sortValue: (r) => r.app.toLowerCase() },
  {
    key: 'result',
    header: '결과',
    cell: (r) => (r.result ? <span className={`stat ${resultClass(r.result)}`}>{r.result}</span> : '—'),
    sortValue: (r) => r.result ?? ''
  },
  { key: 'raw', header: '', align: 'right', cell: (r) => <RawJsonButton data={r.raw} title="감사 이벤트 원본" /> }
]

export function Security(): JSX.Element {
  const [data, setData] = useState<SecurityData>(EMPTY_DATA)
  const [diag, setDiag] = useState<DiagnosticsData | null>(null)
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)

  useEffect(() => {
    invoke<DiagnosticsData>('diagnostics_status')
      .then(setDiag)
      .catch(() => setDiag(null))
  }, [])

  useEffect(() => {
    invoke<SecurityData>('security_events', {
      source: applied.source || undefined,
      dateFrom: applied.dateFrom || undefined,
      dateTo: applied.dateTo || undefined,
      search: applied.search || undefined
    })
      .then(setData)
      .catch(() => setData(EMPTY_DATA))
  }, [applied])

  const apply = (e: React.FormEvent): void => {
    e.preventDefault()
    setApplied(draft)
  }
  const reset = (): void => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)
  const k = data.kpis

  return (
    <div className="content">
      <form className="conv-filters" onSubmit={apply}>
        <select
          className="filter-field"
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
          title="소스 필터"
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          className="filter-field"
          value={draft.dateFrom}
          max={draft.dateTo || undefined}
          onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
          title="시작일"
        />
        <span className="filter-dash">~</span>
        <input
          type="date"
          className="filter-field"
          value={draft.dateTo}
          min={draft.dateFrom || undefined}
          onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
          title="종료일"
        />
        <div className="search filter-search">
          <Search size={15} />
          <input
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            placeholder="작업 · 사용자 · 앱 검색"
          />
        </div>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          적용
        </button>
        <button type="button" className="conv-btn ghost" onClick={reset}>
          초기화
        </button>
        <span className="muted conv-count">{n(data.events.length)}건</span>
      </form>

      <div className="kpi-row">
        <Kpi icon={<ShieldCheck />} label="감사 이벤트" value={n(k.total)} foot="필터 결과" />
        <Kpi
          icon={<AlertOctagon />}
          label="차단·거부"
          value={n(k.blocked)}
          foot="result=denied/blocked"
          tone={k.blocked > 0 ? 'danger' : undefined}
        />
        <Kpi icon={<UserCheck />} label="고유 사용자" value={n(k.uniqueUsers)} foot="행위자 수" />
        <Kpi
          icon={<Activity />}
          label="최다 작업"
          value={k.topOperation ?? '—'}
          foot={k.topOperation ? `${n(k.topOperationCount)}건` : ''}
        />
      </div>

      {diag && diag.rows.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>관리자 진단</h2>
            <span className="hint">
              정상 {diag.kpis.ok} · 거부 {diag.kpis.forbidden} · 미존재 {diag.kpis.notFound}
            </span>
          </div>
          <div className="card-body">
            <DataTable<DiagRow>
              rows={diag.rows}
              rowKey={(r) => r.label}
              columns={DIAG_COLUMNS}
              initialSort={{ key: 'label', direction: 'asc' }}
              maxHeight={240}
            />
          </div>
        </div>
      )}

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>감사 이벤트</h2>
          <span className="hint">{n(data.events.length)}건 · 최신순</span>
        </div>
        <div className="card-body">
          <DataTable<EventRow>
            rows={data.events}
            rowKey={(r) => r.id}
            columns={EVENT_COLUMNS}
            initialSort={{ key: 'time', direction: 'desc' }}
            maxHeight={460}
          />
        </div>
      </div>
    </div>
  )
}

