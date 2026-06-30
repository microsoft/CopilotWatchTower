/**
 * Audit log collection — port of services/audit_query.py.
 * Three sources: Purview unified audit (async query), Entra directory
 * audits, Entra sign-ins. Each keeps its own watermark + error state.
 */
import {
  getAuditCollectionState,
  updateAuditCollectionState,
  upsertAuditEvents,
  type AuditCollectionState,
  type AuditEventRow
} from '../db'
import {
  submitAuditLogQuery,
  waitForAuditQuery,
  listAuditQueryRecords,
  listDirectoryAudits,
  listSignIns,
  GraphError
} from '../graph'
import { auditDataFromRaw, copilotEventData, auditPayloadItems, payloadJson } from '../auditPayload'

type Dict = Record<string, unknown>

export interface CollectionOutcome {
  source: string
  fetched: number
  error?: string
  pending?: boolean
  details: string[]
}

const DEFAULT_BACKFILL_DAYS = 7
const NOISE_AUDIT_CATEGORIES = new Set(['ProvisioningManagement'])
// Copilot/agent-only audit collection: Purview keeps just Copilot interactions;
// Entra directory audits are filtered to entries mentioning Copilot/agents/bots.
const PURVIEW_DEFAULT_OPERATIONS = ['CopilotInteraction']
const COPILOT_AGENT_RE = /copilot|agent|bot|virtual\s*agent|power\s*virtual|declarative/i

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
}
function str(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v)
}
function isAfter(a: string, b: string): boolean {
  return a > b
}

function newState(source: string): AuditCollectionState {
  return {
    source,
    last_collected_at: null,
    pending_query_id: null,
    pending_submitted_at: null,
    pending_window_start: null,
    pending_window_end: null,
    last_error: null,
    last_error_at: null,
    last_success_at: null,
    last_record_count: 0,
    enabled: true
  }
}

function windowDetail(start: string | null, end: string | null): string {
  return `창: ${start ?? '(unknown)'} → ${end ?? '(unknown)'}`
}

function recordError(state: AuditCollectionState, err: unknown): CollectionOutcome {
  const msg = err instanceof Error ? err.message : String(err)
  state.last_error = msg
  state.last_error_at = isoNow()
  updateAuditCollectionState(state)
  return { source: state.source, fetched: 0, error: msg, details: [] }
}

// ---- Purview -----------------------------------------------------------

function parsePurviewEvent(raw: Dict, fetchedAt: string): AuditEventRow {
  const ad = auditDataFromRaw(raw)
  const operation = raw.operation ?? ad.Operation
  const userId = raw.userId ?? ad.UserId
  const upn = raw.userPrincipalName ?? ad.UserPrincipalName
  const eventTime = raw.createdDateTime ?? raw.recordDate ?? ad.CreationTime ?? fetchedAt
  const workload = raw.workload ?? ad.Workload
  const app =
    raw.appId ??
    ad.AppName ??
    ad.AppDisplayName ??
    copilotEventData(ad).AppHost ??
    ad.AppIdentity ??
    ad.AddOnName ??
    ad.AppExternalId ??
    ad.AddOnGuid
  const clientIp = raw.clientIp ?? ad.ClientIP
  const targetResources = payloadJson(auditPayloadItems(raw, ad))
  const eventId = String(raw.id ?? raw.recordId ?? `purview:${String(eventTime)}:${String(userId)}`)
  return {
    id: `purview:${eventId}`,
    source: 'purview',
    event_time: String(eventTime),
    user_id: str(userId),
    upn: str(upn),
    operation: str(operation),
    workload: str(workload),
    app: str(app),
    target_resources: targetResources,
    client_ip: str(clientIp),
    result: str(ad.ResultStatus),
    raw_json: JSON.stringify(raw),
    fetched_at: fetchedAt
  }
}

async function drainPurviewQuery(
  state: AuditCollectionState,
  pollSeconds: number,
  maxWaitSeconds: number
): Promise<CollectionOutcome> {
  const qid = state.pending_query_id
  if (!qid) return { source: 'purview', fetched: 0, details: [] }
  const payload = await waitForAuditQuery(qid, pollSeconds, maxWaitSeconds)
  const status = String(payload.status ?? '').toLowerCase()
  if (status === 'running' || status === 'notstarted' || status === 'queued' || status === '') {
    return {
      source: 'purview',
      fetched: 0,
      pending: true,
      details: [windowDetail(state.pending_window_start, state.pending_window_end), `query ${qid} (${status || 'unknown'})`]
    }
  }
  if (status === 'failed' || status === 'cancelled') {
    const errObj = (payload.error as Dict) ?? {}
    const msg = status === 'failed' ? String(errObj.message ?? 'query failed') : 'query cancelled'
    state.pending_query_id = null
    state.pending_submitted_at = null
    state.last_error = msg
    state.last_error_at = isoNow()
    updateAuditCollectionState(state)
    return { source: 'purview', fetched: 0, error: msg, details: [] }
  }
  // succeeded
  const fetchedAt = isoNow()
  const rows: AuditEventRow[] = []
  for await (const raw of listAuditQueryRecords(qid)) rows.push(parsePurviewEvent(raw, fetchedAt))
  if (rows.length) upsertAuditEvents(rows)
  const userKeys = new Set(rows.map((r) => r.user_id ?? r.upn).filter(Boolean) as string[])
  const details = [windowDetail(state.pending_window_start, state.pending_window_end), `query ${qid} (succeeded)`]
  if (userKeys.size) details.push(`영향 사용자 ${userKeys.size}명`)
  state.last_collected_at = state.pending_window_end ?? isoNow()
  state.last_success_at = isoNow()
  state.last_record_count = rows.length
  state.last_error = null
  state.last_error_at = null
  state.pending_query_id = null
  state.pending_submitted_at = null
  state.pending_window_start = null
  state.pending_window_end = null
  updateAuditCollectionState(state)
  return { source: 'purview', fetched: rows.length, details }
}

export async function collectPurview(backfillDays = DEFAULT_BACKFILL_DAYS): Promise<CollectionOutcome> {
  const state = getAuditCollectionState('purview') ?? newState('purview')
  if (!state.enabled) return { source: 'purview', fetched: 0, details: [] }
  try {
    if (state.pending_query_id) return await drainPurviewQuery(state, 10, 60)
    const windowEnd = isoNow()
    const windowStart = state.last_collected_at ?? isoDaysAgo(backfillDays)
    const qid = await submitAuditLogQuery({
      displayName: `CopilotWatchTower-${windowEnd}`,
      start: windowStart,
      end: windowEnd,
      operationFilters: PURVIEW_DEFAULT_OPERATIONS
    })
    state.pending_query_id = qid
    state.pending_submitted_at = isoNow()
    state.pending_window_start = windowStart
    state.pending_window_end = windowEnd
    state.last_error = null
    state.last_error_at = null
    updateAuditCollectionState(state)
    return await drainPurviewQuery(state, 10, 60)
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) {
      state.enabled = false
      state.last_error = '404 — Purview Audit Log Query API not available'
      state.last_error_at = isoNow()
      updateAuditCollectionState(state)
      return { source: 'purview', fetched: 0, error: String(e), details: [] }
    }
    return recordError(state, e)
  }
}

// ---- Entra audits + sign-ins -------------------------------------------

function parseDirectoryAudit(raw: Dict, fetchedAt: string): AuditEventRow {
  const initiatedBy = (raw.initiatedBy as Dict) ?? {}
  const user = (initiatedBy.user as Dict) ?? {}
  const targets = (raw.targetResources as unknown[]) ?? []
  return {
    id: `entra_audit:${String(raw.id)}`,
    source: 'entra_audit',
    event_time: String(raw.activityDateTime ?? fetchedAt),
    user_id: str(user.id),
    upn: str(user.userPrincipalName),
    operation: str(raw.activityDisplayName),
    workload: str(raw.category),
    app: str(raw.loggedByService),
    target_resources: targets.length ? JSON.stringify(targets) : null,
    client_ip: null,
    result: str(raw.result),
    raw_json: JSON.stringify(raw),
    fetched_at: fetchedAt
  }
}

function parseSignIn(raw: Dict, fetchedAt: string): AuditEventRow {
  const status = raw.status as Dict | undefined
  return {
    id: `entra_signin:${String(raw.id)}`,
    source: 'entra_signin',
    event_time: String(raw.createdDateTime ?? fetchedAt),
    user_id: str(raw.userId),
    upn: str(raw.userPrincipalName),
    operation: str(raw.appDisplayName),
    workload: 'signIns',
    app: str(raw.clientAppUsed),
    target_resources: null,
    client_ip: str(raw.ipAddress),
    result: status && typeof status === 'object' ? str(status.errorCode) : null,
    raw_json: JSON.stringify(raw),
    fetched_at: fetchedAt
  }
}

async function collectEntra(source: 'entra_audit' | 'entra_signin', backfillDays: number): Promise<CollectionOutcome> {
  const state = getAuditCollectionState(source) ?? newState(source)
  if (!state.enabled) return { source, fetched: 0, details: [] }
  const since = state.last_collected_at ?? isoDaysAgo(backfillDays)
  const until = isoNow()
  try {
    const fetchedAt = isoNow()
    let buffer: AuditEventRow[] = []
    let total = 0
    let filtered = 0
    const userKeys = new Set<string>()
    const stream = source === 'entra_audit' ? listDirectoryAudits(since, until) : listSignIns(since, until)
    for await (const raw of stream) {
      const row = source === 'entra_audit' ? parseDirectoryAudit(raw, fetchedAt) : parseSignIn(raw, fetchedAt)
      if (source === 'entra_audit' && NOISE_AUDIT_CATEGORIES.has(row.workload ?? '')) {
        filtered += 1
        continue
      }
      // Keep only Copilot/agent-related directory audits (consent, app/SP
      // changes for agents, etc.). Match against operation + targets + service.
      if (source === 'entra_audit' && !COPILOT_AGENT_RE.test(`${row.operation ?? ''} ${row.app ?? ''} ${row.target_resources ?? ''}`)) {
        filtered += 1
        continue
      }
      buffer.push(row)
      total += 1
      const key = row.user_id ?? row.upn
      if (key) userKeys.add(key)
      if (buffer.length >= 500) {
        upsertAuditEvents(buffer)
        buffer = []
      }
    }
    if (buffer.length) upsertAuditEvents(buffer)
    state.last_collected_at = until
    state.last_success_at = isoNow()
    state.last_record_count = total
    state.last_error = null
    state.last_error_at = null
    updateAuditCollectionState(state)
    const details = [windowDetail(since, until)]
    if (filtered) details.push(`노이즈 제외 ${filtered}건`)
    if (userKeys.size) details.push(`영향 사용자 ${userKeys.size}명`)
    return { source, fetched: total, details }
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) state.enabled = false
    return recordError(state, e)
  }
}

export async function collectEntraAudits(backfillDays = DEFAULT_BACKFILL_DAYS): Promise<CollectionOutcome> {
  return collectEntra('entra_audit', backfillDays)
}
export async function collectEntraSignins(backfillDays = DEFAULT_BACKFILL_DAYS): Promise<CollectionOutcome> {
  return collectEntra('entra_signin', backfillDays)
}

/** Run all three audit collectors in series; never throws. */
export async function collectAudit(
  onLog?: (line: string) => void
): Promise<{ fetched: number; errors: number; outcomes: CollectionOutcome[] }> {
  const outcomes: CollectionOutcome[] = []
  let fetched = 0
  let errors = 0
  const jobs: [string, () => Promise<CollectionOutcome>][] = [
    ['Purview', () => collectPurview()],
    ['Entra audit', () => collectEntraAudits()]
  ]
  for (const [label, fn] of jobs) {
    try {
      const outcome = await fn()
      outcomes.push(outcome)
      fetched += outcome.fetched
      if (outcome.error) {
        errors += 1
        onLog?.(`${label}: 오류 ${outcome.error}`)
      } else if (outcome.pending) {
        onLog?.(`${label}: 쿼리 진행 중…`)
      } else {
        onLog?.(`${label}: ${outcome.fetched}건 수집`)
      }
      for (const detail of outcome.details) onLog?.(`${label} · ${detail}`)
    } catch (e) {
      errors += 1
      onLog?.(`${label}: 크래시 ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { fetched, errors, outcomes }
}

// isAfter retained for future agent-usage refresh wiring
void isAfter
