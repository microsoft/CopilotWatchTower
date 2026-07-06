import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import {
  Activity,
  Bot,
  Coins,
  FileSearch,
  KeyRound,
  MessageSquareText,
  ShieldAlert,
  type LucideIcon
} from 'lucide-react'

interface SourceSpec {
  icon: LucideIcon
  color: string
  title: string
  summary: string
  technology: string
  data: string[]
  permissions: string[]
  constraints: string[]
  viewIn: string
}

const SOURCE_META: Array<{ key: string; icon: LucideIcon; color: string }> = [
  { key: 'api', icon: MessageSquareText, color: '#60a5fa' },
  { key: 'ediscovery', icon: FileSearch, color: '#38bdf8' },
  { key: 'teams', icon: Bot, color: '#34d399' },
  { key: 'agents', icon: Bot, color: '#fbbf24' },
  { key: 'consumption', icon: Coins, color: '#f472b6' },
  { key: 'audit', icon: ShieldAlert, color: '#a78bfa' },
  { key: 'usage', icon: Activity, color: '#2dd4bf' }
]

function SpecBlock({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="co-spec">
      <span className="co-spec-label">{label}</span>
      {children}
    </div>
  )
}

export function Collect(): JSX.Element {
  const { t } = useTranslation('collect')
  const SOURCES: SourceSpec[] = SOURCE_META.map(({ key, icon, color }) => ({
    icon,
    color,
    title: t(`sources.${key}.title`),
    summary: t(`sources.${key}.summary`),
    technology: t(`sources.${key}.technology`),
    data: t(`sources.${key}.data`, { returnObjects: true }) as string[],
    permissions: t(`sources.${key}.permissions`, { returnObjects: true }) as string[],
    constraints: t(`sources.${key}.constraints`, { returnObjects: true }) as string[],
    viewIn: t(`sources.${key}.viewIn`)
  }))

  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <h2>{t('overview.title')}</h2>
        </div>
        <div className="card-body">
          <p className="co-intro">
            <Trans
              i18nKey="collect:intro"
              components={{
                strongData: <strong />,
                strongTech: <strong />,
                strongPerm: <strong />,
                strongConstraint: <strong />
              }}
            />
          </p>
        </div>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>{t('authMethod.title')}</h2>
        </div>
        <div className="card-body">
          <div className="co-auth">
            <KeyRound size={18} className="co-auth-icon" />
            <div className="co-auth-body">
              <div>
                <strong>{t('authMethod.bootstrapLabel')}</strong>
                {t('authMethod.bootstrapDesc')}
              </div>
              <div>
                <strong>{t('authMethod.appOnlyLabel')}</strong>
                {t('authMethod.appOnlyDesc')}
              </div>
              <div className="co-auth-note">
                <Trans
                  i18nKey="collect:authMethod.noteDesc"
                  values={{ label: t('authMethod.noteLabel') }}
                  components={{ 1: <strong /> }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="co-grid">
        {SOURCES.map((s) => (
          <div className="card co-source" key={s.title}>
            <div className="card-head">
              <h2 className="co-source-title">
                <span className="co-source-icon" style={{ background: `${s.color}22`, color: s.color }}>
                  <s.icon size={15} strokeWidth={2.2} />
                </span>
                {s.title}
              </h2>
            </div>
            <div className="card-body co-source-body">
              <p className="co-summary">{s.summary}</p>
              <SpecBlock label={t('specLabels.technology')}>
                <span className="co-tech">{s.technology}</span>
              </SpecBlock>
              <SpecBlock label={t('specLabels.data')}>
                <ul className="co-bullets">
                  {s.data.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </SpecBlock>
              <SpecBlock label={t('specLabels.permissions')}>
                <div className="co-chips">
                  {s.permissions.map((p) => (
                    <span className="co-chip" key={p}>
                      {p}
                    </span>
                  ))}
                </div>
              </SpecBlock>
              <SpecBlock label={t('specLabels.constraints')}>
                <ul className="co-bullets">
                  {s.constraints.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </SpecBlock>
              <div className="co-viewin">
                {t('viewIn')}
                <strong>{s.viewIn}</strong>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
