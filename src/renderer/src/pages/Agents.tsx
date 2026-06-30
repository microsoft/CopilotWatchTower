import { useEffect, useState } from 'react'
import { Search, Bot, CheckCircle2, Clock, Ban } from 'lucide-react'
import { invoke } from '../lib/api'
import { Kpi } from '../components/Kpi'
import { DataTable, type Column } from '../components/DataTable'

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
const STATE_LABEL: Record<AgentRow['state'], string> = { active: '활성', stale: '비활성', never_used: '미사용' }
const ACTION_LABEL: Record<IdentityEvent['action'], string> = {
  created: '생성',
  deleted: '삭제',
  updated: '수정',
  other: '기타'
}

function n(value: number): string {
  return value.toLocaleString('ko-KR')
}
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

const AGENT_COLUMNS: Column<AgentRow>[] = [
  {
    key: 'name',
    header: '이름',
    cell: (r) => (
      <div>
        <div style={{ fontWeight: 600, color: 'var(--text)' }}>{r.displayName}</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{r.appIdentity || r.id}</div>
      </div>
    ),
    sortValue: (r) => r.displayName.toLowerCase()
  },
  { key: 'source', header: '소스', cell: (r) => r.source || '—', sortValue: (r) => r.source },
  {
    key: 'state',
    header: '상태',
    cell: (r) => <span className={`agent-state ${r.state}`}>{STATE_LABEL[r.state]}</span>,
    sortValue: (r) => r.state
  },
  { key: 'usage', header: '사용 이벤트', align: 'right', cell: (r) => n(r.usageEvents), sortValue: (r) => r.usageEvents },
  {
    key: 'days',
    header: '비활성 일수',
    align: 'right',
    cell: (r) => (r.daysInactive == null ? '—' : n(r.daysInactive)),
    sortValue: (r) => r.daysInactive ?? -1
  },
  { key: 'last', header: '마지막 활동', cell: (r) => dt(r.lastActivity), sortValue: (r) => r.lastActivity ?? '' }
]

const EVENT_COLUMNS: Column<IdentityEvent>[] = [
  { key: 'time', header: '시각', cell: (r) => dt(r.time), sortValue: (r) => r.time },
  {
    key: 'action',
    header: '작업',
    cell: (r) => <span className={`ev-action ${r.action}`}>{ACTION_LABEL[r.action]}</span>,
    sortValue: (r) => r.action
  },
  { key: 'agent', header: '대상', cell: (r) => r.agent, sortValue: (r) => r.agent.toLowerCase() },
  { key: 'operation', header: '작업 유형', cell: (r) => r.operation, sortValue: (r) => r.operation.toLowerCase() },
  { key: 'actor', header: '행위자', cell: (r) => r.actor, sortValue: (r) => r.actor.toLowerCase() },
  { key: 'result', header: '결과', cell: (r) => r.result || '—', sortValue: (r) => r.result ?? '' }
]

export function Agents(): JSX.Element {
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
          임계값
          <select
            className="filter-field"
            value={draft.thresholdDays}
            onChange={(e) => setDraft({ ...draft, thresholdDays: Number(e.target.value) })}
          >
            {THRESHOLDS.map((d) => (
              <option key={d} value={d}>
                {d}일
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
          비활성만
        </label>
        <div className="search filter-search">
          <Search size={15} />
          <input
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            placeholder="에이전트 이름·식별자 검색"
          />
        </div>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          적용
        </button>
        <span className="muted conv-count">{n(data.agents.length)}개 에이전트</span>
      </form>

      <div className="kpi-row">
        <Kpi icon={<Bot />} label="전체 에이전트" value={n(k.total)} foot={`사용 이벤트 ${n(k.usageEvents)}건`} />
        <Kpi icon={<CheckCircle2 />} label="활성" value={n(k.active)} foot={`${k.thresholdDays}일 이내`} tone="positive" />
        <Kpi icon={<Clock />} label="비활성" value={n(k.stale)} foot={`${k.thresholdDays}일 초과`} tone="warn" />
        <Kpi icon={<Ban />} label="미사용" value={n(k.neverUsed)} foot="활동 기록 없음" tone="danger" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>에이전트 인벤토리</h2>
          <span className="hint">{n(data.agents.length)}개</span>
        </div>
        <div className="card-body">
          {data.agents.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <Bot size={24} />
              </div>
              <div className="empty-title">수집된 에이전트가 없습니다</div>
              <div className="empty-desc">
                에이전트 인벤토리는 관리자 위임 권한(카탈로그/등록) 수집이 필요합니다. 수집 후 이 표에 표시됩니다.
              </div>
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
              <h2>에이전트 ID 이벤트</h2>
              <span className="hint">감사 로그 · {n(events.length)}건</span>
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

