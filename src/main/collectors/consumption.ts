/**
 * Power Platform Licensing / consumption collector — port of services/licensing.py.
 * Uses a licensing-audience bearer token captured from an interactive PPAC
 * sign-in (see portal.ts) to call the unofficial JSON endpoints, then upserts
 * point-in-time snapshots into power_platform_consumption.
 */
import { upsertConsumptionRows, type ConsumptionRow } from '../db'
import { httpRequest } from '../http'

const LICENSING_HOST = 'https://licensing.powerplatform.microsoft.com'

const CURRENCY_UNITS: Record<string, string> = {
  MCSMessages: 'messages',
  TenantM365Copilot: 'licenses',
  W365APAYGO: 'licenses'
}
const REPORT_UNITS: Record<string, string> = {
  MCSMessages: 'messages',
  AIByUserAndEnvironment: 'credits',
  ApiByLicensedUser: 'requests',
  ApiByNonLicensedUser: 'requests',
  ApiByFlow: 'requests'
}

type Dict = Record<string, unknown>

function today(): string {
  return new Date().toISOString().slice(0, 10)
}
function toFloat(value: unknown): number {
  if (value === null || value === undefined) return 0
  const s = String(value).trim().replace(/,/g, '')
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}
function datePart(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  if (!s) return null
  return s.split('T', 1)[0].trim() || null
}

async function getJson(token: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(LICENSING_HOST + path)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await httpRequest(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Licensing ${res.status} ${path} :: ${body.slice(0, 160)}`)
  }
  const text = await res.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Licensing ${path} :: expected JSON, got ${text.slice(0, 160)}`)
  }
}

function parseCurrencyReports(data: unknown, snapshotDate: string): ConsumptionRow[] {
  const items = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? (data as Dict).value
      : null
  if (!Array.isArray(items)) return []
  const rows: ConsumptionRow[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const it = item as Dict
    const currency = String(it.currencyType ?? '').trim()
    if (!currency) continue
    const unit = CURRENCY_UNITS[currency] ?? REPORT_UNITS[currency] ?? 'units'
    for (const field of ['purchased', 'allocated', 'consumed']) {
      const value = it[field]
      if (value === null || value === undefined) continue
      rows.push({
        report_type: currency,
        usage_date: snapshotDate,
        environment_id: null,
        environment_name: null,
        user_id: null,
        product: field,
        quantity: toFloat(value),
        unit,
        window_start: null,
        window_end: null,
        raw_json: JSON.stringify(it)
      })
    }
  }
  return rows
}

function parseMcsResourceRows(data: unknown, snapshotDate: string): ConsumptionRow[] {
  const groups = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const rows: ConsumptionRow[] = []
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue
    const resources = (group as Dict).resources
    if (!Array.isArray(resources)) continue
    for (const res of resources) {
      if (!res || typeof res !== 'object') continue
      const r = res as Dict
      const envRaw = r.environmentId
      const envId = envRaw ? String(envRaw).trim() || null : null
      const meta = r.metadata && typeof r.metadata === 'object' ? (r.metadata as Dict) : {}
      const name = String(meta.ResourceName ?? r.resourceId ?? '').trim() || null
      const unit = String(r.unit ?? '').trim().toLowerCase() || 'messages'
      const usageDate = datePart(r.asOfDate) || snapshotDate
      rows.push({
        report_type: 'MCSMessages:resource',
        usage_date: usageDate,
        environment_id: envId,
        environment_name: null,
        user_id: null,
        product: name,
        quantity: toFloat(r.consumed),
        unit,
        window_start: null,
        window_end: null,
        raw_json: JSON.stringify(r)
      })
    }
  }
  return rows
}

/** Fetch CurrencyReports + per-resource MCS consumption and upsert. */
export async function collectConsumption(
  token: string,
  tenantId: string,
  onLog?: (line: string) => void
): Promise<{ rows: number; errors: number }> {
  const snap = today()
  let total = 0
  let errors = 0

  try {
    const data = await getJson(token, `/v1.0/tenants/${tenantId}/CurrencyReports`, {
      includeAllocations: 'True',
      includeConsumptions: 'True'
    })
    const rows = parseCurrencyReports(data, snap)
    total += upsertConsumptionRows(rows)
    onLog?.(`통화 리포트 ${rows.length}행 수집`)
  } catch (e) {
    errors++
    onLog?.(`통화 리포트 오류: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const data = await getJson(token, `/v2.0/tenants/${tenantId}/entitlements/MCSMessages/resources`)
    const rows = parseMcsResourceRows(data, snap)
    total += upsertConsumptionRows(rows)
    onLog?.(`리소스별 메시지 소비 ${rows.length}행 수집`)
  } catch (e) {
    errors++
    onLog?.(`리소스 소비 오류: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { rows: total, errors }
}
