import { useTranslation } from 'react-i18next'
import { LOCALE_TAG, type AppLanguage } from '../i18n'

function localeTag(lng: string): string {
  return LOCALE_TAG[(lng as AppLanguage) in LOCALE_TAG ? (lng as AppLanguage) : 'ko']
}

/** Locale-aware number formatting (replaces scattered `toLocaleString('ko-KR')` calls). */
export function formatNumber(value: number, lng: string, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(localeTag(lng), options)
}

/**
 * Hook returning a locale-bound number formatter `n(value)` that follows the
 * currently active i18next language. Use in place of `value.toLocaleString('ko-KR')`.
 */
export function useNumberFormat(): (value: number, options?: Intl.NumberFormatOptions) => string {
  const { i18n } = useTranslation()
  return (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, i18n.language, options)
}
