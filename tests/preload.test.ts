import { beforeAll, describe, expect, it, vi } from 'vitest'

interface ExposedApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (payload: unknown) => void) => () => void
}

const electronMock = vi.hoisted(() => ({
  exposed: null as ExposedApi | null,
  invoke: vi.fn(async () => ({ ok: true })),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: ExposedApi) => {
      electronMock.exposed = api
    }
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener
  }
}))

describe('sandboxed preload bridge', () => {
  beforeAll(async () => {
    await import('../src/preload/index')
  })

  it('forwards declared invoke channels', async () => {
    const api = electronMock.exposed!

    await expect(api.invoke('system_info', 'argument')).resolves.toEqual({ ok: true })
    expect(electronMock.invoke).toHaveBeenCalledWith('system_info', 'argument')
  })

  it('rejects undeclared invoke channels before reaching ipcRenderer', async () => {
    const api = electronMock.exposed!
    const callsBefore = electronMock.invoke.mock.calls.length

    await expect(api.invoke('run_arbitrary_code')).rejects.toThrow('IPC invoke channel is not allowed')
    expect(electronMock.invoke).toHaveBeenCalledTimes(callsBefore)
  })

  it('subscribes and removes listeners only for declared event channels', () => {
    const api = electronMock.exposed!
    const listener = vi.fn()
    const unsubscribe = api.on('conversation_progress', listener)
    const handler = electronMock.on.mock.calls.at(-1)?.[1] as (_event: unknown, payload: unknown) => void

    handler({}, { message: 'running' })
    expect(listener).toHaveBeenCalledWith({ message: 'running' })

    unsubscribe()
    expect(electronMock.removeListener).toHaveBeenCalledWith('conversation_progress', handler)
    expect(() => api.on('renderer_message', listener)).toThrow('IPC event channel is not allowed')
  })
})