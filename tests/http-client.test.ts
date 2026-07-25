import { describe, expect, it, vi } from 'vitest'
import { httpJson, httpRequest, retryDelayMs, HttpError, HttpTimeoutError, MAX_THROTTLE_RETRIES } from '../src/main/http'

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

/** A `fetch` stand-in that replays a scripted sequence and records its calls. */
function scriptedFetch(sequence: Array<Response | Error>): {
  impl: typeof fetch
  calls: () => number
} {
  let index = 0
  const impl = (async () => {
    const next = sequence[Math.min(index, sequence.length - 1)]
    index++
    if (next instanceof Error) throw next
    return next.clone()
  }) as unknown as typeof fetch
  return { impl, calls: () => index }
}

describe('retryDelayMs', () => {
  it('honours a numeric Retry-After', () => {
    expect(retryDelayMs(response(429, '', { 'retry-after': '7' }), 0)).toBe(7000)
  })

  it('honours an HTTP-date Retry-After', () => {
    const at = new Date(Date.now() + 30_000).toUTCString()
    const delay = retryDelayMs(response(429, '', { 'retry-after': at }), 0)
    expect(delay).toBeGreaterThan(20_000)
    expect(delay).toBeLessThanOrEqual(60_000)
  })

  it('backs off exponentially without a header and caps at 60s', () => {
    expect(retryDelayMs(response(503), 0)).toBe(1000)
    expect(retryDelayMs(response(503), 3)).toBe(8000)
    expect(retryDelayMs(response(503), 20)).toBe(60_000)
  })
})

describe('httpRequest', () => {
  it('retries a throttled GET and returns the eventual success', async () => {
    const { impl, calls } = scriptedFetch([
      response(429, '', { 'retry-after': '0' }),
      response(429, '', { 'retry-after': '0' }),
      response(200, 'ok')
    ])
    const res = await httpRequest('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl, maxRetries: 3 })

    expect(res.status).toBe(200)
    expect(calls()).toBe(3)
  })

  it('does not retry a POST on 5xx, where the outcome is unknown', async () => {
    const { impl, calls } = scriptedFetch([response(503), response(200)])
    const res = await httpRequest('https://graph.microsoft.com/v1.0/x', { method: 'POST' }, { fetchImpl: impl })

    expect(res.status).toBe(503)
    expect(calls()).toBe(1)
  })

  it('retries a POST on 429, where the server states it did not process the request', async () => {
    const { impl, calls } = scriptedFetch([response(429, '', { 'retry-after': '0' }), response(201)])
    const res = await httpRequest('https://graph.microsoft.com/v1.0/x', { method: 'POST' }, { fetchImpl: impl })

    expect(res.status).toBe(201)
    expect(calls()).toBe(2)
  })

  it('gives up after maxRetries instead of looping forever', async () => {
    const { impl, calls } = scriptedFetch([response(503)])
    // Backoff is exponential (1s, 2s, …), so keep the budget small to stay fast.
    const res = await httpRequest('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl, maxRetries: 2 })

    expect(res.status).toBe(503)
    expect(calls()).toBe(3)
  })

  it('defaults to a bounded number of throttle retries', () => {
    expect(MAX_THROTTLE_RETRIES).toBeGreaterThan(0)
    expect(MAX_THROTTLE_RETRIES).toBeLessThanOrEqual(10)
  })

  it('refreshes the token exactly once on 401', async () => {
    const { impl, calls } = scriptedFetch([response(401), response(200)])
    const onUnauthorized = vi.fn().mockResolvedValue(true)
    const res = await httpRequest('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl, onUnauthorized })

    expect(res.status).toBe(200)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(calls()).toBe(2)
  })

  it('does not refresh again when the refreshed token is still rejected', async () => {
    const { impl, calls } = scriptedFetch([response(401)])
    const onUnauthorized = vi.fn().mockResolvedValue(true)
    const res = await httpRequest('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl, onUnauthorized })

    expect(res.status).toBe(401)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(calls()).toBe(2)
  })

  it('aborts a hung request rather than hanging the main process forever', async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch

    await expect(httpRequest('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl, timeoutMs: 20 })).rejects.toBeInstanceOf(
      HttpTimeoutError
    )
  })

  it('propagates caller cancellation', async () => {
    const controller = new AbortController()
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch

    const pending = httpRequest('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl, signal: controller.signal })
    controller.abort()

    // Caller cancellation is not a timeout, so the original abort surfaces.
    await expect(pending).rejects.not.toBeInstanceOf(HttpTimeoutError)
  })
})

describe('httpJson', () => {
  it('throws instead of silently degrading a non-JSON body to an empty object', async () => {
    const { impl } = scriptedFetch([response(200, '<html>Sign in</html>')])

    await expect(httpJson('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl })).rejects.toBeInstanceOf(HttpError)
  })

  it('throws on a non-2xx response', async () => {
    const { impl } = scriptedFetch([response(403, 'Forbidden')])

    await expect(httpJson('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl })).rejects.toBeInstanceOf(HttpError)
  })

  it('parses a JSON body', async () => {
    const { impl } = scriptedFetch([response(200, JSON.stringify({ value: [1, 2] }))])

    await expect(httpJson<{ value: number[] }>('https://graph.microsoft.com/v1.0/me', {}, { fetchImpl: impl })).resolves.toEqual({
      value: [1, 2]
    })
  })
})
