/**
 * Read-only data access over the Python app's per-profile SQLite store.
 *
 * Uses Electron's built-in `node:sqlite` (Node 22+/Electron 42) so there is
 * NO native module to compile or ship — important for portable builds.
 * Resolves the active profile from %LOCALAPPDATA%/CopilotWatchTower/profiles.json
 * and opens profiles/<active>/store.db read-only.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { TurnInput, ThreadGroup } from './threading'
import {
  conversationAgentFromRaw,
  matchAuditAgentsToThreads,
  type AuditAgentReference,
  type ConversationAgentIdentity,
  type InteractionAgentReference
} from './agentIdentity'

let db: DatabaseSync | null = null
let profileMeta: { name: string; tenant: string } | null = null
let currentPath: string | null = null

interface ProfileEntry {
  id: string
  name?: string
  tenant_domain?: string
}
interface Registry {
  active_profile_id?: string
  profiles?: ProfileEntry[]
}

function resolveDbPath(): string | null {
  const override = process.env.CWT_DB_PATH
  if (override && existsSync(override)) return override
  const root = join(process.env.LOCALAPPDATA || '', 'CopilotWatchTower')
  try {
    const reg = JSON.parse(readFileSync(join(root, 'profiles.json'), 'utf-8')) as Registry
    const active = reg.active_profile_id
    const p = reg.profiles?.find((x) => x.id === active)
    if (p) profileMeta = { name: p.name || 'profile', tenant: p.tenant_domain || '—' }
    if (active) {
      const dbp = join(root, 'profiles', active, 'store.db')
      if (existsSync(dbp)) return dbp
    }
  } catch {
    /* missing/corrupt registry — fall through to legacy */
  }
  const legacy = join(root, 'store.db')
  return existsSync(legacy) ? legacy : null
}

function ensureRuntimeSchema(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(audit_collection_state)').all() as Array<{ name: string }>
  if (columns.length && !columns.some((column) => column.name === 'coverage_start_at')) {
    database.exec('ALTER TABLE audit_collection_state ADD COLUMN coverage_start_at TEXT')
  }
  const threadColumns = database.prepare('PRAGMA table_info(conversation_threads)').all() as Array<{ name: string }>
  for (const [name, type] of [
    ['agent_key', 'TEXT'],
    ['agent_id', 'TEXT'],
    ['agent_name', 'TEXT']
  ]) {
    if (threadColumns.length && !threadColumns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE conversation_threads ADD COLUMN ${name} ${type}`)
    }
  }
  database.exec(
    'CREATE INDEX IF NOT EXISTS ix_threads_source_agent_time ON conversation_threads(source_type, agent_key, started_at DESC)'
  )
  database.exec(
    'CREATE INDEX IF NOT EXISTS ix_threads_source_agent_user_time ON conversation_threads(source_type, agent_key, user_id, started_at DESC)'
  )
}

export function openDb(): boolean {
  if (db) return true
  const path = resolveDbPath()
  if (!path) return false
  try {
    db = new DatabaseSync(path, { readOnly: false })
    ensureRuntimeSchema(db)
    currentPath = path
    if (getSettingText('thread_agent_attribution_v1') !== '1') {
      refreshConversationAgentAttribution()
      setSettingText('thread_agent_attribution_v1', '1')
    }
    return true
  } catch {
    db = null
    return false
  }
}

export function dbReady(): boolean {
  return db !== null
}

export function reopen(): boolean {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
  profileMeta = null
  return openDb()
}

// ---- DB management (backup / restore / export) --------------------------
export const EXPORTABLE_TABLES = [
  'interactions',
  'conversation_threads',
  'audit_events',
  'copilot_usage_snapshots',
  'power_platform_consumption',
  'copilot_agents',
  'copilot_admin_diagnostics',
  'users'
] as const

export function currentDbPath(): string | null {
  return currentPath
}
export function dbStat(): { path: string | null; tables: Array<{ name: string; rows: number }> } {
  const tables = EXPORTABLE_TABLES.map((name) => ({
    name,
    rows: get<{ n: number }>(`SELECT COUNT(*) n FROM ${name}`)?.n ?? 0
  }))
  return { path: currentPath, tables }
}

// Data tables cleared by wipeData(). Excludes `settings` (DPAPI credentials),
// `credit_alert_rules` (user config), and `schema_version` so the profile stays
// configured and only collected data is erased.
const WIPEABLE_TABLES = [
  'interactions',
  'conversation_threads',
  'audit_events',
  'audit_collection_state',
  'copilot_usage_snapshots',
  'copilot_usage_user_counts',
  'copilot_admin_diagnostics',
  'copilot_agents',
  'power_platform_consumption',
  'flow_runs',
  'agent_definitions',
  'credit_alerts',
  'ediscovery_jobs',
  'collection_run_logs',
  'collection_state',
  'collection_runs',
  'users'
] as const

/**
 * Erase all collected data while keeping credentials/settings and alert rules.
 * Mirrors the legacy `wipe_collected_data`: deletes every data table, rebuilds
 * the FTS index, and VACUUMs to reclaim space. Returns deleted rows per table.
 */
export function wipeData(): { ok: boolean; deleted: number; counts: Record<string, number>; error?: string } {
  if (!db) return { ok: false, deleted: 0, counts: {}, error: 'no-db' }
  const counts: Record<string, number> = {}
  let total = 0
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const table of WIPEABLE_TABLES) {
      try {
        const n = get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)?.n ?? 0
        db.exec(`DELETE FROM ${table}`)
        counts[table] = n
        total += n
      } catch {
        /* table may not exist on older installs — skip */
      }
    }
    try {
      db.exec("INSERT INTO interactions_fts(interactions_fts) VALUES('rebuild')")
    } catch {
      /* FTS5 may be unavailable — ignore */
    }
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, deleted: 0, counts: {}, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    db.exec('VACUUM')
  } catch {
    /* db busy — data already deleted, skip reclaim */
  }
  return { ok: true, deleted: total, counts }
}
export function checkpoint(): void {
  if (!db) return
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
}
export function closeDb(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}
export function exportTableRows(table: string): Record<string, unknown>[] {
  if (!(EXPORTABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`table not allowed: ${table}`)
  }
  return all<Record<string, unknown>>(`SELECT * FROM ${table}`)
}

function all<T>(sql: string, ...params: Array<string | number>): T[] {
  if (!db) return []
  return db.prepare(sql).all(...params) as T[]
}
function get<T>(sql: string, ...params: Array<string | number>): T | undefined {
  if (!db) return undefined
  return db.prepare(sql).get(...params) as T | undefined
}

// ---- formatting helpers --------------------------------------------------
const APP_PREFIX = /^IPM\.SkypeTeams\.Message\.Copilot\./
const APP_MAP: Record<string, string> = {
  BizChat: 'Teams: BizChat',
  WebChat: 'Teams: WebChat',
  ProactiveChat: 'Teams: 프로액티브',
  ThirdPartyCopilot: '서드파티 Copilot',
  Word: 'Word',
  Forms: 'Forms',
  SharePoint: 'SharePoint',
  Excel: 'Excel',
  PowerPoint: 'PowerPoint'
}

function friendlyApp(app: string | null): string {
  if (!app) return '—'
  const s = app.replace(APP_PREFIX, '')
  return APP_MAP[s] || s
}

function shortTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = d.getMonth() + 1
  const dd = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

function cleanBody(text: string | null): string {
  if (!text) return ''
  let s = text
  s = s.replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  // Strip serializer artifacts: "[AutoGenerated]undefined" / leftover markers.
  s = s.replace(/\[AutoGenerated\]\s*undefined/gi, ' ')
  s = s.replace(/\[AutoGenerated\]/gi, ' ')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return s.length > 4000 ? s.slice(0, 4000) + '…' : s
}

// ---- queries -------------------------------------------------------------
export function systemInfo(): { app: string; profile: string; tenant: string; version: string } {
  return {
    app: 'CopilotWatchTower',
    profile: profileMeta?.name ?? 'profile',
    tenant: profileMeta?.tenant ?? '—',
    version: '2.2.0'
  }
}

export interface DashboardDTO {
  interactions: number
  activeUsers: number
  usersTotal: number
  licensedUsers: number
  inactiveLicensed: number
  adoptionRate: number
  threads: number
  prompts: number
  sessions: number
  riskSignals: number
  agents: number
  creditsUsed: number
  creditsTotal: number
  trend: Array<{ day: string; messages: number; threads: number; prompts: number }>
  topUsers: Array<{ user: string; count: number; share: number }>
  appBreakdown: Array<{ app: string; count: number; share: number }>
}
export function dashboardSummary(): DashboardDTO {
  const interactions = get<{ n: number }>('SELECT COUNT(*) n FROM interactions')?.n ?? 0
  const activeUsers =
    get<{ n: number }>('SELECT COUNT(DISTINCT user_id) n FROM interactions WHERE user_id IS NOT NULL')?.n ?? 0
  const usersTotal = get<{ n: number }>('SELECT COUNT(*) n FROM users')?.n ?? 0
  const licensedUsers = get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE has_copilot_license=1')?.n ?? 0
  const activeLicensed =
    get<{ n: number }>(
      'SELECT COUNT(*) n FROM users u WHERE u.has_copilot_license=1 AND EXISTS (SELECT 1 FROM interactions i WHERE i.user_id = u.id)'
    )?.n ?? 0
  const inactiveLicensed = Math.max(0, licensedUsers - activeLicensed)
  const adoptionRate = licensedUsers > 0 ? activeLicensed / licensedUsers : 0
  const threads = get<{ n: number }>('SELECT COUNT(*) n FROM conversation_threads')?.n ?? 0
  const prompts =
    get<{ n: number }>("SELECT COUNT(*) n FROM interactions WHERE interaction_type='userPrompt'")?.n ?? 0
  const sessions =
    get<{ n: number }>('SELECT COUNT(DISTINCT session_id) n FROM interactions WHERE session_id IS NOT NULL')?.n ?? 0
  const riskSignals =
    get<{ n: number }>(
      "SELECT COUNT(*) n FROM audit_events WHERE LOWER(COALESCE(result,'')) LIKE '%denied%' OR LOWER(COALESCE(result,'')) LIKE '%blocked%' OR LOWER(COALESCE(result,'')) = 'failure'"
    )?.n ?? 0
  const agents = get<{ n: number }>('SELECT COUNT(*) n FROM copilot_agents')?.n ?? 0
  // Real credits from the same source as the Credits page (no more placeholder).
  const creditsTotal =
    get<{ q: number }>(
      "SELECT COALESCE(SUM(quantity),0) q FROM power_platform_consumption WHERE product='purchased' AND unit='messages'"
    )?.q ?? 0
  const creditsUsed =
    get<{ q: number }>("SELECT COALESCE(SUM(quantity),0) q FROM power_platform_consumption WHERE report_type='MCSMessages:user'")?.q ?? 0
  // Daily trend (last 15 days): messages (turns), prompts, threads.
  const msgRows = all<{ d: string; c: number; p: number }>(
    "SELECT substr(created_at,1,10) d, COUNT(*) c, SUM(CASE WHEN interaction_type='userPrompt' THEN 1 ELSE 0 END) p FROM interactions GROUP BY d ORDER BY d DESC LIMIT 15"
  )
  const thrRows = all<{ d: string; c: number }>(
    'SELECT substr(started_at,1,10) d, COUNT(*) c FROM conversation_threads GROUP BY d'
  )
  const thrByDay = new Map(thrRows.map((r) => [r.d, r.c]))
  const trend = msgRows
    .map((r) => ({ day: r.d, messages: r.c, prompts: r.p, threads: thrByDay.get(r.d) ?? 0 }))
    .reverse()
  // Top users by interaction count.
  const topRows = all<{ user_id: string; who: string | null; c: number }>(
    `SELECT i.user_id, COALESCE(u.display_name, u.upn, i.user_id) who, COUNT(*) c
     FROM interactions i LEFT JOIN users u ON u.id = i.user_id
     WHERE i.user_id IS NOT NULL GROUP BY i.user_id ORDER BY c DESC LIMIT 5`
  )
  const topMax = Math.max(1, ...topRows.map((r) => r.c))
  const topUsers = topRows.map((r) => ({
    user: r.who || r.user_id,
    count: r.c,
    share: Math.round((r.c / topMax) * 100)
  }))
  // App usage breakdown — merge raw app ids that share a friendly label.
  const appRowsRaw = all<{ app: string | null; c: number }>(
    'SELECT app, COUNT(*) c FROM interactions GROUP BY app'
  )
  const appMerged = new Map<string, number>()
  for (const r of appRowsRaw) {
    const label = friendlyApp(r.app)
    appMerged.set(label, (appMerged.get(label) ?? 0) + r.c)
  }
  const appSorted = [...appMerged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const appMax = Math.max(1, ...appSorted.map(([, c]) => c))
  const appBreakdown = appSorted.map(([app, c]) => ({
    app,
    count: c,
    share: Math.round((c / appMax) * 100)
  }))
  return {
    interactions,
    activeUsers,
    usersTotal,
    licensedUsers,
    inactiveLicensed,
    adoptionRate,
    threads,
    prompts,
    sessions,
    riskSignals,
    agents,
    creditsUsed: Math.round(creditsUsed),
    creditsTotal: Math.round(creditsTotal),
    trend,
    topUsers,
    appBreakdown
  }
}

// ---- Insights analytics --------------------------------------------------
export interface InsightsFilters {
  source?: string
  dateFrom?: string
  dateTo?: string
  userId?: string
  app?: string
}
export interface InsightsUserRow {
  userId: string
  name: string
  upn: string | null
  activeDays: number
  threads: number
  messages: number
  prompts: number
  responses: number
  apps: number
  topApp: string
  lastActivity: string
}
export interface InsightsDTO {
  kpis: {
    activeUsers: number
    totalUsers: number
    threads: number
    messages: number
    prompts: number
    topApp: string | null
    topAppMessages: number
  }
  trend: Array<{ day: string; messages: number; threads: number }>
  apps: Array<{ label: string; messages: number; share: number }>
  users: InsightsUserRow[]
}

function interactionWhere(f: InsightsFilters): { where: string; params: Array<string | number> } {
  const clauses = ['i.source_type = ?']
  const params: Array<string | number> = [f.source || 'api']
  if (f.userId) {
    clauses.push('i.user_id = ?')
    params.push(f.userId)
  }
  if (f.app) {
    clauses.push('i.app = ?')
    params.push(f.app)
  }
  if (f.dateFrom) {
    clauses.push('i.created_at >= ?')
    params.push(f.dateFrom)
  }
  if (f.dateTo) {
    clauses.push('i.created_at <= ?')
    params.push(`${f.dateTo}T23:59:59Z`)
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params }
}

export function insightsData(f: InsightsFilters): InsightsDTO {
  const { where, params } = interactionWhere(f)
  const base = all<{
    uid: string
    name: string | null
    upn: string | null
    active_days: number
    messages: number
    prompts: number
    responses: number
    last_activity: string
  }>(
    `SELECT i.user_id uid, COALESCE(u.display_name,u.upn,i.user_id) name, u.upn upn,
       COUNT(DISTINCT substr(i.created_at,1,10)) active_days,
       COUNT(*) messages,
       SUM(CASE WHEN i.interaction_type='userPrompt' THEN 1 ELSE 0 END) prompts,
       SUM(CASE WHEN i.interaction_type='aiResponse' THEN 1 ELSE 0 END) responses,
       MAX(i.created_at) last_activity
     FROM interactions i LEFT JOIN users u ON u.id=i.user_id
     ${where} AND i.user_id IS NOT NULL GROUP BY i.user_id`,
    ...params
  )
  // Per-user-app counts → top app + distinct app count (merged by friendly label).
  const uaRows = all<{ uid: string; app: string | null; c: number }>(
    `SELECT i.user_id uid, i.app app, COUNT(*) c FROM interactions i ${where} AND i.user_id IS NOT NULL GROUP BY i.user_id, i.app`,
    ...params
  )
  const userAppTop = new Map<string, { label: string; c: number }>()
  const userAppSet = new Map<string, Set<string>>()
  for (const r of uaRows) {
    const label = friendlyApp(r.app)
    const top = userAppTop.get(r.uid)
    if (!top || r.c > top.c) userAppTop.set(r.uid, { label, c: r.c })
    let set = userAppSet.get(r.uid)
    if (!set) {
      set = new Set()
      userAppSet.set(r.uid, set)
    }
    set.add(label)
  }
  // Threads per user (filtered by source + user + date on started_at).
  const tClauses = ['t.source_type = ?']
  const tParams: Array<string | number> = [f.source || 'api']
  if (f.userId) {
    tClauses.push('t.user_id = ?')
    tParams.push(f.userId)
  }
  if (f.dateFrom) {
    tClauses.push('t.started_at >= ?')
    tParams.push(f.dateFrom)
  }
  if (f.dateTo) {
    tClauses.push('t.started_at <= ?')
    tParams.push(`${f.dateTo}T23:59:59Z`)
  }
  const tWhere = `WHERE ${tClauses.join(' AND ')}`
  const threadRows = all<{ uid: string; c: number }>(
    `SELECT user_id uid, COUNT(*) c FROM conversation_threads t ${tWhere} AND user_id IS NOT NULL GROUP BY user_id`,
    ...tParams
  )
  const threadsByUser = new Map(threadRows.map((r) => [r.uid, r.c]))
  const users: InsightsUserRow[] = base
    .map((r) => ({
      userId: r.uid,
      name: r.name || r.uid,
      upn: r.upn,
      activeDays: r.active_days,
      threads: threadsByUser.get(r.uid) ?? 0,
      messages: r.messages,
      prompts: r.prompts,
      responses: r.responses,
      apps: userAppSet.get(r.uid)?.size ?? 0,
      topApp: userAppTop.get(r.uid)?.label ?? '—',
      lastActivity: r.last_activity
    }))
    .sort((a, b) => b.messages - a.messages)
  // Daily trend (messages + threads).
  const dayMsg = all<{ day: string; messages: number }>(
    `SELECT substr(i.created_at,1,10) day, COUNT(*) messages FROM interactions i ${where} GROUP BY day`,
    ...params
  )
  const dayThread = all<{ day: string; c: number }>(
    `SELECT substr(started_at,1,10) day, COUNT(*) c FROM conversation_threads t ${tWhere} GROUP BY day`,
    ...tParams
  )
  const tByDay = new Map(dayThread.map((r) => [r.day, r.c]))
  const trend = dayMsg
    .map((r) => ({ day: r.day, messages: r.messages, threads: tByDay.get(r.day) ?? 0 }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  // App distribution (merged by friendly label).
  const appRaw = all<{ app: string | null; c: number }>(
    `SELECT i.app app, COUNT(*) c FROM interactions i ${where} GROUP BY i.app`,
    ...params
  )
  const appMerged = new Map<string, number>()
  for (const r of appRaw) {
    const label = friendlyApp(r.app)
    appMerged.set(label, (appMerged.get(label) ?? 0) + r.c)
  }
  const appSorted = [...appMerged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const appMax = Math.max(1, ...appSorted.map(([, c]) => c))
  const apps = appSorted.map(([label, c]) => ({ label, messages: c, share: Math.round((c / appMax) * 100) }))
  const messages = users.reduce((sum, u) => sum + u.messages, 0)
  const prompts = users.reduce((sum, u) => sum + u.prompts, 0)
  const threads = users.reduce((sum, u) => sum + u.threads, 0)
  const totalUsers = get<{ n: number }>('SELECT COUNT(*) n FROM users')?.n ?? users.length
  const topAppEntry = appSorted[0]
  return {
    kpis: {
      activeUsers: users.length,
      totalUsers,
      threads,
      messages,
      prompts,
      topApp: topAppEntry?.[0] ?? null,
      topAppMessages: topAppEntry?.[1] ?? 0
    },
    trend,
    apps,
    users
  }
}

export function insightsUsers(source?: string): Array<{ id: string; name: string }> {
  return all<{ id: string; name: string | null }>(
    `SELECT DISTINCT i.user_id id, COALESCE(u.display_name,u.upn,i.user_id) name
     FROM interactions i LEFT JOIN users u ON u.id=i.user_id
     WHERE i.source_type=? AND i.user_id IS NOT NULL ORDER BY name COLLATE NOCASE`,
    source || 'api'
  ).map((r) => ({ id: r.id, name: r.name || r.id }))
}

export function insightsApps(source?: string): Array<{ value: string; label: string }> {
  return all<{ app: string }>(
    "SELECT DISTINCT app FROM interactions WHERE source_type=? AND app IS NOT NULL AND app<>'' ORDER BY app",
    source || 'api'
  ).map((r) => ({ value: r.app, label: friendlyApp(r.app) }))
}

interface ThreadRow {
  id: string
  user_id: string
  title: string | null
  app: string | null
  started_at: string
  who: string | null
  source_type: string
  agent_key: string | null
  agent_id: string | null
  agent_name: string | null
}
export interface ConversationDTO {
  id: string
  userId: string
  user: string
  title: string
  app: string
  agent?: string
  agentId?: string
  agentKey?: string
  when: string
  tone: string
}
export interface ConvFilters {
  source?: string
  limit?: number
  offset?: number
  dateFrom?: string
  dateTo?: string
  search?: string
  scope?: 'all' | 'title' | 'body'
  agentKey?: string
  userId?: string
  app?: string
}
export const UNKNOWN_CONVERSATION_AGENT_KEY = '__unknown__'
/** True when a label is just a raw conversation/GUID id (no human name). */
function looksLikeId(s: string | null): boolean {
  return !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
}

interface ThreadAgentRow {
  id: string
  source_type: string
  agent_key: string | null
  agent_id: string | null
  agent_name: string | null
}

function enrichApiAgents(rows: ThreadAgentRow[], agentByThread: Map<string, ConversationAgentIdentity>): void {
  const apiThreadIds = rows.filter((row) => row.source_type === 'api').map((row) => row.id)
  if (!apiThreadIds.length) return

  const interactions: InteractionAgentReference[] = []
  for (let offset = 0; offset < apiThreadIds.length; offset += 500) {
    const chunk = apiThreadIds.slice(offset, offset + 500)
    const ph = chunk.map(() => '?').join(',')
    const refs = all<{
      id: string
      request_id: string | null
      thread_id: string
      session_id: string | null
      created_at: string
      user_id: string
      upn: string | null
    }>(
      `SELECT i.id, i.request_id, i.thread_id, i.session_id, i.created_at, i.user_id, u.upn
       FROM interactions i LEFT JOIN users u ON u.id = i.user_id
       WHERE i.thread_id IN (${ph}) AND i.source_type = 'api'`,
      ...chunk
    )
    interactions.push(
      ...refs.map((ref) => ({
        id: ref.id,
        requestId: ref.request_id,
        threadId: ref.thread_id,
        sessionId: ref.session_id,
        createdAt: ref.created_at,
        userKeys: [ref.user_id, ref.upn ?? '']
      }))
    )
  }
  if (!interactions.length) return

  const timestamps = interactions.map((row) => Date.parse(row.createdAt)).filter((value) => !Number.isNaN(value))
  if (!timestamps.length) return
  const windowStart = new Date(Math.min(...timestamps) - 180_000).toISOString()
  const windowEnd = new Date(Math.max(...timestamps) + 180_000).toISOString()
  const auditEvents = all<{
    event_time: string
    user_id: string | null
    upn: string | null
    raw_json: string | null
  }>(
    `SELECT event_time, user_id, upn, raw_json FROM audit_events
     WHERE source = 'purview' AND LOWER(COALESCE(operation,'')) = 'copilotinteraction'
       AND event_time >= ? AND event_time <= ?
     ORDER BY event_time ASC`,
    windowStart,
    windowEnd
  ).map<AuditAgentReference>((event) => ({
    eventTime: event.event_time,
    userKeys: [event.user_id ?? '', event.upn ?? ''],
    rawJson: event.raw_json
  }))
  if (!auditEvents.length) return

  const matched = matchAuditAgentsToThreads(interactions, auditEvents)
  if (!matched.size) return
  const inventoryNames = new Map<string, string>()
  for (const agent of all<{
    id: string
    display_name: string | null
    app_identity: string | null
    app_external_id: string | null
    add_on_guid: string | null
  }>('SELECT id, display_name, app_identity, app_external_id, add_on_guid FROM copilot_agents')) {
    if (!agent.display_name) continue
    for (const value of [agent.id, agent.app_identity, agent.app_external_id, agent.add_on_guid]) {
      if (value) inventoryNames.set(value.toLowerCase(), agent.display_name)
    }
  }
  for (const [threadId, agent] of matched) {
    agentByThread.set(threadId, {
      ...agent,
      name: agent.name || inventoryNames.get(agent.id.toLowerCase()) || null
    })
  }
}

function resolveThreadAgents(rows: ThreadAgentRow[]): Map<string, ConversationAgentIdentity> {
  const agentByThread = new Map<string, ConversationAgentIdentity>()
  const ids = rows.map((row) => row.id)
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500)
    const ph = chunk.map(() => '?').join(',')
    const botRows = all<{ thread_id: string; source_type: string; raw_json: string | null }>(
      `SELECT thread_id, source_type, raw_json FROM interactions
       WHERE thread_id IN (${ph}) AND interaction_type = 'aiResponse' AND raw_json IS NOT NULL
       ORDER BY created_at ASC`,
      ...chunk
    )
    for (const botRow of botRows) {
      if (!botRow.thread_id || agentByThread.has(botRow.thread_id)) continue
      const agent = conversationAgentFromRaw(botRow.raw_json, botRow.source_type)
      if (agent) agentByThread.set(botRow.thread_id, agent)
    }
  }
  enrichApiAgents(rows, agentByThread)
  return agentByThread
}

export function refreshConversationAgentAttribution(sourceType?: string, userId?: string): number {
  if (!db) return 0
  const clauses: string[] = []
  const params: string[] = []
  if (sourceType) {
    clauses.push('source_type = ?')
    params.push(sourceType)
  }
  if (userId) {
    clauses.push('user_id = ?')
    params.push(userId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = all<ThreadAgentRow>(
    `SELECT id, source_type, agent_key, agent_id, agent_name FROM conversation_threads ${where}`,
    ...params
  )
  if (!rows.length) return 0
  const resolved = resolveThreadAgents(rows)
  const update = db.prepare('UPDATE conversation_threads SET agent_key=?, agent_id=?, agent_name=? WHERE id=?')
  let changed = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      const agent = resolved.get(row.id)
      const key = agent?.key ?? null
      const id = agent?.id ?? null
      const name = agent?.name ?? null
      if (row.agent_key === key && row.agent_id === id && row.agent_name === name) continue
      update.run(key, id, name, row.id)
      changed++
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return changed
}

function conversationWhere(f: ConvFilters): { where: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (f.source) {
    clauses.push('t.source_type = ?')
    params.push(f.source)
  }
  if (f.userId) {
    clauses.push('t.user_id = ?')
    params.push(f.userId)
  }
  if (f.agentKey === UNKNOWN_CONVERSATION_AGENT_KEY) {
    clauses.push('t.agent_key IS NULL')
  } else if (f.agentKey) {
    clauses.push('t.agent_key = ?')
    params.push(f.agentKey)
  }
  if (f.app) {
    clauses.push('t.app = ?')
    params.push(f.app)
  }
  if (f.dateFrom) {
    clauses.push('t.started_at >= ?')
    params.push(f.dateFrom)
  }
  if (f.dateTo) {
    clauses.push('t.started_at <= ?')
    params.push(`${f.dateTo}T23:59:59Z`)
  }
  if (f.search && f.search.trim()) {
    const needle = `%${f.search.trim().toLowerCase()}%`
    const bodyExists = 'EXISTS (SELECT 1 FROM interactions i WHERE i.thread_id = t.id AND LOWER(i.body_text) LIKE ?)'
    if (f.scope === 'title') {
      clauses.push('LOWER(t.title) LIKE ?')
      params.push(needle)
    } else if (f.scope === 'body') {
      clauses.push(bodyExists)
      params.push(needle)
    } else {
      clauses.push(`(LOWER(t.title) LIKE ? OR ${bodyExists})`)
      params.push(needle, needle)
    }
  }
  // Hide eDiscovery threads whose messages are ALL streaming/system noise
  // (placeholder / [] / unnamed file stubs). Other sources are untouched.
  clauses.push(
    `(t.source_type <> 'ediscovery' OR EXISTS (
       SELECT 1 FROM interactions i WHERE i.thread_id = t.id
         AND trim(COALESCE(i.body_text,'')) NOT IN ('placeholder','[]','')
         AND trim(REPLACE(COALESCE(i.body_text,''),'unknown-file-name','')) <> ''
     ))`
  )
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export interface ConversationFacetDTO {
  key: string
  name: string
  count: number
}

export interface ConversationPageDTO {
  rows: ConversationDTO[]
  total: number
  limit: number
  offset: number
}

export function conversationAgentFacets(f: ConvFilters): ConversationFacetDTO[] {
  const { where, params } = conversationWhere({ ...f, agentKey: undefined, userId: undefined })
  return all<{ facet_key: string; name: string | null; count: number }>(
    `SELECT COALESCE(t.agent_key, ?) facet_key,
            MAX(COALESCE(NULLIF(t.agent_name,''), NULLIF(t.agent_id,''), '')) name,
            COUNT(*) count
     FROM conversation_threads t
     ${where}
     GROUP BY t.agent_key
     ORDER BY count DESC, name COLLATE NOCASE`,
    UNKNOWN_CONVERSATION_AGENT_KEY,
    ...params
  ).map((row) => ({ key: row.facet_key, name: row.name || '', count: Number(row.count) }))
}

export function conversationUserFacets(f: ConvFilters): ConversationFacetDTO[] {
  const { where, params } = conversationWhere({ ...f, userId: undefined })
  return all<{ facet_key: string; name: string | null; count: number }>(
    `SELECT t.user_id facet_key,
            COALESCE(NULLIF(NULLIF(u.display_name,''), t.user_id), NULLIF(g.display_name,''), NULLIF(g.upn,''),
                     REPLACE(t.user_id,'dataverse:','')) name,
            COUNT(*) count
     FROM conversation_threads t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN users g ON g.id = REPLACE(t.user_id,'dataverse:','')
     ${where}
     GROUP BY t.user_id, name
     ORDER BY count DESC, name COLLATE NOCASE`,
    ...params
  ).map((row) => ({ key: row.facet_key, name: row.name || row.facet_key, count: Number(row.count) }))
}

export function conversationCount(f: ConvFilters): number {
  const { where, params } = conversationWhere(f)
  return get<{ count: number }>(`SELECT COUNT(*) count FROM conversation_threads t ${where}`, ...params)?.count ?? 0
}

export function conversationPage(f: ConvFilters): ConversationPageDTO {
  const limit = Math.max(1, Math.min(100, f.limit ?? 50))
  const offset = Math.max(0, f.offset ?? 0)
  return {
    rows: conversations({ ...f, limit, offset }),
    total: conversationCount(f),
    limit,
    offset
  }
}

export function conversations(arg: number | ConvFilters, source?: string): ConversationDTO[] {
  // Back-compat: conversations(limit, source?) or conversations({...filters}).
  const f: ConvFilters = typeof arg === 'number' ? { limit: arg, source } : arg
  const { where, params } = conversationWhere(f)
  const limit = Math.max(1, Math.min(2000, f.limit ?? 500))
  const offset = Math.max(0, f.offset ?? 0)
  const rows = all<ThreadRow>(
    `SELECT t.id, t.user_id, t.title, t.app, t.started_at, t.source_type,
            t.agent_key, t.agent_id, t.agent_name,
            COALESCE(NULLIF(NULLIF(u.display_name,''), t.user_id), NULLIF(g.display_name,''), NULLIF(g.upn,''),
                     REPLACE(t.user_id,'dataverse:','')) AS who
     FROM conversation_threads t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN users g ON g.id = REPLACE(t.user_id,'dataverse:','')
     ${where}
     ORDER BY t.started_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  )
  return rows.map((r) => {
    return {
      id: r.id,
      userId: r.user_id,
      // Teams/Dataverse threads often have no resolved person — `who` is then the
      // raw conversation GUID, which is noise. Drop it so the UI leans on the
      // topic + agent instead.
      user: looksLikeId(r.who) ? '' : r.who || '',
      title: (cleanBody(r.title).replace(/[<>]/g, '').trim() || '(제목 없음)').slice(0, 90),
      app: friendlyApp(r.app),
      agent: r.agent_name || r.agent_id || undefined,
      agentId: r.agent_id || undefined,
      agentKey: r.agent_key || undefined,
      when: shortTime(r.started_at),
      tone: 'muted'
    }
  })
}

export function conversationUsers(source: string): Array<{ id: string; name: string }> {
  return all<{ id: string; name: string | null }>(
    `SELECT DISTINCT t.user_id AS id,
            COALESCE(NULLIF(NULLIF(u.display_name,''), t.user_id), NULLIF(g.display_name,''), NULLIF(g.upn,''), REPLACE(t.user_id,'dataverse:','')) AS name
     FROM conversation_threads t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN users g ON g.id = REPLACE(t.user_id,'dataverse:','')
     WHERE t.source_type = ? ORDER BY name COLLATE NOCASE`,
    source
  ).map((r) => ({ id: r.id, name: r.name || r.id }))
}

export function conversationApps(source: string): Array<{ value: string; label: string }> {
  return all<{ app: string }>(
    "SELECT DISTINCT app FROM conversation_threads WHERE source_type = ? AND app IS NOT NULL AND app <> '' ORDER BY app",
    source
  ).map((r) => ({ value: r.app, label: friendlyApp(r.app) }))
}

interface TurnRow {
  interaction_type: string | null
  body_text: string | null
  attachments_json: string | null
  raw_json: string | null
}

function parseJsonish(value: unknown): unknown {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
// Pull readable text out of an Adaptive Card (or any nested card JSON).
function extractCardText(node: unknown, lines: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) extractCardText(item, lines)
    return
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (typeof o.text === 'string' && o.text.trim()) lines.push(o.text.trim())
    if (typeof o.title === 'string' && typeof o.value === 'string') {
      lines.push(`${o.title.trim()}: ${o.value.trim()}`)
    }
    for (const key of ['body', 'items', 'columns', 'facts']) {
      if (o[key] != null) extractCardText(o[key], lines)
    }
  }
}
// Copilot's final answer / citations usually live in attachments, not body_text.
function attachmentTexts(attachmentsJson: string | null, rawJson: string | null): string[] {
  let attachments: unknown[] = []
  const a = parseJsonish(attachmentsJson)
  if (Array.isArray(a)) attachments = a
  else if (a && typeof a === 'object' && Array.isArray((a as { attachments?: unknown }).attachments)) {
    attachments = (a as { attachments: unknown[] }).attachments
  } else {
    const raw = parseJsonish(rawJson)
    if (raw && typeof raw === 'object' && Array.isArray((raw as { attachments?: unknown }).attachments)) {
      attachments = (raw as { attachments: unknown[] }).attachments
    }
  }
  const texts: string[] = []
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue
    const content = (att as Record<string, unknown>).content
    const parsed = parseJsonish(content)
    if (parsed == null) {
      if (typeof content === 'string' && content.trim() && !content.trim().startsWith('{')) {
        texts.push(content.trim())
      }
      continue
    }
    const lines: string[] = []
    extractCardText(parsed, lines)
    const text = [...new Set(lines)].join('\n')
    if (text) texts.push(text)
  }
  return texts
}
// Full displayable text for one interaction: cleaned body + attachment cards.
function interactionDisplayText(
  bodyText: string | null,
  attachmentsJson: string | null,
  rawJson: string | null
): string {
  const parts: string[] = []
  const body = cleanBody(bodyText)
  if (body) parts.push(body)
  for (const t of attachmentTexts(attachmentsJson, rawJson)) {
    if (t && !parts.includes(t)) parts.push(t)
  }
  return parts.join('\n\n').trim()
}

// Streaming/system artifacts with no real content: Copilot Studio agents emit a
// "placeholder" message while streaming a reply, plus empty "[]" bodies and
// unnamed file stubs ("unknown-file-name"). Kept in the DB but hidden from the
// conversation view (the final edited text is not in the eDiscovery export).
function isNoiseText(text: string): boolean {
  const t = text.trim()
  if (!t || t === 'placeholder' || t === '[]') return true
  if (t.replace(/unknown-file-name/gi, '').trim() === '') return true
  return false
}

export function conversationThread(threadId: string): Array<{ role: string; text: string; raw: string }> {
  const rows = all<TurnRow>(
    'SELECT interaction_type, body_text, attachments_json, raw_json FROM interactions WHERE thread_id = ? ORDER BY created_at ASC',
    threadId
  )
  return rows
    .map((r) => {
      const role = r.interaction_type === 'userPrompt' ? 'user' : 'bot'
      let text = interactionDisplayText(r.body_text, r.attachments_json, r.raw_json)
      // Proactive Copilot triggers (e.g. ProactiveDocumentSummaryGlance) have an
      // [AutoGenerated]undefined prompt with no typed text. Show a label so the
      // user turn stays visible instead of looking like an AI-only reply.
      if (!text && role === 'user' && /\[AutoGenerated\]/i.test(r.body_text ?? '')) {
        text = '(자동 생성된 요청)'
      }
      return { role, text, raw: r.raw_json ?? '' }
    })
    .filter((t) => t.text && !isNoiseText(t.text))
}

interface AgentRow {
  name: string
  env: string
  credits: number
  share: number
}
export function topAgents(limit: number): AgentRow[] {
  // copilot_agents is empty in current data → returns [] so the caller falls back to mock.
  return all<AgentRow>(
    `SELECT display_name AS name, COALESCE(last_activity_source, '—') AS env,
            usage_event_count AS credits, 0 AS share
     FROM copilot_agents
     ORDER BY usage_event_count DESC
     LIMIT ?`,
    limit
  )
}

// ---- Agents overview + identity events ----------------------------------
export interface AgentFilters {
  thresholdDays?: number
  staleOnly?: boolean
  search?: string
}
export interface AgentOverviewRow {
  id: string
  displayName: string
  source: string
  state: 'active' | 'stale' | 'never_used'
  usageEvents: number
  daysInactive: number | null
  lastActivity: string | null
  appIdentity: string | null
}
export interface AgentsDTO {
  kpis: { total: number; active: number; stale: number; neverUsed: number; usageEvents: number; thresholdDays: number }
  agents: AgentOverviewRow[]
}
export function agentsOverview(f: AgentFilters): AgentsDTO {
  const threshold = f.thresholdDays && f.thresholdDays > 0 ? f.thresholdDays : 30
  const rows = all<{
    id: string
    display_name: string | null
    source: string | null
    usage_event_count: number | null
    last_activity_at: string | null
    app_identity: string | null
    app_external_id: string | null
  }>(
    `SELECT id, display_name, source, usage_event_count, last_activity_at, app_identity, app_external_id
     FROM copilot_agents`
  )
  const now = Date.now()
  const classified: AgentOverviewRow[] = rows.map((r) => {
    const last = r.last_activity_at ? new Date(r.last_activity_at).getTime() : NaN
    const daysInactive = Number.isNaN(last) ? null : Math.floor((now - last) / 86400000)
    let state: 'active' | 'stale' | 'never_used'
    if (daysInactive == null) state = 'never_used'
    else if (daysInactive <= threshold) state = 'active'
    else state = 'stale'
    return {
      id: r.id,
      displayName: r.display_name || r.id,
      source: (r.source || '').replace('_', ' '),
      state,
      usageEvents: r.usage_event_count ?? 0,
      daysInactive,
      lastActivity: r.last_activity_at,
      appIdentity: r.app_identity || r.app_external_id
    }
  })
  const kpis = {
    total: classified.length,
    active: classified.filter((a) => a.state === 'active').length,
    stale: classified.filter((a) => a.state === 'stale').length,
    neverUsed: classified.filter((a) => a.state === 'never_used').length,
    usageEvents: classified.reduce((sum, a) => sum + a.usageEvents, 0),
    thresholdDays: threshold
  }
  let agents = classified
  const search = f.search?.trim().toLowerCase()
  if (search)
    agents = agents.filter(
      (a) =>
        a.displayName.toLowerCase().includes(search) ||
        a.id.toLowerCase().includes(search) ||
        (a.appIdentity ?? '').toLowerCase().includes(search)
    )
  if (f.staleOnly) agents = agents.filter((a) => a.state !== 'active')
  agents = [...agents].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
  return { kpis, agents }
}

function agentTargetName(json: string | null): string {
  if (!json) return '—'
  try {
    const parsed = JSON.parse(json)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of arr) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const dn = obj.displayName || obj.DisplayName || obj.name || obj.Name
        if (dn) return String(dn)
      }
    }
  } catch {
    /* ignore malformed JSON */
  }
  return '—'
}

export interface AgentIdentityEvent {
  time: string
  action: 'created' | 'deleted' | 'updated' | 'other'
  agent: string
  actor: string
  result: string | null
  operation: string
}
export function agentIdentityEvents(limit = 200): AgentIdentityEvent[] {
  const rows = all<{
    event_time: string
    operation: string | null
    upn: string | null
    user_id: string | null
    result: string | null
    target_resources: string | null
  }>(
    `SELECT event_time, operation, upn, user_id, result, target_resources FROM audit_events
     WHERE LOWER(COALESCE(operation,'')) LIKE '%application%'
        OR LOWER(COALESCE(operation,'')) LIKE '%service principal%'
        OR LOWER(COALESCE(operation,'')) LIKE '%oauth2permission%'
        OR LOWER(COALESCE(operation,'')) LIKE '%consent%'
        OR LOWER(COALESCE(operation,'')) LIKE '%bot%'
     ORDER BY event_time DESC LIMIT ?`,
    limit
  )
  return rows.map((r) => {
    const op = (r.operation || '').toLowerCase()
    let action: 'created' | 'deleted' | 'updated' | 'other' = 'other'
    if (/(add|create|consent|register)/.test(op)) action = 'created'
    else if (/(delete|remove)/.test(op)) action = 'deleted'
    else if (/(update|set|modify|change)/.test(op)) action = 'updated'
    return {
      time: r.event_time,
      action,
      agent: agentTargetName(r.target_resources),
      actor: r.upn || r.user_id || '—',
      result: r.result,
      operation: r.operation || '—'
    }
  })
}

// ---- settings / secrets (read) ------------------------------------------
export function getSettingText(key: string): string | null {
  const r = get<{ value: Uint8Array }>('SELECT value FROM settings WHERE key=?', key)
  return r ? Buffer.from(r.value).toString('utf8') : null
}
export function getSecretRaw(key: string): Buffer | null {
  const r = get<{ value: Uint8Array }>('SELECT value FROM settings WHERE key=?', key)
  return r ? Buffer.from(r.value) : null
}
/** Write a UTF-8 text setting (BLOB value, like the Python repo). */
export function setSettingText(key: string, value: string): void {
  if (!db) throw new Error('db not open')
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, Buffer.from(value, 'utf8'))
}
/** Write a raw BLOB setting (e.g. a DPAPI-encrypted secret). */
export function setSettingBlob(key: string, value: Buffer): void {
  if (!db) throw new Error('db not open')
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, value)
}
/** True when the last agent-registrations diagnostic probe returned ok (Agent365 signal). */
export function agentInventoryDetected(): boolean {
  const r = get<{ status: string }>(
    "SELECT status FROM copilot_admin_diagnostics WHERE key='agent_registrations'"
  )
  return r?.status === 'ok'
}

// ---- collection writes --------------------------------------------------
function run(sql: string, params: Array<string | number | null>): void {
  if (!db) throw new Error('db not open')
  db.prepare(sql).run(...params)
}

export interface UserUpsert {
  id: string
  upn: string | null
  displayName: string | null
  enabled: boolean
}
export function upsertUsers(users: UserUpsert[]): void {
  for (const u of users) {
    run(
      `INSERT INTO users(id, upn, display_name, enabled) VALUES(?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET upn=excluded.upn, display_name=excluded.display_name, enabled=excluded.enabled`,
      [u.id, u.upn, u.displayName, u.enabled ? 1 : 0]
    )
  }
}
export function setCopilotLicensed(ids: string[]): void {
  run('UPDATE users SET has_copilot_license=0', [])
  for (const id of ids) run('UPDATE users SET has_copilot_license=1 WHERE id=?', [id])
}

export interface InteractionUpsert {
  id: string
  userId: string
  sessionId: string | null
  requestId: string | null
  createdAt: string
  interactionType: string | null
  app: string | null
  bodyText: string | null
  bodyContentType: string | null
  attachmentsJson: string | null
  rawJson: string
  sourceType: string
}
export function upsertInteractions(rows: InteractionUpsert[]): void {
  const fetchedAt = new Date().toISOString()
  for (const r of rows) {
    run(
      `INSERT INTO interactions(id,user_id,session_id,request_id,created_at,interaction_type,app,body_text,body_content_type,attachments_json,raw_json,fetched_at,source_type)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, session_id=excluded.session_id, request_id=excluded.request_id, created_at=excluded.created_at, interaction_type=excluded.interaction_type, app=excluded.app, body_text=excluded.body_text, body_content_type=excluded.body_content_type, attachments_json=excluded.attachments_json, raw_json=excluded.raw_json, fetched_at=excluded.fetched_at, source_type=excluded.source_type`,
      [
        r.id,
        r.userId,
        r.sessionId,
        r.requestId,
        r.createdAt,
        r.interactionType,
        r.app,
        r.bodyText,
        r.bodyContentType,
        r.attachmentsJson,
        r.rawJson,
        fetchedAt,
        r.sourceType
      ]
    )
  }
}

export function getCollectionState(userId: string): { watermark: string | null; backfillComplete: boolean } {
  const r = get<{ last_collected_at: string | null; backfill_complete: number }>(
    'SELECT last_collected_at, backfill_complete FROM collection_state WHERE user_id=?',
    userId
  )
  return { watermark: r?.last_collected_at ?? null, backfillComplete: Boolean(r?.backfill_complete) }
}
export function updateCollectionState(userId: string, lastCollectedAt: string, backfillComplete: boolean): void {
  run(
    `INSERT INTO collection_state(user_id, last_collected_at, backfill_complete) VALUES(?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET last_collected_at=excluded.last_collected_at,
       backfill_complete=MAX(collection_state.backfill_complete, excluded.backfill_complete)`,
    [userId, lastCollectedAt, backfillComplete ? 1 : 0]
  )
}

// ---- audit events + collection state ------------------------------------
export interface AuditEventRow {
  id: string
  source: string
  event_time: string
  user_id: string | null
  upn: string | null
  operation: string | null
  workload: string | null
  app: string | null
  target_resources: string | null
  client_ip: string | null
  result: string | null
  raw_json: string
  fetched_at: string
}
export function upsertAuditEvents(rows: AuditEventRow[]): number {
  for (const e of rows) {
    run(
      `INSERT INTO audit_events(id,source,event_time,user_id,upn,operation,workload,app,target_resources,client_ip,result,raw_json,fetched_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET source=excluded.source, event_time=excluded.event_time, user_id=excluded.user_id, upn=excluded.upn, operation=excluded.operation, workload=excluded.workload, app=excluded.app, target_resources=excluded.target_resources, client_ip=excluded.client_ip, result=excluded.result, raw_json=excluded.raw_json, fetched_at=excluded.fetched_at`,
      [
        e.id,
        e.source,
        e.event_time,
        e.user_id,
        e.upn,
        e.operation,
        e.workload,
        e.app,
        e.target_resources,
        e.client_ip,
        e.result,
        e.raw_json,
        e.fetched_at
      ]
    )
  }
  return rows.length
}

export interface AuditCollectionState {
  source: string
  last_collected_at: string | null
  coverage_start_at: string | null
  pending_query_id: string | null
  pending_submitted_at: string | null
  pending_window_start: string | null
  pending_window_end: string | null
  last_error: string | null
  last_error_at: string | null
  last_success_at: string | null
  last_record_count: number
  enabled: boolean
}
export function getAuditCollectionState(source: string): AuditCollectionState | null {
  const r = get<{
    source: string
    last_collected_at: string | null
    coverage_start_at: string | null
    pending_query_id: string | null
    pending_submitted_at: string | null
    pending_window_start: string | null
    pending_window_end: string | null
    last_error: string | null
    last_error_at: string | null
    last_success_at: string | null
    last_record_count: number
    enabled: number
  }>(
    `SELECT source, last_collected_at, coverage_start_at, pending_query_id, pending_submitted_at, pending_window_start,
            pending_window_end, last_error, last_error_at, last_success_at, last_record_count, enabled
     FROM audit_collection_state WHERE source=?`,
    source
  )
  if (!r) return null
  return { ...r, last_record_count: Number(r.last_record_count ?? 0), enabled: Boolean(r.enabled) }
}
export function updateAuditCollectionState(s: AuditCollectionState): void {
  run(
    `INSERT INTO audit_collection_state(source,last_collected_at,coverage_start_at,pending_query_id,pending_submitted_at,pending_window_start,pending_window_end,last_error,last_error_at,last_success_at,last_record_count,enabled)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source) DO UPDATE SET last_collected_at=excluded.last_collected_at, coverage_start_at=excluded.coverage_start_at, pending_query_id=excluded.pending_query_id, pending_submitted_at=excluded.pending_submitted_at, pending_window_start=excluded.pending_window_start, pending_window_end=excluded.pending_window_end, last_error=excluded.last_error, last_error_at=excluded.last_error_at, last_success_at=excluded.last_success_at, last_record_count=excluded.last_record_count, enabled=excluded.enabled`,
    [
      s.source,
      s.last_collected_at,
      s.coverage_start_at,
      s.pending_query_id,
      s.pending_submitted_at,
      s.pending_window_start,
      s.pending_window_end,
      s.last_error,
      s.last_error_at,
      s.last_success_at,
      s.last_record_count,
      s.enabled ? 1 : 0
    ]
  )
}

export function apiInteractionBounds(): { earliest: string; latest: string } | null {
  const row = get<{ earliest: string | null; latest: string | null }>(
    "SELECT MIN(created_at) earliest, MAX(created_at) latest FROM interactions WHERE source_type='api'"
  )
  return row?.earliest && row.latest ? { earliest: row.earliest, latest: row.latest } : null
}

// ---- copilot usage snapshots --------------------------------------------
export interface UsageSnapshotRow {
  snapshot_date: string
  user_id: string | null
  upn: string | null
  period: string
  display_name: string | null
  last_activity_overall: string | null
  last_activity_teams: string | null
  last_activity_word: string | null
  last_activity_excel: string | null
  last_activity_powerpoint: string | null
  last_activity_outlook: string | null
  last_activity_onenote: string | null
  last_activity_loop: string | null
  last_activity_bizchat: string | null
  raw_json: string | null
}
export function upsertUsageSnapshots(snaps: UsageSnapshotRow[]): number {
  for (const s of snaps) {
    const userKey = s.user_id || s.upn || '_total'
    const sid = createHash('sha1').update(`${s.snapshot_date}|${s.period}|${userKey}`).digest('hex').slice(0, 32)
    run(
      `INSERT INTO copilot_usage_snapshots(id,snapshot_date,user_id,upn,user_key,period,display_name,last_activity_overall,last_activity_teams,last_activity_word,last_activity_excel,last_activity_powerpoint,last_activity_outlook,last_activity_onenote,last_activity_loop,last_activity_bizchat,raw_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, last_activity_overall=excluded.last_activity_overall, last_activity_teams=excluded.last_activity_teams, last_activity_word=excluded.last_activity_word, last_activity_excel=excluded.last_activity_excel, last_activity_powerpoint=excluded.last_activity_powerpoint, last_activity_outlook=excluded.last_activity_outlook, last_activity_onenote=excluded.last_activity_onenote, last_activity_loop=excluded.last_activity_loop, last_activity_bizchat=excluded.last_activity_bizchat, raw_json=excluded.raw_json`,
      [
        sid,
        s.snapshot_date,
        s.user_id,
        s.upn,
        userKey,
        s.period,
        s.display_name,
        s.last_activity_overall,
        s.last_activity_teams,
        s.last_activity_word,
        s.last_activity_excel,
        s.last_activity_powerpoint,
        s.last_activity_outlook,
        s.last_activity_onenote,
        s.last_activity_loop,
        s.last_activity_bizchat,
        s.raw_json
      ]
    )
  }
  return snaps.length
}

// ---- copilot admin diagnostics + agent inventory ------------------------
export interface CopilotAdminDiagnosticRow {
  key: string
  label: string
  endpoint: string
  status: string
  status_code: number | null
  summary: string | null
  payload_json: string | null
  error: string | null
  captured_at: string
}
export function upsertCopilotAdminDiagnostics(rows: CopilotAdminDiagnosticRow[]): number {
  for (const r of rows) {
    run(
      `INSERT INTO copilot_admin_diagnostics(key,label,endpoint,status,status_code,summary,payload_json,error,captured_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET label=excluded.label, endpoint=excluded.endpoint, status=excluded.status, status_code=excluded.status_code, summary=excluded.summary, payload_json=excluded.payload_json, error=excluded.error, captured_at=excluded.captured_at`,
      [r.key, r.label, r.endpoint, r.status, r.status_code, r.summary, r.payload_json, r.error, r.captured_at]
    )
  }
  return rows.length
}

export interface CopilotAgentRow {
  id: string
  display_name: string | null
  app_identity: string | null
  app_external_id: string | null
  add_on_guid: string | null
  source: string
  status: string | null
  created_at: string | null
  updated_at: string | null
  raw_json: string | null
  captured_at: string
}
export function upsertCopilotAgents(rows: CopilotAgentRow[]): number {
  let n = 0
  for (const r of rows) {
    if (!r.id) continue
    run(
      `INSERT INTO copilot_agents(id,display_name,app_identity,app_external_id,add_on_guid,source,status,created_at,updated_at,raw_json,captured_at,last_activity_at,last_activity_source,usage_event_count)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0)
       ON CONFLICT(id) DO UPDATE SET display_name=COALESCE(excluded.display_name, copilot_agents.display_name), app_identity=COALESCE(excluded.app_identity, copilot_agents.app_identity), app_external_id=COALESCE(excluded.app_external_id, copilot_agents.app_external_id), add_on_guid=COALESCE(excluded.add_on_guid, copilot_agents.add_on_guid), source=excluded.source, status=COALESCE(excluded.status, copilot_agents.status), created_at=COALESCE(excluded.created_at, copilot_agents.created_at), updated_at=COALESCE(excluded.updated_at, copilot_agents.updated_at), raw_json=excluded.raw_json, captured_at=excluded.captured_at`,
      [
        r.id,
        r.display_name,
        r.app_identity,
        r.app_external_id,
        r.add_on_guid,
        r.source,
        r.status,
        r.created_at,
        r.updated_at,
        r.raw_json,
        r.captured_at
      ]
    )
    n++
  }
  return n
}
export function replaceCopilotAgentsForSource(source: string, rows: CopilotAgentRow[]): number {
  run('DELETE FROM copilot_agents WHERE source=?', [source])
  return upsertCopilotAgents(rows.filter((r) => r.source === source))
}

// ---- power platform consumption -----------------------------------------
export interface ConsumptionRow {
  report_type: string
  usage_date: string
  environment_id: string | null
  environment_name: string | null
  user_id: string | null
  product: string | null
  quantity: number
  unit: string | null
  window_start: string | null
  window_end: string | null
  raw_json: string | null
}
export function upsertConsumptionRows(rows: ConsumptionRow[]): number {
  const now = new Date().toISOString()
  for (const c of rows) {
    const userKey = c.user_id || (c.environment_id ? `_env:${c.environment_id}` : '_total')
    const product = c.product || ''
    const id = createHash('sha1').update(`${c.report_type}|${c.usage_date}|${userKey}|${product}`).digest('hex').slice(0, 32)
    run(
      `INSERT INTO power_platform_consumption(id,report_type,usage_date,environment_id,environment_name,user_id,user_key,product,quantity,unit,window_start,window_end,raw_json,captured_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET environment_name=excluded.environment_name, quantity=excluded.quantity, unit=excluded.unit, window_start=excluded.window_start, window_end=excluded.window_end, raw_json=excluded.raw_json, captured_at=excluded.captured_at`,
      [
        id,
        c.report_type,
        c.usage_date,
        c.environment_id,
        c.environment_name,
        c.user_id,
        userKey,
        c.product,
        Number(c.quantity || 0),
        c.unit,
        c.window_start,
        c.window_end,
        c.raw_json,
        now
      ]
    )
  }
  return rows.length
}

export function startRun(trigger: string): number {
  if (!db) throw new Error('db not open')
  const res = db.prepare('INSERT INTO collection_runs(started_at, trigger) VALUES(?,?)').run(new Date().toISOString(), trigger)
  return Number(res.lastInsertRowid)
}
export function finishRun(runId: number, usersProcessed: number, interactionsFetched: number, errors: number): void {
  run(
    'UPDATE collection_runs SET finished_at=?, users_processed=?, interactions_fetched=?, errors_count=? WHERE id=?',
    [new Date().toISOString(), usersProcessed, interactionsFetched, errors, runId]
  )
}

/** Fetch user records by id (for targeted single/few-user collection). */
export function usersByIds(ids: string[]): UserUpsert[] {
  if (!ids.length) return []
  const ph = ids.map(() => '?').join(',')
  const rows = all<{ id: string; upn: string | null; display_name: string | null; enabled: number }>(
    `SELECT id, upn, display_name, enabled FROM users WHERE id IN (${ph})`,
    ...ids
  )
  return rows.map((r) => ({ id: r.id, upn: r.upn, displayName: r.display_name, enabled: Boolean(r.enabled) }))
}

/**
 * Unified per-kind run history with captured live-log lines
 * (``collection_run_logs``). Survives restarts so past runs and their logs can
 * be inspected from the page.
 */
export function startRunLog(kind: string, trigger: string): number {
  if (!db) throw new Error('db not open')
  const res = db
    .prepare('INSERT INTO collection_run_logs(kind, trigger, started_at, status) VALUES(?,?,?,?)')
    .run(kind, trigger, new Date().toISOString(), 'running')
  return Number(res.lastInsertRowid)
}
export function finishRunLog(
  id: number,
  status: string,
  errorCount: number,
  summary: string | null,
  logsJson: string | null
): void {
  run('UPDATE collection_run_logs SET finished_at=?, status=?, error_count=?, summary=?, logs_json=? WHERE id=?', [
    new Date().toISOString(),
    status,
    errorCount,
    summary,
    logsJson,
    id
  ])
}

// ---- threading read/write -----------------------------------------------
export function interactionsForUser(userId: string, sourceType: string): TurnInput[] {
  const rows = all<{
    id: string
    session_id: string | null
    request_id: string | null
    created_at: string
    interaction_type: string | null
    app: string | null
    body_text: string | null
  }>(
    'SELECT id, session_id, request_id, created_at, interaction_type, app, body_text FROM interactions WHERE user_id=? AND source_type=?',
    userId,
    sourceType
  )
  return rows.map((r) => ({
    id: r.id,
    userId,
    sessionId: r.session_id,
    requestId: r.request_id,
    createdAt: r.created_at,
    interactionType: r.interaction_type,
    app: r.app,
    bodyText: r.body_text
  }))
}
export function deleteUserThreads(userId: string, sourceType: string): void {
  run('DELETE FROM conversation_threads WHERE user_id=? AND source_type=?', [userId, sourceType])
}
export function upsertThreads(threads: ThreadGroup[], sourceType: string): void {
  const now = new Date().toISOString()
  for (const t of threads) {
    run(
      `INSERT OR REPLACE INTO conversation_threads(id,user_id,started_at,ended_at,app,turn_count,prompt_count,response_count,session_ids,topic_keywords,title,cluster_label,computed_at,source_type)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        t.id,
        t.userId,
        t.startedAt,
        t.endedAt,
        t.app,
        t.turnCount,
        t.promptCount,
        t.responseCount,
        JSON.stringify(t.sessionIds),
        JSON.stringify([]),
        t.title,
        null,
        now,
        sourceType
      ]
    )
  }
}
export function assignThreadsToInteractions(pairs: Array<[string, string]>): void {
  for (const [interactionId, threadId] of pairs) {
    run('UPDATE interactions SET thread_id=? WHERE id=?', [threadId, interactionId])
  }
}

// ---- page DTOs over existing tables -------------------------------------
type Sev = 'high' | 'med' | 'low'
function sevForOp(op: string | null): Sev {
  const s = (op ?? '').toLowerCase()
  if (s.includes('delete') || s.includes('remove')) return 'high'
  if (s.includes('update') || s.includes('policy') || s.includes('add') || s.includes('consent')) return 'med'
  return 'low'
}

export interface SecurityDTO {
  kpis: { total: number; copilot: number; actors: number; high: number }
  events: Array<{ time: string; actor: string; action: string; sev: Sev }>
  dist: Array<{ label: string; value: number }>
}
export function securityOverview(): SecurityDTO {
  const total = get<{ n: number }>('SELECT COUNT(*) n FROM audit_events')?.n ?? 0
  const copilot = get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE operation='CopilotInteraction'")?.n ?? 0
  const actors =
    get<{ n: number }>('SELECT COUNT(DISTINCT COALESCE(upn,user_id)) n FROM audit_events WHERE upn IS NOT NULL OR user_id IS NOT NULL')?.n ?? 0
  const high =
    get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE lower(operation) LIKE '%delete%' OR lower(operation) LIKE '%remove%'")?.n ??
    0
  const evRows = all<{ event_time: string; upn: string | null; user_id: string | null; operation: string | null }>(
    'SELECT event_time, upn, user_id, operation FROM audit_events ORDER BY event_time DESC LIMIT 14'
  )
  const events = evRows.map((r) => ({
    time: shortTime(r.event_time),
    actor: r.upn || r.user_id || '시스템',
    action: r.operation || '—',
    sev: sevForOp(r.operation)
  }))
  const dRows = all<{ operation: string | null; c: number }>(
    'SELECT operation, COUNT(*) c FROM audit_events GROUP BY operation ORDER BY c DESC LIMIT 6'
  )
  const dist = dRows.map((r) => ({ label: r.operation || '기타', value: r.c }))
  return { kpis: { total, copilot, actors, high }, events, dist }
}

// ---- Security: filtered audit events + diagnostics ----------------------
export interface AuditFilters {
  source?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  limit?: number
}
export interface SecurityEventRow {
  id: string
  time: string
  source: string
  sourceLabel: string
  user: string
  operation: string
  workload: string
  app: string
  result: string | null
  raw: string
}
export interface SecurityEventsDTO {
  kpis: { total: number; blocked: number; uniqueUsers: number; topOperation: string | null; topOperationCount: number }
  events: SecurityEventRow[]
}
export function securityEvents(f: AuditFilters): SecurityEventsDTO {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (f.source) {
    clauses.push('source = ?')
    params.push(f.source)
  }
  if (f.dateFrom) {
    clauses.push('event_time >= ?')
    params.push(f.dateFrom)
  }
  if (f.dateTo) {
    clauses.push('event_time <= ?')
    params.push(`${f.dateTo}T23:59:59Z`)
  }
  if (f.search && f.search.trim()) {
    const needle = `%${f.search.trim().toLowerCase()}%`
    clauses.push(
      "(LOWER(COALESCE(operation,'')) LIKE ? OR LOWER(COALESCE(upn,'')) LIKE ? OR LOWER(COALESCE(user_id,'')) LIKE ? OR LOWER(COALESCE(app,'')) LIKE ? OR LOWER(COALESCE(workload,'')) LIKE ?)"
    )
    params.push(needle, needle, needle, needle, needle)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = f.limit ?? 1000
  const rows = all<{
    id: string
    event_time: string
    source: string
    upn: string | null
    user_id: string | null
    operation: string | null
    workload: string | null
    app: string | null
    result: string | null
    raw_json: string
  }>(
    `SELECT id, event_time, source, upn, user_id, operation, workload, app, result, raw_json
     FROM audit_events ${where} ORDER BY event_time DESC LIMIT ?`,
    ...params,
    limit
  )
  const events: SecurityEventRow[] = rows.map((r) => ({
    id: r.id,
    time: r.event_time,
    source: r.source,
    sourceLabel: AUDIT_SRC_LABEL[r.source] || r.source,
    user: r.upn || r.user_id || '—',
    operation: r.operation || '—',
    workload: r.workload || '—',
    app: friendlyApp(r.app),
    result: r.result,
    raw: r.raw_json
  }))
  const blocked = events.filter((e) => {
    const x = (e.result || '').toLowerCase()
    return x.includes('denied') || x.includes('blocked') || x === 'failure'
  }).length
  const uniqueUsers = new Set(events.filter((e) => e.user !== '—').map((e) => e.user)).size
  const opCounts = new Map<string, number>()
  for (const e of events) opCounts.set(e.operation, (opCounts.get(e.operation) ?? 0) + 1)
  const topOp = [...opCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    kpis: {
      total: events.length,
      blocked,
      uniqueUsers,
      topOperation: topOp?.[0] ?? null,
      topOperationCount: topOp?.[1] ?? 0
    },
    events
  }
}

const KIND_LABEL: Record<string, string> = {
  conversation: '대화 수집',
  audit: '감사 로그',
  usage: '공식 사용량',
  diagnostics: '에이전트 진단',
  consumption: '크레딧 소비',
  transcripts: 'Teams 대화',
  flow_runs: '에이전트 실행',
  agent_definitions: '에이전트 정의'
}
function runStatus(s: string | null): string {
  if (s === 'success') return 'ok'
  if (s === 'running') return 'run'
  if (s === 'error' || s === 'warn') return 'err'
  return 'idle'
}
export interface CollectDTO {
  kpis: { sources: number; lastRun: string; runs: number; errors: number }
  sources: Array<{ name: string; status: string; last: string; count: string }>
  jobs: Array<{ time: string; job: string; result: string; status: string }>
}
export function collectOverview(): CollectDTO {
  const jobRows = all<{ kind: string; status: string | null; started_at: string; summary: string | null }>(
    'SELECT kind, status, started_at, summary FROM collection_run_logs ORDER BY started_at DESC LIMIT 12'
  )
  const jobs = jobRows.map((r) => ({
    time: shortTime(r.started_at),
    job: KIND_LABEL[r.kind] || r.kind,
    result: r.summary || '—',
    status: runStatus(r.status)
  }))
  const srcRows = all<{ kind: string; status: string | null; started_at: string }>(
    'SELECT kind, status, MAX(started_at) started_at FROM collection_run_logs GROUP BY kind ORDER BY started_at DESC'
  )
  const sources = srcRows.map((r) => ({
    name: KIND_LABEL[r.kind] || r.kind,
    status: runStatus(r.status),
    last: shortTime(r.started_at),
    count: ''
  }))
  const errors =
    get<{ n: number }>("SELECT COUNT(*) n FROM collection_run_logs WHERE status IN ('warn','error')")?.n ?? 0
  return {
    kpis: { sources: srcRows.length, lastRun: jobRows[0] ? shortTime(jobRows[0].started_at) : '—', runs: jobRows.length, errors },
    sources,
    jobs
  }
}

export interface EdiscoveryDTO {
  kpis: { jobs: number; items: number; running: number; failed: number }
  jobs: Array<{
    id: string
    target: string
    status: string
    window: string
    added: number
    updated: string
    error: string | null
    running: boolean
    raw: Record<string, unknown>
  }>
}
function ediscoveryWindowLabel(start: string | null, end: string | null): string {
  const s = start ? start.split('T')[0] : ''
  const e = end ? end.split('T')[0] : ''
  if (!s && !e) return '전체 기간'
  return `${s || '처음'} ~ ${e || '현재'}`
}
export function ediscoveryOverview(): EdiscoveryDTO {
  const rows = all<{
    id: string
    target_upn: string | null
    target_user_id: string | null
    status: string | null
    interactions_added: number | null
    window_start: string | null
    window_end: string | null
    case_id: string | null
    search_id: string | null
    operation_url: string | null
    export_url: string | null
    last_error: string | null
    last_error_at: string | null
    created_at: string
    updated_at: string | null
  }>(
    'SELECT id, target_upn, target_user_id, status, interactions_added, window_start, window_end, case_id, search_id, operation_url, export_url, last_error, last_error_at, created_at, updated_at FROM ediscovery_jobs ORDER BY created_at DESC'
  )
  const jobs = rows.map((r) => ({
    id: r.id,
    target: r.target_upn || '내보내기',
    status: r.status || 'pending',
    window: ediscoveryWindowLabel(r.window_start, r.window_end),
    added: r.interactions_added ?? 0,
    updated: shortTime(r.updated_at || r.created_at),
    error: r.last_error,
    running: r.status !== 'done' && r.status !== 'error',
    raw: { ...r }
  }))
  const items = get<{ n: number }>('SELECT COALESCE(SUM(interactions_added),0) n FROM ediscovery_jobs')?.n ?? 0
  const running = jobs.filter((j) => j.running).length
  const failed = jobs.filter((j) => j.status === 'error').length
  return { kpis: { jobs: rows.length, items, running, failed }, jobs }
}

export interface EdiscoveryJob {
  id: string
  targetUpn: string
  targetUserId: string | null
  windowStart: string | null
  windowEnd: string | null
  status: string
  caseId: string | null
  searchId: string | null
  operationUrl: string | null
  exportUrl: string | null
  interactionsAdded: number
  lastError: string | null
  lastErrorAt: string | null
  createdAt: string
  updatedAt: string
}
interface EdiscoveryJobRow {
  id: string
  target_upn: string
  target_user_id: string | null
  window_start: string | null
  window_end: string | null
  status: string
  case_id: string | null
  search_id: string | null
  operation_url: string | null
  export_url: string | null
  interactions_added: number | null
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}
function rowToEdiscoveryJob(r: EdiscoveryJobRow): EdiscoveryJob {
  return {
    id: r.id,
    targetUpn: r.target_upn,
    targetUserId: r.target_user_id,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    status: r.status,
    caseId: r.case_id,
    searchId: r.search_id,
    operationUrl: r.operation_url,
    exportUrl: r.export_url,
    interactionsAdded: r.interactions_added ?? 0,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}
export function getEdiscoveryJob(id: string): EdiscoveryJob | null {
  const r = get<EdiscoveryJobRow>('SELECT * FROM ediscovery_jobs WHERE id=?', id)
  return r ? rowToEdiscoveryJob(r) : null
}
export function listEdiscoveryJobs(): EdiscoveryJob[] {
  return all<EdiscoveryJobRow>('SELECT * FROM ediscovery_jobs ORDER BY created_at DESC').map(rowToEdiscoveryJob)
}
export function deleteEdiscoveryJob(id: string): void {
  run('DELETE FROM ediscovery_jobs WHERE id=?', [id])
}
/** Count eDiscovery interactions + derived threads for one target user
 * (user_id = ``ediscovery:<upn>``). Interactions carry no per-job id, so the
 * finest deletable unit is "all eDiscovery conversations for this UPN". */
export function countEdiscoveryConversations(userId: string): { interactions: number; threads: number } {
  const interactions =
    get<{ n: number }>(
      "SELECT COUNT(*) n FROM interactions WHERE source_type='ediscovery' AND user_id=?",
      userId
    )?.n ?? 0
  const threads =
    get<{ n: number }>(
      "SELECT COUNT(*) n FROM conversation_threads WHERE source_type='ediscovery' AND user_id=?",
      userId
    )?.n ?? 0
  return { interactions, threads }
}
export function deleteEdiscoveryConversations(userId: string): void {
  run("DELETE FROM interactions WHERE source_type='ediscovery' AND user_id=?", [userId])
  run("DELETE FROM conversation_threads WHERE source_type='ediscovery' AND user_id=?", [userId])
}
export function upsertEdiscoveryJob(j: EdiscoveryJob): void {
  run(
    `INSERT INTO ediscovery_jobs(id,target_upn,target_user_id,window_start,window_end,status,case_id,search_id,operation_url,export_url,interactions_added,last_error,last_error_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       target_upn=excluded.target_upn, target_user_id=excluded.target_user_id,
       window_start=excluded.window_start, window_end=excluded.window_end, status=excluded.status,
       case_id=excluded.case_id, search_id=excluded.search_id, operation_url=excluded.operation_url,
       export_url=excluded.export_url, interactions_added=excluded.interactions_added,
       last_error=excluded.last_error, last_error_at=excluded.last_error_at, updated_at=excluded.updated_at`,
    [
      j.id,
      j.targetUpn,
      j.targetUserId,
      j.windowStart,
      j.windowEnd,
      j.status,
      j.caseId,
      j.searchId,
      j.operationUrl,
      j.exportUrl,
      j.interactionsAdded,
      j.lastError,
      j.lastErrorAt,
      j.createdAt,
      j.updatedAt
    ]
  )
}

const RULE_LABEL: Record<string, string> = {
  agent_daily_abs: '에이전트 일일 한도',
  user_daily_abs: '사용자 일일 한도',
  spike: '급증 감지',
  tenant_monthly_pct: '월 테넌트 사용률',
  tenant_monthly_abs: '월 테넌트 한도',
  env_daily_abs: '환경 일일 한도',
  remaining_pct: '잔여 비율',
  forecast_exhaust: '소진 예측'
}
export function alertRules(): Array<{ name: string; cond: string; on: boolean }> {
  const rows = all<{ rule_key: string; enabled: number; threshold: number; secondary: number; severity: string }>(
    'SELECT rule_key, enabled, threshold, secondary, severity FROM credit_alert_rules ORDER BY rule_key'
  )
  return rows.map((r) => ({
    name: RULE_LABEL[r.rule_key] || r.rule_key,
    cond: `임계값 ${r.threshold}${r.secondary ? ` · 보조 ${r.secondary}` : ''} · ${r.severity}`,
    on: Boolean(r.enabled)
  }))
}

export interface CreditsDTO {
  purchased: number
  consumed: number
  users: Array<{ user: string; messages: number; share: number }>
}
export function creditsOverview(): CreditsDTO {
  const purchased =
    get<{ q: number }>("SELECT COALESCE(SUM(quantity),0) q FROM power_platform_consumption WHERE product='purchased' AND unit='messages'")?.q ??
    0
  const consumed =
    get<{ q: number }>("SELECT COALESCE(SUM(quantity),0) q FROM power_platform_consumption WHERE report_type='MCSMessages:user'")?.q ?? 0
  const uRows = all<{ user_key: string | null; q: number }>(
    "SELECT user_key, SUM(quantity) q FROM power_platform_consumption WHERE report_type='MCSMessages:user' GROUP BY user_key ORDER BY q DESC LIMIT 8"
  )
  const max = Math.max(1, ...uRows.map((r) => r.q))
  const users = uRows.map((r) => ({ user: r.user_key || '—', messages: Math.round(r.q), share: Math.round((r.q / max) * 100) }))
  return { purchased: Math.round(purchased), consumed: Math.round(consumed), users }
}

// ---- Consumption explorer (overview + agents/environments/users tabs) ----
// Avoids date('now') filters: data is dated in 2026, so projection is derived
// from the data's own usage_date span rather than the wall clock.
export interface ConsumptionExplorerDTO {
  summary: {
    purchased: number
    consumed: number
    remaining: number
    projectedMonth: number
    agentCount: number
    environmentCount: number
    userCount: number
    latestDate: string
    unit: string
  }
  trend: Array<{ day: string; quantity: number }>
  agents: Array<{ name: string; env: string; quantity: number }>
  environments: Array<{ env: string; quantity: number }>
  users: Array<{ user: string; quantity: number; share: number }>
}
export function consumptionExplorer(): ConsumptionExplorerDTO {
  const purchased =
    get<{ q: number }>(
      "SELECT COALESCE(SUM(quantity),0) q FROM power_platform_consumption WHERE product='purchased' AND unit='messages'"
    )?.q ?? 0
  const consumed =
    get<{ q: number }>("SELECT COALESCE(SUM(quantity),0) q FROM power_platform_consumption WHERE report_type='MCSMessages:user'")?.q ?? 0
  const span = get<{ lo: string | null; hi: string | null }>(
    "SELECT MIN(usage_date) lo, MAX(usage_date) hi FROM power_platform_consumption WHERE report_type='MCSMessages:user'"
  )
  let activeDays = 1
  if (span?.lo && span?.hi) {
    const d0 = Date.parse(span.lo)
    const d1 = Date.parse(span.hi)
    if (!Number.isNaN(d0) && !Number.isNaN(d1)) activeDays = Math.max(Math.round((d1 - d0) / 86_400_000) + 1, 1)
  }
  const projectedMonth = activeDays ? (consumed / activeDays) * 30 : 0
  const unit =
    get<{ u: string | null }>("SELECT unit u FROM power_platform_consumption WHERE report_type='MCSMessages:user' AND unit IS NOT NULL LIMIT 1")?.u ||
    'messages'
  const agentRows = all<{ product: string | null; env: string | null; q: number }>(
    "SELECT product, COALESCE(environment_name, environment_id) env, SUM(quantity) q FROM power_platform_consumption WHERE report_type='MCSMessages:resource' GROUP BY product, env ORDER BY q DESC LIMIT 100"
  )
  const agents = agentRows.map((r) => ({ name: r.product || '—', env: r.env || '—', quantity: Math.round(r.q) }))
  const envRows = all<{ env: string | null; q: number }>(
    "SELECT COALESCE(environment_name, environment_id) env, SUM(quantity) q FROM power_platform_consumption WHERE report_type='MCSMessages:resource' GROUP BY env ORDER BY q DESC"
  )
  const environments = envRows.map((r) => ({ env: r.env || '—', quantity: Math.round(r.q) }))
  const userRows = all<{ user_key: string | null; q: number }>(
    "SELECT user_key, SUM(quantity) q FROM power_platform_consumption WHERE report_type='MCSMessages:user' GROUP BY user_key ORDER BY q DESC"
  )
  const umax = Math.max(1, ...userRows.map((r) => r.q))
  const users = userRows.map((r) => ({
    user: r.user_key || '—',
    quantity: Math.round(r.q),
    share: Math.round((r.q / umax) * 100)
  }))
  const trendRows = all<{ day: string; q: number }>(
    "SELECT usage_date day, SUM(quantity) q FROM power_platform_consumption WHERE report_type='MCSMessages:resource' AND usage_date IS NOT NULL GROUP BY usage_date ORDER BY usage_date"
  )
  const trend = trendRows.map((r) => ({ day: r.day, quantity: Math.round(r.q) }))
  return {
    summary: {
      purchased: Math.round(purchased),
      consumed: Math.round(consumed),
      remaining: Math.max(0, Math.round(purchased - consumed)),
      projectedMonth: Math.round(projectedMonth),
      agentCount: agents.length,
      environmentCount: environments.length,
      userCount: users.length,
      latestDate: span?.hi || '—',
      unit
    },
    trend,
    agents,
    environments,
    users
  }
}

// ---- collect-source status DTOs (audit / usage / diagnostics) -----------
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : '—'
}
const AUDIT_SRC_LABEL: Record<string, string> = {
  purview: 'Purview 통합 감사',
  entra_audit: 'Entra 디렉터리 감사',
  entra_signin: 'Entra 로그인'
}

export interface AuditCollectDTO {
  kpis: { total: number; purview: number; entraAudit: number; entraSignin: number }
  sources: Array<{ source: string; label: string; enabled: boolean; pending: boolean; last: string; count: number; error: string | null }>
  recent: Array<{ time: string; source: string; operation: string; actor: string }>
}
export function auditCollectStatus(): AuditCollectDTO {
  const cnt = (s: string): number => get<{ n: number }>('SELECT COUNT(*) n FROM audit_events WHERE source=?', s)?.n ?? 0
  const total = get<{ n: number }>('SELECT COUNT(*) n FROM audit_events')?.n ?? 0
  const stateRows = all<{
    source: string
    last_collected_at: string | null
    coverage_start_at: string | null
    pending_query_id: string | null
    last_record_count: number
    last_error: string | null
    enabled: number
  }>('SELECT source, last_collected_at, coverage_start_at, pending_query_id, last_record_count, last_error, enabled FROM audit_collection_state')
  const byState = new Map(stateRows.map((r) => [r.source, r]))
  const sources = ['purview', 'entra_audit', 'entra_signin'].map((src) => {
    const st = byState.get(src)
    return {
      source: src,
      label: AUDIT_SRC_LABEL[src] || src,
      enabled: st ? Boolean(st.enabled) : true,
      pending: Boolean(st?.pending_query_id),
      last:
        st?.coverage_start_at && st.last_collected_at
          ? `${dateOnly(st.coverage_start_at)} ~ ${dateOnly(st.last_collected_at)}`
          : st?.last_collected_at
            ? shortTime(st.last_collected_at)
            : '—',
      count: cnt(src),
      error: st?.last_error ?? null
    }
  })
  const recent = all<{ event_time: string; source: string; operation: string | null; upn: string | null; user_id: string | null }>(
    'SELECT event_time, source, operation, upn, user_id FROM audit_events ORDER BY event_time DESC LIMIT 12'
  ).map((r) => ({
    time: shortTime(r.event_time),
    source: AUDIT_SRC_LABEL[r.source] || r.source,
    operation: r.operation || '—',
    actor: r.upn || r.user_id || '시스템'
  }))
  return { kpis: { total, purview: cnt('purview'), entraAudit: cnt('entra_audit'), entraSignin: cnt('entra_signin') }, sources, recent }
}

export interface UsageCollectDTO {
  kpis: { rows: number; latest: string; users: number; period: string }
  top: Array<{ user: string; overall: string; teams: string; word: string; excel: string }>
}
export function usageCollectStatus(): UsageCollectDTO {
  const rows = get<{ n: number }>('SELECT COUNT(*) n FROM copilot_usage_snapshots')?.n ?? 0
  const latest = get<{ d: string | null }>('SELECT MAX(snapshot_date) d FROM copilot_usage_snapshots')?.d ?? null
  const users = get<{ n: number }>('SELECT COUNT(DISTINCT user_key) n FROM copilot_usage_snapshots')?.n ?? 0
  const period = get<{ p: string | null }>('SELECT period AS p FROM copilot_usage_snapshots GROUP BY period ORDER BY COUNT(*) DESC LIMIT 1')?.p ?? '—'
  const top = all<{
    upn: string | null
    display_name: string | null
    last_activity_overall: string | null
    last_activity_teams: string | null
    last_activity_word: string | null
    last_activity_excel: string | null
  }>(
    "SELECT upn, display_name, last_activity_overall, last_activity_teams, last_activity_word, last_activity_excel FROM copilot_usage_snapshots WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM copilot_usage_snapshots) AND user_key!='_total' ORDER BY last_activity_overall DESC LIMIT 12"
  ).map((r) => ({
    user: r.display_name || r.upn || '—',
    overall: dateOnly(r.last_activity_overall),
    teams: dateOnly(r.last_activity_teams),
    word: dateOnly(r.last_activity_word),
    excel: dateOnly(r.last_activity_excel)
  }))
  return { kpis: { rows, latest: latest || '—', users, period }, top }
}

export interface DiagnosticsDTO {
  kpis: { total: number; ok: number; forbidden: number; notFound: number }
  rows: Array<{ label: string; endpoint: string; status: string; summary: string; capturedAt: string }>
}
export function diagnosticsStatus(): DiagnosticsDTO {
  const rows = all<{
    label: string
    endpoint: string
    status: string
    status_code: number | null
    summary: string | null
    captured_at: string
  }>('SELECT label, endpoint, status, status_code, summary, captured_at FROM copilot_admin_diagnostics ORDER BY label')
  const cnt = (s: string): number => rows.filter((r) => r.status === s).length
  return {
    kpis: { total: rows.length, ok: cnt('ok'), forbidden: cnt('forbidden'), notFound: cnt('not_found') },
    rows: rows.map((r) => ({
      label: r.label,
      endpoint: r.endpoint,
      status: r.status,
      summary: r.summary || '—',
      capturedAt: shortTime(r.captured_at)
    }))
  }
}

export interface ConversationCollectDTO {
  kpis: { interactions: number; users: number; threads: number; lastRun: string }
  users: Array<{ userId: string; user: string; count: number; last: string; backfill: boolean }>
  runs: Array<{
    id: number
    started: string
    trigger: string
    users: number
    interactions: number
    errors: number
    status: string
    log: string
  }>
}
export function conversationCollectStatus(): ConversationCollectDTO {
  const interactions = get<{ n: number }>('SELECT COUNT(*) n FROM interactions')?.n ?? 0
  const userCount = get<{ n: number }>('SELECT COUNT(DISTINCT user_id) n FROM interactions')?.n ?? 0
  const threads = get<{ n: number }>('SELECT COUNT(*) n FROM conversation_threads')?.n ?? 0

  // Run history (with captured live-log lines) from the unified run-log table.
  const runRows = all<{
    id: number
    started_at: string
    finished_at: string | null
    trigger: string
    status: string
    error_count: number | null
    summary: string | null
    logs_json: string | null
  }>(
    "SELECT id, started_at, finished_at, trigger, status, error_count, summary, logs_json FROM collection_run_logs WHERE kind='conversation' ORDER BY started_at DESC LIMIT 50"
  )
  const runs = runRows.map((r) => {
    let users = 0
    let inter = 0
    try {
      const s = r.summary ? (JSON.parse(r.summary) as { users?: number; interactions?: number }) : {}
      users = s.users ?? 0
      inter = s.interactions ?? 0
    } catch {
      /* ignore malformed summary */
    }
    let log = ''
    try {
      const lines = r.logs_json ? (JSON.parse(r.logs_json) as Array<{ at: string; text: string }>) : []
      log = lines.map((l) => `[${shortTime(l.at)}] ${l.text}`).join('\n')
    } catch {
      /* ignore malformed logs */
    }
    return {
      id: r.id,
      started: shortTime(r.started_at),
      trigger: r.trigger,
      users,
      interactions: inter,
      errors: r.error_count ?? 0,
      status: r.finished_at ? (r.status === 'error' || (r.error_count ?? 0) > 0 ? 'err' : 'ok') : 'run',
      log
    }
  })

  // Per-user collection status — ALL collected users (the page handles
  // search / sort / paging client-side, for tenants with thousands of users).
  const userRows = all<{
    user_id: string
    display_name: string | null
    upn: string | null
    c: number
    last_collected_at: string | null
    backfill_complete: number | null
  }>(
    `SELECT i.user_id, u.display_name, u.upn, COUNT(*) c, cs.last_collected_at, cs.backfill_complete
     FROM interactions i
     LEFT JOIN users u ON u.id = i.user_id
     LEFT JOIN collection_state cs ON cs.user_id = i.user_id
     GROUP BY i.user_id ORDER BY c DESC`
  )
  const users = userRows.map((r) => ({
    userId: r.user_id,
    user: r.display_name || r.upn || r.user_id,
    count: r.c,
    last: r.last_collected_at ? shortTime(r.last_collected_at) : '—',
    backfill: Boolean(r.backfill_complete)
  }))
  return {
    kpis: { interactions, users: userCount, threads, lastRun: runRows[0] ? shortTime(runRows[0].started_at) : '—' },
    users,
    runs
  }
}

export interface AgentCreditDTO {
  kpis: { agents: number; messages: number; environments: number; top: string }
  agents: Array<{ name: string; env: string; messages: number; share: number }>
}
export function agentCreditOverview(): AgentCreditDTO {
  const rows = all<{ product: string | null; environment_id: string | null; quantity: number }>(
    "SELECT product, environment_id, SUM(quantity) quantity FROM power_platform_consumption WHERE report_type='MCSMessages:resource' GROUP BY product, environment_id ORDER BY quantity DESC LIMIT 20"
  )
  const messages = rows.reduce((s, r) => s + (r.quantity || 0), 0)
  const environments = new Set(rows.map((r) => r.environment_id).filter(Boolean)).size
  const max = Math.max(1, ...rows.map((r) => r.quantity || 0))
  const agents = rows.map((r) => ({
    name: r.product || '(이름 없음)',
    env: r.environment_id ? r.environment_id.slice(0, 8) : '—',
    messages: Math.round(r.quantity || 0),
    share: Math.round(((r.quantity || 0) / max) * 100)
  }))
  return {
    kpis: { agents: rows.length, messages: Math.round(messages), environments, top: agents[0]?.name || '—' },
    agents
  }
}

// ---- credit alerts engine inputs + persistence --------------------------
export interface CreditAlertRule {
  rule_key: string
  enabled: boolean
  threshold: number
  secondary: number
  severity: string
}
export function listCreditAlertRules(): CreditAlertRule[] {
  return all<{ rule_key: string; enabled: number; threshold: number | null; secondary: number | null; severity: string | null }>(
    'SELECT rule_key, enabled, threshold, secondary, severity FROM credit_alert_rules'
  ).map((r) => ({
    rule_key: r.rule_key,
    enabled: Boolean(r.enabled),
    threshold: r.threshold ?? 0,
    secondary: r.secondary ?? 0,
    severity: r.severity ?? 'warn'
  }))
}

export interface ConsumptionSummary {
  total: number
  projected_month: number
  latest_date: string | null
  earliest_date: string | null
}
export function consumptionSummary(reportType: string, days = 30): ConsumptionSummary {
  const r = get<{ total: number | null; latest_date: string | null; earliest_date: string | null }>(
    "SELECT SUM(quantity) total, MAX(usage_date) latest_date, MIN(usage_date) earliest_date FROM power_platform_consumption WHERE report_type=? AND usage_date >= date('now', ?)",
    reportType,
    `-${days} day`
  )
  const total = Number(r?.total ?? 0)
  const earliest = r?.earliest_date ?? null
  const latest = r?.latest_date ?? null
  let activeDays = 0
  if (earliest && latest) {
    const d0 = Date.parse(earliest)
    const d1 = Date.parse(latest)
    if (!Number.isNaN(d0) && !Number.isNaN(d1)) activeDays = Math.max(Math.round((d1 - d0) / 86_400_000) + 1, 1)
  }
  return { total, projected_month: activeDays ? (total / activeDays) * 30 : 0, latest_date: latest, earliest_date: earliest }
}

interface DeltaRow {
  k: string
  environment_id: string | null
  environment_name: string | null
  usage_date: string
  quantity: number
  unit: string | null
  delta: number | null
}
export interface CreditDelta {
  product?: string
  user_id?: string
  name?: string
  display_name?: string
  upn?: string | null
  environment_name: string | null
  last_delta: number
  baseline_daily: number
  spike_ratio: number | null
  latest_quantity: number
  last_date: string
}
function creditDeltaSeries(reportType: string, entityCol: 'product' | 'user_id', days: number): DeltaRow[] {
  const sql =
    `SELECT ${entityCol} AS k, environment_id, environment_name, usage_date, quantity, unit, ` +
    `quantity - LAG(quantity) OVER (PARTITION BY ${entityCol} ORDER BY usage_date) AS delta ` +
    `FROM power_platform_consumption WHERE report_type=? AND ${entityCol} IS NOT NULL AND ${entityCol} <> '' ` +
    `AND usage_date >= date('now', ?) ORDER BY ${entityCol}, usage_date`
  return all<DeltaRow>(sql, reportType, `-${days} day`)
}
function groupByKey(rows: DeltaRow[]): Map<string, DeltaRow[]> {
  const groups = new Map<string, DeltaRow[]>()
  for (const r of rows) {
    let g = groups.get(r.k)
    if (!g) {
      g = []
      groups.set(r.k, g)
    }
    g.push(r)
  }
  return groups
}
function summariseDelta(series: DeltaRow[]): Omit<CreditDelta, 'product' | 'user_id' | 'name'> {
  const deltas = series.filter((r) => r.delta !== null).map((r) => Math.max(Number(r.delta) || 0, 0))
  const last = series[series.length - 1]
  const lastDelta = last.delta !== null ? Math.max(Number(last.delta) || 0, 0) : 0
  const prior = deltas.slice(0, -1)
  const baseline = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0
  return {
    environment_name: last.environment_name,
    latest_quantity: Number(last.quantity) || 0,
    last_date: last.usage_date,
    last_delta: Math.round(lastDelta * 100) / 100,
    baseline_daily: Math.round(baseline * 100) / 100,
    spike_ratio: baseline > 0 ? Math.round((lastDelta / baseline) * 100) / 100 : null
  }
}
export function agentCreditDeltas(days = 30): CreditDelta[] {
  const groups = groupByKey(creditDeltaSeries('MCSMessages:resource', 'product', days))
  const out: CreditDelta[] = []
  for (const [product, series] of groups) out.push({ ...summariseDelta(series), product, name: product })
  out.sort((a, b) => b.last_delta - a.last_delta)
  return out.slice(0, 100)
}
export function userCreditDeltas(days = 30): CreditDelta[] {
  const groups = groupByKey(creditDeltaSeries('MCSMessages:user', 'user_id', days))
  const out: CreditDelta[] = []
  for (const [userId, series] of groups) out.push({ ...summariseDelta(series), user_id: userId })
  out.sort((a, b) => b.last_delta - a.last_delta)
  const top = out.slice(0, 100)
  const ids = top.map((d) => d.user_id).filter(Boolean) as string[]
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    const nameRows = all<{ id: string; display_name: string | null; upn: string | null }>(
      `SELECT id, display_name, upn FROM users WHERE id IN (${placeholders})`,
      ...ids
    )
    const names = new Map(nameRows.map((r) => [r.id, [r.display_name, r.upn] as const]))
    for (const d of top) {
      const [disp, upn] = names.get(d.user_id as string) ?? [null, null]
      d.display_name = disp || d.user_id
      d.upn = upn
    }
  }
  return top
}

export interface CreditAlertRecord {
  rule_key: string
  severity: string
  tier: string
  scope_type: string
  scope_id: string | null
  scope_label: string | null
  environment_name: string | null
  metric: number | null
  threshold: number | null
  baseline: number | null
  usage_date: string | null
  detail_json: string | null
}
export function upsertCreditAlerts(records: CreditAlertRecord[]): number {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  let newCount = 0
  for (const rec of records) {
    const id = createHash('sha1').update(`${rec.rule_key}|${rec.scope_id || ''}|${rec.usage_date || ''}`).digest('hex').slice(0, 32)
    const existing = get<{ id: string }>('SELECT id FROM credit_alerts WHERE id=?', id)
    if (!existing) newCount++
    run(
      `INSERT INTO credit_alerts(id,rule_key,severity,tier,scope_type,scope_id,scope_label,environment_name,metric,threshold,baseline,usage_date,detail_json,status,first_seen,last_seen)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
       ON CONFLICT(id) DO UPDATE SET severity=excluded.severity, metric=excluded.metric, threshold=excluded.threshold, baseline=excluded.baseline, scope_label=excluded.scope_label, environment_name=excluded.environment_name, detail_json=excluded.detail_json, last_seen=excluded.last_seen`,
      [
        id,
        rec.rule_key,
        rec.severity,
        rec.tier,
        rec.scope_type,
        rec.scope_id,
        rec.scope_label,
        rec.environment_name,
        rec.metric,
        rec.threshold,
        rec.baseline,
        rec.usage_date,
        rec.detail_json,
        now,
        now
      ]
    )
  }
  return newCount
}

export interface CreditAlert {
  rule_key: string
  severity: string
  tier: string
  scope_type: string
  scope_label: string | null
  environment_name: string | null
  metric: number | null
  threshold: number | null
  usage_date: string | null
  status: string
  last_seen: string
}
export function listCreditAlerts(status?: string): CreditAlert[] {
  const order = " ORDER BY (severity='danger') DESC, last_seen DESC LIMIT 200"
  if (status) {
    return all<CreditAlert>(`SELECT * FROM credit_alerts WHERE status=?${order}`, status)
  }
  return all<CreditAlert>(`SELECT * FROM credit_alerts${order}`)
}

export interface DataverseStatusDTO {
  kpis: { interactions: number; users: number; threads: number; apps: number }
  runs: Array<{
    id: number
    started: string
    trigger: string
    environments: number
    transcripts: number
    rows: number
    errors: number
    status: string
    log: string
  }>
}
export function dataverseStatus(): DataverseStatusDTO {
  const interactions = get<{ n: number }>("SELECT COUNT(*) n FROM interactions WHERE source_type='dataverse'")?.n ?? 0
  const users = get<{ n: number }>("SELECT COUNT(DISTINCT user_id) n FROM interactions WHERE source_type='dataverse'")?.n ?? 0
  const threads = get<{ n: number }>("SELECT COUNT(*) n FROM conversation_threads WHERE source_type='dataverse'")?.n ?? 0
  const apps = get<{ n: number }>("SELECT COUNT(DISTINCT app) n FROM interactions WHERE source_type='dataverse' AND app IS NOT NULL")?.n ?? 0
  const runRows = all<{
    id: number
    started_at: string
    finished_at: string | null
    trigger: string
    status: string
    error_count: number | null
    summary: string | null
    logs_json: string | null
  }>(
    "SELECT id, started_at, finished_at, trigger, status, error_count, summary, logs_json FROM collection_run_logs WHERE kind='transcripts' ORDER BY started_at DESC LIMIT 50"
  )
  const runs = runRows.map((r) => {
    let environments = 0
    let transcripts = 0
    let rows = 0
    try {
      const s = r.summary ? (JSON.parse(r.summary) as { environments?: number; transcripts?: number; rows?: number }) : {}
      environments = s.environments ?? 0
      transcripts = s.transcripts ?? 0
      rows = s.rows ?? 0
    } catch {
      /* ignore malformed summary */
    }
    let log = ''
    try {
      const lines = r.logs_json ? (JSON.parse(r.logs_json) as Array<{ at: string; text: string }>) : []
      log = lines.map((l) => `[${shortTime(l.at)}] ${l.text}`).join('\n')
    } catch {
      /* ignore malformed logs */
    }
    return {
      id: r.id,
      started: shortTime(r.started_at),
      trigger: r.trigger,
      environments,
      transcripts,
      rows,
      errors: r.error_count ?? 0,
      status: r.finished_at ? (r.status === 'error' || (r.error_count ?? 0) > 0 ? 'err' : 'ok') : 'run',
      log
    }
  })
  return { kpis: { interactions, users, threads, apps }, runs }
}

// ---- flow runs (Dataverse) ----------------------------------------------
export interface FlowRunRow {
  id: string
  environment_id: string | null
  environment_name: string | null
  workflow_id: string | null
  workflow_name: string | null
  modern_flow_type: number | null
  conversation_id: string | null
  bot_id: string | null
  owner_id: string | null
  owner_name: string | null
  status: string | null
  trigger_type: string | null
  start_time: string | null
  end_time: string | null
  duration_ms: number | null
  error_code: string | null
  error_message: string | null
  run_date: string | null
  created_on: string | null
  raw_json: string | null
}
export function upsertFlowRuns(rows: FlowRunRow[]): number {
  const now = new Date().toISOString()
  for (const r of rows) {
    run(
      `INSERT INTO flow_runs(id,environment_id,environment_name,workflow_id,workflow_name,modern_flow_type,conversation_id,bot_id,owner_id,owner_name,status,trigger_type,start_time,end_time,duration_ms,error_code,error_message,run_date,created_on,raw_json,captured_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, end_time=excluded.end_time, duration_ms=excluded.duration_ms, error_code=excluded.error_code, error_message=excluded.error_message, workflow_name=COALESCE(excluded.workflow_name, flow_runs.workflow_name), owner_name=COALESCE(excluded.owner_name, flow_runs.owner_name), raw_json=excluded.raw_json, captured_at=excluded.captured_at`,
      [
        r.id,
        r.environment_id,
        r.environment_name,
        r.workflow_id,
        r.workflow_name,
        r.modern_flow_type,
        r.conversation_id,
        r.bot_id,
        r.owner_id,
        r.owner_name,
        r.status,
        r.trigger_type,
        r.start_time,
        r.end_time,
        r.duration_ms,
        r.error_code,
        r.error_message,
        r.run_date,
        r.created_on,
        r.raw_json,
        now
      ]
    )
  }
  return rows.length
}
function flowStatusClass(status: string | null): string {
  const s = (status ?? '').toLowerCase()
  if (s === 'succeeded') return 'ok'
  if (s === 'failed') return 'err'
  if (s === 'running') return 'run'
  return 'idle'
}
export interface FlowRunsDTO {
  kpis: { runs: number; failed: number; flows: number; environments: number }
  recent: Array<{ time: string; flow: string; status: string; statusRaw: string; env: string; error?: string; raw?: string }>
}
export function flowRunsStatus(): FlowRunsDTO {
  const runs = get<{ n: number }>('SELECT COUNT(*) n FROM flow_runs')?.n ?? 0
  const failed = get<{ n: number }>("SELECT COUNT(*) n FROM flow_runs WHERE lower(status)='failed'")?.n ?? 0
  const flows = get<{ n: number }>('SELECT COUNT(DISTINCT workflow_id) n FROM flow_runs')?.n ?? 0
  const environments = get<{ n: number }>('SELECT COUNT(DISTINCT environment_id) n FROM flow_runs')?.n ?? 0
  const recent = all<{ start_time: string | null; created_on: string | null; workflow_name: string | null; status: string | null; environment_name: string | null; error_code: string | null; error_message: string | null; raw_json: string | null }>(
    'SELECT start_time, created_on, workflow_name, status, environment_name, error_code, error_message, raw_json FROM flow_runs ORDER BY COALESCE(start_time, created_on) DESC LIMIT 12'
  ).map((r) => ({
    time: shortTime(r.start_time || r.created_on || ''),
    flow: r.workflow_name || '—',
    status: flowStatusClass(r.status),
    statusRaw: r.status || '—',
    env: r.environment_name || '—',
    error: flowRunError(r.error_code, r.error_message),
    raw: r.raw_json ?? undefined
  }))
  return { kpis: { runs, failed, flows, environments }, recent }
}

/** Build a one-line failure reason from a flow run's error fields. The
 * Dataverse `errormessage` is usually a JSON blob ({code,message}); pull the
 * human message and prefix the code when present. */
function flowRunError(code: string | null, message: string | null): string | undefined {
  let msg = (message || '').trim()
  if (msg.startsWith('{')) {
    try {
      const o = JSON.parse(msg) as { message?: unknown }
      if (typeof o.message === 'string' && o.message.trim()) msg = o.message.trim()
    } catch {
      /* not JSON — keep raw */
    }
  }
  const c = (code || '').trim()
  if (c && msg) return `${c}: ${msg}`
  return c || msg || undefined
}

// ---- agent definitions (risk-scored) ------------------------------------
export interface AgentDefinitionRow {
  id: string
  environment_id: string | null
  environment_name: string | null
  bot_name: string | null
  schema_name: string | null
  state: string | null
  component_count: number
  has_trigger: boolean
  external_call_count: number
  tool_count: number
  loop_count: number
  knowledge_count: number
  generative_orchestration: boolean
  risk_score: number
  risk_band: string | null
  risk_factors_json: string | null
  created_by: string | null
  modified_by: string | null
  modified_on: string | null
}
export function upsertAgentDefinitions(rows: AgentDefinitionRow[]): number {
  const now = new Date().toISOString()
  for (const r of rows) {
    run(
      `INSERT INTO agent_definitions(id,environment_id,environment_name,bot_name,schema_name,state,component_count,has_trigger,external_call_count,tool_count,loop_count,knowledge_count,generative_orchestration,risk_score,risk_band,risk_factors_json,created_by,modified_by,modified_on,captured_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET environment_name=excluded.environment_name, bot_name=excluded.bot_name, schema_name=excluded.schema_name, state=excluded.state, component_count=excluded.component_count, has_trigger=excluded.has_trigger, external_call_count=excluded.external_call_count, tool_count=excluded.tool_count, loop_count=excluded.loop_count, knowledge_count=excluded.knowledge_count, generative_orchestration=excluded.generative_orchestration, risk_score=excluded.risk_score, risk_band=excluded.risk_band, risk_factors_json=excluded.risk_factors_json, modified_by=excluded.modified_by, modified_on=excluded.modified_on, captured_at=excluded.captured_at`,
      [
        r.id,
        r.environment_id,
        r.environment_name,
        r.bot_name,
        r.schema_name,
        r.state,
        r.component_count,
        r.has_trigger ? 1 : 0,
        r.external_call_count,
        r.tool_count,
        r.loop_count,
        r.knowledge_count,
        r.generative_orchestration ? 1 : 0,
        r.risk_score,
        r.risk_band,
        r.risk_factors_json,
        r.created_by,
        r.modified_by,
        r.modified_on,
        now
      ]
    )
  }
  return rows.length
}
export interface HighRiskAgent {
  id: string
  bot_name: string | null
  environment_name: string | null
  risk_score: number
  risk_band: string | null
  has_trigger: boolean
  external_call_count: number
  loop_count: number
}
export function highRiskAgents(minScore = 70): HighRiskAgent[] {
  return all<{
    id: string
    bot_name: string | null
    environment_name: string | null
    risk_score: number
    risk_band: string | null
    has_trigger: number
    external_call_count: number
    loop_count: number
  }>(
    'SELECT id, bot_name, environment_name, risk_score, risk_band, has_trigger, external_call_count, loop_count FROM agent_definitions WHERE risk_score >= ? ORDER BY risk_score DESC',
    minScore
  ).map((r) => ({ ...r, has_trigger: Boolean(r.has_trigger) }))
}
export interface AgentDefsDTO {
  kpis: { agents: number; high: number; triggers: number; environments: number }
  agents: Array<{ name: string; env: string; score: number; band: string; trigger: boolean; external: number; loops: number }>
}
export function agentDefsStatus(): AgentDefsDTO {
  const total = get<{ n: number }>('SELECT COUNT(*) n FROM agent_definitions')?.n ?? 0
  const high = get<{ n: number }>('SELECT COUNT(*) n FROM agent_definitions WHERE risk_score >= 50')?.n ?? 0
  const triggers = get<{ n: number }>('SELECT COUNT(*) n FROM agent_definitions WHERE has_trigger = 1')?.n ?? 0
  const environments = get<{ n: number }>('SELECT COUNT(DISTINCT environment_id) n FROM agent_definitions')?.n ?? 0
  const agents = all<{
    bot_name: string | null
    environment_name: string | null
    risk_score: number
    risk_band: string | null
    has_trigger: number
    external_call_count: number
    loop_count: number
  }>(
    'SELECT bot_name, environment_name, risk_score, risk_band, has_trigger, external_call_count, loop_count FROM agent_definitions ORDER BY risk_score DESC LIMIT 20'
  ).map((r) => ({
    name: r.bot_name || '(이름 없음)',
    env: r.environment_name || '—',
    score: Math.round(r.risk_score),
    band: r.risk_band || 'low',
    trigger: Boolean(r.has_trigger),
    external: r.external_call_count,
    loops: r.loop_count
  }))
  return { kpis: { agents: total, high, triggers, environments }, agents }
}
