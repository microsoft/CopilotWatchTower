import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, AlertTriangle, Zap, Boxes, CloudDownload, Loader2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

interface AgentRow {
  name: string
  env: string
  score: number
  band: string
  trigger: boolean
  external: number
  loops: number
}
interface DTO {
  kpis: { agents: number; high: number; triggers: number; environments: number }
  agents: AgentRow[]
}

const FALLBACK: DTO = { kpis: { agents: 0, high: 0, triggers: 0, environments: 0 }, agents: [] }

function bandSev(band: string): string {
  if (band === 'critical' || band === 'high') return 'high'
  if (band === 'medium') return 'med'
  return 'low'
}

export function AgentDefsCollect(): JSX.Element {
  const { t } = useTranslation('agentDefsCollect')
  const n = useNumberFormat()
  const BAND_LABEL: Record<string, string> = {
    critical: t('band.critical'),
    high: t('band.high'),
    medium: t('band.medium'),
    low: t('band.low')
  }
  const [d, setD] = useState<DTO>(FALLBACK)
  const run = useCollectionRun('agentdefs')

  function load(): void {
    invoke<DTO | null>('agent_defs_status')
      .then((x) => {
        if (x) setD(x)
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

  return (
    <div className="content">
      <div className="page-actions">
        <button className="btn primary" onClick={() => startRun('agentdefs')} disabled={run.running}>
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />} {t('collectButton')}
        </button>
      </div>
      <p className="ediscovery-desc">
        <Trans i18nKey="agentDefsCollect:autoLoginDesc" components={{ strong: <strong /> }} />
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('agentdefs')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<Boxes />} label={t('kpis.agents')} value={n(d.kpis.agents)} foot="agent_definitions" />
        <Kpi icon={<ShieldAlert />} label={t('kpis.high')} value={n(d.kpis.high)} foot={t('kpis.highFoot')} />
        <Kpi icon={<Zap />} label={t('kpis.triggers')} value={n(d.kpis.triggers)} foot="has trigger" />
        <Kpi icon={<Boxes />} label={t('kpis.environments')} value={n(d.kpis.environments)} foot="environments" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('table.title')}</h2>
          <span className="hint">{t('table.subtitle', { count: d.agents.length })}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t('table.columns.agent')}</th>
              <th>{t('table.columns.env')}</th>
              <th>{t('table.columns.risk')}</th>
              <th>{t('table.columns.signals')}</th>
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
                  <td className="muted">{a.env}</td>
                  <td>
                    <span className={`sev ${bandSev(a.band)}`}>
                      {a.score} · {BAND_LABEL[a.band] || a.band}
                    </span>
                  </td>
                  <td className="muted">
                    {a.trigger && <AlertTriangle size={13} style={{ verticalAlign: 'middle' }} />} {t('table.signals', { external: a.external, loops: a.loops })}
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
