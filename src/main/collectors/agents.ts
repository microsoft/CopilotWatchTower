/**
 * Copilot admin diagnostics + agent inventory — port of services/admin_diagnostics.py.
 * Probes read-only Copilot admin APIs (app-only) and derives copilot_agents
 * rows from the agent_registrations / catalog_packages payloads.
 */
import { createHash } from 'node:crypto'
import {
  upsertCopilotAdminDiagnostics,
  replaceCopilotAgentsForSource,
  type CopilotAdminDiagnosticRow,
  type CopilotAgentRow
} from '../db'
import {
  getCopilotAdminLimitedMode,
  listCopilotAdminPolicySettings,
  listCopilotAdminCatalogPackages,
  listCopilotAgentRegistrations,
  GraphError
} from '../graph'

type Dict = Record<string, unknown>

const AGENT_ELEMENT_TYPES = new Set(['DeclarativeCopilots', 'CustomEngineCopilots'])
const AGENT_SOURCES = new Set(['agent_registrations', 'catalog_packages'])

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

// ---- payload → agent-row extraction ------------------------------------

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function firstDeepValue(payload: unknown, ...names: string[]): string | null {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const obj = payload as Dict
    for (const [key, value] of Object.entries(obj)) {
      if (wanted.has(key.toLowerCase()) && isScalar(value)) {
        const text = String(value).trim()
        if (text) return text
      }
    }
    for (const value of Object.values(obj)) {
      const nested = firstDeepValue(value, ...names)
      if (nested) return nested
    }
  } else if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = firstDeepValue(item, ...names)
      if (nested) return nested
    }
  }
  return null
}

function elementTypes(item: Dict): string[] {
  const value = item.elementTypes ?? item.ElementTypes
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === 'string') return value.split(',').map((p) => p.trim()).filter(Boolean)
  return []
}

function isAgentPackage(item: Dict): boolean {
  return elementTypes(item).some((t) => AGENT_ELEMENT_TYPES.has(t))
}

function payloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Dict
    for (const key of ['value', 'items', 'results', 'agents', 'packages']) {
      const v = obj[key]
      if (Array.isArray(v)) return v
    }
    return [payload]
  }
  return []
}

function agentIdentifier(item: Dict, source: string): string {
  for (const key of ['id', 'agentId', 'appId', 'appIdentity', 'appExternalId', 'externalId', 'addOnGuid', 'teamsAppId']) {
    const value = firstDeepValue(item, key)
    if (value) return value
  }
  const digest = createHash('sha1').update(JSON.stringify(item)).digest('hex').slice(0, 24)
  return `${source}:${digest}`
}

function agentRowsFromPayloadJson(payloadJson: string, capturedAt: string, source: string): CopilotAgentRow[] {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return []
  }
  const rows: CopilotAgentRow[] = []
  for (const item of payloadItems(payload)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const dict = item as Dict
    if (source === 'catalog_packages' && !isAgentPackage(dict)) continue
    rows.push({
      id: agentIdentifier(dict, source),
      display_name: firstDeepValue(dict, 'displayName', 'name', 'title', 'appDisplayName', 'AddOnName'),
      app_identity: firstDeepValue(dict, 'appIdentity'),
      app_external_id: firstDeepValue(dict, 'appExternalId', 'externalId', 'teamsAppId'),
      add_on_guid: firstDeepValue(dict, 'addOnGuid', 'addOnId', 'teamsAppDefinitionId'),
      source,
      status: firstDeepValue(dict, 'status', 'state', 'publishingStatus', 'availabilityStatus'),
      created_at: firstDeepValue(dict, 'createdDateTime', 'createdAt', 'createdOn', 'creationTime'),
      updated_at: firstDeepValue(dict, 'lastModifiedDateTime', 'updatedDateTime', 'updatedAt', 'modifiedDateTime'),
      raw_json: JSON.stringify(dict),
      captured_at: capturedAt
    })
  }
  return rows
}

// ---- probes ------------------------------------------------------------

interface Probe {
  key: string
  label: string
  endpoint: string
  fn: () => Promise<unknown>
  summarize: (payload: unknown) => string
}

function summarizeLimitedMode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '응답 수신'
  const enabled = (payload as Dict).isEnabledForGroup
  if (enabled === true) return '제한 모드 켜짐'
  if (enabled === false) return '제한 모드 꺼짐'
  return '제한 모드 응답 수신'
}
function summarizeCollection(payload: unknown, unit: string): string {
  return Array.isArray(payload) ? `${unit} ${payload.length.toLocaleString()}개` : `${unit} 응답 수신`
}
function errorSummary(status: string): string {
  if (status === 'forbidden') return '권한 없음 (동의 필요)'
  if (status === 'not_found') return '엔드포인트 없음'
  return '호출 실패'
}

async function probe(p: Probe): Promise<CopilotAdminDiagnosticRow> {
  const capturedAt = isoNow()
  try {
    const payload = await p.fn()
    return {
      key: p.key,
      label: p.label,
      endpoint: p.endpoint,
      status: 'ok',
      status_code: 200,
      summary: p.summarize(payload),
      payload_json: JSON.stringify(payload),
      error: null,
      captured_at: capturedAt
    }
  } catch (e) {
    if (e instanceof GraphError) {
      const status = e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : 'error'
      return {
        key: p.key,
        label: p.label,
        endpoint: p.endpoint,
        status,
        status_code: e.status,
        summary: errorSummary(status),
        payload_json: null,
        error: e.message,
        captured_at: capturedAt
      }
    }
    return {
      key: p.key,
      label: p.label,
      endpoint: p.endpoint,
      status: 'error',
      status_code: null,
      summary: '호출 실패',
      payload_json: null,
      error: e instanceof Error ? e.message : String(e),
      captured_at: capturedAt
    }
  }
}

/** Probe Copilot admin APIs, persist diagnostics, and derive copilot_agents. */
export async function collectAdminDiagnostics(
  onLog?: (line: string) => void
): Promise<{ diagnostics: number; agents: number }> {
  const probes: Probe[] = [
    { key: 'limited_mode', label: '제한 모드', endpoint: '/copilot/admin/settings/limitedMode', fn: getCopilotAdminLimitedMode, summarize: summarizeLimitedMode },
    { key: 'policy_settings', label: '정책 설정', endpoint: '/copilot/admin/policySettings', fn: listCopilotAdminPolicySettings, summarize: (p) => summarizeCollection(p, '정책') },
    { key: 'catalog_packages', label: '카탈로그 패키지', endpoint: '/copilot/admin/catalog/packages', fn: listCopilotAdminCatalogPackages, summarize: (p) => summarizeCollection(p, '패키지') },
    { key: 'agent_registrations', label: '에이전트 등록', endpoint: '/copilot/agentRegistrations', fn: listCopilotAgentRegistrations, summarize: (p) => summarizeCollection(p, '등록') }
  ]
  const rows: CopilotAdminDiagnosticRow[] = []
  for (const p of probes) {
    const row = await probe(p)
    rows.push(row)
    onLog?.(`${p.label}: ${row.summary ?? row.status}`)
  }
  upsertCopilotAdminDiagnostics(rows)

  // Derive agent rows from successful agent_registrations / catalog_packages payloads.
  const bySource: Record<string, CopilotAgentRow[]> = {}
  for (const row of rows) {
    if (row.status !== 'ok' || !AGENT_SOURCES.has(row.key) || !row.payload_json) continue
    for (const agent of agentRowsFromPayloadJson(row.payload_json, row.captured_at, row.key)) {
      ;(bySource[agent.source] ??= []).push(agent)
    }
  }
  let agentCount = 0
  for (const [source, agentRows] of Object.entries(bySource)) {
    replaceCopilotAgentsForSource(source, agentRows)
    agentCount += agentRows.length
  }
  if (agentCount) onLog?.(`에이전트 ${agentCount}개 인벤토리화`)
  return { diagnostics: rows.length, agents: agentCount }
}
