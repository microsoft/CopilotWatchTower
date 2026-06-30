import { useEffect, useState } from 'react'
import { Plus, Trash2, LogIn, Loader2 } from 'lucide-react'
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
      isLast
        ? `'${p.name}'은(는) 마지막 프로필입니다.\n삭제하면 모든 데이터가 사라지고, 다시 시작하려면 새 프로필을 추가해야 합니다. 계속할까요?`
        : `'${p.name}' 프로필을 삭제할까요?\n이 프로필에 수집된 데이터(store.db)가 영구 삭제됩니다.`
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
        window.alert(`삭제 실패: ${res?.error ?? 'unknown'}`)
      }
    } catch (e) {
      window.alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="content">
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>프로필 관리</h2>
            <span className="hint">{profiles.length}개</span>
          </div>
          <div className="card-body">
            <div className="profile-list">
              {profiles.map((p) => (
                <div key={p.id} className={`profile-item${p.id === activeId ? ' active' : ''}`}>
                  <div className="avatar sm">{p.name.slice(0, 1).toUpperCase()}</div>
                  <div className="profile-item-text">
                    <div className="profile-item-name">
                      {p.name}
                      {p.id === activeId && <span className="tag-active">활성</span>}
                    </div>
                    <div className="muted sm">{p.tenant_domain ?? '—'}</div>
                  </div>
                  <div className="profile-item-actions">
                    {p.id !== activeId && (
                      <button className="btn-sm" disabled={!!busy} onClick={() => switchTo(p.id)}>
                        {busy === p.id ? <Loader2 size={13} className="spin" /> : <LogIn size={13} />}
                        전환
                      </button>
                    )}
                    <button
                      className="btn-sm danger"
                      disabled={!!busy}
                      title="프로필 삭제"
                      onClick={() => remove(p)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {profiles.length === 0 && <div className="empty-state">등록된 프로필이 없습니다.</div>}
            </div>
            <button className="btn primary profile-add-btn" disabled={!!busy} onClick={() => onAddProfile?.()}>
              <Plus size={15} /> 프로필 추가
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>시스템 정보</h2>
          </div>
          <div className="card-body">
            <div className="kv">
              <span>앱</span>
              <b>{info?.app ?? '—'}</b>
            </div>
            <div className="kv">
              <span>활성 프로필</span>
              <b>{info?.profile ?? '—'}</b>
            </div>
            <div className="kv">
              <span>테넌트</span>
              <b>{info?.tenant ?? '—'}</b>
            </div>
            <div className="kv">
              <span>버전</span>
              <b>{info?.version ?? '—'}</b>
            </div>
            <div className="kv">
              <span>테마</span>
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

