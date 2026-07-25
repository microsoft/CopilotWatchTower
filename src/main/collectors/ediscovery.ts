/**
 * Microsoft Purview eDiscovery automated collection — port of
 * services/ediscovery.py + workers/ediscovery_collector.py.
 *
 * Pipeline (resumable via the job's persisted artifacts):
 *   reuse onboarding's delegated login (silent) → create/reuse case → add
 *   search (non-custodial mailbox source + KQL content query) → estimate
 *   (poll LRO) → export (poll LRO) → resolve download URL (prefer Azure Blob
 *   SAS) → download ZIP → parse → ingest interactions.
 *
 * eDiscovery requires *delegated* Graph auth (``eDiscovery.ReadWrite.All``);
 * app-only is Premium-only. Onboarding already consents to this scope and seeds
 * a persistent, DPAPI-encrypted token cache, so collection acquires tokens
 * **silently** (fully automated, no prompt). A device-code prompt only appears
 * as a fallback when no reusable cached login exists (e.g. older profiles).
 *
 * LIMITATIONS (verify against a live tenant):
 *  - Needs the tenant's eDiscovery (Premium) capability + delegated consent.
 *  - Only the programmatic Azure Blob SAS download path is implemented. Tenants
 *    that return the browser-interactive "direct download proxy" URL surface a
 *    clear, actionable error (the headless-browser download is a later phase).
 */
import { PublicClientApplication, type AccountInfo } from '@azure/msal-node'
import * as db from '../db'
import { makeCachePlugin } from '../tokenCache'
import { parseExportPackage } from './ediscoveryExport'
import { httpRequest, DOWNLOAD_TIMEOUT_MS, type HttpOptions } from '../http'

const GRAPH_V1 = 'https://graph.microsoft.com/v1.0'
// Well-known Microsoft Graph PowerShell public client (multi-tenant, device-code).
const PUBLIC_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
const EDISCOVERY_SCOPES = ['eDiscovery.ReadWrite.All']
const TERMINAL = new Set(['succeeded', 'failed', 'partiallysucceeded'])
const DEFAULT_CASE_NAME = 'CopilotWatchTower'
const POLL_SECONDS = 15
const MAX_POLL_SECONDS = 21600

export class EdiscoveryError extends Error {}

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  message: string
}
export type OnDeviceCode = (dc: DeviceCodeInfo) => void
export type OnProgress = (stage: string, message: string) => void
export type ShouldStop = () => boolean
/** Downloads a browser-interactive (ME3 proxy) export URL → ZIP bytes. */
export type ProxyDownload = (url: string) => Promise<Buffer>

// ---- delegated token -----------------------------------------------------
// Reuses the persistent, DPAPI-encrypted token cache seeded by onboarding
// (its bootstrap scopes already include eDiscovery.ReadWrite.All). Collection
// mints tokens *silently* from that cached multi-resource refresh token, so it
// runs fully automated — no device-code prompt. Device code only triggers as a
// fallback (e.g. profiles onboarded before the cache existed, or a revoked
// token); that fallback then re-seeds the cache for subsequent silent runs.
let pca: PublicClientApplication | null = null
let pcaKey: string | null = null
let cachedToken: { token: string; exp: number } | null = null
let cachedAccount: AccountInfo | null = null

export function resetEdiscoveryAuth(): void {
  pca = null
  pcaKey = null
  cachedToken = null
  cachedAccount = null
}

function publicClient(tenantId: string, cacheDir: string): PublicClientApplication {
  const key = `${tenantId}|${cacheDir}`
  if (pca && pcaKey === key) return pca
  pca = new PublicClientApplication({
    auth: { clientId: PUBLIC_CLIENT_ID, authority: `https://login.microsoftonline.com/${tenantId}` },
    cache: { cachePlugin: makeCachePlugin(cacheDir, tenantId) }
  })
  pcaKey = key
  return pca
}

async function trySilent(app: PublicClientApplication, account: AccountInfo, now: number): Promise<string | null> {
  try {
    const silent = await app.acquireTokenSilent({ account, scopes: EDISCOVERY_SCOPES })
    if (silent?.accessToken) {
      cachedAccount = account
      cachedToken = { token: silent.accessToken, exp: silent.expiresOn ? silent.expiresOn.getTime() : now + 3_000_000 }
      return cachedToken.token
    }
  } catch {
    /* silent acquisition failed for this account — caller falls back */
  }
  return null
}

async function delegatedToken(tenantId: string, cacheDir: string, onCode: OnDeviceCode): Promise<string> {
  const now = Date.now()
  if (cachedToken && now < cachedToken.exp - 60_000) return cachedToken.token
  const app = publicClient(tenantId, cacheDir)
  // Prefer the in-memory account, then any account from the persisted cache
  // (seeded by onboarding) — this is the fully-automated, no-prompt path.
  if (cachedAccount) {
    const tok = await trySilent(app, cachedAccount, now)
    if (tok) return tok
  }
  for (const account of await app.getTokenCache().getAllAccounts()) {
    const tok = await trySilent(app, account, now)
    if (tok) return tok
  }
  // No reusable cached login — fall back to an interactive device-code prompt.
  const res = await app.acquireTokenByDeviceCode({
    scopes: EDISCOVERY_SCOPES,
    deviceCodeCallback: (r) => onCode({ userCode: r.userCode, verificationUri: r.verificationUri, message: r.message })
  })
  if (!res?.accessToken) throw new EdiscoveryError('eDiscovery 위임 로그인에 실패했습니다.')
  cachedAccount = res.account ?? null
  cachedToken = { token: res.accessToken, exp: res.expiresOn ? res.expiresOn.getTime() : now + 3_000_000 }
  return cachedToken.token
}

// ---- Graph request helpers ----------------------------------------------
type Json = Record<string, unknown>

async function gReq(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  opts: HttpOptions = {}
): Promise<Response> {
  const res = await httpRequest(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    },
    opts
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403)
      throw new EdiscoveryError('eDiscovery 권한이 없습니다. eDiscovery 역할 그룹 멤버십과 테넌트 capability를 확인하세요. (403)')
    if (res.status === 401)
      throw new EdiscoveryError('eDiscovery 토큰/스코프 문제입니다. 동의가 부여되었는지 확인하세요. (401)')
    throw new EdiscoveryError(`Graph ${method} ${res.status}: ${text.slice(0, 300)}`)
  }
  return res
}

/**
 * A response body that is not valid JSON is an error, never `{}`. Swallowing
 * it here used to turn an HTML error page into "0 cases found", which silently
 * produced duplicate cases and empty collections.
 */
async function gJson(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  opts: HttpOptions = {}
): Promise<Json> {
  const res = await gReq(token, method, url, body, opts)
  const text = await res.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as Json
  } catch {
    throw new EdiscoveryError(
      `Graph ${method} ${url.slice(0, 80)}: JSON 응답을 기대했지만 다른 형식을 받았습니다: ${text.slice(0, 200)}`
    )
  }
}

async function gPaginate(token: string, url: string): Promise<Json[]> {
  const out: Json[] = []
  let next: string | null = url
  while (next) {
    const page = (await gJson(token, 'GET', next)) as { value?: Json[]; ['@odata.nextLink']?: string }
    for (const v of page.value ?? []) out.push(v)
    next = page['@odata.nextLink'] ?? null
  }
  return out
}

// ---- Graph eDiscovery API (port of services/graph.py) -------------------
const CASES_URL = `${GRAPH_V1}/security/cases/ediscoveryCases`

async function preflight(token: string): Promise<void> {
  await gJson(token, 'GET', `${CASES_URL}?$top=1`)
}

async function findCase(token: string, displayName: string): Promise<Json | null> {
  for (const raw of await gPaginate(token, `${CASES_URL}?$top=100`)) {
    if (String(raw.displayName ?? '') === displayName) return raw
  }
  return null
}

async function createCase(token: string, displayName: string, description: string): Promise<Json> {
  const existing = await findCase(token, displayName)
  if (existing) return existing
  return gJson(token, 'POST', CASES_URL, { displayName, description })
}

async function findSearch(token: string, caseId: string, displayName: string): Promise<Json | null> {
  for (const raw of await gPaginate(token, `${CASES_URL}/${caseId}/searches?$top=100`)) {
    if (String(raw.displayName ?? '') === displayName) return raw
  }
  return null
}

async function addSearch(
  token: string,
  caseId: string,
  displayName: string,
  contentQuery: string,
  mailbox: string
): Promise<Json> {
  const existing = await findSearch(token, caseId, displayName)
  if (existing) return existing
  // Phase 1: non-custodial data source per mailbox (reuse if it already exists).
  const dsUrl = `${CASES_URL}/${caseId}/noncustodialDataSources`
  const listExisting = async (): Promise<Map<string, string>> => {
    const found = new Map<string, string>()
    for (const raw of await gPaginate(token, `${dsUrl}?$top=100`)) {
      const ds = (raw.dataSource ?? {}) as Json
      const email = String(ds.email ?? raw.email ?? '').toLowerCase()
      const id = String(raw.id ?? '')
      if (email && id) found.set(email, id)
    }
    return found
  }
  let byEmail = await listExisting()
  let dsId = byEmail.get(mailbox.toLowerCase()) ?? ''
  if (!dsId) {
    try {
      const ds = await gJson(token, 'POST', dsUrl, {
        dataSource: {
          '@odata.type': 'microsoft.graph.security.userSource',
          email: mailbox,
          includedSources: 'mailbox'
        }
      })
      dsId = String(ds.id ?? '')
    } catch (e) {
      if (!(e instanceof EdiscoveryError) || !/\b409\b/.test(e.message)) throw e
      byEmail = await listExisting()
      dsId = byEmail.get(mailbox.toLowerCase()) ?? ''
    }
  }
  if (!dsId) throw new EdiscoveryError(`비-보관 데이터 소스 생성 실패: ${mailbox}`)
  // Phase 2: create the search bound to that data source.
  return gJson(token, 'POST', `${CASES_URL}/${caseId}/searches`, {
    displayName,
    contentQuery,
    'noncustodialSources@odata.bind': [`${dsUrl}/${dsId}`]
  })
}

async function estimateSearch(token: string, caseId: string, searchId: string): Promise<string | null> {
  const res = await gReq(token, 'POST', `${CASES_URL}/${caseId}/searches/${searchId}/estimateStatistics`)
  return res.headers.get('Location') ?? res.headers.get('location')
}

async function exportSearch(token: string, caseId: string, searchId: string, displayName: string): Promise<string | null> {
  const res = await gReq(token, 'POST', `${CASES_URL}/${caseId}/searches/${searchId}/exportResult`, {
    displayName,
    exportCriteria: 'searchHits',
    additionalOptions: 'splitSource, includeFolderAndPath, condensePaths, friendlyName',
    exportFormat: 'msg'
  })
  return res.headers.get('Location') ?? res.headers.get('location')
}

async function getOperation(token: string, operationUrl: string): Promise<Json> {
  let url = operationUrl
  if (url.startsWith('/')) url = `https://graph.microsoft.com${url}`
  if (!url.startsWith('http')) url = `${CASES_URL}/operations/${url}`
  return gJson(token, 'GET', url)
}

// ---- query + download-url helpers (port of services/ediscovery.py) ------
function dateOnly(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  return t.includes('T') ? t.split('T')[0] : t
}
function buildContentQuery(start: string | null, end: string | null): string {
  const clauses: string[] = []
  const s = dateOnly(start)
  const e = dateOnly(end)
  if (s && e) clauses.push(`(received>=${s} AND received<=${e})`)
  else if (s) clauses.push(`received>=${s}`)
  else if (e) clauses.push(`received<=${e}`)
  clauses.push(
    '(ItemClass:IPM.SkypeTeams.Message.Copilot.*) ' +
      'OR (ItemClass:IPM.SkypeTeams.Message.ConnectedAIApp*) ' +
      'OR (ItemClass:IPM.SkypeTeams.Message.CloudAIApp*) ' +
      'OR (ItemClass:IPM.SkypeTeams.Message.TeamCopilot*) ' +
      'OR (ItemClass:IPM.SkypeTeams.TeamCopilot*)'
  )
  return clauses.map((c) => `(${c})`).join(' AND ')
}

function isDirectDownloadProxy(url: string): boolean {
  const low = (url || '').toLowerCase()
  return low.includes('proxyservice.ediscovery') || low.includes('exportaedblobfileresult')
}

/** Returns [url, isProxy]; prefers a programmatic Azure Blob SAS link. */
function extractDownloadUrl(payload: Json): [string | null, boolean] {
  const blob = (payload.azureBlobUrl ?? payload.azureBlobContainer) as string | undefined
  if (blob) {
    const tok = (payload.azureBlobToken ?? payload.azureBlobSasToken) as string | undefined
    if (tok) {
      const sep = String(blob).includes('?') ? '&' : '?'
      return [`${blob}${sep}${String(tok).replace(/^[?&]/, '')}`, false]
    }
    return [String(blob), false]
  }
  if (payload.downloadUrl) {
    const url = String(payload.downloadUrl)
    return [url, isDirectDownloadProxy(url)]
  }
  const meta = payload.exportFileMetadata
  if (Array.isArray(meta)) {
    const entries = meta.filter((m): m is Json => !!m && typeof m === 'object' && !!(m as Json).downloadUrl)
    const rank = (entry: Json): number => {
      const name = String(entry.fileName ?? entry.filename ?? '').toLowerCase()
      if (name.startsWith('items')) return 0
      if (name.startsWith('reports')) return 2
      return 1
    }
    entries.sort((a, b) => rank(a) - rank(b))
    if (entries[0]?.downloadUrl) {
      const url = String(entries[0].downloadUrl)
      return [url, isDirectDownloadProxy(url)]
    }
  }
  return [null, false]
}

// ---- orchestrator -------------------------------------------------------
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}
function caseDisplayName(job: db.EdiscoveryJob): string {
  const alias = (job.targetUpn || 'all').split('@')[0] || 'all'
  // Stable per-user name so the case is REUSED instead of piling up one per run.
  return `${DEFAULT_CASE_NAME} - ${alias}`
}

async function pollOperation(
  token: string,
  operationUrl: string,
  label: string,
  onProgress: OnProgress,
  shouldStop: ShouldStop
): Promise<Json> {
  const started = Date.now()
  const deadline = started + MAX_POLL_SECONDS * 1000
  let attempt = 0
  for (;;) {
    if (shouldStop()) throw new EdiscoveryError(`${label} 사용자에 의해 취소됨`)
    attempt++
    const payload = await getOperation(token, operationUrl)
    const status = String(payload.status ?? '').toLowerCase()
    const elapsed = Math.round((Date.now() - started) / 1000)
    onProgress('exporting', `${label} 진행 중 · ${elapsed}초 · ${status || 'running'} (#${attempt})`)
    if (TERMINAL.has(status)) {
      if (status === 'failed') throw new EdiscoveryError(`${label} 실패: ${JSON.stringify(payload.statusDetail ?? payload).slice(0, 200)}`)
      onProgress('exporting', `${label} 완료 · ${elapsed}초`)
      return payload
    }
    if (Date.now() >= deadline) throw new EdiscoveryError(`${label} 시간 초과 (${MAX_POLL_SECONDS}s)`)
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000))
  }
}

/**
 * Node cannot allocate a Buffer larger than ~2 GiB, and the ZIP parser needs the
 * whole package resident. Refuse oversized packages with an actionable message
 * instead of dying with an out-of-memory crash mid-collection.
 */
const MAX_EXPORT_BYTES = 1_500_000_000

async function downloadAndParse(
  job: db.EdiscoveryJob,
  onProgress: OnProgress,
  proxyDownload?: ProxyDownload
): Promise<db.InteractionUpsert[]> {
  if (!job.exportUrl) throw new EdiscoveryError('다운로드할 내보내기 URL이 없습니다.')
  let buf: Buffer
  if (isDirectDownloadProxy(job.exportUrl)) {
    // ME3 / eDiscovery Standard: browser-interactive proxy URL (no SAS token).
    if (!proxyDownload) {
      throw new EdiscoveryError(
        '이 테넌트의 내보내기는 브라우저 로그인 기반 프록시 URL입니다. (브라우저 다운로드 핸들러가 제공되지 않음)'
      )
    }
    onProgress('downloading', '브라우저로 내보내기 패키지를 다운로드하는 중… (창에서 로그인하세요)')
    buf = await proxyDownload(job.exportUrl)
  } else {
    // ME5 / eDiscovery Premium: Azure Blob SAS — direct programmatic download.
    onProgress('downloading', '내보내기 패키지를 다운로드하는 중…')
    const res = await httpRequest(job.exportUrl, {}, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
    if (!res.ok) throw new EdiscoveryError(`다운로드 실패 ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_EXPORT_BYTES) {
      throw new EdiscoveryError(
        `내보내기 패키지가 너무 큽니다(${Math.round(declared / 1e9)} GB). 기간을 좁혀 다시 수집하세요.`
      )
    }
    buf = Buffer.from(await res.arrayBuffer())
  }
  if (buf.length > MAX_EXPORT_BYTES) {
    throw new EdiscoveryError(
      `내보내기 패키지가 너무 큽니다(${Math.round(buf.length / 1e9)} GB). 기간을 좁혀 다시 수집하세요.`
    )
  }
  onProgress('parsing', `패키지 파싱 중… (${Math.round(buf.length / 1024)} KB)`)
  const userId = job.targetUserId || `ediscovery:${job.targetUpn.toLowerCase()}`
  return parseExportPackage(buf, userId, (line) => onProgress('parsing', line))
}

/**
 * Run (or resume) the eDiscovery pipeline for one job. Persists the job at
 * each stage so an interrupted run reconnects to the most advanced artifact.
 * Returns the parsed interaction rows (caller ingests + recomputes threads).
 */
export async function runEdiscoveryJob(
  job: db.EdiscoveryJob,
  opts: {
    tenantId: string
    cacheDir: string
    onCode: OnDeviceCode
    onProgress: OnProgress
    shouldStop: ShouldStop
    proxyDownload?: ProxyDownload
  }
): Promise<db.InteractionUpsert[]> {
  const { tenantId, cacheDir, onCode, onProgress, shouldStop, proxyDownload } = opts
  const save = (status?: string): void => {
    if (status) job.status = status
    job.updatedAt = nowIso()
    db.upsertEdiscoveryJob(job)
  }
  try {
    onProgress('pending', 'eDiscovery 위임 로그인 확인 중…')
    const token = await delegatedToken(tenantId, cacheDir, onCode)

    // Resume points (most advanced first).
    if (job.exportUrl) {
      onProgress('downloading', '다운로드 단계부터 재개')
      return downloadAndParse(job, onProgress, proxyDownload)
    }
    if (job.operationUrl) {
      onProgress('exporting', '진행 중이던 내보내기 폴링 재개')
      const final = await pollOperation(token, job.operationUrl, 'Export', onProgress, shouldStop)
      const [url, isProxy] = extractDownloadUrl(final)
      if (!url) throw new EdiscoveryError('내보내기는 완료됐지만 다운로드 URL이 없습니다.')
      job.exportUrl = url
      save('downloading')
      if (isProxy) onProgress('downloading', '프록시 URL 반환 — 브라우저로 다운로드합니다')
      return downloadAndParse(job, onProgress, proxyDownload)
    }

    if (!job.caseId) {
      onProgress('preflight', 'eDiscovery 권한 확인 중…')
      await preflight(token)
      const name = caseDisplayName(job)
      onProgress('case', `eDiscovery 케이스 생성 '${name}'`)
      const c = await createCase(token, name, 'Auto-created by CopilotWatchTower for Copilot interaction collection.')
      job.caseId = String(c.id ?? '')
      if (!job.caseId) throw new EdiscoveryError('케이스 ID를 얻지 못했습니다.')
      save('case')
    } else {
      onProgress('case', `기존 케이스 재사용 '${job.caseId}'`)
    }
    if (shouldStop()) throw new EdiscoveryError('검색 생성 전 취소됨')

    if (!job.searchId) {
      onProgress('searching', `검색 추가: ${job.targetUpn}`)
      const search = await addSearch(
        token,
        job.caseId,
        `Copilot-${job.targetUpn}-${job.id.slice(0, 8)}`,
        buildContentQuery(job.windowStart, job.windowEnd),
        job.targetUpn
      )
      job.searchId = String(search.id ?? '')
      if (!job.searchId) throw new EdiscoveryError('검색 ID를 얻지 못했습니다.')
      save('searching')
    } else {
      onProgress('searching', `기존 검색 재사용 '${job.searchId}'`)
    }

    onProgress('searching', '검색 통계 추정 중…')
    const estOp = await estimateSearch(token, job.caseId, job.searchId)
    if (estOp) await pollOperation(token, estOp, 'Estimate', onProgress, shouldStop)
    if (shouldStop()) throw new EdiscoveryError('내보내기 전 취소됨')

    onProgress('exporting', '내보내기 시작…')
    const expOp = await exportSearch(token, job.caseId, job.searchId, `Export-${job.targetUpn}-${job.id.slice(0, 8)}`)
    if (!expOp) throw new EdiscoveryError('내보내기가 operation location을 반환하지 않았습니다.')
    job.operationUrl = expOp
    save('exporting')
    const final = await pollOperation(token, expOp, 'Export', onProgress, shouldStop)
    const [url, isProxy] = extractDownloadUrl(final)
    if (!url) throw new EdiscoveryError('내보내기는 완료됐지만 다운로드 URL이 없습니다.')
    job.exportUrl = url
    save('downloading')
    if (isProxy) onProgress('downloading', '프록시 URL 반환 — 브라우저로 다운로드합니다')
    return downloadAndParse(job, onProgress, proxyDownload)
  } catch (e) {
    job.lastError = e instanceof Error ? e.message : String(e)
    job.lastErrorAt = nowIso()
    save('error')
    throw e instanceof EdiscoveryError ? e : new EdiscoveryError(String(e))
  }
}
