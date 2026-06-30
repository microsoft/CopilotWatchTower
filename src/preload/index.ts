import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The single bridge the renderer is allowed to use. It mirrors the Python
 * app's RPC shape: one ``invoke(method, ...args)`` entry point that returns a
 * promise. As real backend methods are ported, only the main-process handlers
 * change — this surface stays stable.
 */
const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
