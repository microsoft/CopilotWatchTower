import { useEffect, useState } from 'react'
import { Bot, Coins, Boxes, Crown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface AgentRow {
  name: string
  env: string
  messages: number
  share: number
}
interface DTO {
  kpis: { agents: number; messages: number; environments: number; top: string }
  agents: AgentRow[]
}

const FALLBACK: DTO = {
  kpis: { agents: 0, messages: 0, environments: 0, top: '—' },
  agents: []
}

export function AgentCredit(): JSX.Element {
  const { t } = useTranslation('agentCredit')
  const n = useNumberFormat()
  const [d, setD] = useState<DTO>(FALLBACK)
  useEffect(() => {
    invoke<DTO | null>('agent_credit_overview')
      .then((x) => {
        if (x) setD(x)
      })
      .catch(() => {})
  }, [])

  return (
    <div className="content">
      <div className="kpi-row">
        <Kpi icon={<Bot />} label={t('kpis.agents')} value={n(d.kpis.agents)} foot="MCSMessages" />
        <Kpi icon={<Coins />} label={t('kpis.messages')} value={n(d.kpis.messages)} foot={t('kpis.messagesFoot')} />
        <Kpi icon={<Boxes />} label={t('kpis.environments')} value={n(d.kpis.environments)} foot="environments" />
        <Kpi icon={<Crown />} label={t('kpis.top')} value={d.kpis.top} foot="top agent" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('table.title')}</h2>
          <span className="hint">{t('table.subtitle', { count: d.agents.length })}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('columns.agent')}</th>
              <th>{t('columns.env')}</th>
              <th>{t('columns.messages')}</th>
              <th>{t('columns.share')}</th>
            </tr>
          </thead>
          <tbody>
            {d.agents.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  {t('table.empty')}
                </td>
              </tr>
            ) : (
              d.agents.map((a, i) => (
                <tr key={i}>
                  <td className="ttl">{a.name}</td>
                  <td className="muted mono">{a.env}</td>
                  <td className="muted">{n(a.messages)}</td>
                  <td>
                    <div className="minimeter">
                      <span style={{ width: `${Math.min(100, a.share)}%` }} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
