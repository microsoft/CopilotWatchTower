import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Eagerly load every namespace file under locales/<lng>/<ns>.json. Adding a new
// namespace is just a matter of dropping `locales/ko/<ns>.json` (+ the other
// languages) — no central registry edit needed. Mirrors the pattern used by the
// (now retired) legacy/web/src/i18n/index.ts.
const modules = import.meta.glob('./locales/*/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>

const resources: Record<string, Record<string, Record<string, unknown>>> = {}
for (const [path, mod] of Object.entries(modules)) {
  const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/)
  if (!match) continue
  const [, lng, ns] = match
  ;(resources[lng] ??= {})[ns] = mod.default
}

export const SUPPORTED_LANGUAGES = ['ko', 'en', 'ja', 'zh-CN', 'es'] as const
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const LANGUAGE_LABEL: Record<AppLanguage, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
  'zh-CN': '简体中文',
  es: 'Español'
}

// Maps an app language to an Intl/Number.toLocaleString locale tag.
export const LOCALE_TAG: Record<AppLanguage, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
  'zh-CN': 'zh-CN',
  es: 'es-ES'
}

export const LANGUAGE_STORAGE_KEY = 'cwt-language'

export function loadStoredLanguage(): AppLanguage {
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (raw && (SUPPORTED_LANGUAGES as readonly string[]).includes(raw)) return raw as AppLanguage
  } catch {
    /* ignore */
  }
  return 'ko'
}

const namespaces = Array.from(new Set(Object.values(resources).flatMap((nsMap) => Object.keys(nsMap))))

void i18n.use(initReactI18next).init({
  resources,
  lng: loadStoredLanguage(),
  fallbackLng: 'ko',
  ns: namespaces,
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false
})

export default i18n
