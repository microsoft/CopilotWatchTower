import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ThemePicker } from './ThemePicker'
import { LanguagePicker } from './LanguagePicker'
import type { AppLanguage } from '../i18n'

export function Topbar({
  title,
  subtitle,
  themeId,
  onThemeChange,
  languageId,
  onLanguageChange,
  onRefresh
}: {
  title: string
  subtitle: string
  themeId: string
  onThemeChange: (id: string) => void
  languageId: AppLanguage
  onLanguageChange: (id: AppLanguage) => void
  onRefresh: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        <div className="subtitle">{subtitle}</div>
      </div>
      <div className="spacer" />
      <span className="pill live">
        <span className="dot" /> {t('live')}
      </span>
      <LanguagePicker current={languageId} onSelect={onLanguageChange} />
      <ThemePicker current={themeId} onSelect={onThemeChange} />
      <button className="btn" onClick={onRefresh}>
        <RefreshCw size={15} /> {t('refresh')}
      </button>
    </div>
  )
}
