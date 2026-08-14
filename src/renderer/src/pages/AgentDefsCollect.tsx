import { useEffect, useRef, useState } from 'react'
import {
  ShieldAlert,
  AlertTriangle,
  Zap,
  Boxes,
  CloudDownload,
  Loader2,
  KeyRound,
  ChevronRight,
  ChevronDown
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'
import { useNumberFormat } from '../lib/format'

type Severity = 'critical' | 'high' | 'medium' | 'low'

interface Finding {
  key: string
  category: string
  severity: Severity
  count: number
  evidence: string | null
}
interface AgentRow {
  name: string
  env: string
  score: number
  band: string
  trigger: boolean
  external: number
  loops: number
  findings: Finding[]
}
interface DTO {
  kpis: { agents: number; high: number; triggers: number; environments: number; critical: number }
  agents: AgentRow[]
}

const FALLBACK: DTO = { kpis: { agents: 0, high: 0, triggers: 0, environments: 0, critical: 0 }, agents: [] }

const SEV_CLASS: Record<Severity, string> = { critical: 'crit', high: 'high', medium: 'med', low: 'low' }
const SEV_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 }

function bandSev(band: string): string {
  if (band === 'critical' || band === 'high') return 'high'
  if (band === 'medium') return 'med'
  return 'low'
}

/** Collapse a finding list into one badge per severity, most severe first. */
function severityCounts(findings: Finding[]): Array<{ severity: Severity; count: number }> {
  const counts = new Map<Severity, number>()
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1)
  return [...counts.entries()]
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
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
  const SEV_LABEL: Record<Severity, string> = {
    critical: t('severity.critical'),
    high: t('severity.high'),
    medium: t('severity.medium'),
    low: t('severity.low')
  }
  const [d, setD] = useState<DTO>(FALLBACK)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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

      <div className="kpi-row kpi-row-5">
        <Kpi icon={<Boxes />} label={t('kpis.agents')} value={n(d.kpis.agents)} foot="agent_definitions" />
        <Kpi
          icon={<KeyRound />}
          label={t('kpis.critical')}
          value={n(d.kpis.critical)}
          foot={t('kpis.criticalFoot')}
          tone="danger"
        />
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
              <th>{t('table.columns.findings')}</th>
              <th>{t('table.columns.signals')}</th>
            </tr>
          </thead>
          <tbody>
            {d.agents.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  {t('table.empty')}
                </td>
              </tr>
            ) : (
              d.agents.flatMap((a, i) => {
                const id = `${a.name}-${a.env}-${i}`
                const open = expanded.has(id)
                const chips = severityCounts(a.findings)
                const rows = [
                  <tr key={id}>
                    <td className="ttl">{a.name}</td>
                    <td className="muted">{a.env}</td>
                    <td>
                      <span className={`sev ${bandSev(a.band)}`}>
                        {a.score} · {BAND_LABEL[a.band] || a.band}
                      </span>
                    </td>
                    <td>
                      {a.findings.length === 0 ? (
                        <span className="muted">{t('table.noFindings')}</span>
                      ) : (
                        <button className="finding-toggle" onClick={() => toggle(id)} aria-expanded={open}>
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="finding-chips">
                            {chips.map((c) => (
                              <span key={c.severity} className={`sev ${SEV_CLASS[c.severity]}`}>
                                {SEV_LABEL[c.severity]} {c.count}
                              </span>
                            ))}
                          </span>
                        </button>
                      )}
                    </td>
                    <td className="muted">
                      {a.trigger && <AlertTriangle size={13} style={{ verticalAlign: 'middle' }} />}{' '}
                      {t('table.signals', { external: a.external, loops: a.loops })}
                    </td>
                  </tr>
                ]
                if (open && a.findings.length > 0) {
                  rows.push(
                    <tr key={`${id}-detail`}>
                      <td colSpan={5}>
                        <div className="finding-list">
                          {a.findings.map((f) => (
                            <div key={f.key} className={`finding-item ${SEV_CLASS[f.severity]}`}>
                              <span className={`sev ${SEV_CLASS[f.severity]}`}>{SEV_LABEL[f.severity]}</span>
                              <div className="finding-body">
                                <div className="finding-title">
                                  {t(`findings.${f.key}.title`, { defaultValue: f.key })}
                                </div>
                                <div className="finding-fix">{t(`findings.${f.key}.fix`, { defaultValue: '' })}</div>
                                {f.evidence && <div className="finding-evidence">{f.evidence}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                }
                return rows
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
