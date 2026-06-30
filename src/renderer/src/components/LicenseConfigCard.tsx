import { useEffect, useState } from 'react'
import { ScanSearch, Save, Lock, Unlock } from 'lucide-react'
import { invoke } from '../lib/api'
import {
  CAPABILITY_LABEL,
  setCapabilitiesLocal,
  useCapabilities,
  type CapabilityKey,
  type CapabilityProfile
} from '../lib/capabilities'

type Flags = { copilot_seats: boolean; e5: boolean; agent_inventory: boolean }

const PRESET_OPTIONS: Array<{ key: string; label: string; flags: Flags }> = [
  { key: 'me3', label: 'ME3 (Copilot 없음)', flags: { copilot_seats: false, e5: false, agent_inventory: false } },
  { key: 'me3_copilot', label: 'ME3 + Copilot', flags: { copilot_seats: true, e5: false, agent_inventory: false } },
  { key: 'me5_copilot', label: 'ME5 + Copilot', flags: { copilot_seats: true, e5: true, agent_inventory: false } },
  { key: 'agent365', label: '+ Agent365', flags: { copilot_seats: true, e5: true, agent_inventory: true } }
]

const CAPS: CapabilityKey[] = ['copilot_seats', 'e5', 'agent_inventory']

function presetForFlags(f: Flags): string {
  const hit = PRESET_OPTIONS.find(
    (p) =>
      p.flags.copilot_seats === f.copilot_seats &&
      p.flags.e5 === f.e5 &&
      p.flags.agent_inventory === f.agent_inventory
  )
  return hit?.key ?? 'custom'
}

const SOURCE_LABEL: Record<string, string> = {
  default: '미설정 (모든 기능 허용)',
  manual: '수동 지정',
  detected: '자동 감지'
}

/**
 * Settings card to choose the tenant's M365 license configuration. The choice
 * is the source of truth for feature gating (capabilities.py parity). "감지하여
 * 채우기" pre-fills from subscribedSkus but never auto-saves.
 */
export function LicenseConfigCard(): JSX.Element {
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
    const o = PRESET_OPTIONS.find((p) => p.key === k)
    if (o) setDraft({ ...o.flags })
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
        setMsg('저장되었습니다. 사이드바 잠금이 갱신됩니다.')
      } else {
        setMsg(`저장 실패: ${r.error ?? '알 수 없는 오류'}`)
      }
    } catch {
      setMsg('저장 중 오류가 발생했습니다.')
    } finally {
      setBusy('idle')
    }
  }
  async function detect(): Promise<void> {
    setBusy('detecting')
    setMsg('테넌트 SKU를 감지하는 중…')
    try {
      const r = await invoke<{ ok: boolean; capabilities?: CapabilityProfile; error?: string }>('capabilities_suggest')
      if (r.ok && r.capabilities) {
        const c = r.capabilities
        setDraft({ copilot_seats: c.copilot_seats, e5: c.e5, agent_inventory: c.agent_inventory })
        setMsg('감지 완료 — 검토 후 [저장]을 눌러 적용하세요.')
      } else {
        setMsg(`감지 실패: ${r.error === 'no-credentials' ? '온보딩이 완료되지 않았습니다.' : r.error ?? '오류'}`)
      }
    } catch {
      setMsg('감지 중 오류가 발생했습니다.')
    } finally {
      setBusy('idle')
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>라이선스 구성</h2>
        <span className={`hint cap-source cap-source-${profile.source}`}>
          {profile.source === 'default' ? <Unlock size={13} /> : <Lock size={13} />}
          {SOURCE_LABEL[profile.source] ?? profile.source}
        </span>
      </div>
      <div className="card-body">
        <p className="muted cap-desc">
          테넌트의 Microsoft 365 라이선스 구성을 지정하면, 사용할 수 없는 기능(대화 탐색(API)·공식 보고서·공식 사용량·에이전트)이
          자동으로 잠깁니다. 지정 전에는 모든 기능이 열려 있습니다.
        </p>

        <label className="cap-field">
          <span className="cap-label">프리셋</span>
          <select className="cap-select" value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
            {PRESET_OPTIONS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="custom">사용자 지정</option>
          </select>
        </label>

        <div className="cap-toggles">
          {CAPS.map((cap) => (
            <label key={cap} className="cap-toggle">
              <input type="checkbox" checked={draft[cap]} onChange={() => toggle(cap)} />
              <span>{CAPABILITY_LABEL[cap]}</span>
            </label>
          ))}
        </div>

        <div className="cap-actions">
          <button className="btn" onClick={detect} disabled={busy !== 'idle'} type="button">
            <ScanSearch size={15} />
            감지하여 채우기
          </button>
          <button className="btn primary" onClick={save} disabled={busy !== 'idle'} type="button">
            <Save size={15} />
            {busy === 'saving' ? '저장 중…' : '저장'}
          </button>
          {msg && <span className="cap-msg muted">{msg}</span>}
        </div>
      </div>
    </div>
  )
}
