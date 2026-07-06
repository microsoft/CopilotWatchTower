import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare, Users, GitBranch, PlayCircle, Radio, Loader2, Search, DownloadCloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { DataTable, type Column } from '../components/DataTable'
import { RawJsonButton } from '../components/RawJsonModal'
import { useCollectionRun, startRun, startConversationUser, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface UserRow {
  userId: string
  user: string
  count: number
  last: string
  backfill: boolean
}
interface RunRow {
  id: number
  started: string
  trigger: string
  users: number
  interactions: number
  errors: number
  status: string
  log: string
}
interface DTO {
  kpis: { interactions: number; users: number; threads: number; lastRun: string }
  users: UserRow[]
  runs: RunRow[]
}

const FALLBACK: DTO = {
  kpis: { interactions: 0, users: 0, threads: 0, lastRun: '—' },
  users: [],
  runs: []
}

export function ConversationCollect(): JSX.Element {
  const { t } = useTranslation('conversationCollect')
  const n = useNumberFormat()
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('conversation')

  function load(): void {
    invoke<DTO | null>('conversation_collect_status')
      .then((x) => {
        if (x) setD(x)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  // Refresh page data when a run finishes (even one started on another page).
  const prevRunning = useRef(run.running)
  useEffect(() => {
    if (prevRunning.current && !run.running) load()
    prevRunning.current = run.running
  }, [run.running])

  const [userQuery, setUserQuery] = useState('')
  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return d.users
    return d.users.filter((u) => u.user.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q))
  }, [d.users, userQuery])

  const userColumns: Column<UserRow>[] = [
    { key: 'user', header: t('userStatus.columns.user'), cell: (u) => <span className="ttl">{u.user}</span>, sortValue: (u) => u.user },
    { key: 'count', header: t('userStatus.columns.count'), align: 'right', cell: (u) => n(u.count), sortValue: (u) => u.count },
    { key: 'last', header: t('userStatus.columns.last'), cell: (u) => <span className="muted">{u.last}</span>, sortValue: (u) => u.last },
    {
      key: 'backfill',
      header: t('userStatus.columns.backfill'),
      cell: (u) => <span className={`stat ${u.backfill ? 'ok' : 'idle'}`}>{u.backfill ? t('userStatus.backfill.done') : t('userStatus.backfill.inProgress')}</span>,
      sortValue: (u) => (u.backfill ? 1 : 0)
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      cell: (u) => (
        <button
          className="btn-sm"
          disabled={run.running}
          title={t('collectUserTitle')}
          onClick={() => startConversationUser(u.userId, u.user)}
        >
          <DownloadCloud size={13} /> {t('collectUser')}
        </button>
      )
    }
  ]

  const runColumns: Column<RunRow>[] = [
    { key: 'started', header: t('runHistory.columns.started'), cell: (r) => <span className="muted">{r.started}</span>, sortValue: (r) => r.started },
    { key: 'trigger', header: t('runHistory.columns.trigger'), cell: (r) => <span className="muted">{r.trigger}</span>, sortValue: (r) => r.trigger },
    { key: 'users', header: t('runHistory.columns.users'), align: 'right', cell: (r) => n(r.users), sortValue: (r) => r.users },
    { key: 'interactions', header: t('runHistory.columns.interactions'), align: 'right', cell: (r) => n(r.interactions), sortValue: (r) => r.interactions },
    {
      key: 'status',
      header: t('runHistory.columns.status'),
      cell: (r) => (
        <span className={`stat ${r.status}`}>
          {r.status === 'ok' ? t('runHistory.status.done') : r.status === 'err' ? t('runHistory.status.errorCount', { count: r.errors }) : t('runHistory.status.running')}
        </span>
      ),
      sortValue: (r) => r.status
    },
    {
      key: 'log',
      header: t('runHistory.columns.log'),
      align: 'right',
      cell: (r) => (r.log ? <RawJsonButton data={r.log} title={t('runHistory.logTitle')} /> : <span className="muted">—</span>)
    }
  ]

  return (
    <div className="content">
      <div className="page-actions">
        <button className="btn primary" onClick={() => startRun('conversation')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} {t('collectAll')}
        </button>
        <span className="muted action-status">{t('collectAllDesc')}</span>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('conversation')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<MessagesSquare />} label={t('kpis.interactions')} value={n(d.kpis.interactions)} foot="interactions" />
        <Kpi icon={<Users />} label={t('kpis.users')} value={n(d.kpis.users)} foot="distinct" />
        <Kpi icon={<GitBranch />} label={t('kpis.threads')} value={n(d.kpis.threads)} foot="conversation_threads" />
        <Kpi icon={<PlayCircle />} label={t('kpis.lastRun')} value={d.kpis.lastRun} foot="collection run" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('userStatus.title')}</h2>
          <span className="hint">{t('userStatus.count', { count: n(filteredUsers.length) })}</span>
        </div>
        <div className="card-toolbar">
          <div className="search-box">
            <Search size={14} />
            <input
              type="text"
              placeholder={t('userStatus.searchPlaceholder')}
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
            />
          </div>
        </div>
        {d.users.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{t('userStatus.emptyTitle')}</div>
            <div className="empty-desc">{t('userStatus.emptyDesc')}</div>
          </div>
        ) : (
          <DataTable<UserRow>
            rows={filteredUsers}
            rowKey={(u) => u.userId}
            columns={userColumns}
            initialSort={{ key: 'count', direction: 'desc' }}
            pageSize={12}
          />
        )}
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>{t('runHistory.title')}</h2>
          <span className="hint">{t('runHistory.count', { count: n(d.runs.length) })}</span>
        </div>
        {d.runs.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{t('runHistory.emptyTitle')}</div>
          </div>
        ) : (
          <DataTable<RunRow>
            rows={d.runs}
            rowKey={(r) => String(r.id)}
            columns={runColumns}
            initialSort={{ key: 'started', direction: 'desc' }}
            pageSize={10}
          />
        )}
      </div>
    </div>
  )
}
