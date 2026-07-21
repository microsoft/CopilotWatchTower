import { describe, expect, it } from 'vitest'
import {
  auditDataFromRaw,
  auditPayloadItems,
  copilotEventData,
  payloadJson
} from '../src/main/auditPayload'

describe('audit payload extraction', () => {
  it('parses string-encoded audit and Copilot event data', () => {
    const raw = {
      auditData: JSON.stringify({
        ObjectId: 'document.docx',
        CopilotEventData: JSON.stringify({ ThreadId: 'thread-1', AccessedResources: ['site-a'] })
      }),
      service: 'Copilot'
    }

    const auditData = auditDataFromRaw(raw)
    expect(copilotEventData(auditData)).toEqual({ ThreadId: 'thread-1', AccessedResources: ['site-a'] })
    expect(auditPayloadItems(raw, auditData)).toEqual([
      { key: 'ObjectId', value: 'document.docx' },
      { key: 'ThreadId', value: 'thread-1' },
      { key: 'AccessedResources', value: ['site-a'] },
      { key: 'service', value: 'Copilot' }
    ])
  })

  it('preserves existing items without duplicating later values', () => {
    const raw = { auditData: { ObjectId: 'new-value', Empty: '', '@odata.type': '#ignored' } }
    const items = auditPayloadItems(raw, undefined, JSON.stringify([{ key: 'ObjectId', value: 'existing' }]))

    expect(items).toEqual([{ key: 'ObjectId', value: 'existing' }])
    expect(payloadJson(items)).toBe('[{"key":"ObjectId","value":"existing"}]')
    expect(payloadJson([])).toBeNull()
  })
})