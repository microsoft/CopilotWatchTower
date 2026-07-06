import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { OnboardModal } from './components/OnboardModal'
import { WelcomeGate } from './components/WelcomeGate'
import { LockedNotice } from './components/LockedNotice'
import { invoke } from './lib/api'
import { loadCapabilities, useCapabilities, gateFor } from './lib/capabilities'
import { THEMES, applyTheme } from './lib/theme'
import i18n, { loadStoredLanguage, LANGUAGE_STORAGE_KEY, type AppLanguage } from './i18n'
import { ROUTES, DEFAULT_ROUTE } from './routes'
import type { SystemInfo } from './types'

export type { SystemInfo }

export function App(): JSX.Element {
  const { t } = useTranslation('nav')
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [active, setActive] = useState(DEFAULT_ROUTE)
  const [themeId, setThemeId] = useState(() => localStorage.getItem('cwt-theme') || 'watchtower')
  const [languageId, setLanguageId] = useState<AppLanguage>(() => loadStoredLanguage())
  const [refreshKey, setRefreshKey] = useState(0)
  const [onboardOpen, setOnboardOpen] = useState(false)
  const [profileState, setProfileState] = useState<'loading' | 'none' | 'ready'>('loading')
  const caps = useCapabilities()

  useEffect(() => {
    invoke<SystemInfo>('system_info')
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  // Load the license-capability profile so nav gating reflects the tenant.
  useEffect(() => {
    loadCapabilities()
  }, [])

  // Detect the "no profile" state (fresh install OR last profile deleted) so we
  // can show a welcome/onboarding gate instead of an empty app shell.
  useEffect(() => {
    invoke<{ activeId: string | null }>('profiles_list')
      .then((d) => setProfileState(d.activeId ? 'ready' : 'none'))
      .catch(() => setProfileState('ready'))
  }, [])

  useEffect(() => {
    const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0]
    applyTheme(theme)
    localStorage.setItem('cwt-theme', theme.id)
  }, [themeId])

  useEffect(() => {
    void i18n.changeLanguage(languageId)
    localStorage.setItem(LANGUAGE_STORAGE_KEY, languageId)
  }, [languageId])

  const routeKey = ROUTES[active] ? active : DEFAULT_ROUTE
  const route = ROUTES[routeKey]
  const Page = route.Component
  const gate = gateFor(active, caps)

  if (profileState === 'loading') {
    return (
      <div className="app app-welcome">
        <div className="welcome-gate" />
      </div>
    )
  }

  if (profileState === 'none') {
    return (
      <div className="app app-welcome">
        <WelcomeGate onAdd={() => setOnboardOpen(true)} />
        {onboardOpen && <OnboardModal onClose={() => setOnboardOpen(false)} />}
      </div>
    )
  }

  return (
    <div className="app">
      <Sidebar active={active} onSelect={setActive} info={info} onAddProfile={() => setOnboardOpen(true)} />
      <main className="main">
        <Topbar
          title={t(`routes.${routeKey}.title`)}
          subtitle={t(`routes.${routeKey}.subtitle`)}
          themeId={themeId}
          onThemeChange={setThemeId}
          languageId={languageId}
          onLanguageChange={setLanguageId}
          onRefresh={() => setRefreshKey((k) => k + 1)}
        />
        {gate.locked ? (
          <LockedNotice required={gate.required} onConfigure={() => setActive('settings')} />
        ) : (
          <Page
            key={`${active}:${refreshKey}`}
            info={info}
            source={route.source}
            onAddProfile={() => setOnboardOpen(true)}
            onNavigate={setActive}
            themeId={themeId}
            onThemeChange={setThemeId}
          />
        )}
      </main>
      {onboardOpen && <OnboardModal onClose={() => setOnboardOpen(false)} />}
    </div>
  )
}
