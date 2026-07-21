import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel
} from '../src/shared/ipc'

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort()
}

describe('IPC channel contract', () => {
  const mainSource = readFileSync(resolve('src/main/index.ts'), 'utf8')

  it('contains every main-process invoke handler exactly once', () => {
    const registered = uniqueMatches(mainSource, /ipcMain\.handle\(['"]([^'"]+)['"]/g)
    const declared = [...INVOKE_CHANNELS].sort()

    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
    expect(registered).toEqual(declared)
  })

  it('contains every main-process event channel', () => {
    const emitted = uniqueMatches(mainSource, /sendEvent\([^,]+,\s*['"]([^'"]+)['"]/g)
    const declared = [...EVENT_CHANNELS].sort()

    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
    expect(emitted).toEqual(declared)
  })

  it('accepts declared channels and rejects unknown channels', () => {
    expect(isInvokeChannel('system_info')).toBe(true)
    expect(isInvokeChannel('run_arbitrary_code')).toBe(false)
    expect(isEventChannel('conversation_progress')).toBe(true)
    expect(isEventChannel('renderer_message')).toBe(false)
  })
})