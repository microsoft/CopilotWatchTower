import { useEffect, useRef, useState } from 'react'
import { Check, Plus, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import type { SystemInfo } from '../types'

interface ProfileEntry {
  id: string
  name: string
  tenant_domain?: string | null
}

export function ProfileMenu({
  info,
  onAddProfile
}: {
  info: SystemInfo | null
  onAddProfile: () => void
}): JSX.Element {
  const { t } = useTranslation('profileMenu')
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    invoke<{ profiles: ProfileEntry[]; activeId: string | null }>('profiles_list')
      .then((d) => {
        setProfiles(d.profiles)
        setActiveId(d.activeId)
      })
      .catch(() => {})
  }, [open])

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  async function switchTo(id: string): Promise<void> {
    if (id === activeId) {
      setOpen(false)
      return
    }
    await invoke('profile_switch', id).catch(() => {})
    location.reload()
  }

  return (
    <div className="profile-menu-wrap" ref={ref}>
      <button className="profile-chip as-button" onClick={() => setOpen((o) => !o)}>
        <div className="avatar">{(info?.profile ?? 'C').slice(0, 1).toUpperCase()}</div>
        <div className="profile-meta">
          <div className="profile-name" title={info?.profile ?? ''}>
            {info?.profile ?? t('unnamed')}
          </div>
          <div className="profile-tenant" title={info?.tenant ?? ''}>
            {info?.tenant ?? t('noTenant')}
          </div>
        </div>
        <ChevronDown size={14} className="profile-caret" />
      </button>

      {open && (
        <div className="profile-pop">
          <div className="profile-pop-title">{t('title')}</div>
          {profiles.map((p) => (
            <button key={p.id} className={`profile-row${p.id === activeId ? ' active' : ''}`} onClick={() => switchTo(p.id)}>
              <div className="avatar sm">{p.name.slice(0, 1).toUpperCase()}</div>
              <div className="profile-row-text">
                <div className="profile-row-name">{p.name}</div>
                <div className="muted sm">{p.tenant_domain ?? ''}</div>
              </div>
              {p.id === activeId && <Check size={14} className="theme-check" />}
            </button>
          ))}
          <button
            className="profile-row add"
            onClick={() => {
              setOpen(false)
              onAddProfile()
            }}
          >
            <Plus size={15} /> {t('add')}
          </button>
        </div>
      )}
    </div>
  )
}
