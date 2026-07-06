import { useEffect, useRef, useState } from 'react'
import { Languages, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY, type AppLanguage } from '../i18n'

export function LanguagePicker({
  current,
  onSelect
}: {
  current: string
  onSelect: (id: AppLanguage) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="theme-picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title={t('language')}>
        <Languages size={15} />
        {LANGUAGE_LABEL[(current as AppLanguage) in LANGUAGE_LABEL ? (current as AppLanguage) : 'ko']}
      </button>
      {open && (
        <div className="theme-menu">
          {SUPPORTED_LANGUAGES.map((lng) => (
            <button
              key={lng}
              className={`theme-row${lng === current ? ' active' : ''}`}
              onClick={() => {
                onSelect(lng)
                localStorage.setItem(LANGUAGE_STORAGE_KEY, lng)
                setOpen(false)
              }}
            >
              <span className="theme-name">{LANGUAGE_LABEL[lng]}</span>
              {lng === current && <Check size={14} className="theme-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
