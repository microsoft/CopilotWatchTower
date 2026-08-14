/**
 * Dataverse Copilot Studio transcript collector — port of services/dataverse.py.
 * Recovers Teams-channel (and other-channel) Copilot conversations that the
 * Graph `getAllEnterpriseInteractions` substrate misses. Uses per-environment
 * `*.crm.dynamics.com` bearer tokens captured from an interactive maker-portal
 * sign-in (portal.capturePortalTokens) + the Global Discovery Service.
 */
import * as db from '../db'
import { recomputeThreads } from '../threading'
import { analyzeAgent, parentBotId } from './agentRisk'
import type { PortalTokens } from '../portal'
import { httpRequest } from '../http'

const DISCOVERY_INSTANCES_URL = 'https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances'
const DISCOVERY_HOST = 'globaldisco.crm.dynamics.com'
const API_VERSION = 'v9.2'
const SOURCE_DATAVERSE = 'dataverse'
const TEAMS_CHANNEL_ID = 'msteams'
const USER_PROMPT = 'userPrompt'
const AI_RESPONSE = 'aiResponse'

type Dict = Record<string, unknown>

export interface DataverseEnvironment {
  id: string
  url: string
  friendlyName: string | null
}

// ---- parsers (HTTP-free, testable) -------------------------------------

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function normaliseTimestamp(value: unknown, fallback: string): string {
  if (value === null || value === undefined || typeof value === 'boolean') return fallback
  let epoch: number | null = null
  if (typeof value === 'number') epoch = value
  else if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d+$/.test(text)) epoch = Number(text)
    else return text || fallback
  }
  if (epoch === null) return fallback
  if (epoch >= 1e12) epoch /= 1000
  const d = new Date(epoch * 1000)
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString().replace(/\.\d+Z$/, 'Z')
}

function coerceActivities(content: unknown): Dict[] {
  let data = content
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return []
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const acts = (data as Dict).activities
    return Array.isArray(acts) ? (acts.filter((a) => a && typeof a === 'object') as Dict[]) : []
  }
  if (Array.isArray(data)) return data.filter((a) => a && typeof a === 'object') as Dict[]
  return []
}

function normaliseRole(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'number') return value === 1 ? 'user' : value === 0 ? 'bot' : ''
  const text = String(value).trim().toLowerCase()
  if (text === 'user' || text === 'bot') return text
  if (text === '1') return 'user'
  if (text === '0') return 'bot'
  return ''
}

function hasAadObjectId(sender: unknown): boolean {
  if (!sender || typeof sender !== 'object') return false
  const s = sender as Dict
  return Boolean(s.aadObjectId || s.aadobjectid)
}

function activityRole(activity: Dict): string {
  const sender = (activity.from as Dict) || {}
  if (hasAadObjectId(sender)) return USER_PROMPT
  const role = normaliseRole(typeof sender === 'object' ? sender.role : null)
  if (role === 'user') return USER_PROMPT
  if (role === 'bot') return AI_RESPONSE
  const recipient = (activity.recipient as Dict) || {}
  const rrole = normaliseRole(typeof recipient === 'object' ? recipient.role : null)
  if (rrole === 'bot') return USER_PROMPT
  if (rrole === 'user') return AI_RESPONSE
  return USER_PROMPT
}

function participantId(activity: Dict): [string, string | null] {
  const sender = (activity.from as Dict) || {}
  if (!sender || typeof sender !== 'object') return ['dataverse:unknown', null]
  const aad = sender.aadObjectId || sender.aadobjectid
  const raw = aad || sender.id || 'unknown'
  const name = sender.name
  return [`dataverse:${String(raw)}`, name ? String(name) : null]
}

export interface ParsedTranscript {
  rows: db.InteractionUpsert[]
  participants: Map<string, string>
  activitiesSeen: number
  skippedNonTeams: number
}

export function parseConversationTranscript(
  content: unknown,
  opts: { transcriptId: string; environmentId: string; agentId?: string | null; agentName?: string | null; fetchedAt?: string; teamsOnly?: boolean }
): ParsedTranscript {
  const fetchedAt = opts.fetchedAt || isoNow()
  const activities = coerceActivities(content)
  const result: ParsedTranscript = { rows: [], participants: new Map(), activitiesSeen: 0, skippedNonTeams: 0 }
  if (!activities.length) return result

  let humanUserId = 'dataverse:unknown'
  let humanName: string | null = null
  const aadActivity = activities.find((a) => hasAadObjectId(a.from))
  if (aadActivity) {
    ;[humanUserId, humanName] = participantId(aadActivity)
  } else {
    const userActivity = activities.find((a) => activityRole(a) === USER_PROMPT)
    if (userActivity) [humanUserId, humanName] = participantId(userActivity)
  }

  const seen = new Set<string>()
  activities.forEach((activity, idx) => {
    if (String(activity.type ?? '').toLowerCase() !== 'message') return
    result.activitiesSeen++
    const text = activity.text
    if (typeof text !== 'string' || !text.trim()) return
    const channelId = String(activity.channelId ?? '').trim()
    if (opts.teamsOnly && channelId.toLowerCase() !== TEAMS_CHANNEL_ID) {
      result.skippedNonTeams++
      return
    }
    const conversation = (activity.conversation as Dict) || {}
    const sessionId =
      conversation && typeof conversation === 'object' && conversation.id ? String(conversation.id) : opts.transcriptId
    const activityId = String(activity.id ?? `${idx}`)
    const rowId = `dataverse:${opts.transcriptId}:${activityId}:${idx}`
    if (seen.has(rowId)) return
    seen.add(rowId)
    const createdAt = normaliseTimestamp(activity.timestamp ?? activity.localTimestamp, fetchedAt)
    result.rows.push({
      id: rowId,
      userId: humanUserId,
      sessionId,
      requestId: activityId,
      createdAt,
      interactionType: activityRole(activity),
      app: channelId || null,
      bodyText: text,
      bodyContentType: 'text',
      attachmentsJson: null,
      rawJson: JSON.stringify({
        source: 'dataverse',
        environment_id: opts.environmentId,
        agent_id: opts.agentId ?? null,
        agent_name: opts.agentName ?? null,
        channel_id: channelId,
        activity
      }),
      sourceType: SOURCE_DATAVERSE
    })
  })

  if (humanUserId !== 'dataverse:unknown') {
    result.participants.set(humanUserId, humanName || humanUserId)
  } else if (result.rows.length) {
    result.participants.set(humanUserId, '(알 수 없는 사용자)')
  }
  return result
}

export function parseEnvironmentsJson(data: unknown): DataverseEnvironment[] {
  const items = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as Dict).value : null
  if (!Array.isArray(items)) return []
  const envs: DataverseEnvironment[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const it = item as Dict
    const rawUrl = it.ApiUrl || it.apiUrl || it.Url || it.url || ''
    let url = String(rawUrl).trim()
    if (!url) continue
    try {
      const u = new URL(url)
      url = `${u.protocol}//${u.host}`
    } catch {
      url = url.replace(/\/+$/, '')
    }
    if (!url || seen.has(url)) continue
    seen.add(url)
    const id = String(it.Id || it.id || it.EnvironmentId || it.environmentId || url)
    const name = it.FriendlyName || it.friendlyName || it.UniqueName || it.uniqueName
    envs.push({ id, url, friendlyName: name ? String(name) : null })
  }
  return envs
}

// ---- HTTP client -------------------------------------------------------

async function getJson(url: string, token: string, prefer = 'odata.maxpagesize=200'): Promise<Dict> {
  const res = await httpRequest(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: prefer
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Dataverse ${res.status} ${url.slice(0, 80)} :: ${body.slice(0, 160)}`)
  }
  const text = await res.text()
  if (!text.trim()) return {} as Dict
  try {
    return JSON.parse(text) as Dict
  } catch {
    throw new Error(`Dataverse ${url.slice(0, 80)} :: expected JSON, got ${text.slice(0, 160)}`)
  }
}

async function discoverEnvironments(token: string): Promise<DataverseEnvironment[]> {
  return parseEnvironmentsJson(await getJson(DISCOVERY_INSTANCES_URL, token))
}

/** Resolve the environments to collect. Prefer Global Discovery (a single token
 * enumerates every org); when that token was not captured — the maker portal now
 * enumerates via BAP and only mints per-org Dataverse tokens — fall back to the
 * captured ``*.crm.dynamics.com`` org tokens and query each org directly. */
async function resolveEnvironments(
  tokens: PortalTokens,
  onLog?: (line: string) => void
): Promise<DataverseEnvironment[]> {
  const globaldisco = tokens[DISCOVERY_HOST]
  if (globaldisco) {
    const envs = await discoverEnvironments(globaldisco)
    onLog?.(`환경 ${envs.length}개 발견 (Global Discovery)`)
    return envs
  }
  const orgHosts = Object.keys(tokens).filter(
    (h) => h.includes('.crm') && h.includes('.dynamics.com') && h !== DISCOVERY_HOST
  )
  if (!orgHosts.length) {
    throw new Error('Dataverse 토큰을 캡처하지 못했습니다. 포털 로그인 또는 환경 접근 권한을 확인하세요.')
  }
  onLog?.(`환경 ${orgHosts.length}개 (캡처된 org 토큰 사용 — Global Discovery 건너뜀)`)
  return orgHosts.map((host) => ({ id: host, url: `https://${host}`, friendlyName: host }))
}

type OnLog = (line: string) => void

/**
 * Paging stops at `maxPages` to bound a runaway collection. Truncation used to
 * be silent, so a partial dataset was indistinguishable from a complete one —
 * unacceptable for a governance report. Always say so out loud.
 */
function warnTruncated(onLog: OnLog | undefined, label: string, pages: number, rows: number): void {
  onLog?.(
    `⚠ ${label}: ${pages} 페이지(${rows} 행)에서 중단했습니다 — 결과가 잘렸을 수 있습니다. 기간/필터를 좁혀 다시 수집하세요.`
  )
}

async function fetchTranscripts(
  env: DataverseEnvironment,
  token: string,
  onLog?: OnLog,
  maxPages = 50
): Promise<Dict[]> {
  const base = env.url.replace(/\/+$/, '')
  let url: string | null =
    `${base}/api/data/${API_VERSION}/conversationtranscripts?$select=conversationtranscriptid,content,createdon,name,schematype,_botid_value`
  const out: Dict[] = []
  let pages = 0
  while (url && pages < maxPages) {
    const data = await getJson(url, token)
    for (const r of (data.value as Dict[]) ?? []) out.push(r)
    url = (data['@odata.nextLink'] as string) ?? null
    pages++
  }
  if (url) warnTruncated(onLog, `${env.friendlyName || env.id} conversationtranscripts`, pages, out.length)
  return out
}

/** Map each Copilot Studio agent's botid → display name for the environment, so
 * transcripts can be attributed to the agent they belong to (bot lookup). */
async function fetchBots(env: DataverseEnvironment, token: string): Promise<Map<string, string>> {
  const base = env.url.replace(/\/+$/, '')
  const map = new Map<string, string>()
  try {
    const data = await getJson(`${base}/api/data/${API_VERSION}/bots?$select=botid,name,schemaname`, token)
    for (const b of (data.value as Dict[]) ?? []) {
      const name = b.name != null ? String(b.name) : ''
      if (!name) continue
      if (b.botid != null) map.set(String(b.botid).toLowerCase(), name)
      if (b.schemaname != null) map.set(String(b.schemaname).toLowerCase(), name)
    }
  } catch {
    /* bots unreadable — agent names just stay unresolved */
  }
  return map
}

// ---- orchestration -----------------------------------------------------

export interface TranscriptCollectResult {
  environments: number
  transcripts: number
  rows: number
  errors: number
}

export async function collectTranscripts(
  tokens: PortalTokens,
  teamsOnly: boolean,
  onLog?: (line: string) => void
): Promise<TranscriptCollectResult> {
  const envs = await resolveEnvironments(tokens, onLog)
  const result: TranscriptCollectResult = { environments: 0, transcripts: 0, rows: 0, errors: 0 }

  for (const env of envs) {
    let host = ''
    try {
      host = new URL(env.url).host.toLowerCase()
    } catch {
      host = ''
    }
    const token = host ? tokens[host] : undefined
    const label = env.friendlyName || host || env.id
    if (!token) {
      onLog?.(`${label}: 토큰 없음 — 포털에서 이 환경을 열면 수집됩니다.`)
      continue
    }
    try {
      const transcripts = await fetchTranscripts(env, token, onLog)
      result.transcripts += transcripts.length
      const bots = await fetchBots(env, token)
      const interactions: db.InteractionUpsert[] = []
      const participants = new Map<string, string>()
      let skippedNonTeams = 0
      for (const t of transcripts) {
        const agentId = t._botid_value != null ? String(t._botid_value) : null
        const agentName = agentId ? bots.get(agentId.toLowerCase()) ?? null : null
        const parsed = parseConversationTranscript(t.content, {
          transcriptId: String(t.conversationtranscriptid ?? ''),
          environmentId: env.id,
          agentId,
          agentName,
          teamsOnly
        })
        for (const r of parsed.rows) interactions.push(r)
        for (const [id, name] of parsed.participants) participants.set(id, name)
        skippedNonTeams += parsed.skippedNonTeams
      }
      if (participants.size) {
        db.upsertUsers([...participants].map(([id, name]) => ({ id, upn: null, displayName: name, enabled: true })))
      }
      if (interactions.length) {
        db.upsertInteractions(interactions)
        result.rows += interactions.length
        for (const id of participants.keys()) recomputeThreads(id, SOURCE_DATAVERSE)
      }
      result.environments++
      onLog?.(`${label}: 대화 ${transcripts.length}건 → 턴 ${interactions.length}개`)
      if (teamsOnly && interactions.length === 0 && skippedNonTeams > 0) {
        onLog?.(
          `  ↳ ${label}: Teams 채널 외 메시지 ${skippedNonTeams}건을 제외했습니다. ‘Teams 채널만 수집’을 끄면 모두 수집됩니다.`
        )
      }
    } catch (e) {
      result.errors++
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Dataverse 403') || msg.includes('0x80040220') || msg.includes('Principal user')) {
        onLog?.(
          `${label}: 접근 권한 부족(403) — “나를 시스템 관리자로 자동 추가” 옵션을 켜고 다시 수집하거나, 해당 환경에서 다운로드 계정에 대화 기록 읽기 권한이 있는 보안 역할을 부여하세요.`
        )
      } else {
        onLog?.(`${label}: 오류 ${msg}`)
      }
    }
  }
  return result
}

// ---- flow runs ---------------------------------------------------------

const FORMATTED = '@OData.Community.Display.V1.FormattedValue'
const FLOW_RUN_SELECT =
  'flowrunid,name,status,starttime,endtime,duration,errorcode,errormessage,modernflowtype,conversationid,triggertype,createdon,_workflow_value,_ownerid_value'

function str_(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const t = String(v).trim()
  return t || null
}
function int_(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const num = Number(v)
  return Number.isFinite(num) ? Math.trunc(num) : null
}
function datePart_(v: unknown): string | null {
  const t = str_(v)
  return t ? t.split('T', 1)[0] : null
}

export function parseFlowRunRecord(record: Dict, environmentId: string | null, environmentName: string | null): db.FlowRunRow | null {
  const runId = str_(record.flowrunid) || str_(record.name)
  if (!runId) return null
  const startTime = str_(record.starttime)
  const createdOn = str_(record.createdon)
  return {
    id: runId,
    environment_id: environmentId,
    environment_name: environmentName,
    workflow_id: str_(record._workflow_value) || str_(record.workflowid),
    workflow_name: str_(record[`_workflow_value${FORMATTED}`]),
    modern_flow_type: int_(record.modernflowtype),
    conversation_id: str_(record.conversationid),
    bot_id: null,
    owner_id: str_(record._ownerid_value),
    owner_name: str_(record[`_ownerid_value${FORMATTED}`]),
    status: str_(record.status),
    trigger_type: str_(record.triggertype),
    start_time: startTime,
    end_time: str_(record.endtime),
    duration_ms: int_(record.duration),
    error_code: str_(record.errorcode),
    error_message: str_(record.errormessage),
    run_date: datePart_(startTime || createdOn),
    created_on: createdOn,
    raw_json: JSON.stringify(record)
  }
}

async function fetchFlowRuns(
  env: DataverseEnvironment,
  token: string,
  onLog?: OnLog,
  maxPages = 50
): Promise<Dict[]> {
  const base = env.url.replace(/\/+$/, '')
  let url: string | null = `${base}/api/data/${API_VERSION}/flowruns?$select=${FLOW_RUN_SELECT}&$orderby=createdon desc`
  const out: Dict[] = []
  let pages = 0
  while (url && pages < maxPages) {
    const data = await getJson(url, token, 'odata.maxpagesize=200,odata.include-annotations="*"')
    for (const r of (data.value as Dict[]) ?? []) out.push(r)
    url = (data['@odata.nextLink'] as string) ?? null
    pages++
  }
  if (url) warnTruncated(onLog, `${env.friendlyName || env.id} flowruns`, pages, out.length)
  return out
}

export interface FlowRunCollectResult {
  environments: number
  runs: number
  errors: number
}

export async function collectFlowRuns(tokens: PortalTokens, onLog?: (line: string) => void): Promise<FlowRunCollectResult> {
  const envs = await resolveEnvironments(tokens, onLog)
  const result: FlowRunCollectResult = { environments: 0, runs: 0, errors: 0 }
  for (const env of envs) {
    let host = ''
    try {
      host = new URL(env.url).host.toLowerCase()
    } catch {
      host = ''
    }
    const token = host ? tokens[host] : undefined
    const label = env.friendlyName || host || env.id
    if (!token) {
      onLog?.(`${label}: 토큰 없음 — 포털에서 이 환경을 열면 수집됩니다.`)
      continue
    }
    try {
      const records = await fetchFlowRuns(env, token, onLog)
      const rows = records
        .map((r) => parseFlowRunRecord(r, env.id, env.friendlyName))
        .filter((r): r is db.FlowRunRow => r !== null)
      if (rows.length) db.upsertFlowRuns(rows)
      result.runs += rows.length
      result.environments++
      onLog?.(`${label}: 플로우 실행 ${rows.length}건`)
    } catch (e) {
      result.errors++
      onLog?.(`${label}: 오류 ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

// ---- agent definitions (bot components → risk score) -------------------

const BOT_SELECT_BASE = 'botid,name,schemaname,statecode,createdon,modifiedon,_modifiedby_value,_createdby_value'
// authenticationmode powers the "unauthenticated access" finding. It is appended
// separately because an unknown $select column fails the entire OData query, and
// not every environment exposes it — fetchBots() falls back when that happens.
const BOT_SELECT = `${BOT_SELECT_BASE},authenticationmode`
const BOTCOMPONENT_SELECT =
  'botcomponentid,name,componenttype,schemaname,statecode,componentstate,modifiedon,_parentbotid_value,content,data'

async function fetchEntity(
  env: DataverseEnvironment,
  token: string,
  entitySet: string,
  opts: { select?: string; top?: number; includeFormatted?: boolean; maxPages?: number; onLog?: OnLog }
): Promise<Dict[]> {
  const base = env.url.replace(/\/+$/, '')
  const params = new URLSearchParams()
  if (opts.select) params.set('$select', opts.select)
  if (opts.top) params.set('$top', String(opts.top))
  const qs = params.toString()
  let url: string | null = `${base}/api/data/${API_VERSION}/${entitySet}${qs ? `?${qs}` : ''}`
  const prefer = opts.includeFormatted
    ? 'odata.maxpagesize=200,odata.include-annotations="*"'
    : 'odata.maxpagesize=200'
  const out: Dict[] = []
  let pages = 0
  const max = opts.maxPages ?? 50
  while (url && pages < max) {
    const data = await getJson(url, token, prefer)
    for (const r of (data.value as Dict[]) ?? []) out.push(r)
    url = (data['@odata.nextLink'] as string) ?? null
    pages++
  }
  if (url) warnTruncated(opts.onLog, `${env.friendlyName || env.id} ${entitySet}`, pages, out.length)
  return out
}

function stateLabel(bot: Dict): string | null {
  const formatted = bot[`statecode${FORMATTED}`]
  if (formatted) return String(formatted)
  const code = bot.statecode
  if (code === 0) return 'Active'
  if (code === 1) return 'Inactive'
  return null
}

/** Dataverse ``bot.authenticationmode``; null when the column was not returned. */
function authModeOf(bot: Dict): number | null {
  const raw = bot.authenticationmode
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Fetch bots with the auth column, degrading to the base column set when the
 * environment rejects it, so one unsupported field can never zero out an
 * environment's inventory.
 */
async function fetchBotDefinitions(env: DataverseEnvironment, token: string, label: string, onLog?: OnLog): Promise<Dict[]> {
  try {
    return await fetchEntity(env, token, 'bots', { select: BOT_SELECT, includeFormatted: true, maxPages: 20, onLog })
  } catch {
    onLog?.(`${label}: authenticationmode 미지원 — 기본 필드로 재시도`)
    return await fetchEntity(env, token, 'bots', {
      select: BOT_SELECT_BASE,
      includeFormatted: true,
      maxPages: 20,
      onLog
    })
  }
}

export interface AgentDefCollectResult {
  environments: number
  agents: number
  errors: number
}

export async function collectAgentDefinitions(tokens: PortalTokens, onLog?: (line: string) => void): Promise<AgentDefCollectResult> {
  const envs = await resolveEnvironments(tokens, onLog)
  const result: AgentDefCollectResult = { environments: 0, agents: 0, errors: 0 }
  for (const env of envs) {
    let host = ''
    try {
      host = new URL(env.url).host.toLowerCase()
    } catch {
      host = ''
    }
    const token = host ? tokens[host] : undefined
    const label = env.friendlyName || host || env.id
    if (!token) {
      onLog?.(`${label}: 토큰 없음 — 포털에서 이 환경을 열면 수집됩니다.`)
      continue
    }
    try {
      const bots = await fetchBotDefinitions(env, token, label, onLog)
      if (!bots.length) {
        onLog?.(`${label}: 에이전트 없음`)
        continue
      }
      const components = await fetchEntity(env, token, 'botcomponents', {
        select: BOTCOMPONENT_SELECT,
        top: 5000,
        maxPages: 50,
        onLog
      })
      const byBot = new Map<string, Dict[]>()
      for (const c of components) {
        const parent = parentBotId(c)
        if (parent) {
          let g = byBot.get(parent)
          if (!g) {
            g = []
            byBot.set(parent, g)
          }
          g.push(c)
        }
      }
      const rows: db.AgentDefinitionRow[] = []
      for (const bot of bots) {
        const botId = String(bot.botid ?? '').trim()
        if (!botId) continue
        const profile = analyzeAgent(byBot.get(botId) ?? [], { authenticationMode: authModeOf(bot) })
        rows.push({
          id: botId,
          environment_id: env.id,
          environment_name: env.friendlyName,
          bot_name: str_(bot.name),
          schema_name: str_(bot.schemaname),
          state: stateLabel(bot),
          component_count: profile.componentCount,
          has_trigger: profile.hasTrigger,
          external_call_count: profile.externalCallCount,
          tool_count: profile.toolCount,
          loop_count: profile.loopCount,
          knowledge_count: profile.knowledgeCount,
          generative_orchestration: profile.generativeOrchestration,
          risk_score: profile.score,
          risk_band: profile.band,
          risk_factors_json: profile.factorsJson,
          risk_findings_json: profile.findingsJson,
          created_by: str_(bot[`_createdby_value${FORMATTED}`]),
          modified_by: str_(bot[`_modifiedby_value${FORMATTED}`]),
          modified_on: str_(bot.modifiedon)
        })
      }
      if (rows.length) db.upsertAgentDefinitions(rows)
      result.agents += rows.length
      result.environments++
      onLog?.(`${label}: 에이전트 ${rows.length}개 점수화`)
    } catch (e) {
      result.errors++
      onLog?.(`${label}: 오류 ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}
