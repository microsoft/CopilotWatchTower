import { describe, expect, it } from 'vitest'
import {
  allowsKind,
  defaultUnconfiguredProfile,
  PRESET_AGENT365,
  PRESET_ME3,
  PRESET_ME3_COPILOT,
  profileFromPreset,
  profileFromToggles,
  suggestFromSkus
} from '../src/main/capabilities'

describe('license capability profiles', () => {
  it('keeps an unconfigured profile permissive', () => {
    const profile = defaultUnconfiguredProfile()

    expect(allowsKind(profile, 'conversation')).toBe(true)
    expect(allowsKind(profile, 'usage')).toBe(true)
    expect(allowsKind(profile, 'diagnostics')).toBe(true)
  })

  it('gates only the collection kinds required by a configured preset', () => {
    const me3 = profileFromPreset(PRESET_ME3)
    const copilot = profileFromPreset(PRESET_ME3_COPILOT)
    const agent365 = profileFromPreset(PRESET_AGENT365)

    expect(allowsKind(me3, 'conversation')).toBe(false)
    expect(allowsKind(me3, 'audit')).toBe(true)
    expect(allowsKind(copilot, 'conversation')).toBe(true)
    expect(allowsKind(copilot, 'diagnostics')).toBe(false)
    expect(allowsKind(agent365, 'diagnostics')).toBe(true)
  })

  it('marks non-preset toggle combinations as custom', () => {
    const profile = profileFromToggles({ copilot_seats: false, e5: true, agent_inventory: false })

    expect(profile.preset).toBe('custom')
  })

  it('uses subscribed service plans only as a detected suggestion', () => {
    const profile = suggestFromSkus(
      [
        {
          servicePlans: [
            { servicePlanId: '3f30311c-6b1e-49a9-ab65-1c52d2bb8e80' },
            { servicePlanId: '2f442157-a11c-46b9-ae5b-6e39ff4e5849' }
          ]
        }
      ],
      false,
      '2026-07-14T00:00:00Z'
    )

    expect(profile).toMatchObject({
      copilot_seats: true,
      e5: true,
      agent_inventory: false,
      source: 'detected',
      updated_at: '2026-07-14T00:00:00Z'
    })
  })
})