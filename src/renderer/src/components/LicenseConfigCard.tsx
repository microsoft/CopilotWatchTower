import { useEffect, useState } from 'react'
import { ScanSearch, Save, Lock, Unlock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'
import {
  capabilityLabel,
  setCapabilitiesLocal,
  useCapabilities,
  type CapabilityKey,
  type CapabilityProfile
} from '../lib/capabilities'

type Flags = { copilot_seats: boolean; e5: boolean; agent_inventory: boolean }

const PRESET_FLAGS: Record<string, Flags> = {
  me3: { copilot_seats: false, e5: false, agent_inventory: false },
  me3_copilot: { copilot_seats: true, e5: false, agent_inventory: false },
  me5_copilot: { copilot_seats: true, e5: true, agent_inventory: false },
  agent365: { copilot_seats: true, e5: true, agent_inventory: true }
}
const PRESET_KEYS = ['me3', 'me3_copilot', 'me5_copilot', 'agent365'] as const

const CAPS: CapabilityKey[] = ['copilot_seats', 'e5', 'agent_inventory']

function presetForFlags(f: Flags): string {
  const hit = PRESET_KEYS.find(
    (k) =>
      PRESET_FLAGS[k].copilot_seats === f.copilot_seats &&
      PRESET_FLAGS[k].e5 === f.e5 &&
      PRESET_FLAGS[k].agent_inventory === f.agent_inventory
  )
  return hit ?? 'custom'
}

/**
 * Settings card to choose the tenant's M365 license configuration. The choice
 * is the source of truth for feature gating (capabilities.py parity). Detect
 * pre-fills from subscribedSkus but never auto-saves.
 */
export function LicenseConfigCard(): JSX.Element {
  const { t } = useTranslation('licenseConfig')
  const profile = useCapabilities()
  const [draft, setDraft] = useState<Flags>({
    copilot_seats: profile.copilot_seats,
    e5: profile.e5,
    agent_inventory: profile.agent_inventory
  })
  const [busy, setBusy] = useState<'idle' | 'saving' | 'detecting'>('idle')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setDraft({ copilot_seats: profile.copilot_seats, e5: profile.e5, agent_inventory: profile.agent_inventory })
  }, [profile])

  const presetKey = presetForFlags(draft)

  function applyPreset(k: string): void {
    const flags = PRESET_FLAGS[k]
    if (flags) setDraft({ ...flags })
    setMsg('')
  }
  function toggle(cap: CapabilityKey): void {
    setDraft((d) => ({ ...d, [cap]: !d[cap] }))
    setMsg('')
  }
  async function save(): Promise<void> {
    setBusy('saving')
    try {
      const r = await invoke<{ ok: boolean; capabilities?: CapabilityProfile; error?: string }>('capabilities_set', {
        toggles: draft
      })
      if (r.ok && r.capabilities) {
        setCapabilitiesLocal(r.capabilities)
        setMsg(t('messages.saved'))
      } else {
        setMsg(t('messages.saveFailed', { error: r.error ?? t('unknownError') }))
      }
    } catch {
      setMsg(t('messages.saveError'))
    } finally {
      setBusy('idle')
    }
  }
  async function detect(): Promise<void> {
    setBusy('detecting')
    setMsg(t('messages.detecting'))
    try {
      const r = await invoke<{ ok: boolean; capabilities?: CapabilityProfile; error?: string }>('capabilities_suggest')
      if (r.ok && r.capabilities) {
        const c = r.capabilities
        setDraft({ copilot_seats: c.copilot_seats, e5: c.e5, agent_inventory: c.agent_inventory })
        setMsg(t('messages.detected'))
      } else {
        setMsg(
          t('messages.detectFailed', {
            error: r.error === 'no-credentials' ? t('messages.detectFailedNoCreds') : r.error ?? t('unknownError')
          })
        )
      }
    } catch {
      setMsg(t('messages.detectError'))
    } finally {
      setBusy('idle')
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('title')}</h2>
        <span className={`hint cap-source cap-source-${profile.source}`}>
          {profile.source === 'default' ? <Unlock size={13} /> : <Lock size={13} />}
          {t(`source.${profile.source}`, { defaultValue: profile.source })}
        </span>
      </div>
      <div className="card-body">
        <p className="muted cap-desc">{t('desc')}</p>

        <label className="cap-field">
          <span className="cap-label">{t('presetLabel')}</span>
          <select className="cap-select" value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
            {PRESET_KEYS.map((k) => (
              <option key={k} value={k}>
                {t(`presets.${k}`)}
              </option>
            ))}
            <option value="custom">{t('customOption')}</option>
          </select>
        </label>

        <div className="cap-toggles">
          {CAPS.map((cap) => (
            <label key={cap} className="cap-toggle">
              <input type="checkbox" checked={draft[cap]} onChange={() => toggle(cap)} />
              <span>{capabilityLabel(cap)}</span>
            </label>
          ))}
        </div>

        <div className="cap-actions">
          <button className="btn" onClick={detect} disabled={busy !== 'idle'} type="button">
            <ScanSearch size={15} />
            {t('detect')}
          </button>
          <button className="btn primary" onClick={save} disabled={busy !== 'idle'} type="button">
            <Save size={15} />
            {busy === 'saving' ? t('saving') : t('save')}
          </button>
          {msg && <span className="cap-msg muted">{msg}</span>}
        </div>
      </div>
    </div>
  )
}
