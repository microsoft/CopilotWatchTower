/**
 * License-capability store + nav gating (renderer side of capabilities.py).
 *
 * A tiny module-level store (like collectRuns.ts) holds the active capability
 * profile fetched from the main process. Until the admin configures licensing
 * (source === 'default') nothing is gated, so existing profiles are unaffected.
 */
import { useSyncExternalStore } from 'react'
import { invoke } from './api'

export type CapabilityKey = 'copilot_seats' | 'e5' | 'agent_inventory'

export interface CapabilityProfile {
  copilot_seats: boolean
  e5: boolean
  agent_inventory: boolean
  preset: string
  source: 'manual' | 'detected' | 'default'
  updated_at: string | null
}

/** Nav keys that require a capability. Keys not listed are always available. */
export const NAV_REQUIRED_CAPABILITY: Partial<Record<string, CapabilityKey>> = {
  conversationsApi: 'copilot_seats',
  collectConversation: 'copilot_seats',
  reports: 'copilot_seats',
  collectUsage: 'copilot_seats',
  agents: 'agent_inventory',
  collectDiagnostics: 'agent_inventory'
}

const DEFAULT_PROFILE: CapabilityProfile = {
  copilot_seats: true,
  e5: true,
  agent_inventory: true,
  preset: 'custom',
  source: 'default',
  updated_at: null
}

let profile: CapabilityProfile = DEFAULT_PROFILE
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function snapshot(): CapabilityProfile {
  return profile
}

/** Fetch the active profile from the main process and notify subscribers. */
export async function loadCapabilities(): Promise<void> {
  try {
    const p = await invoke<CapabilityProfile & { presets?: string[] }>('capabilities_get')
    if (p && typeof p === 'object') {
      profile = {
        copilot_seats: !!p.copilot_seats,
        e5: !!p.e5,
        agent_inventory: !!p.agent_inventory,
        preset: p.preset || 'custom',
        source: p.source || 'default',
        updated_at: p.updated_at ?? null
      }
      emit()
    }
  } catch {
    /* bridge unavailable (browser preview) — keep the permissive default */
  }
}

/** Apply a profile locally (after a Settings save) without a round-trip. */
export function setCapabilitiesLocal(p: CapabilityProfile): void {
  profile = p
  emit()
}

export function useCapabilities(): CapabilityProfile {
  return useSyncExternalStore(subscribe, snapshot)
}

export function isConfigured(p: CapabilityProfile): boolean {
  return p.source !== 'default'
}

export interface CapabilityGate {
  locked: boolean
  required?: CapabilityKey
}

/** Whether a nav key is locked for the given profile. */
export function gateFor(navKey: string, p: CapabilityProfile): CapabilityGate {
  const required = NAV_REQUIRED_CAPABILITY[navKey]
  if (!required) return { locked: false }
  // No gating until the admin makes an explicit choice.
  if (p.source === 'default') return { locked: false, required }
  return { locked: !p[required], required }
}

/** Human-readable Korean label for a capability requirement. */
export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  copilot_seats: 'Microsoft 365 Copilot 라이선스',
  e5: 'Microsoft 365 E5',
  agent_inventory: 'Agent365 (에이전트 인벤토리)'
}
