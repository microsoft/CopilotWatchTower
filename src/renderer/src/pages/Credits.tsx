import { useEffect, useRef, useState } from 'react'
import { Coins, TrendingDown, Wallet, TrendingUp, CloudDownload, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LineChart, type LineSeries } from '../components/LineChart'
import { DataTable, type Column } from '../components/DataTable'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface AgentRow {
  name: string
  env: string
  quantity: number
}
interface EnvRow {
  env: string
  quantity: number
}
interface UserRow {
  user: string
  quantity: number
  share: number
}
interface ExplorerData {
  summary: {
    purchased: number
    consumed: number
    remaining: number
    projectedMonth: number
    agentCount: number
    environmentCount: number
    userCount: number
    latestDate: string
    unit: string
  }
  trend: Array<{ day: string; quantity: number }>
  agents: AgentRow[]
  environments: EnvRow[]
  users: UserRow[]
}

type Tab = 'agents' | 'environments' | 'users'

const TREND_SERIES: LineSeries[] = [{ key: 'quantity', color: 'var(--accent)', label: '메시지 소비' }]

function n(value: number): string {
  return value.toLocaleString('ko-KR')
}

const AGENT_COLUMNS: Column<AgentRow>[] = [
  { key: 'name', header: '에이전트', cell: (r) => r.name, sortValue: (r) => r.name.toLowerCase() },
  { key: 'env', header: '환경', cell: (r) => r.env, sortValue: (r) => r.env.toLowerCase() },
  { key: 'quantity', header: '메시지 소비', align: 'right', cell: (r) => n(r.quantity), sortValue: (r) => r.quantity }
]
const ENV_COLUMNS: Column<EnvRow>[] = [
  { key: 'env', header: '환경', cell: (r) => r.env, sortValue: (r) => r.env.toLowerCase() },
  { key: 'quantity', header: '메시지 소비', align: 'right', cell: (r) => n(r.quantity), sortValue: (r) => r.quantity }
]
const USER_COLUMNS: Column<UserRow>[] = [
  { key: 'user', header: '사용자', cell: (r) => r.user, sortValue: (r) => r.user.toLowerCase() },
  { key: 'quantity', header: '메시지 소비', align: 'right', cell: (r) => n(r.quantity), sortValue: (r) => r.quantity },
  {
    key: 'share',
    header: '비중',
    cell: (r) => (
      <div className="minimeter">
        <span style={{ width: `${Math.min(100, r.share)}%` }} />
      </div>
    ),
    sortValue: (r) => r.share
  }
]

export function Credits(): JSX.Element {
  const [data, setData] = useState<ExplorerData | null>(null)
  const [tab, setTab] = useState<Tab>('agents')
  const run = useCollectionRun('consumption')

  function load(): void {
    invoke<ExplorerData | null>('consumption_explorer')
      .then((d) => {
        if (d) setData(d)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  const prevRunning = useRef(run.running)
  useEffect(() => {
    if (prevRunning.current && !run.running) load()
    prevRunning.current = run.running
  }, [run.running])

  const s = data?.summary
  const pct = s && s.purchased > 0 ? Math.round((s.consumed / s.purchased) * 100) : 0
  const rows = tab === 'agents' ? data?.agents ?? [] : tab === 'environments' ? data?.environments ?? [] : data?.users ?? []

  return (
    <div className="content">
      <div className="page-actions">
        <button className="btn primary" onClick={() => startRun('consumption')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />}
          포털에서 소비 데이터 수집
        </button>
      </div>
      <p className="ediscovery-desc">
        설정의 <strong>다운로드 계정</strong>(eDiscovery 서비스 계정)으로 Power Platform 관리 센터에 자동
        로그인합니다. 계정이 없으면 로그인 창이 표시됩니다.
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('consumption')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Coins />} label="구매 메시지" value={s ? n(s.purchased) : '—'} foot="Copilot Studio" />
        <Kpi
          icon={<Wallet />}
          label="사용 메시지"
          value={s ? n(s.consumed) : '—'}
          delta={s ? `${pct}%` : undefined}
          foot={s ? `구매 ${n(s.purchased)} 중` : ''}
        />
        <Kpi
          icon={<TrendingDown />}
          label="잔여"
          value={s ? n(s.remaining) : '—'}
          foot={s ? `${100 - pct}% 남음` : ''}
        />
        <Kpi
          icon={<TrendingUp />}
          label="예상 월 사용량"
          value={s ? n(s.projectedMonth) : '—'}
          foot="현재 추세 기준"
          tone="warn"
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>크레딧 사용량</h2>
            <span className="hint">{s ? `as of ${s.latestDate}` : ''}</span>
          </div>
          <div className="card-body">
            <div style={{ fontSize: 28, fontWeight: 680, letterSpacing: '-0.02em' }}>
              {s ? n(s.consumed) : '—'}
              <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>
                {' '}
                / {s ? n(s.purchased) : '—'}
              </span>
            </div>
            <div className="credit-meter">
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="meter-foot">
                <span>{pct}% 사용</span>
                <span>{s ? n(s.remaining) : '—'} 남음</span>
              </div>
            </div>
            <div className="credit-facts">
              <div>
                <span className="muted">에이전트</span>
                <strong>{s ? n(s.agentCount) : '—'}</strong>
              </div>
              <div>
                <span className="muted">환경</span>
                <strong>{s ? n(s.environmentCount) : '—'}</strong>
              </div>
              <div>
                <span className="muted">사용자</span>
                <strong>{s ? n(s.userCount) : '—'}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>일별 소비 추이</h2>
            <span className="hint">에이전트 메시지</span>
          </div>
          <div className="card-body">
            <LineChart data={data?.trend ?? []} series={TREND_SERIES} height={210} />
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>소비 상세</h2>
          <div className="scope-toggle" role="group" aria-label="소비 분류">
            <button type="button" className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
              에이전트
            </button>
            <button
              type="button"
              className={tab === 'environments' ? 'active' : ''}
              onClick={() => setTab('environments')}
            >
              환경
            </button>
            <button type="button" className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
              사용자
            </button>
          </div>
        </div>
        <div className="card-body">
          {tab === 'agents' && (
            <DataTable<AgentRow>
              rows={data?.agents ?? []}
              rowKey={(r) => `${r.name}-${r.env}`}
              columns={AGENT_COLUMNS}
              initialSort={{ key: 'quantity', direction: 'desc' }}
              maxHeight={400}
            />
          )}
          {tab === 'environments' && (
            <DataTable<EnvRow>
              rows={data?.environments ?? []}
              rowKey={(r) => r.env}
              columns={ENV_COLUMNS}
              initialSort={{ key: 'quantity', direction: 'desc' }}
              maxHeight={400}
            />
          )}
          {tab === 'users' && (
            <DataTable<UserRow>
              rows={data?.users ?? []}
              rowKey={(r) => r.user}
              columns={USER_COLUMNS}
              initialSort={{ key: 'quantity', direction: 'desc' }}
              maxHeight={400}
            />
          )}
          {rows.length === 0 && <div className="empty-state">수집된 소비 데이터가 없습니다.</div>}
        </div>
      </div>
    </div>
  )
}

