import { useEffect, useState } from 'react'
import { invoke } from '../lib/api'
import { Kpi } from '../components/Kpi'
import { LineChart, type LineSeries } from '../components/LineChart'
import { DataTable, type Column } from '../components/DataTable'
import { Users, MessagesSquare, Layers, AppWindow } from 'lucide-react'

interface UserRow {
  userId: string
  name: string
  upn: string | null
  activeDays: number
  threads: number
  messages: number
  prompts: number
  responses: number
  apps: number
  topApp: string
  lastActivity: string
}
interface InsightsData {
  kpis: {
    activeUsers: number
    totalUsers: number
    threads: number
    messages: number
    prompts: number
    topApp: string | null
    topAppMessages: number
  }
  trend: Array<{ day: string; messages: number; threads: number }>
  apps: Array<{ label: string; messages: number; share: number }>
  users: UserRow[]
}
interface UserOpt {
  id: string
  name: string
}
interface AppOpt {
  value: string
  label: string
}
interface Filters {
  dateFrom: string
  dateTo: string
  userId: string
  app: string
}

const EMPTY_FILTERS: Filters = { dateFrom: '', dateTo: '', userId: '', app: '' }
const EMPTY_DATA: InsightsData = {
  kpis: { activeUsers: 0, totalUsers: 0, threads: 0, messages: 0, prompts: 0, topApp: null, topAppMessages: 0 },
  trend: [],
  apps: [],
  users: []
}
const SERIES: LineSeries[] = [
  { key: 'messages', color: 'var(--accent)', label: '메시지' },
  { key: 'threads', color: '#2dd4bf', label: '스레드' }
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

const COLUMNS: Column<UserRow>[] = [
  { key: 'name', header: '사용자', cell: (r) => r.name, sortValue: (r) => r.name.toLowerCase() },
  { key: 'upn', header: 'UPN', cell: (r) => r.upn || '—', sortValue: (r) => (r.upn ?? '').toLowerCase() },
  { key: 'activeDays', header: '활동일', align: 'right', cell: (r) => n(r.activeDays), sortValue: (r) => r.activeDays },
  { key: 'threads', header: '스레드', align: 'right', cell: (r) => n(r.threads), sortValue: (r) => r.threads },
  { key: 'messages', header: '메시지', align: 'right', cell: (r) => n(r.messages), sortValue: (r) => r.messages },
  { key: 'prompts', header: '프롬프트', align: 'right', cell: (r) => n(r.prompts), sortValue: (r) => r.prompts },
  { key: 'responses', header: '응답', align: 'right', cell: (r) => n(r.responses), sortValue: (r) => r.responses },
  { key: 'apps', header: '앱', align: 'right', cell: (r) => n(r.apps), sortValue: (r) => r.apps },
  { key: 'topApp', header: '최상위 앱', cell: (r) => r.topApp, sortValue: (r) => r.topApp.toLowerCase() },
  { key: 'lastActivity', header: '마지막 활동', cell: (r) => dt(r.lastActivity), sortValue: (r) => r.lastActivity }
]

export function Insights(): JSX.Element {
  const [data, setData] = useState<InsightsData>(EMPTY_DATA)
  const [users, setUsers] = useState<UserOpt[]>([])
  const [apps, setApps] = useState<AppOpt[]>([])
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)

  useEffect(() => {
    invoke<UserOpt[]>('insights_users')
      .then(setUsers)
      .catch(() => setUsers([]))
    invoke<AppOpt[]>('insights_apps')
      .then(setApps)
      .catch(() => setApps([]))
  }, [])

  useEffect(() => {
    const payload = {
      dateFrom: applied.dateFrom || undefined,
      dateTo: applied.dateTo || undefined,
      userId: applied.userId || undefined,
      app: applied.app || undefined
    }
    invoke<InsightsData>('insights_data', payload)
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
        <select
          className="filter-field"
          value={draft.userId}
          onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
          title="사용자 필터"
        >
          <option value="">모든 사용자</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select
          className="filter-field"
          value={draft.app}
          onChange={(e) => setDraft({ ...draft, app: e.target.value })}
          title="앱 필터"
        >
          <option value="">모든 앱</option>
          {apps.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          적용
        </button>
        <button type="button" className="conv-btn ghost" onClick={reset}>
          초기화
        </button>
      </form>

      <div className="kpi-row">
        <Kpi
          icon={<Users />}
          label="활성 사용자"
          value={n(k.activeUsers)}
          foot={`전체 ${n(k.totalUsers)}명`}
        />
        <Kpi icon={<Layers />} label="스레드" value={n(k.threads)} foot="대화 스레드 수" />
        <Kpi
          icon={<MessagesSquare />}
          label="메시지"
          value={n(k.messages)}
          foot={`프롬프트 ${n(k.prompts)}개`}
        />
        <Kpi
          icon={<AppWindow />}
          label="최상위 앱"
          value={k.topApp ?? '—'}
          foot={k.topApp ? `${n(k.topAppMessages)}개 메시지` : ''}
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>일별 활동 추이</h2>
            <span className="hint">메시지 · 스레드</span>
          </div>
          <div className="card-body">
            <LineChart data={data.trend} series={SERIES} height={240} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>앱별 메시지</h2>
            <span className="hint">상위 {data.apps.length}개</span>
          </div>
          <div className="card-body">
            <div className="distbars">
              {data.apps.map((a) => (
                <div className="distrow" key={a.label}>
                  <span className="distlabel" title={a.label}>
                    {a.label}
                  </span>
                  <span className="distbar">
                    <span style={{ width: `${a.share}%` }} />
                  </span>
                  <span className="distval">{n(a.messages)}</span>
                </div>
              ))}
              {data.apps.length === 0 && <div className="empty-state">데이터 없음</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>사용자별 활동 요약</h2>
          <span className="hint">{n(data.users.length)}명</span>
        </div>
        <div className="card-body">
          <DataTable<UserRow>
            rows={data.users}
            rowKey={(r) => r.userId}
            columns={COLUMNS}
            initialSort={{ key: 'messages', direction: 'desc' }}
            maxHeight={420}
          />
        </div>
      </div>
    </div>
  )
}

