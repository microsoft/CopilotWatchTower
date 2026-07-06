import { useEffect, useRef, useState } from 'react'
import { Palette, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { THEMES, type Theme } from '../lib/theme'

export function ThemePicker({
  current,
  onSelect
}: {
  current: string
  onSelect: (id: string) => void
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

  const active = THEMES.find((t) => t.id === current) ?? THEMES[0]
  const dark = THEMES.filter((t) => t.mode === 'dark')
  const light = THEMES.filter((t) => t.mode === 'light')

  const row = (t: Theme): JSX.Element => (
    <button
      key={t.id}
      className={`theme-row${t.id === current ? ' active' : ''}`}
      onClick={() => {
        onSelect(t.id)
        setOpen(false)
      }}
    >
      <span className="swatches" style={{ background: t.panel, borderColor: t.border }}>
        <span style={{ background: t.accent }} />
        <span style={{ background: t.ok }} />
        <span style={{ background: t.text }} />
      </span>
      <span className="theme-name">{t.name}</span>
      {t.id === current && <Check size={14} className="theme-check" />}
    </button>
  )

  return (
    <div className="theme-picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title={t('colorTheme')}>
        <Palette size={15} />
        <span className="swatch-dot" style={{ background: active.accent }} />
        {t('theme')}
      </button>
      {open && (
        <div className="theme-menu">
          <div className="theme-menu-title">{t('mode.dark', { ns: 'themeGallery' })} · {dark.length}</div>
          {dark.map(row)}
          <div className="theme-menu-title">{t('mode.light', { ns: 'themeGallery' })} · {light.length}</div>
          {light.map(row)}
        </div>
      )}
    </div>
  )
}
