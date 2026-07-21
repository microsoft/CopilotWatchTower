import { describe, expect, it } from 'vitest'
import { planPurviewCoverageWindow } from '../src/main/purviewCoverage'

const BASE = {
  now: '2026-07-21T00:00:00Z',
  apiEarliestAt: '2026-05-25T09:12:46Z',
  apiLatestAt: '2026-06-30T05:30:58Z',
  maxWindowDays: 30,
  retentionDays: 180
}

describe('Purview API-conversation coverage planner', () => {
  it('starts with the newest bounded window', () => {
    const result = planPurviewCoverageWindow({ ...BASE, coverageStartAt: null, coverageEndAt: null })

    expect(result).toEqual({
      start: '2026-05-31T05:35:58.000Z',
      end: '2026-06-30T05:35:58.000Z',
      direction: 'initial'
    })
  })

  it('fills a newer gap before historical backfill', () => {
    const result = planPurviewCoverageWindow({
      ...BASE,
      coverageStartAt: '2026-06-22T00:00:00Z',
      coverageEndAt: '2026-06-29T00:00:00Z'
    })

    expect(result).toEqual({
      start: '2026-06-29T00:00:00.000Z',
      end: '2026-06-30T05:35:58.000Z',
      direction: 'forward'
    })
  })

  it('backfills earlier API conversations in bounded windows', () => {
    const result = planPurviewCoverageWindow({
      ...BASE,
      coverageStartAt: '2026-06-29T00:00:00Z',
      coverageEndAt: '2026-06-30T05:35:58Z'
    })

    expect(result).toEqual({
      start: '2026-05-30T00:00:00.000Z',
      end: '2026-06-29T00:00:00.000Z',
      direction: 'backfill'
    })
  })

  it('stops when the retained API range is fully covered', () => {
    const result = planPurviewCoverageWindow({
      ...BASE,
      coverageStartAt: '2026-05-25T09:07:46Z',
      coverageEndAt: '2026-06-30T05:35:58Z'
    })

    expect(result).toBeNull()
  })

  it('does not request data outside the retention window', () => {
    const result = planPurviewCoverageWindow({
      ...BASE,
      apiEarliestAt: '2025-01-01T00:00:00Z',
      coverageStartAt: '2026-03-01T00:00:00Z',
      coverageEndAt: '2026-06-30T05:35:58Z'
    })

    expect(result?.start).toBe('2026-01-30T00:00:00.000Z')
  })
})