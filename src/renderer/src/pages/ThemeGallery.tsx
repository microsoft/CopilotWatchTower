import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { THEMES, mix, type Theme } from '../lib/theme'
import type { PageProps } from '../types'

const KPIS = ['128', '94%', '7']

function sidebarTone(t: Theme): string {
  return mix(t.bg, t.mode === 'dark' ? '#000000' : t.text, t.mode === 'dark' ? 0.28 : 0.05)
}

function ThemeCard({ t, active, onSelect }: { t: Theme; active: boolean; onSelect: () => void }): JSX.Element {
  const { t: tr } = useTranslation('themeGallery')
  return (
    <button className={`tg-card${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="tg-preview" style={{ background: t.bg }}>
        <div className="tg-side" style={{ background: sidebarTone(t), borderColor: t.border }}>
          <span className="tg-side-dot" style={{ background: t.accent }} />
          <span className="tg-side-bar" style={{ background: t.text, opacity: 0.5 }} />
          <span className="tg-side-bar" style={{ background: t.textMuted, opacity: 0.4 }} />
          <span className="tg-side-bar" style={{ background: t.textMuted, opacity: 0.4 }} />
          <span className="tg-side-bar" style={{ background: t.textMuted, opacity: 0.4 }} />
        </div>
        <div className="tg-main">
          <div className="tg-kpis">
            {KPIS.map((k, i) => (
              <div key={i} className="tg-kpi" style={{ background: t.panel, borderColor: t.border }}>
                <span className="tg-kpi-num" style={{ color: t.text }}>
                  {k}
                </span>
                <span className="tg-kpi-lbl" style={{ background: t.textMuted, opacity: 0.5 }} />
              </div>
            ))}
          </div>
          <div className="tg-card-inner" style={{ background: t.panel, borderColor: t.border }}>
            <span className="tg-line tg-line-lg" style={{ background: t.text }} />
            <span className="tg-line" style={{ background: t.textMuted, opacity: 0.6 }} />
            <span className="tg-line tg-line-sm" style={{ background: t.textMuted, opacity: 0.5 }} />
            <div className="tg-row">
              <span className="tg-btn" style={{ background: t.accent }} />
              <span className="tg-btn2" style={{ background: t.accent2 ?? t.accent }} />
              <span className="tg-flex" />
              <span className="tg-sdot" style={{ background: t.ok }} />
              <span className="tg-sdot" style={{ background: t.warn }} />
              <span className="tg-sdot" style={{ background: t.danger }} />
            </div>
          </div>
        </div>
      </div>
      <div className="tg-meta">
        <span className="tg-name">{t.name}</span>
        <span className="tg-mode">{t.mode === 'dark' ? tr('mode.dark') : tr('mode.light')}</span>
        {active && <Check size={15} className="tg-check" />}
      </div>
    </button>
  )
}

export function ThemeGallery({ themeId, onThemeChange }: PageProps): JSX.Element {
  const { t } = useTranslation('themeGallery')
  const dark = THEMES.filter((t) => t.mode === 'dark')
  const light = THEMES.filter((t) => t.mode === 'light')
  const select = (id: string): void => onThemeChange?.(id)

  return (
    <div className="content">
      <p className="tg-intro">{t('intro', { count: THEMES.length })}</p>

      <div className="tg-section-title">{t('mode.dark')} · {dark.length}</div>
      <div className="tg-grid">
        {dark.map((t) => (
          <ThemeCard key={t.id} t={t} active={t.id === themeId} onSelect={() => select(t.id)} />
        ))}
      </div>

      <div className="tg-section-title">{t('mode.light')} · {light.length}</div>
      <div className="tg-grid">
        {light.map((t) => (
          <ThemeCard key={t.id} t={t} active={t.id === themeId} onSelect={() => select(t.id)} />
        ))}
      </div>
    </div>
  )
}
