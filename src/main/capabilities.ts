/**
 * License-configuration capability model — Electron port of
 * services/capabilities.py.
 *
 * The set of data sources (and therefore features) the app can surface depends
 * on the tenant's Microsoft 365 license configuration. Rather than hard-code the
 * four common tiers, capabilities are modelled as an *additive* set of booleans;
 * the four tiers are human-friendly presets layered on top.
 *
 * The **source of truth is the administrator's explicit choice in Settings**
 * (persisted as the `capabilities_json` setting). SKU auto-detection
 * (`suggestFromSkus`) only *pre-fills* the form — it is never authoritative.
 *
 * Three license-driven gates exist:
 *  - `copilot_seats`: full M365 Copilot license → Graph interaction/usage APIs
 *    return data. Gates API conversation collection + official usage reports.
 *  - `e5`: E5 plan present. Only affects audit-retention messaging — never a gate.
 *  - `agent_inventory`: Agent365 → /copilot/agentRegistrations returns agents.
 *
 * eDiscovery, Dataverse (Teams) transcripts and Power Platform consumption are
 * always available — they depend on tenant *usage*, not the M365 license tier.
 */

// ---- license-detection knowledge (used only by the "suggest" helper) -------

/** M365 Copilot *service plan* IDs (inner plans of a SKU). */
export const COPILOT_SERVICE_PLAN_IDS: ReadonlySet<string> = new Set([
  '3f30311c-6b1e-49a9-ab65-1c52d2bb8e80', // M365_COPILOT_BUSINESS_CHAT
  'a62f8878-de10-42f3-b68f-6149a25ceb97', // M365_COPILOT_APPS
  'b95945de-b3bd-46db-8437-f2beb6ea2347', // M365_COPILOT_TEAMS
  '931e4a88-a67f-48b5-814f-16a5f1e6028d', // M365_COPILOT_INTELLIGENT_SEARCH
  '0aedf20c-091d-420b-aadf-30c042609612', // M365_COPILOT_SHAREPOINT
  '12d3a26a-c0b9-4cdd-9a5d-99ec6f1f5c75' // M365 Copilot for Service
])

/** Best-effort E5 indicators (only drives audit-retention messaging). */
export const E5_INDICATOR_SERVICE_PLAN_IDS: ReadonlySet<string> = new Set([
  '2f442157-a11c-46b9-ae5b-6e39ff4e5849', // M365 Advanced Auditing (E5)
  'a413a9ff-720c-4789-9ae5-d39a4d20f04e', // Communications Compliance (E5)
  'bf6f5520-59e3-4f82-974b-7dbbc4fd27c7' // Insider Risk Management (E5)
])

// ---- presets (stable keys persisted in settings) --------------------------

export const PRESET_ME3 = 'me3'
export const PRESET_ME3_COPILOT = 'me3_copilot'
export const PRESET_ME5_COPILOT = 'me5_copilot'
export const PRESET_AGENT365 = 'agent365'
export const PRESET_CUSTOM = 'custom'

export const PRESETS: readonly string[] = [PRESET_ME3, PRESET_ME3_COPILOT, PRESET_ME5_COPILOT, PRESET_AGENT365]

/** preset -> [copilot_seats, e5, agent_inventory]. Additive/monotonic. */
const PRESET_FLAGS: Record<string, [boolean, boolean, boolean]> = {
  [PRESET_ME3]: [false, false, false],
  [PRESET_ME3_COPILOT]: [true, false, false],
  [PRESET_ME5_COPILOT]: [true, true, false],
  [PRESET_AGENT365]: [true, true, true]
}

export type CapabilityKey = 'copilot_seats' | 'e5' | 'agent_inventory'

/** Collection kinds gated by a capability. Unlisted kinds are always allowed. */
export const KIND_REQUIRED_CAPABILITY: Record<string, CapabilityKey> = {
  conversation: 'copilot_seats',
  usage: 'copilot_seats',
  diagnostics: 'agent_inventory'
}

export interface CapabilityProfile {
  copilot_seats: boolean
  e5: boolean
  agent_inventory: boolean
  preset: string
  source: 'manual' | 'detected' | 'default'
  updated_at: string | null
}

export function presetFor(copilotSeats: boolean, e5: boolean, agentInventory: boolean): string {
  const combo: [boolean, boolean, boolean] = [!!copilotSeats, !!e5, !!agentInventory]
  for (const [preset, flags] of Object.entries(PRESET_FLAGS)) {
    if (flags[0] === combo[0] && flags[1] === combo[1] && flags[2] === combo[2]) return preset
  }
  return PRESET_CUSTOM
}

export function profileFromPreset(preset: string, updatedAt: string | null = null): CapabilityProfile {
  const flags = PRESET_FLAGS[preset]
  if (!flags) throw new Error(`Unknown preset: ${preset}`)
  return {
    copilot_seats: flags[0],
    e5: flags[1],
    agent_inventory: flags[2],
    preset,
    source: 'manual',
    updated_at: updatedAt
  }
}

export function profileFromToggles(
  toggles: { copilot_seats?: unknown; e5?: unknown; agent_inventory?: unknown },
  updatedAt: string | null = null
): CapabilityProfile {
  const seats = !!toggles.copilot_seats
  const e5 = !!toggles.e5
  const agent = !!toggles.agent_inventory
  return {
    copilot_seats: seats,
    e5,
    agent_inventory: agent,
    preset: presetFor(seats, e5, agent),
    source: 'manual',
    updated_at: updatedAt
  }
}

/** Profile used before the admin configures licensing: everything on, no gating. */
export function defaultUnconfiguredProfile(): CapabilityProfile {
  return {
    copilot_seats: true,
    e5: true,
    agent_inventory: true,
    preset: PRESET_CUSTOM,
    source: 'default',
    updated_at: null
  }
}

/** Rehydrate a persisted profile dict (settings JSON) into a profile. */
export function profileFromSettings(raw: unknown): CapabilityProfile {
  if (!raw || typeof raw !== 'object') return defaultUnconfiguredProfile()
  const r = raw as Record<string, unknown>
  const seats = !!r.copilot_seats
  const e5 = !!r.e5
  const agent = !!r.agent_inventory
  return {
    copilot_seats: seats,
    e5,
    agent_inventory: agent,
    preset: String(r.preset || presetFor(seats, e5, agent)),
    source: (r.source as CapabilityProfile['source']) || 'manual',
    updated_at: (r.updated_at as string | null) ?? null
  }
}

/** Whether the given collection kind is permitted by this profile. */
export function allowsKind(profile: CapabilityProfile, kind: string): boolean {
  const required = KIND_REQUIRED_CAPABILITY[kind]
  if (!required) return true
  if (profile.source === 'default') return true
  return !!profile[required]
}

function skuServicePlanIds(skus: Array<Record<string, unknown>>): Set<string> {
  const plans = new Set<string>()
  for (const sku of skus) {
    for (const plan of (sku.servicePlans as Array<Record<string, unknown>>) ?? []) {
      const id = plan.servicePlanId
      if (id) plans.add(String(id))
    }
  }
  return plans
}

/**
 * Best-effort capability suggestion from `subscribedSkus`. Only pre-fills the
 * Settings form; the admin confirms it. `agentInventory` is supplied by the
 * caller from a live /copilot/agentRegistrations probe.
 */
export function suggestFromSkus(
  subscribedSkus: Array<Record<string, unknown>>,
  agentInventory: boolean,
  updatedAt: string | null = null
): CapabilityProfile {
  const plans = skuServicePlanIds(subscribedSkus)
  const seats = [...plans].some((p) => COPILOT_SERVICE_PLAN_IDS.has(p))
  const e5 = [...plans].some((p) => E5_INDICATOR_SERVICE_PLAN_IDS.has(p))
  const agent = !!agentInventory
  return {
    copilot_seats: seats,
    e5,
    agent_inventory: agent,
    preset: presetFor(seats, e5, agent),
    source: 'detected',
    updated_at: updatedAt
  }
}
