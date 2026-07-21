import type { EventChannel, InvokeChannel } from '../../../shared/ipc'

declare global {
  interface Window {
    api: {
      invoke: (channel: InvokeChannel, ...args: unknown[]) => Promise<unknown>
      on: (channel: EventChannel, listener: (payload: unknown) => void) => () => void
    }
  }
}

/**
 * Typed wrapper over the preload bridge. Same idea as the Python app's
 * ``bridge.ts`` — call a named backend method, get a typed promise back.
 */
export function invoke<T>(channel: InvokeChannel, ...args: unknown[]): Promise<T> {
  if (typeof window === 'undefined' || !window.api) {
    return Promise.reject(new Error('bridge unavailable'))
  }
  return window.api.invoke(channel, ...args) as Promise<T>
}

/** Subscribe to a main-process event channel; returns an unsubscribe fn. */
export function subscribe<T>(channel: EventChannel, cb: (payload: T) => void): () => void {
  if (typeof window === 'undefined' || !window.api?.on) return () => undefined
  return window.api.on(channel, (p) => cb(p as T))
}
