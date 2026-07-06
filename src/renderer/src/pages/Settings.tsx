import { useEffect, useState } from 'react'
import { Plus, Trash2, LogIn, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import { LicenseConfigCard } from '../components/LicenseConfigCard'
import { EdiscoveryAccountCard } from '../components/EdiscoveryAccountCard'
import type { PageProps } from '../types'

interface ProfileEntry {
  id: string
  name: string
  tenant_domain?: string | null
}

export function Settings({ info, onAddProfile }: PageProps): JSX.Element {
  const { t } = useTranslation('settings')
  const theme = localStorage.getItem('cwt-theme') || 'watchtower'
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  function load(): void {
    invoke<{ profiles: ProfileEntry[]; activeId: string | null }>('profiles_list')
      .then((d) => {
        setProfiles(d.profiles)
        setActiveId(d.activeId)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  async function switchTo(id: string): Promise<void> {
    if (id === activeId || busy) return
    setBusy(id)
    try {
      await invoke('profile_switch', id)
      location.reload()
    } catch {
      setBusy(null)
    }
  }

  async function remove(p: ProfileEntry): Promise<void> {
    if (busy) return
    const isLast = profiles.length <= 1
    const confirmed = window.confirm(
      isLast ? t('confirm.deleteLast', { name: p.name }) : t('confirm.delete', { name: p.name })
    )
    if (!confirmed) return
    setBusy(p.id)
    try {
      const res = await invoke<{ ok: boolean; error?: string; reload?: boolean }>('profile_delete', p.id)
      if (res?.ok) {
        if (res.reload || isLast) {
          location.reload()
          return
        }
        load()
      } else {
        window.alert(t('messages.deleteFailed', { error: res?.error ?? t('messages.unknownError') }))
      }
    } catch (e) {
      window.alert(t('messages.deleteFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="content">
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{t('profiles.title')}</h2>
            <span className="hint">{t('profiles.count', { count: profiles.length })}</span>
          </div>
          <div className="card-body">
            <div className="profile-list">
              {profiles.map((p) => (
                <div key={p.id} className={`profile-item${p.id === activeId ? ' active' : ''}`}>
                  <div className="avatar sm">{p.name.slice(0, 1).toUpperCase()}</div>
                  <div className="profile-item-text">
                    <div className="profile-item-name">
                      {p.name}
                      {p.id === activeId && <span className="tag-active">{t('profiles.active')}</span>}
                    </div>
                    <div className="muted sm">{p.tenant_domain ?? t('profiles.noTenant')}</div>
                  </div>
                  <div className="profile-item-actions">
                    {p.id !== activeId && (
                      <button className="btn-sm" disabled={!!busy} onClick={() => switchTo(p.id)}>
                        {busy === p.id ? <Loader2 size={13} className="spin" /> : <LogIn size={13} />}
                        {t('profiles.switch')}
                      </button>
                    )}
                    <button
                      className="btn-sm danger"
                      disabled={!!busy}
                      title={t('profiles.deleteTitle')}
                      onClick={() => remove(p)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {profiles.length === 0 && <div className="empty-state">{t('profiles.empty')}</div>}
            </div>
            <button className="btn primary profile-add-btn" disabled={!!busy} onClick={() => onAddProfile?.()}>
              <Plus size={15} /> {t('profiles.add')}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t('systemInfo.title')}</h2>
          </div>
          <div className="card-body">
            <div className="kv">
              <span>{t('systemInfo.app')}</span>
              <b>{info?.app ?? '—'}</b>
            </div>
            <div className="kv">
              <span>{t('systemInfo.activeProfile')}</span>
              <b>{info?.profile ?? '—'}</b>
            </div>
            <div className="kv">
              <span>{t('systemInfo.tenant')}</span>
              <b>{info?.tenant ?? '—'}</b>
            </div>
            <div className="kv">
              <span>{t('systemInfo.version')}</span>
              <b>{info?.version ?? '—'}</b>
            </div>
            <div className="kv">
              <span>{t('systemInfo.theme')}</span>
              <b>{theme}</b>
            </div>
          </div>
        </div>
      </div>

      <div className="section-gap" />

      <LicenseConfigCard />

      <div className="section-gap" />

      <EdiscoveryAccountCard />
    </div>
  )
}

