/**
 * Shared HTTP client for every outbound call the main process makes
 * (Graph, Purview eDiscovery, Dataverse, BAP, Power Platform, Entra onboarding).
 *
 * Before this existed each collector hand-rolled its own `fetch` wrapper, so
 * timeout handling, 429 throttling and 401 refresh behaved differently per API
 * — and none of them had a timeout at all, which let a single unresponsive
 * endpoint hang the whole main process (and with it the UI) indefinitely.
 */

export class HttpError extends Error {
  readonly status: number
  readonly url: string
  readonly body: string
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} ${url.slice(0, 120)} :: ${body.slice(0, 200)}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
  }
}

export class HttpTimeoutError extends Error {
  readonly url: string
  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${url.slice(0, 120)}`)
    this.name = 'HttpTimeoutError'
    this.url = url
  }
}

/** Default per-request budget. Long downloads override this explicitly. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Budget for bulk export/blob downloads. */
export const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
export const MAX_THROTTLE_RETRIES = 5

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Backoff for a throttled/unavailable response: honour `Retry-After`
 * (seconds or HTTP-date), otherwise exponential backoff, capped at 60s.
 */
export function retryDelayMs(res: { headers: { get(name: string): string | null } }, attempt: number): number {
  const raw = res.headers.get('retry-after')
  let fromHeader = 0
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds > 0) {
      fromHeader = seconds * 1000
    } else {
      const at = Date.parse(raw)
      if (Number.isFinite(at)) fromHeader = Math.max(0, at - Date.now())
    }
  }
  return Math.min(60_000, Math.max(fromHeader, 1000 * 2 ** attempt))
}

export interface HttpOptions {
  /** Abort the request after this many ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Caller-owned cancellation (user pressed Stop, app quitting, …). */
  signal?: AbortSignal
  /**
   * Invoked once on 401 before a single retry. Return true to retry — used to
   * drop cached tokens and mint a fresh one.
   */
  onUnauthorized?: () => Promise<boolean> | boolean
  /** Max retries for 429/5xx. Defaults to MAX_THROTTLE_RETRIES. */
  maxRetries?: number
  /** Optional progress/diagnostic sink. Never receives credentials. */
  onRetry?: (info: { url: string; status: number; attempt: number; delayMs: number }) => void
  /** Injection seam for tests. */
  fetchImpl?: typeof fetch
}

function composeSignal(timeoutMs: number, external: AbortSignal | undefined): {
  signal: AbortSignal
  cleanup: () => void
  timedOut: () => boolean
} {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    },
    timedOut: () => timedOut
  }
}

/**
 * Perform a request with a hard timeout, 401-refresh and 429/5xx backoff.
 * Non-idempotent methods are retried on 429 only (the server states it did not
 * process the request); they are never retried on 5xx, where the outcome is
 * unknown and a retry could duplicate work.
 */
export async function httpRequest(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: externalSignal,
    onUnauthorized,
    maxRetries = MAX_THROTTLE_RETRIES,
    onRetry,
    fetchImpl = fetch
  } = opts
  const method = (init.method ?? 'GET').toUpperCase()
  const idempotent = IDEMPOTENT_METHODS.has(method)
  let refreshed = false

  for (let attempt = 0; ; attempt++) {
    const { signal, cleanup, timedOut } = composeSignal(timeoutMs, externalSignal)
    let res: Response
    try {
      res = await fetchImpl(url, { ...init, signal })
    } catch (e) {
      cleanup()
      if (timedOut()) throw new HttpTimeoutError(url, timeoutMs)
      throw e
    }
    cleanup()

    if (res.status === 401 && onUnauthorized && !refreshed) {
      refreshed = true
      if (await onUnauthorized()) continue
    }

    const retryable = RETRYABLE_STATUS.has(res.status) && (idempotent || res.status === 429)
    if (retryable && attempt < maxRetries) {
      const delayMs = retryDelayMs(res, attempt)
      onRetry?.({ url, status: res.status, attempt, delayMs })
      await sleep(delayMs)
      continue
    }
    return res
  }
}

/**
 * `httpRequest` + status check + JSON parse. A body that is not valid JSON is
 * an error, never an empty object: silently degrading to `{}` is how a
 * governance tool ends up reporting "0 findings" for a failed API call.
 */
export async function httpJson<T>(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<T> {
  const res = await httpRequest(url, init, opts)
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''))
  const text = await res.text()
  if (!text.trim()) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(res.status, url, `expected JSON, got: ${text.slice(0, 200)}`)
  }
}
