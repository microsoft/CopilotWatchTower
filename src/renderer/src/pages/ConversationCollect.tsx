import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare, Users, GitBranch, PlayCircle, Radio, Loader2, Search, DownloadCloud } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { DataTable, type Column } from '../components/DataTable'
import { RawJsonButton } from '../components/RawJsonModal'
import { useCollectionRun, startRun, startConversationUser, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

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

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function ConversationCollect(): JSX.Element {
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
    { key: 'user', header: '사용자', cell: (u) => <span className="ttl">{u.user}</span>, sortValue: (u) => u.user },
    { key: 'count', header: '상호작용', align: 'right', cell: (u) => n(u.count), sortValue: (u) => u.count },
    { key: 'last', header: '워터마크', cell: (u) => <span className="muted">{u.last}</span>, sortValue: (u) => u.last },
    {
      key: 'backfill',
      header: '백필',
      cell: (u) => <span className={`stat ${u.backfill ? 'ok' : 'idle'}`}>{u.backfill ? '완료' : '진행 중'}</span>,
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
          title="이 사용자만 다시 수집"
          onClick={() => startConversationUser(u.userId, u.user)}
        >
          <DownloadCloud size={13} /> 수집
        </button>
      )
    }
  ]

  const runColumns: Column<RunRow>[] = [
    { key: 'started', header: '시작', cell: (r) => <span className="muted">{r.started}</span>, sortValue: (r) => r.started },
    { key: 'trigger', header: '트리거', cell: (r) => <span className="muted">{r.trigger}</span>, sortValue: (r) => r.trigger },
    { key: 'users', header: '사용자', align: 'right', cell: (r) => n(r.users), sortValue: (r) => r.users },
    { key: 'interactions', header: '수집', align: 'right', cell: (r) => n(r.interactions), sortValue: (r) => r.interactions },
    {
      key: 'status',
      header: '상태',
      cell: (r) => (
        <span className={`stat ${r.status}`}>
          {r.status === 'ok' ? '완료' : r.status === 'err' ? `오류 ${r.errors}` : '실행 중'}
        </span>
      ),
      sortValue: (r) => r.status
    },
    {
      key: 'log',
      header: '로그',
      align: 'right',
      cell: (r) => (r.log ? <RawJsonButton data={r.log} title="실행 로그" /> : <span className="muted">—</span>)
    }
  ]

  return (
    <div className="content">
      <div className="page-actions">
        <button className="btn primary" onClick={() => startRun('conversation')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <Radio size={15} />} 전체 수집 시작
        </button>
        <span className="muted action-status">전체 사용자를 순회 수집합니다. 개별 수집은 아래 표의 “수집” 버튼.</span>
      </div>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('conversation')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<MessagesSquare />} label="총 상호작용" value={n(d.kpis.interactions)} foot="interactions" />
        <Kpi icon={<Users />} label="수집 사용자" value={n(d.kpis.users)} foot="distinct" />
        <Kpi icon={<GitBranch />} label="대화 스레드" value={n(d.kpis.threads)} foot="conversation_threads" />
        <Kpi icon={<PlayCircle />} label="마지막 수집" value={d.kpis.lastRun} foot="collection run" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>사용자별 수집 현황</h2>
          <span className="hint">{n(filteredUsers.length)}명</span>
        </div>
        <div className="card-toolbar">
          <div className="search-box">
            <Search size={14} />
            <input
              type="text"
              placeholder="사용자 이름·ID 검색"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
            />
          </div>
        </div>
        {d.users.length === 0 ? (
          <div className="empty">
            <div className="empty-title">아직 수집된 대화가 없습니다</div>
            <div className="empty-desc">위 “전체 수집 시작”을 눌러 수집하세요.</div>
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
          <h2>수집 실행 이력</h2>
          <span className="hint">{n(d.runs.length)}회</span>
        </div>
        {d.runs.length === 0 ? (
          <div className="empty">
            <div className="empty-title">실행 기록이 없습니다</div>
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
