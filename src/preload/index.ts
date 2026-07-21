import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  isEventChannel,
  isInvokeChannel,
  type EventChannel,
  type InvokeChannel
} from '../shared/ipc'

/**
 * The single bridge the renderer is allowed to use. It mirrors the Python
 * app's RPC shape: one ``invoke(method, ...args)`` entry point that returns a
 * promise. As real backend methods are ported, only the main-process handlers
 * change — this surface stays stable.
 */
const api = {
  invoke: (channel: InvokeChannel, ...args: unknown[]): Promise<unknown> => {
    if (!isInvokeChannel(channel)) return Promise.reject(new Error(`IPC invoke channel is not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: EventChannel, listener: (payload: unknown) => void): (() => void) => {
    if (!isEventChannel(channel)) throw new Error(`IPC event channel is not allowed: ${channel}`)
    const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
