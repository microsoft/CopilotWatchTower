/**
 * Audit payload helpers — port of audit_payload.py (subset used by the
 * Purview collector to build the `target_resources` JSON column).
 */

const PRIORITY_AUDIT_DATA_KEYS = [
  'ObjectId',
  'TargetUrl',
  'TargetUrls',
  'FileName',
  'Site',
  'AppIdentity',
  'AppName',
  'AppDisplayName',
  'AddOnName',
  'AddOnGuid',
  'AddOnType',
  'AppDistributionMode',
  'AppExternalId',
  'ChatThreadId',
  'OperationScope',
  'AppAccessContext'
]

const PRIORITY_COPILOT_EVENT_KEYS = [
  'AppHost',
  'ThreadId',
  'ModelTransparencyDetails',
  'AccessedResources',
  'Contexts',
  'MessageIds'
]

const RAW_TOP_LEVEL_KEYS = ['objectId', 'service', 'auditLogRecordType']

type Dict = Record<string, unknown>

function asDict(value: unknown): Dict {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Dict
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Dict
    } catch {
      return {}
    }
  }
  return {}
}

export function auditDataFromRaw(raw: Dict): Dict {
  return asDict(raw.auditData)
}

export function copilotEventData(auditData: Dict): Dict {
  return asDict(auditData.CopilotEventData)
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Dict).length === 0
  return false
}

function isMetadataKey(key: string): boolean {
  return key.startsWith('@') || key.endsWith('@odata.type')
}

interface PayloadItem {
  key: string
  value: unknown
}

function appendPayloadItem(items: PayloadItem[], seen: Set<string>, key: string, value: unknown): void {
  if (isEmpty(value)) return
  if (seen.has(key)) return
  seen.add(key)
  items.push({ key, value })
}

function existingItems(rawJson: string | null): PayloadItem[] {
  if (!rawJson) return []
  try {
    const parsed = JSON.parse(rawJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((i) => i && typeof i === 'object') as PayloadItem[]
  } catch {
    return []
  }
}

export function auditPayloadItems(raw: Dict, auditData?: Dict, existingJson: string | null = null): PayloadItem[] {
  const ad = auditData ?? auditDataFromRaw(raw)
  const ed = copilotEventData(ad)
  const items: PayloadItem[] = []
  const seen = new Set<string>()

  for (const item of existingItems(existingJson)) {
    appendPayloadItem(items, seen, (item.key as string) || 'payload', item.value)
  }
  for (const key of PRIORITY_AUDIT_DATA_KEYS) appendPayloadItem(items, seen, key, ad[key])
  for (const key of PRIORITY_COPILOT_EVENT_KEYS) appendPayloadItem(items, seen, key, ed[key])
  for (const [key, value] of Object.entries(ad)) {
    if (key === 'CopilotEventData' || isMetadataKey(key)) continue
    appendPayloadItem(items, seen, key, value)
  }
  for (const [key, value] of Object.entries(ed)) {
    if (isMetadataKey(key)) continue
    appendPayloadItem(items, seen, key, value)
  }
  for (const key of RAW_TOP_LEVEL_KEYS) appendPayloadItem(items, seen, key, raw[key])
  return items
}

export function payloadJson(items: PayloadItem[]): string | null {
  return items.length ? JSON.stringify(items) : null
}
