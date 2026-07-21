const DAY_MS = 86_400_000
const DEFAULT_MARGIN_MS = 300_000

export interface PurviewCoverageInput {
  now: string
  apiEarliestAt: string
  apiLatestAt: string
  coverageStartAt: string | null
  coverageEndAt: string | null
  maxWindowDays?: number
  retentionDays?: number
}

export interface PurviewCoverageWindow {
  start: string
  end: string
  direction: 'initial' | 'forward' | 'backfill'
}

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function planPurviewCoverageWindow(input: PurviewCoverageInput): PurviewCoverageWindow | null {
  const now = timestamp(input.now)
  const apiEarliest = timestamp(input.apiEarliestAt)
  const apiLatest = timestamp(input.apiLatestAt)
  if (now === null || apiEarliest === null || apiLatest === null) return null

  const maxWindowMs = Math.max(1, input.maxWindowDays ?? 30) * DAY_MS
  const retentionStart = now - Math.max(1, input.retentionDays ?? 180) * DAY_MS
  const desiredStart = Math.max(retentionStart, apiEarliest - DEFAULT_MARGIN_MS)
  const desiredEnd = Math.min(now, apiLatest + DEFAULT_MARGIN_MS)
  if (desiredStart >= desiredEnd) return null

  const coverageEnd = timestamp(input.coverageEndAt)
  const coverageStart = timestamp(input.coverageStartAt) ?? coverageEnd
  if (coverageStart === null || coverageEnd === null) {
    return {
      start: new Date(Math.max(desiredStart, desiredEnd - maxWindowMs)).toISOString(),
      end: new Date(desiredEnd).toISOString(),
      direction: 'initial'
    }
  }

  if (coverageEnd < desiredEnd) {
    const start = Math.max(desiredStart, coverageEnd)
    return {
      start: new Date(start).toISOString(),
      end: new Date(Math.min(desiredEnd, start + maxWindowMs)).toISOString(),
      direction: 'forward'
    }
  }

  if (coverageStart > desiredStart) {
    return {
      start: new Date(Math.max(desiredStart, coverageStart - maxWindowMs)).toISOString(),
      end: new Date(coverageStart).toISOString(),
      direction: 'backfill'
    }
  }

  return null
}