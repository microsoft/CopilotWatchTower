import { useEffect, useState } from 'react'
import { MessagesSquare, Users, Bot, AlertTriangle, UserMinus, Activity } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import { Kpi } from '../components/Kpi'
import { LineChart, type LineSeries } from '../components/LineChart'
import { useCapabilities } from '../lib/capabilities'
import { useNumberFormat } from '../lib/format'
import type { PageProps } from '../types'

interface TrendPoint {
  day: string
  messages: number
  threads: number
  prompts: number
}
interface RankItem {
  user: string
  count: number
  share: number
}
interface AppItem {
  app: string
  count: number
  share: number
}
interface Summary {
  interactions: number
  activeUsers: number
  usersTotal: number
  licensedUsers: number
  inactiveLicensed: number
  adoptionRate: number
  threads: number
  prompts: number
  sessions: number
  riskSignals: number
  agents: number
  creditsUsed: number
  creditsTotal: number
  trend: TrendPoint[]
  topUsers: RankItem[]
  appBreakdown: AppItem[]
}

export function Dashboard({ onNavigate }: PageProps): JSX.Element {
  const { t } = useTranslation('dashboard')
  const n = useNumberFormat()
  const [summary, setSummary] = useState<Summary | null>(null)
  const caps = useCapabilities()

  useEffect(() => {
    invoke<Summary>('dashboard_summary').then(setSummary).catch(() => {})
  }, [])

  const s = summary
  const adoptionPct = s ? Math.round(s.adoptionRate * 100) : 0
  const creditPct = s && s.creditsTotal > 0 ? Math.round((s.creditsUsed / s.creditsTotal) * 100) : 0
  const dashSeries: LineSeries[] = [
    { key: 'messages', color: 'var(--accent)', label: t('trend.messages') },
    { key: 'threads', color: '#2dd4bf', label: t('trend.threads') },
    { key: 'prompts', color: '#a78bfa', label: t('trend.prompts') }
  ]

  return (
    <div className="content">
      {caps.source === 'default' && (
        <div className="license-banner">
          <AlertTriangle size={16} />
          <span>{t('banner.text')}</span>
          {onNavigate && (
            <button className="btn-sm" onClick={() => onNavigate('settings')} type="button">
              {t('banner.cta')}
            </button>
          )}
        </div>
      )}
      <div className="kpi-row kpi-row-6">
        <Kpi
          icon={<Users />}
          label={t('kpis.activeUsers')}
          value={s ? n(s.activeUsers) : '—'}
          foot={s ? t('kpis.activeUsersFoot', { count: n(s.usersTotal) }) : ''}
        />
        <Kpi
          icon={<MessagesSquare />}
          label={t('kpis.interactions')}
          value={s ? n(s.interactions) : '—'}
          foot={s ? t('kpis.interactionsFoot', { count: n(s.threads) }) : ''}
        />
        <Kpi
          icon={<Activity />}
          label={t('kpis.sessions')}
          value={s ? n(s.sessions) : '—'}
          foot={s ? t('kpis.sessionsFoot', { count: n(s.prompts) }) : ''}
        />
        <Kpi
          icon={<UserMinus />}
          label={t('kpis.inactiveLicensed')}
          value={s ? n(s.inactiveLicensed) : '—'}
          foot={s ? t('kpis.inactiveLicensedFoot', { pct: adoptionPct, count: n(s.licensedUsers) }) : ''}
          tone={s && s.inactiveLicensed > 0 ? 'danger' : undefined}
        />
        <Kpi icon={<Bot />} label={t('kpis.agents')} value={s ? n(s.agents) : '—'} foot={t('kpis.agentsFoot')} />
        <Kpi
          icon={<AlertTriangle />}
          label={t('kpis.riskSignals')}
          value={s ? n(s.riskSignals) : '—'}
          foot={t('kpis.riskSignalsFoot')}
          tone={s && s.riskSignals > 0 ? 'danger' : undefined}
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('trend.title')}</h2>
            <span className="hint">{t('trend.subtitle')}</span>
          </div>
          <div className="card-body">
            <LineChart data={s?.trend ?? []} series={dashSeries} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('credits.title')}</h2>
            <span className="hint">{t('credits.subtitle')}</span>
          </div>
          <div className="card-body">
            <div style={{ fontSize: 28, fontWeight: 680, letterSpacing: '-0.02em' }}>
              {s ? n(s.creditsUsed) : '—'}
              <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}>
                {' '}
                / {s ? n(s.creditsTotal) : '—'}
              </span>
            </div>
            <div className="credit-meter">
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${creditPct}%` }} />
              </div>
              <div className="meter-foot">
                <span>{t('credits.usedPct', { pct: creditPct })}</span>
                <span>{t('credits.remaining', { count: s ? n(Math.max(0, s.creditsTotal - s.creditsUsed)) : '—' })}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('topUsers.title')}</h2>
            <span className="hint">{t('topUsers.subtitle')}</span>
          </div>
          <div className="card-body">
            <div className="rank">
              {(s?.topUsers ?? []).map((u) => (
                <div className="rank-row" key={u.user}>
                  <div className="rank-name">{u.user}</div>
                  <div className="rank-credits">{n(u.count)}</div>
                  <div className="rank-bar">
                    <span style={{ width: `${u.share}%` }} />
                  </div>
                </div>
              ))}
              {(s?.topUsers ?? []).length === 0 && <div className="empty-state">{t('noData', { ns: 'common' })}</div>}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('appUsage.title')}</h2>
            <span className="hint">{t('appUsage.subtitle')}</span>
          </div>
          <div className="card-body">
            <div className="rank">
              {(s?.appBreakdown ?? []).map((a) => (
                <div className="rank-row" key={a.app}>
                  <div className="rank-name">{a.app}</div>
                  <div className="rank-credits">{n(a.count)}</div>
                  <div className="rank-bar">
                    <span style={{ width: `${a.share}%` }} />
                  </div>
                </div>
              ))}
              {(s?.appBreakdown ?? []).length === 0 && <div className="empty-state">{t('noData', { ns: 'common' })}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
