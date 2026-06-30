import { useEffect, useState } from 'react'
import { MessagesSquare, Users, Bot, AlertTriangle, UserMinus, Activity } from 'lucide-react'
import { invoke } from '../lib/api'
import { Kpi } from '../components/Kpi'
import { LineChart, type LineSeries } from '../components/LineChart'
import { useCapabilities } from '../lib/capabilities'
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

function n(value: number): string {
  return value.toLocaleString('ko-KR')
}

const DASH_SERIES: LineSeries[] = [
  { key: 'messages', color: 'var(--accent)', label: '턴' },
  { key: 'threads', color: '#2dd4bf', label: '스레드' },
  { key: 'prompts', color: '#a78bfa', label: '프롬프트' }
]

export function Dashboard({ onNavigate }: PageProps): JSX.Element {
  const [summary, setSummary] = useState<Summary | null>(null)
  const caps = useCapabilities()

  useEffect(() => {
    invoke<Summary>('dashboard_summary').then(setSummary).catch(() => {})
  }, [])

  const s = summary
  const adoptionPct = s ? Math.round(s.adoptionRate * 100) : 0
  const creditPct = s && s.creditsTotal > 0 ? Math.round((s.creditsUsed / s.creditsTotal) * 100) : 0

  return (
    <div className="content">
      {caps.source === 'default' && (
        <div className="license-banner">
          <AlertTriangle size={16} />
          <span>
            테넌트의 라이선스 구성이 아직 지정되지 않았습니다. 지정하면 사용할 수 없는 기능이 자동으로 정리되어 불필요한 오류를
            줄일 수 있습니다.
          </span>
          {onNavigate && (
            <button className="btn-sm" onClick={() => onNavigate('settings')} type="button">
              라이선스 구성
            </button>
          )}
        </div>
      )}
      <div className="kpi-row kpi-row-6">
        <Kpi
          icon={<Users />}
          label="활성 사용자"
          value={s ? n(s.activeUsers) : '—'}
          foot={s ? `전체 ${n(s.usersTotal)}명` : ''}
        />
        <Kpi
          icon={<MessagesSquare />}
          label="총 상호작용"
          value={s ? n(s.interactions) : '—'}
          foot={s ? `스레드 ${n(s.threads)}개` : ''}
        />
        <Kpi
          icon={<Activity />}
          label="의미 있는 상호작용"
          value={s ? n(s.sessions) : '—'}
          foot={s ? `프롬프트 ${n(s.prompts)}개` : ''}
        />
        <Kpi
          icon={<UserMinus />}
          label="미사용 라이선스"
          value={s ? n(s.inactiveLicensed) : '—'}
          foot={s ? `도입률 ${adoptionPct}% · 라이선스 ${n(s.licensedUsers)}` : ''}
          tone={s && s.inactiveLicensed > 0 ? 'danger' : undefined}
        />
        <Kpi icon={<Bot />} label="에이전트" value={s ? n(s.agents) : '—'} foot="등록·관찰 에이전트" />
        <Kpi
          icon={<AlertTriangle />}
          label="위험 신호"
          value={s ? n(s.riskSignals) : '—'}
          foot="차단·거부 감사 이벤트"
          tone={s && s.riskSignals > 0 ? 'danger' : undefined}
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>사용 추이</h2>
            <span className="hint">최근 15일</span>
          </div>
          <div className="card-body">
            <LineChart data={s?.trend ?? []} series={DASH_SERIES} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>파워플랫폼 크레딧</h2>
            <span className="hint">이번 달</span>
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
                <span>{creditPct}% 사용</span>
                <span>{s ? n(Math.max(0, s.creditsTotal - s.creditsUsed)) : '—'} 남음</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>상위 사용자</h2>
            <span className="hint">상호작용 수</span>
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
              {(s?.topUsers ?? []).length === 0 && <div className="empty-state">데이터 없음</div>}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>앱별 사용량</h2>
            <span className="hint">상위 앱</span>
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
              {(s?.appBreakdown ?? []).length === 0 && <div className="empty-state">데이터 없음</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
