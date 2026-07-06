import { useEffect, useState } from 'react'
import { Search, ShieldCheck, AlertOctagon, UserCheck, Activity } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { DataTable, type Column } from '../components/DataTable'
import { RawJsonButton } from '../components/RawJsonModal'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

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
const SOURCE_KEYS = ['', 'purview', 'entra_audit', 'entra_signin'] as const

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

export function Security(): JSX.Element {
  const { t } = useTranslation('security')
  const n = useNumberFormat()
  const SOURCES = SOURCE_KEYS.map((value) => ({ value, label: t(`sources.${value || 'all'}`) }))
  const DIAG_COLUMNS: Column<DiagRow>[] = [
    { key: 'label', header: t('columns.diagLabel'), cell: (r) => r.label, sortValue: (r) => r.label.toLowerCase() },
    { key: 'endpoint', header: t('columns.endpoint'), cell: (r) => <span className="mono">{r.endpoint}</span> },
    {
      key: 'status',
      header: t('columns.status'),
      cell: (r) => <span className={`stat ${r.status === 'ok' ? 'ok' : r.status === 'not_found' ? 'idle' : 'err'}`}>{r.status}</span>,
      sortValue: (r) => r.status
    },
    { key: 'summary', header: t('columns.summary'), cell: (r) => r.summary || '—' },
    { key: 'capturedAt', header: t('columns.capturedAt'), cell: (r) => dt(r.capturedAt), sortValue: (r) => r.capturedAt }
  ]

  const EVENT_COLUMNS: Column<EventRow>[] = [
    { key: 'time', header: t('columns.time'), cell: (r) => dt(r.time), sortValue: (r) => r.time },
    { key: 'source', header: t('columns.source'), cell: (r) => r.sourceLabel, sortValue: (r) => r.source },
    { key: 'user', header: t('columns.user'), cell: (r) => r.user, sortValue: (r) => r.user.toLowerCase() },
    { key: 'operation', header: t('columns.operation'), cell: (r) => r.operation, sortValue: (r) => r.operation.toLowerCase() },
    { key: 'workload', header: t('columns.workload'), cell: (r) => r.workload },
    { key: 'app', header: t('columns.app'), cell: (r) => r.app, sortValue: (r) => r.app.toLowerCase() },
    {
      key: 'result',
      header: t('columns.result'),
      cell: (r) => (r.result ? <span className={`stat ${resultClass(r.result)}`}>{r.result}</span> : '—'),
      sortValue: (r) => r.result ?? ''
    },
    { key: 'raw', header: '', align: 'right', cell: (r) => <RawJsonButton data={r.raw} title={t('rawAuditEventTitle')} /> }
  ]

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
          title={t('filters.sourceFilter')}
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
          title={t('filters.dateFrom')}
        />
        <span className="filter-dash">~</span>
        <input
          type="date"
          className="filter-field"
          value={draft.dateTo}
          min={draft.dateFrom || undefined}
          onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
          title={t('filters.dateTo')}
        />
        <div className="search filter-search">
          <Search size={15} />
          <input
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            placeholder={t('filters.searchPlaceholder')}
          />
        </div>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          {t('filters.apply')}
        </button>
        <button type="button" className="conv-btn ghost" onClick={reset}>
          {t('filters.reset')}
        </button>
        <span className="muted conv-count">{t('count', { count: n(data.events.length) })}</span>
      </form>

      <div className="kpi-row">
        <Kpi icon={<ShieldCheck />} label={t('kpis.total')} value={n(k.total)} foot={t('kpis.totalFoot')} />
        <Kpi
          icon={<AlertOctagon />}
          label={t('kpis.blocked')}
          value={n(k.blocked)}
          foot={t('kpis.blockedFoot')}
          tone={k.blocked > 0 ? 'danger' : undefined}
        />
        <Kpi icon={<UserCheck />} label={t('kpis.uniqueUsers')} value={n(k.uniqueUsers)} foot={t('kpis.uniqueUsersFoot')} />
        <Kpi
          icon={<Activity />}
          label={t('kpis.topOperation')}
          value={k.topOperation ?? '—'}
          foot={k.topOperation ? t('kpis.topOperationFoot', { count: n(k.topOperationCount) }) : ''}
        />
      </div>

      {diag && diag.rows.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>{t('diagnostics.title')}</h2>
            <span className="hint">
              {t('diagnostics.subtitle', { ok: diag.kpis.ok, forbidden: diag.kpis.forbidden, notFound: diag.kpis.notFound })}
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
          <h2>{t('auditEvents.title')}</h2>
          <span className="hint">{t('auditEvents.subtitle', { count: n(data.events.length) })}</span>
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

