import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import { Kpi } from '../components/Kpi'
import { LineChart, type LineSeries } from '../components/LineChart'
import { DataTable, type Column } from '../components/DataTable'
import { useNumberFormat } from '../lib/format'
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

export function Insights(): JSX.Element {
  const { t } = useTranslation('insights')
  const n = useNumberFormat()
  const SERIES: LineSeries[] = [
    { key: 'messages', color: 'var(--accent)', label: t('trend.messages') },
    { key: 'threads', color: '#2dd4bf', label: t('trend.threads') }
  ]
  const COLUMNS: Column<UserRow>[] = [
    { key: 'name', header: t('columns.name'), cell: (r) => r.name, sortValue: (r) => r.name.toLowerCase() },
    { key: 'upn', header: 'UPN', cell: (r) => r.upn || '—', sortValue: (r) => (r.upn ?? '').toLowerCase() },
    { key: 'activeDays', header: t('columns.activeDays'), align: 'right', cell: (r) => n(r.activeDays), sortValue: (r) => r.activeDays },
    { key: 'threads', header: t('columns.threads'), align: 'right', cell: (r) => n(r.threads), sortValue: (r) => r.threads },
    { key: 'messages', header: t('columns.messages'), align: 'right', cell: (r) => n(r.messages), sortValue: (r) => r.messages },
    { key: 'prompts', header: t('columns.prompts'), align: 'right', cell: (r) => n(r.prompts), sortValue: (r) => r.prompts },
    { key: 'responses', header: t('columns.responses'), align: 'right', cell: (r) => n(r.responses), sortValue: (r) => r.responses },
    { key: 'apps', header: t('columns.apps'), align: 'right', cell: (r) => n(r.apps), sortValue: (r) => r.apps },
    { key: 'topApp', header: t('columns.topApp'), cell: (r) => r.topApp, sortValue: (r) => r.topApp.toLowerCase() },
    { key: 'lastActivity', header: t('columns.lastActivity'), cell: (r) => dt(r.lastActivity), sortValue: (r) => r.lastActivity }
  ]
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
        <select
          className="filter-field"
          value={draft.userId}
          onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
          title={t('filters.userFilter')}
        >
          <option value="">{t('filters.allUsers')}</option>
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
          title={t('filters.appFilter')}
        >
          <option value="">{t('filters.allApps')}</option>
          {apps.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          {t('filters.apply')}
        </button>
        <button type="button" className="conv-btn ghost" onClick={reset}>
          {t('filters.reset')}
        </button>
      </form>

      <div className="kpi-row">
        <Kpi
          icon={<Users />}
          label={t('kpis.activeUsers')}
          value={n(k.activeUsers)}
          foot={t('kpis.activeUsersFoot', { count: n(k.totalUsers) })}
        />
        <Kpi icon={<Layers />} label={t('kpis.threads')} value={n(k.threads)} foot={t('kpis.threadsFoot')} />
        <Kpi
          icon={<MessagesSquare />}
          label={t('kpis.messages')}
          value={n(k.messages)}
          foot={t('kpis.messagesFoot', { count: n(k.prompts) })}
        />
        <Kpi
          icon={<AppWindow />}
          label={t('kpis.topApp')}
          value={k.topApp ?? '—'}
          foot={k.topApp ? t('kpis.topAppFoot', { count: n(k.topAppMessages) }) : ''}
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('trend.title')}</h2>
            <span className="hint">{t('trend.subtitle')}</span>
          </div>
          <div className="card-body">
            <LineChart data={data.trend} series={SERIES} height={240} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('appMessages.title')}</h2>
            <span className="hint">{t('appMessages.subtitle', { count: data.apps.length })}</span>
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
              {data.apps.length === 0 && <div className="empty-state">{t('noData', { ns: 'common' })}</div>}
            </div>
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>{t('userSummary.title')}</h2>
          <span className="hint">{t('userSummary.countSuffix', { count: n(data.users.length) })}</span>
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

