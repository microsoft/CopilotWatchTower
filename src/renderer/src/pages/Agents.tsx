import { useEffect, useState } from 'react'
import { Search, Bot, CheckCircle2, Clock, Ban } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import { Kpi } from '../components/Kpi'
import { DataTable, type Column } from '../components/DataTable'
import { useNumberFormat } from '../lib/format'

interface AgentRow {
  id: string
  displayName: string
  source: string
  state: 'active' | 'stale' | 'never_used'
  usageEvents: number
  daysInactive: number | null
  lastActivity: string | null
  appIdentity: string | null
}
interface AgentsData {
  kpis: { total: number; active: number; stale: number; neverUsed: number; usageEvents: number; thresholdDays: number }
  agents: AgentRow[]
}
interface IdentityEvent {
  time: string
  action: 'created' | 'deleted' | 'updated' | 'other'
  agent: string
  actor: string
  result: string | null
  operation: string
}
interface Filters {
  thresholdDays: number
  staleOnly: boolean
  search: string
}

const EMPTY_DATA: AgentsData = {
  kpis: { total: 0, active: 0, stale: 0, neverUsed: 0, usageEvents: 0, thresholdDays: 30 },
  agents: []
}
const THRESHOLDS = [7, 14, 30, 60, 90]

function dt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const mm = d.getMonth() + 1
  const dd = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

export function Agents(): JSX.Element {
  const { t } = useTranslation('agents')
  const n = useNumberFormat()
  const STATE_LABEL: Record<AgentRow['state'], string> = {
    active: t('stateLabel.active'),
    stale: t('stateLabel.stale'),
    never_used: t('stateLabel.never_used')
  }
  const ACTION_LABEL: Record<IdentityEvent['action'], string> = {
    created: t('actionLabel.created'),
    deleted: t('actionLabel.deleted'),
    updated: t('actionLabel.updated'),
    other: t('actionLabel.other')
  }
  const AGENT_COLUMNS: Column<AgentRow>[] = [
    {
      key: 'name',
      header: t('columns.name'),
      cell: (r) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>{r.displayName}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{r.appIdentity || r.id}</div>
        </div>
      ),
      sortValue: (r) => r.displayName.toLowerCase()
    },
    { key: 'source', header: t('columns.source'), cell: (r) => r.source || '—', sortValue: (r) => r.source },
    {
      key: 'state',
      header: t('columns.state'),
      cell: (r) => <span className={`agent-state ${r.state}`}>{STATE_LABEL[r.state]}</span>,
      sortValue: (r) => r.state
    },
    { key: 'usage', header: t('columns.usage'), align: 'right', cell: (r) => n(r.usageEvents), sortValue: (r) => r.usageEvents },
    {
      key: 'days',
      header: t('columns.days'),
      align: 'right',
      cell: (r) => (r.daysInactive == null ? '—' : n(r.daysInactive)),
      sortValue: (r) => r.daysInactive ?? -1
    },
    { key: 'last', header: t('columns.last'), cell: (r) => dt(r.lastActivity), sortValue: (r) => r.lastActivity ?? '' }
  ]

  const EVENT_COLUMNS: Column<IdentityEvent>[] = [
    { key: 'time', header: t('columns.time'), cell: (r) => dt(r.time), sortValue: (r) => r.time },
    {
      key: 'action',
      header: t('columns.action'),
      cell: (r) => <span className={`ev-action ${r.action}`}>{ACTION_LABEL[r.action]}</span>,
      sortValue: (r) => r.action
    },
    { key: 'agent', header: t('columns.agent'), cell: (r) => r.agent, sortValue: (r) => r.agent.toLowerCase() },
    { key: 'operation', header: t('columns.operation'), cell: (r) => r.operation, sortValue: (r) => r.operation.toLowerCase() },
    { key: 'actor', header: t('columns.actor'), cell: (r) => r.actor, sortValue: (r) => r.actor.toLowerCase() },
    { key: 'result', header: t('columns.result'), cell: (r) => r.result || '—', sortValue: (r) => r.result ?? '' }
  ]

  const [data, setData] = useState<AgentsData>(EMPTY_DATA)
  const [events, setEvents] = useState<IdentityEvent[]>([])
  const [draft, setDraft] = useState<Filters>({ thresholdDays: 30, staleOnly: false, search: '' })
  const [applied, setApplied] = useState<Filters>({ thresholdDays: 30, staleOnly: false, search: '' })

  useEffect(() => {
    invoke<IdentityEvent[]>('agent_identity_events')
      .then(setEvents)
      .catch(() => setEvents([]))
  }, [])

  useEffect(() => {
    invoke<AgentsData>('agents_overview', {
      thresholdDays: applied.thresholdDays,
      staleOnly: applied.staleOnly || undefined,
      search: applied.search || undefined
    })
      .then(setData)
      .catch(() => setData(EMPTY_DATA))
  }, [applied])

  const apply = (e: React.FormEvent): void => {
    e.preventDefault()
    setApplied(draft)
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)
  const k = data.kpis

  return (
    <div className="content">
      <form className="conv-filters" onSubmit={apply}>
        <label className="filter-inline">
          {t('filters.threshold')}
          <select
            className="filter-field"
            value={draft.thresholdDays}
            onChange={(e) => setDraft({ ...draft, thresholdDays: Number(e.target.value) })}
          >
            {THRESHOLDS.map((d) => (
              <option key={d} value={d}>
                {t('filters.thresholdDays', { count: d })}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={draft.staleOnly}
            onChange={(e) => setDraft({ ...draft, staleOnly: e.target.checked })}
          />
          {t('filters.staleOnly')}
        </label>
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
        <span className="muted conv-count">{t('count', { count: data.agents.length })}</span>
      </form>

      <div className="kpi-row">
        <Kpi icon={<Bot />} label={t('kpis.total')} value={n(k.total)} foot={t('kpis.totalFoot', { count: n(k.usageEvents) })} />
        <Kpi icon={<CheckCircle2 />} label={t('kpis.active')} value={n(k.active)} foot={t('kpis.activeFoot', { count: k.thresholdDays })} tone="positive" />
        <Kpi icon={<Clock />} label={t('kpis.stale')} value={n(k.stale)} foot={t('kpis.staleFoot', { count: k.thresholdDays })} tone="warn" />
        <Kpi icon={<Ban />} label={t('kpis.neverUsed')} value={n(k.neverUsed)} foot={t('kpis.neverUsedFoot')} tone="danger" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('inventory.title')}</h2>
          <span className="hint">{t('inventory.count', { count: n(data.agents.length) })}</span>
        </div>
        <div className="card-body">
          {data.agents.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <Bot size={24} />
              </div>
              <div className="empty-title">{t('inventory.emptyTitle')}</div>
              <div className="empty-desc">{t('inventory.emptyDesc')}</div>
            </div>
          ) : (
            <DataTable<AgentRow>
              rows={data.agents}
              rowKey={(r) => r.id}
              columns={AGENT_COLUMNS}
              initialSort={{ key: 'last', direction: 'desc' }}
              maxHeight={420}
            />
          )}
        </div>
      </div>

      {events.length > 0 && (
        <>
          <div className="section-gap" />
          <div className="card">
            <div className="card-head">
              <h2>{t('identityEvents.title')}</h2>
              <span className="hint">{t('identityEvents.subtitle', { count: n(events.length) })}</span>
            </div>
            <div className="card-body">
              <DataTable<IdentityEvent>
                rows={events}
                rowKey={(r) => `${r.agent}-${r.time}-${r.operation}`}
                columns={EVENT_COLUMNS}
                initialSort={{ key: 'time', direction: 'desc' }}
                maxHeight={360}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

