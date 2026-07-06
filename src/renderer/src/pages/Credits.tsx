import { useEffect, useRef, useState } from 'react'
import { Coins, TrendingDown, Wallet, TrendingUp, CloudDownload, Loader2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LineChart, type LineSeries } from '../components/LineChart'
import { DataTable, type Column } from '../components/DataTable'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

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

export function Credits(): JSX.Element {
  const { t } = useTranslation('credits')
  const n = useNumberFormat()
  const TREND_SERIES: LineSeries[] = [{ key: 'quantity', color: 'var(--accent)', label: t('trend.label') }]
  const AGENT_COLUMNS: Column<AgentRow>[] = [
    { key: 'name', header: t('columns.agent'), cell: (r) => r.name, sortValue: (r) => r.name.toLowerCase() },
    { key: 'env', header: t('columns.env'), cell: (r) => r.env, sortValue: (r) => r.env.toLowerCase() },
    { key: 'quantity', header: t('columns.quantity'), align: 'right', cell: (r) => n(r.quantity), sortValue: (r) => r.quantity }
  ]
  const ENV_COLUMNS: Column<EnvRow>[] = [
    { key: 'env', header: t('columns.env'), cell: (r) => r.env, sortValue: (r) => r.env.toLowerCase() },
    { key: 'quantity', header: t('columns.quantity'), align: 'right', cell: (r) => n(r.quantity), sortValue: (r) => r.quantity }
  ]
  const USER_COLUMNS: Column<UserRow>[] = [
    { key: 'user', header: t('columns.user'), cell: (r) => r.user, sortValue: (r) => r.user.toLowerCase() },
    { key: 'quantity', header: t('columns.quantity'), align: 'right', cell: (r) => n(r.quantity), sortValue: (r) => r.quantity },
    {
      key: 'share',
      header: t('columns.share'),
      cell: (r) => (
        <div className="minimeter">
          <span style={{ width: `${Math.min(100, r.share)}%` }} />
        </div>
      ),
      sortValue: (r) => r.share
    }
  ]
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
          {t('collectButton')}
        </button>
      </div>
      <p className="ediscovery-desc">
        <Trans i18nKey="credits:autoLoginDesc" components={{ strong: <strong /> }} />
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('consumption')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Coins />} label={t('kpis.purchased')} value={s ? n(s.purchased) : '—'} foot="Copilot Studio" />
        <Kpi
          icon={<Wallet />}
          label={t('kpis.consumed')}
          value={s ? n(s.consumed) : '—'}
          delta={s ? `${pct}%` : undefined}
          foot={s ? t('kpis.consumedFoot', { count: n(s.purchased) }) : ''}
        />
        <Kpi
          icon={<TrendingDown />}
          label={t('kpis.remaining')}
          value={s ? n(s.remaining) : '—'}
          foot={s ? t('kpis.remainingFoot', { pct: 100 - pct }) : ''}
        />
        <Kpi
          icon={<TrendingUp />}
          label={t('kpis.projectedMonth')}
          value={s ? n(s.projectedMonth) : '—'}
          foot={t('kpis.projectedMonthFoot')}
          tone="warn"
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('usage.title')}</h2>
            <span className="hint">{s ? t('usage.asOf', { date: s.latestDate }) : ''}</span>
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
                <span>{t('usage.usedPct', { pct })}</span>
                <span>{t('usage.remaining', { count: s ? n(s.remaining) : '—' })}</span>
              </div>
            </div>
            <div className="credit-facts">
              <div>
                <span className="muted">{t('usage.agents')}</span>
                <strong>{s ? n(s.agentCount) : '—'}</strong>
              </div>
              <div>
                <span className="muted">{t('usage.environments')}</span>
                <strong>{s ? n(s.environmentCount) : '—'}</strong>
              </div>
              <div>
                <span className="muted">{t('usage.users')}</span>
                <strong>{s ? n(s.userCount) : '—'}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('dailyTrend.title')}</h2>
            <span className="hint">{t('dailyTrend.subtitle')}</span>
          </div>
          <div className="card-body">
            <LineChart data={data?.trend ?? []} series={TREND_SERIES} height={210} />
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>{t('detail.title')}</h2>
          <div className="scope-toggle" role="group" aria-label={t('detail.scopeLabel')}>
            <button type="button" className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
              {t('detail.agents')}
            </button>
            <button
              type="button"
              className={tab === 'environments' ? 'active' : ''}
              onClick={() => setTab('environments')}
            >
              {t('detail.environments')}
            </button>
            <button type="button" className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
              {t('detail.users')}
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
          {rows.length === 0 && <div className="empty-state">{t('detail.empty')}</div>}
        </div>
      </div>
    </div>
  )
}

