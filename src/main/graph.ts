/**
 * Microsoft Graph client (app-only), ported from services/graph.py.
 * Uses built-in fetch + OData @odata.nextLink pagination.
 */
import { getAppToken, resetAuth } from './auth'

const BETA = 'https://graph.microsoft.com/beta'
const V1 = 'https://graph.microsoft.com/v1.0'

export class GraphError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GraphError'
    this.status = status
  }
}

interface ODataPage {
  value?: unknown[]
  ['@odata.nextLink']?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const MAX_THROTTLE_RETRIES = 5
/** Wait time for a 429: honor Retry-After header, else exponential backoff, cap 60s. */
function throttleDelayMs(res: Response, attempt: number): number {
  const hdr = Number(res.headers.get('retry-after'))
  const fromHdr = Number.isFinite(hdr) && hdr > 0 ? hdr * 1000 : 0
  return Math.min(60000, Math.max(fromHdr, 1000 * 2 ** attempt))
}

async function graphGet(url: string, retry = true, attempt = 0): Promise<ODataPage> {
  const token = await getAppToken()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401 && retry) {
    resetAuth()
    return graphGet(url, false)
  }
  if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
    await sleep(throttleDelayMs(res, attempt))
    return graphGet(url, retry, attempt + 1)
  }
  if (!res.ok) {
    const body = await res.text()
    throw new GraphError(res.status, `Graph ${res.status} ${url.slice(0, 90)} :: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as ODataPage
}

export interface GraphUser {
  id: string
  upn: string | null
  displayName: string | null
  enabled: boolean
}

export async function* listUsers(): AsyncGenerator<GraphUser> {
  let url: string | null = `${V1}/users?$select=id,displayName,userPrincipalName,accountEnabled&$top=999`
  while (url) {
    const page = await graphGet(url)
    for (const raw of page.value ?? []) {
      const u = raw as Record<string, unknown>
      yield {
        id: String(u.id),
        upn: (u.userPrincipalName as string) ?? null,
        displayName: (u.displayName as string) ?? null,
        enabled: u.accountEnabled !== false
      }
    }
    url = page['@odata.nextLink'] ?? null
  }
}

export interface RawInteraction {
  id: string
  sessionId?: string | null
  requestId?: string | null
  createdDateTime: string
  interactionType?: string | null
  appClass?: string | null
  from?: { application?: { displayName?: string } }
  body?: { content?: string; contentType?: string }
  attachments?: unknown[]
}

function stripMs(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z').replace(/\.\d+\+00:00$/, 'Z')
}

export async function* listInteractions(userId: string, since: string | null): AsyncGenerator<RawInteraction> {
  let url: string | null = `${BETA}/copilot/users/${userId}/interactionHistory/getAllEnterpriseInteractions?$top=50`
  if (since) {
    const until = stripMs(new Date().toISOString())
    const filter = `createdDateTime gt ${since} and createdDateTime lt ${until}`
    url += `&$filter=${encodeURIComponent(filter)}`
  }
  while (url) {
    const page = await graphGet(url)
    for (const raw of page.value ?? []) yield raw as RawInteraction
    url = page['@odata.nextLink'] ?? null
  }
}

// ---- raw GET / POST helpers (non-OData payloads) ------------------------

async function graphGetOne(url: string, retry = true, attempt = 0): Promise<Record<string, unknown>> {
  const token = await getAppToken()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401 && retry) {
    resetAuth()
    return graphGetOne(url, false)
  }
  if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
    await sleep(throttleDelayMs(res, attempt))
    return graphGetOne(url, retry, attempt + 1)
  }
  if (!res.ok) {
    const body = await res.text()
    throw new GraphError(res.status, `Graph ${res.status} ${url.slice(0, 90)} :: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

async function graphPost(url: string, body: unknown, retry = true, attempt = 0): Promise<Record<string, unknown>> {
  const token = await getAppToken()
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status === 401 && retry) {
    resetAuth()
    return graphPost(url, body, false)
  }
  if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
    await sleep(throttleDelayMs(res, attempt))
    return graphPost(url, body, retry, attempt + 1)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new GraphError(res.status, `Graph ${res.status} ${url.slice(0, 90)} :: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

const GRAPH_DT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|\+00:00)?$/

function normaliseGraphDatetime(value: string): string {
  if (!value) return value
  const m = GRAPH_DT_RE.exec(value)
  return m ? `${m[1]}Z` : value
}

/** OData $filter for a datetime field; ge/lt half-open interval. */
function dateFilter(field: string, since: string | null, until: string | null): string | null {
  const parts: string[] = []
  if (since) parts.push(`${field} ge ${normaliseGraphDatetime(since)}`)
  if (until) parts.push(`${field} lt ${normaliseGraphDatetime(until)}`)
  return parts.length ? parts.join(' and ') : null
}

// ---- Purview audit (async query) ----------------------------------------

/** Create an async Purview audit-log query; returns the query id. */
export async function submitAuditLogQuery(opts: {
  displayName: string
  start: string
  end: string
  operationFilters?: string[]
}): Promise<string> {
  const body: Record<string, unknown> = {
    displayName: opts.displayName,
    filterStartDateTime: normaliseGraphDatetime(opts.start),
    filterEndDateTime: normaliseGraphDatetime(opts.end)
  }
  if (opts.operationFilters?.length) body.operationFilters = opts.operationFilters
  const payload = await graphPost(`${BETA}/security/auditLog/queries`, body)
  return String(payload.id)
}

export async function getAuditLogQuery(queryId: string): Promise<Record<string, unknown>> {
  return graphGetOne(`${BETA}/security/auditLog/queries/${queryId}`)
}

/** Poll a Purview query until terminal state or deadline; returns final payload. */
export async function waitForAuditQuery(
  queryId: string,
  pollSeconds = 10,
  maxSeconds = 60
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxSeconds * 1000
  for (;;) {
    const payload = await getAuditLogQuery(queryId)
    const status = String(payload.status ?? '').toLowerCase()
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return payload
    if (Date.now() >= deadline) return payload
    await new Promise((r) => setTimeout(r, pollSeconds * 1000))
  }
}

export async function* listAuditQueryRecords(queryId: string): AsyncGenerator<Record<string, unknown>> {
  let url: string | null = `${BETA}/security/auditLog/queries/${queryId}/records?$top=200`
  while (url) {
    const page = await graphGet(url)
    for (const raw of page.value ?? []) yield raw as Record<string, unknown>
    url = page['@odata.nextLink'] ?? null
  }
}

// ---- Entra directory audits + sign-ins ----------------------------------

export async function* listDirectoryAudits(
  since: string | null,
  until: string | null
): AsyncGenerator<Record<string, unknown>> {
  let url: string | null = `${V1}/auditLogs/directoryAudits?$top=250`
  const filt = dateFilter('activityDateTime', since, until)
  if (filt) url += `&$filter=${encodeURIComponent(filt)}`
  while (url) {
    const page = await graphGet(url)
    for (const raw of page.value ?? []) yield raw as Record<string, unknown>
    url = page['@odata.nextLink'] ?? null
  }
}

export async function* listSignIns(
  since: string | null,
  until: string | null
): AsyncGenerator<Record<string, unknown>> {
  let url: string | null = `${V1}/auditLogs/signIns?$top=250`
  const filt = dateFilter('createdDateTime', since, until)
  if (filt) url += `&$filter=${encodeURIComponent(filt)}`
  while (url) {
    const page = await graphGet(url)
    for (const raw of page.value ?? []) yield raw as Record<string, unknown>
    url = page['@odata.nextLink'] ?? null
  }
}

// ---- Copilot usage reports (CSV) ----------------------------------------

async function fetchReportCsv(url: string, retry = true): Promise<string> {
  const token = await getAppToken()
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/csv, application/octet-stream, */*' },
    redirect: 'follow'
  })
  if (res.status === 401 && retry) {
    resetAuth()
    return fetchReportCsv(url, false)
  }
  if (!res.ok) {
    const body = await res.text()
    throw new GraphError(res.status, `Graph ${res.status} ${url.slice(0, 90)} :: ${body.slice(0, 160)}`)
  }
  return res.text()
}

/** Try the v1.0 copilot/reports endpoint, falling back to beta /reports on 404/400. */
async function fetchReportCsvWithFallback(v1Url: string, betaUrl: string): Promise<string> {
  try {
    return await fetchReportCsv(v1Url)
  } catch (e) {
    if (e instanceof GraphError && (e.status === 404 || e.status === 400)) {
      return fetchReportCsv(betaUrl)
    }
    throw e
  }
}

export function fetchCopilotUsageUserDetail(period = 'D30'): Promise<string> {
  return fetchReportCsvWithFallback(
    `${V1}/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='${period}')?$format=text/csv`,
    `${BETA}/reports/getMicrosoft365CopilotUsageUserDetail(period='${period}')?$format=text/csv`
  )
}

export function fetchCopilotUserCountSummary(period = 'D30'): Promise<string> {
  return fetchReportCsvWithFallback(
    `${V1}/copilot/reports/getMicrosoft365CopilotUserCountSummary(period='${period}')?$format=text/csv`,
    `${BETA}/reports/getMicrosoft365CopilotUserCountSummary(period='${period}')?$format=text/csv`
  )
}

export function fetchCopilotUserCountTrend(period = 'D30'): Promise<string> {
  return fetchReportCsvWithFallback(
    `${V1}/copilot/reports/getMicrosoft365CopilotUserCountTrend(period='${period}')?$format=text/csv`,
    `${BETA}/reports/getMicrosoft365CopilotUserCountTrend(period='${period}')?$format=text/csv`
  )
}

// ---- Copilot admin diagnostics (agent inventory) ------------------------

async function graphGetJsonWithFallback(v1Url: string, betaUrl: string): Promise<Record<string, unknown>> {
  try {
    return await graphGetOne(v1Url)
  } catch (e) {
    if (e instanceof GraphError && (e.status === 400 || e.status === 404)) return graphGetOne(betaUrl)
    throw e
  }
}

async function paginateAll(baseUrl: string): Promise<Record<string, unknown>[]> {
  let url: string | null = baseUrl
  const out: Record<string, unknown>[] = []
  while (url) {
    const page = await graphGet(url)
    for (const r of page.value ?? []) out.push(r as Record<string, unknown>)
    url = page['@odata.nextLink'] ?? null
  }
  return out
}

export function getCopilotAdminLimitedMode(): Promise<Record<string, unknown>> {
  return graphGetJsonWithFallback(
    `${V1}/copilot/admin/settings/limitedMode`,
    `${BETA}/copilot/admin/settings/limitedMode`
  )
}
export function listCopilotAdminPolicySettings(): Promise<Record<string, unknown>[]> {
  return paginateAll(`${BETA}/copilot/admin/policySettings?$top=50`)
}
export function listCopilotAdminCatalogPackages(): Promise<Record<string, unknown>[]> {
  return paginateAll(`${BETA}/copilot/admin/catalog/packages?$top=50`)
}
export function listCopilotAgentRegistrations(): Promise<Record<string, unknown>[]> {
  return paginateAll(`${BETA}/copilot/agentRegistrations?$top=50`)
}

/** Raw subscribedSkus list (for capability suggestion). */
export async function listSubscribedSkus(): Promise<Array<Record<string, unknown>>> {
  const res = await graphGet(`${V1}/subscribedSkus`)
  return (res.value as Array<Record<string, unknown>>) ?? []
}

/** Copilot-licensed user ids (subscribedSkus → assignedLicenses filter). */
export async function listCopilotLicensedUserIds(): Promise<string[]> {
  const skus = await graphGet(`${V1}/subscribedSkus`)
  const copilotSkuIds: string[] = []
  for (const raw of skus.value ?? []) {
    const sku = raw as Record<string, unknown>
    const plans = (sku.servicePlans as Array<Record<string, unknown>>) ?? []
    if (plans.some((p) => /COPILOT/i.test(String(p.servicePlanName ?? '')))) {
      copilotSkuIds.push(String(sku.skuId))
    }
  }
  const ids = new Set<string>()
  for (const skuId of copilotSkuIds) {
    let url: string | null = `${V1}/users?$filter=${encodeURIComponent(
      `assignedLicenses/any(x:x/skuId eq ${skuId})`
    )}&$select=id&$top=999`
    while (url) {
      const page = await graphGet(url)
      for (const raw of page.value ?? []) ids.add(String((raw as Record<string, unknown>).id))
      url = page['@odata.nextLink'] ?? null
    }
  }
  return [...ids]
}
