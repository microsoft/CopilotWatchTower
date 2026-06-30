/**
 * Microsoft 365 Copilot usage report ingestion — port of services/usage_reports.py.
 * Pulls the per-tenant CSV "user detail" report (app-only, Reports.Read.All)
 * and writes one row per (user, period) into copilot_usage_snapshots.
 */
import { upsertUsageSnapshots, type UsageSnapshotRow } from '../db'
import { fetchCopilotUsageUserDetail, GraphError } from '../graph'
import { parseCsvDicts, normalizeUsageRow, periodFromReport } from '../usageMapping'

export const USAGE_REPORT_PERIODS = ['D7', 'D30', 'D90', 'D180'] as const

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseDetailCsv(text: string, period: string): UsageSnapshotRow[] {
  const today = isoToday()
  const out: UsageSnapshotRow[] = []
  for (const raw of parseCsvDicts(text)) {
    const p = normalizeUsageRow(raw)
    out.push({
      snapshot_date: p.report_refresh_date || today,
      user_id: null,
      upn: p.upn,
      period: periodFromReport(p.report_period, period),
      display_name: p.display_name,
      last_activity_overall: p.last_activity_overall,
      last_activity_teams: p.last_activity_teams,
      last_activity_word: p.last_activity_word,
      last_activity_excel: p.last_activity_excel,
      last_activity_powerpoint: p.last_activity_powerpoint,
      last_activity_outlook: p.last_activity_outlook,
      last_activity_onenote: p.last_activity_onenote,
      last_activity_loop: p.last_activity_loop,
      last_activity_bizchat: p.last_activity_bizchat,
      raw_json: JSON.stringify(raw)
    })
  }
  return out
}

/** Fetch + persist the Copilot user detail report. Returns rows written; 403/404 → 0. */
export async function collectCopilotUsage(period = 'D30'): Promise<number> {
  let csv: string
  try {
    csv = await fetchCopilotUsageUserDetail(period)
  } catch (e) {
    if (e instanceof GraphError && (e.status === 403 || e.status === 404)) return 0
    throw e
  }
  const rows = parseDetailCsv(csv, period)
  if (!rows.length) return 0
  return upsertUsageSnapshots(rows)
}
