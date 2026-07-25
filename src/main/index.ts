import { app, BrowserWindow, ipcMain as electronIpcMain, shell, dialog, type IpcMainInvokeEvent } from 'electron'
import { join, dirname } from 'path'
import { pathToFileURL } from 'node:url'
import * as realdb from './db'
import * as profiles from './profiles'
import { hasCredentials, resetAuth } from './auth'
import {
  runCollection,
  runConversationCollection,
  runAuditCollection,
  runUsageCollection,
  runDiagnosticsCollection
} from './collector'
import { onboard } from './onboard'
import { captureBearerToken, captureDataverseTokens, downloadViaBrowser } from './portal'
import { dpapiProtect, dpapiUnprotect } from './secrets'
import { collectConsumption } from './collectors/consumption'
import {
  type CapabilityProfile,
  KIND_REQUIRED_CAPABILITY,
  PRESETS,
  PRESET_CUSTOM,
  allowsKind,
  defaultUnconfiguredProfile,
  profileFromPreset,
  profileFromSettings,
  profileFromToggles,
  suggestFromSkus
} from './capabilities'
import { listSubscribedSkus } from './graph'
import { collectTranscripts, collectFlowRuns, collectAgentDefinitions } from './collectors/dataverse'
import { parseExportPackage } from './collectors/ediscoveryExport'
import { runEdiscoveryJob } from './collectors/ediscovery'
import { randomUUID } from 'node:crypto'
import { recomputeThreads } from './threading'
import { evaluateCreditAlerts } from './collectors/creditAlerts'
import { collectPurview } from './collectors/audit'
import type { EventChannel, InvokeChannel } from '../shared/ipc'
import { isAllowedPrimaryNavigation, isSafeExternalUrl } from './windowSecurity'
import { toCsv } from './csv'

/**
 * Real backend. Channel names mirror the Python bridge surface
 * (``ALLOWED_METHODS`` in the PySide6 app) so the renderer contract stays the
 * same. There is no demo data: a profile with nothing collected shows an empty
 * app (zeros / empty tables), never placeholder numbers.
 */

let collecting = false
let onboarding = false
let consuming = false
let collectingTranscripts = false
let collectingFlowRuns = false
let collectingAgentDefs = false
let collectingConversation = false
let collectingAudit = false
let collectingUsage = false
let collectingDiagnostics = false
let collectingEdiscovery = false
let stopEdiscovery = false
let purviewAttributionTimer: ReturnType<typeof setTimeout> | null = null

const ipcMain = {
  handle(channel: InvokeChannel, listener: Parameters<typeof electronIpcMain.handle>[1]): void {
    electronIpcMain.handle(channel, listener)
  }
}

function sendEvent(event: IpcMainInvokeEvent, channel: EventChannel, payload: unknown): void {
  if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Log a diagnostic without leaking PII. Graph/Dataverse errors routinely carry
 * response bodies containing UPNs, prompts and tokens, so only the message text
 * ever reaches stdout — never the raw error object.
 */
function logError(context: string, e: unknown): void {
  console.error(`${context}: ${errMsg(e)}`)
}

function schedulePurviewAttribution(delayMs = 10_000): void {
  if (purviewAttributionTimer) clearTimeout(purviewAttributionTimer)
  purviewAttributionTimer = setTimeout(() => void recoverPurviewAttribution(), delayMs)
}

async function recoverPurviewAttribution(): Promise<void> {
  purviewAttributionTimer = null
  if (!realdb.dbReady() || !hasCredentials() || !realdb.apiInteractionBounds()) {
    schedulePurviewAttribution(900_000)
    return
  }
  if (collecting || collectingConversation || collectingAudit || collectingDiagnostics || collectingUsage) {
    schedulePurviewAttribution(30_000)
    return
  }

  collectingAudit = true
  try {
    const outcome = await collectPurview()
    if (outcome.pending) schedulePurviewAttribution(30_000)
    else if (outcome.coverageComplete) schedulePurviewAttribution(900_000)
    else if (outcome.error) schedulePurviewAttribution(900_000)
    else schedulePurviewAttribution(5_000)
  } catch (e) {
    logError('Purview agent attribution recovery failed', e)
    schedulePurviewAttribution(900_000)
  } finally {
    collectingAudit = false
  }
}

// ---- license capability gating (port of capabilities.py) ------------------
function loadCapabilityProfile(): CapabilityProfile {
  const raw = realdb.getSettingText('capabilities_json')
  if (!raw) return defaultUnconfiguredProfile()
  try {
    return profileFromSettings(JSON.parse(raw))
  } catch {
    return defaultUnconfiguredProfile()
  }
}
/** Returns a soft-error result when a gated collection kind is not licensed. */
function capabilityGate(kind: string): { ok: false; error: string; capability: string } | null {
  if (allowsKind(loadCapabilityProfile(), kind)) return null
  return { ok: false, error: 'license-required', capability: KIND_REQUIRED_CAPABILITY[kind] }
}
function registerHandlers(): void {
  realdb.openDb()

  // Real data only. With no profile DB open we return empty/zero shapes — never
  // demo data — so a freshly created profile shows an empty app.
  const arr = (real: () => unknown[]): unknown[] => {
    if (!realdb.dbReady()) return []
    try {
      return real()
    } catch (e) {
      logError('ipc-handler', e)
      return []
    }
  }
  const obj = <T>(real: () => T): T | null => {
    if (!realdb.dbReady()) return null
    try {
      return real()
    } catch (e) {
      logError('ipc-handler', e)
      return null
    }
  }

  ipcMain.handle('system_info', () => realdb.systemInfo())
  ipcMain.handle('dashboard_summary', () => obj(() => realdb.dashboardSummary()))
  ipcMain.handle('conversations_recent', () => arr(() => realdb.conversations(6)))
  ipcMain.handle('conversations_all', (_e, filters: unknown) => {
    const f: realdb.ConvFilters =
      typeof filters === 'string'
        ? { source: filters }
        : filters && typeof filters === 'object'
          ? (filters as realdb.ConvFilters)
          : {}
    // Source-scoped views return real (possibly empty) data — no shared mock fallback.
    if (f.source) {
      if (!realdb.dbReady()) return []
      try {
        return realdb.conversations({ limit: 2000, ...f })
      } catch (e) {
        logError('conversations_all', e)
        return []
      }
    }
    return arr(() => realdb.conversations({ limit: 2000 }))
  })
  ipcMain.handle('conversation_agent_facets', (_e, filters: unknown) => {
    if (!realdb.dbReady()) return []
    const f = filters && typeof filters === 'object' ? (filters as realdb.ConvFilters) : {}
    try {
      return realdb.conversationAgentFacets(f)
    } catch (e) {
      logError('conversation_agent_facets', e)
      return []
    }
  })
  ipcMain.handle('conversation_user_facets', (_e, filters: unknown) => {
    if (!realdb.dbReady()) return []
    const f = filters && typeof filters === 'object' ? (filters as realdb.ConvFilters) : {}
    try {
      return realdb.conversationUserFacets(f)
    } catch (e) {
      logError('conversation_user_facets', e)
      return []
    }
  })
  ipcMain.handle('conversation_page', (_e, filters: unknown) => {
    const f = filters && typeof filters === 'object' ? (filters as realdb.ConvFilters) : {}
    if (!realdb.dbReady()) return { rows: [], total: 0, limit: f.limit ?? 50, offset: f.offset ?? 0 }
    try {
      return realdb.conversationPage(f)
    } catch (e) {
      logError('conversation_page', e)
      return { rows: [], total: 0, limit: f.limit ?? 50, offset: f.offset ?? 0 }
    }
  })
  ipcMain.handle('conversation_users', (_e, source: unknown) => {
    if (!realdb.dbReady()) return []
    try {
      return realdb.conversationUsers(String(source || 'api'))
    } catch {
      return []
    }
  })
  ipcMain.handle('conversation_apps', (_e, source: unknown) => {
    if (!realdb.dbReady()) return []
    try {
      return realdb.conversationApps(String(source || 'api'))
    } catch {
      return []
    }
  })
  ipcMain.handle('insights_data', (_e, filters: unknown) => {
    const f: realdb.InsightsFilters =
      filters && typeof filters === 'object' ? (filters as realdb.InsightsFilters) : {}
    if (!realdb.dbReady())
      return { kpis: { activeUsers: 0, totalUsers: 0, threads: 0, messages: 0, prompts: 0, topApp: null, topAppMessages: 0 }, trend: [], apps: [], users: [] }
    try {
      return realdb.insightsData(f)
    } catch (e) {
      logError('insights_data', e)
      return { kpis: { activeUsers: 0, totalUsers: 0, threads: 0, messages: 0, prompts: 0, topApp: null, topAppMessages: 0 }, trend: [], apps: [], users: [] }
    }
  })
  ipcMain.handle('insights_users', (_e, source: unknown) => {
    if (!realdb.dbReady()) return []
    try {
      return realdb.insightsUsers(typeof source === 'string' ? source : undefined)
    } catch {
      return []
    }
  })
  ipcMain.handle('insights_apps', (_e, source: unknown) => {
    if (!realdb.dbReady()) return []
    try {
      return realdb.insightsApps(typeof source === 'string' ? source : undefined)
    } catch {
      return []
    }
  })
  ipcMain.handle('top_agents', () => arr(() => realdb.topAgents(5)))
  ipcMain.handle('agents_all', () => arr(() => realdb.topAgents(40)))
  ipcMain.handle('agents_overview', (_e, filters: unknown) => {
    const f: realdb.AgentFilters =
      filters && typeof filters === 'object' ? (filters as realdb.AgentFilters) : {}
    if (!realdb.dbReady())
      return { kpis: { total: 0, active: 0, stale: 0, neverUsed: 0, usageEvents: 0, thresholdDays: f.thresholdDays ?? 30 }, agents: [] }
    try {
      return realdb.agentsOverview(f)
    } catch (e) {
      logError('agents_overview', e)
      return { kpis: { total: 0, active: 0, stale: 0, neverUsed: 0, usageEvents: 0, thresholdDays: f.thresholdDays ?? 30 }, agents: [] }
    }
  })
  ipcMain.handle('agent_identity_events', () => {
    if (!realdb.dbReady()) return []
    try {
      return realdb.agentIdentityEvents(200)
    } catch {
      return []
    }
  })
  ipcMain.handle('conversation_thread', (_e, id: unknown) => {
    try {
      return realdb.conversationThread(String(id))
    } catch {
      return []
    }
  })

  const real = <T>(fn: () => T): T | null => {
    if (!realdb.dbReady()) return null
    try {
      return fn()
    } catch (e) {
      logError('ipc-handler', e)
      return null
    }
  }
  ipcMain.handle('security_overview', () => real(() => realdb.securityOverview()))
  ipcMain.handle('security_events', (_e, filters: unknown) => {
    const f: realdb.AuditFilters =
      filters && typeof filters === 'object' ? (filters as realdb.AuditFilters) : {}
    if (!realdb.dbReady())
      return { kpis: { total: 0, blocked: 0, uniqueUsers: 0, topOperation: null, topOperationCount: 0 }, events: [] }
    try {
      return realdb.securityEvents(f)
    } catch (e) {
      logError('security_events', e)
      return { kpis: { total: 0, blocked: 0, uniqueUsers: 0, topOperation: null, topOperationCount: 0 }, events: [] }
    }
  })
  ipcMain.handle('credits_overview', () => real(() => realdb.creditsOverview()))
  ipcMain.handle('consumption_explorer', () => {
    if (!realdb.dbReady()) return null
    try {
      return realdb.consumptionExplorer()
    } catch (e) {
      logError('consumption_explorer', e)
      return null
    }
  })
  ipcMain.handle('alert_rules', () => real(() => realdb.alertRules()))
  ipcMain.handle('collect_overview', () => real(() => realdb.collectOverview()))
  ipcMain.handle('ediscovery_overview', () => real(() => realdb.ediscoveryOverview()))
  ipcMain.handle('ediscovery_import', async (event, targetUpns: unknown) => {
    const upns = (Array.isArray(targetUpns) ? targetUpns.map(String) : String(targetUpns ?? '').split(/[\n,;]+/))
      .map((u) => u.trim())
      .filter(Boolean)
    if (!upns.length) return { ok: false, error: 'no-upn' }
    const fs = await import('node:fs')
    const log = (message: string): void => {
      sendEvent(event, 'ediscovery_progress', { message })
    }
    const results: Array<{ upn: string; rows: number; error?: string }> = []
    let totalRows = 0
    for (let i = 0; i < upns.length; i++) {
      const upn = upns[i]
      log(`[${i + 1}/${upns.length}] ${upn}: 패키지 파일을 선택하세요…`)
      const res = await dialog.showOpenDialog({
        title: `eDiscovery 패키지 선택 — ${upn} (${i + 1}/${upns.length})`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (res.canceled || !res.filePaths[0]) {
        results.push({ upn, rows: 0, error: 'canceled' })
        log(`[${i + 1}/${upns.length}] ${upn}: 건너뜀(취소)`)
        continue
      }
      try {
        const buf = fs.readFileSync(res.filePaths[0])
        const userId = `ediscovery:${upn.toLowerCase()}`
        realdb.upsertUsers([{ id: userId, upn, displayName: upn.split('@')[0], enabled: true }])
        const rows = parseExportPackage(buf, userId)
        if (rows.length) {
          realdb.upsertInteractions(rows)
          recomputeThreads(userId, 'ediscovery')
        }
        totalRows += rows.length
        results.push({ upn, rows: rows.length })
        log(`[${i + 1}/${upns.length}] ${upn}: ${rows.length}개 턴 가져옴`)
      } catch (e) {
        results.push({ upn, rows: 0, error: errMsg(e) })
        log(`[${i + 1}/${upns.length}] ${upn}: 오류 ${errMsg(e)}`)
      }
    }
    return { ok: true, totalRows, users: results.filter((r) => !r.error).length, results }
  })

  // Automated Purview eDiscovery collection (delegated device-code auth).
  ipcMain.handle('ediscovery_collect_start', async (event, payload: unknown) => {
    if (collectingEdiscovery) return { ok: false, error: 'already-running' }
    const p = (payload && typeof payload === 'object' ? payload : {}) as {
      upn?: string
      start?: string
      end?: string
      jobId?: string
    }
    const tenantId = realdb.getSettingText('tenant_id')
    if (!tenantId) return { ok: false, error: 'no-tenant' }
    let job: realdb.EdiscoveryJob | null
    if (p.jobId) {
      job = realdb.getEdiscoveryJob(String(p.jobId))
      if (!job) return { ok: false, error: 'not-found' }
    } else {
      const upn = String(p.upn ?? '').trim()
      if (!upn) return { ok: false, error: 'no-upn' }
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
      job = {
        id: randomUUID(),
        targetUpn: upn,
        targetUserId: `ediscovery:${upn.toLowerCase()}`,
        windowStart: p.start ? String(p.start) : null,
        windowEnd: p.end ? String(p.end) : null,
        status: 'pending',
        caseId: null,
        searchId: null,
        operationUrl: null,
        exportUrl: null,
        interactionsAdded: 0,
        lastError: null,
        lastErrorAt: null,
        createdAt: now,
        updatedAt: now
      }
      realdb.upsertEdiscoveryJob(job)
    }
    collectingEdiscovery = true
    stopEdiscovery = false
    const send = (data: unknown): void => {
      sendEvent(event, 'ediscovery_progress', data)
    }
    try {
      const uid = job.targetUserId ?? `ediscovery:${job.targetUpn.toLowerCase()}`
      realdb.upsertUsers([{ id: uid, upn: job.targetUpn, displayName: job.targetUpn.split('@')[0], enabled: true }])
      // Token cache lives in the active profile's directory (seeded at onboarding).
      const dbp = realdb.currentDbPath()
      const cacheDir = dbp ? dirname(dbp) : profiles.rootDir()
      // Optional service-account credentials for unattended ME3 proxy download.
      const edUser = realdb.getSettingText('ediscovery_browser_user') || ''
      const edPwBlob = realdb.getSecretRaw('ediscovery_browser_password')
      let edCreds: { user: string; password: string } | undefined
      if (edUser && edPwBlob && edPwBlob.length) {
        try {
          edCreds = { user: edUser, password: dpapiUnprotect(edPwBlob) }
        } catch {
          edCreds = undefined
        }
      }
      const rows = await runEdiscoveryJob(job, {
        tenantId,
        cacheDir,
        onCode: (dc) =>
          send({
            stage: 'pending',
            message: `로그인 필요: ${dc.verificationUri} 에서 코드 ${dc.userCode} 입력`,
            deviceCode: dc
          }),
        onProgress: (stage, message) => send({ stage, message }),
        shouldStop: () => stopEdiscovery,
        // ME3 / eDiscovery Standard: browser-interactive proxy URL download.
        proxyDownload: async (url: string) =>
          (
            await downloadViaBrowser(url, {
              title: 'eDiscovery 내보내기 다운로드',
              credentials: edCreds,
              onLog: (m) => send({ stage: 'downloading', message: m })
            })
          ).buffer
      })
      let added = 0
      if (rows.length) {
        realdb.upsertInteractions(rows)
        recomputeThreads(uid, 'ediscovery')
        added = rows.length
      }
      job.interactionsAdded = added
      job.status = 'done'
      job.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
      realdb.upsertEdiscoveryJob(job)
      send({ stage: 'done', message: `완료 · ${added}개 상호작용` })
      return { ok: true, jobId: job.id, added }
    } catch (e) {
      // The error is surfaced once by the renderer (invoke result → edLog);
      // do NOT also stream it via 'ediscovery_progress' or it logs twice.
      return { ok: false, jobId: job.id, error: errMsg(e) }
    } finally {
      collectingEdiscovery = false
    }
  })

  ipcMain.handle('ediscovery_collect_stop', () => {
    stopEdiscovery = true
    return { ok: true }
  })
  ipcMain.handle('ediscovery_job_delete', async (e, id: unknown) => {
    if (collectingEdiscovery) return { ok: false, error: 'collecting' }
    const jobId = String(id ?? '').trim()
    if (!jobId) return { ok: false, error: 'no-id' }
    try {
      const job = realdb.getEdiscoveryJob(jobId)
      const uid = job?.targetUserId || (job ? `ediscovery:${job.targetUpn.toLowerCase()}` : '')
      const counts = uid ? realdb.countEdiscoveryConversations(uid) : { interactions: 0, threads: 0 }
      const hasConv = counts.interactions > 0 || counts.threads > 0
      const buttons = hasConv
        ? ['취소', '작업만 삭제', `대화도 함께 삭제 (${counts.interactions}건·스레드 ${counts.threads}개)`]
        : ['취소', '작업만 삭제']
      const opts = {
        type: 'warning' as const,
        buttons,
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: '수집 작업 삭제',
        message: '이 eDiscovery 수집 작업을 삭제할까요?',
        detail: hasConv
          ? `“대화도 함께 삭제”를 누르면 ${job?.targetUpn ?? ''}의 eDiscovery 대화 ${counts.interactions}건과 스레드 ${counts.threads}개가 함께 삭제됩니다.\n(이 UPN의 다른 실행으로 수집된 대화도 포함됩니다 — 작업별로 분리할 수 없습니다.)`
          : '연결된 eDiscovery 대화가 없습니다. 작업 기록만 삭제됩니다.'
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (res.response === 0) return { ok: false, canceled: true }
      realdb.deleteEdiscoveryJob(jobId)
      const deletedConversations = res.response === 2 && !!uid
      if (deletedConversations) realdb.deleteEdiscoveryConversations(uid)
      return {
        ok: true,
        deletedConversations,
        removed: deletedConversations ? counts : { interactions: 0, threads: 0 }
      }
    } catch (e2) {
      return { ok: false, error: errMsg(e2) }
    }
  })

  // eDiscovery ME3 unattended-download service account (DPAPI-stored).
  ipcMain.handle('ediscovery_creds_status', () => {
    const b = realdb.getSecretRaw('ediscovery_browser_password')
    return { user: realdb.getSettingText('ediscovery_browser_user') || '', configured: !!(b && b.length) }
  })
  ipcMain.handle('ediscovery_creds_set', (_e, payload: unknown) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as { user?: string; password?: string }
    const user = String(p.user ?? '').trim()
    const password = String(p.password ?? '')
    if (!user || !password) return { ok: false, error: 'missing' }
    try {
      realdb.setSettingText('ediscovery_browser_user', user)
      realdb.setSettingBlob('ediscovery_browser_password', dpapiProtect(password))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })
  ipcMain.handle('ediscovery_creds_clear', () => {
    try {
      realdb.setSettingText('ediscovery_browser_user', '')
      realdb.setSettingBlob('ediscovery_browser_password', Buffer.alloc(0))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })
  ipcMain.handle('audit_collect_status', () => real(() => realdb.auditCollectStatus()))
  ipcMain.handle('usage_collect_status', () => real(() => realdb.usageCollectStatus()))
  ipcMain.handle('diagnostics_status', () => real(() => realdb.diagnosticsStatus()))
  ipcMain.handle('conversation_collect_status', () => real(() => realdb.conversationCollectStatus()))
  ipcMain.handle('agent_credit_overview', () => real(() => realdb.agentCreditOverview()))
  ipcMain.handle('dataverse_status', () => real(() => realdb.dataverseStatus()))
  ipcMain.handle('flow_runs_status', () => real(() => realdb.flowRunsStatus()))
  ipcMain.handle('agent_defs_status', () => real(() => realdb.agentDefsStatus()))
  ipcMain.handle('alerts_list', () => real(() => realdb.listCreditAlerts('active')))
  ipcMain.handle('alerts_evaluate', () => {
    try {
      return { ok: true, ...evaluateCreditAlerts() }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })

  ipcMain.handle('profiles_list', () => profiles.listProfiles())
  ipcMain.handle('profile_switch', (_e, id: unknown) => {
    const ok = profiles.setActiveProfile(String(id))
    if (ok) {
      realdb.reopen()
      resetAuth()
    }
    return { ok }
  })
  ipcMain.handle('profile_delete', (_e, id: unknown) => {
    const targetId = String(id)
    const { profiles: list, activeId } = profiles.listProfiles()
    if (!list.some((p) => p.id === targetId)) return { ok: false, error: 'not-found' }
    const isActive = targetId === activeId
    try {
      // Release the file lock on the active store.db before removing its folder.
      if (isActive) realdb.closeDb()
      profiles.deleteProfile(targetId)
      if (isActive) {
        realdb.reopen()
        resetAuth()
      }
      return { ok: true, reload: isActive }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })
  ipcMain.handle('onboard_start', async (event, payload: unknown) => {
    if (onboarding) return { ok: false, error: 'already-running' }
    onboarding = true
    try {
      const p =
        typeof payload === 'string'
          ? { name: payload }
          : ((payload && typeof payload === 'object' ? payload : {}) as {
              name?: string
              edUser?: string
              edPassword?: string
            })
      const edCreds =
        p.edUser && p.edPassword ? { user: String(p.edUser), password: String(p.edPassword) } : undefined
      const res = await onboard(
        String(p.name ?? ''),
        (message, percent) => {
          sendEvent(event, 'onboard_progress', { message, percent })
        },
        (dc) => {
          sendEvent(event, 'onboard_device_code', dc)
        },
        edCreds
      )
      if (res.ok) {
        realdb.reopen()
        resetAuth()
      }
      return res
    } finally {
      onboarding = false
    }
  })

  ipcMain.handle('auth_status', () => {
    try {
      return { hasCredentials: hasCredentials() }
    } catch {
      return { hasCredentials: false }
    }
  })
  ipcMain.handle('collect_start', async (event) => {
    if (collecting) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    collecting = true
    try {
      const result = await runCollection('manual', (p) => {
        sendEvent(event, 'collect_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      collecting = false
    }
  })

  // Per-source Graph API collection: each "데이터 수집" page triggers only its own
  // source via its own button (conversations / audit / usage / diagnostics).
  ipcMain.handle('conversation_collect_start', async (event) => {
    if (collectingConversation) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    const gate = capabilityGate('conversation')
    if (gate) return gate
    collectingConversation = true
    try {
      const result = await runConversationCollection('manual', (p) => {
        sendEvent(event, 'conversation_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingConversation = false
      schedulePurviewAttribution(1_000)
    }
  })

  // Targeted collection for a single user (from the per-user status table).
  ipcMain.handle('conversation_collect_user', async (event, userId: unknown) => {
    if (collectingConversation) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    const gate = capabilityGate('conversation')
    if (gate) return gate
    const id = String(userId ?? '').trim()
    if (!id) return { ok: false, error: 'no-user' }
    collectingConversation = true
    try {
      const result = await runConversationCollection(
        'manual:user',
        (p) => {
          sendEvent(event, 'conversation_progress', p)
        },
        { userIds: [id] }
      )
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingConversation = false
      schedulePurviewAttribution(1_000)
    }
  })

  ipcMain.handle('audit_collect_start', async (event) => {
    if (collectingAudit) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    collectingAudit = true
    try {
      const result = await runAuditCollection((p) => {
        sendEvent(event, 'audit_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingAudit = false
      schedulePurviewAttribution(5_000)
    }
  })

  ipcMain.handle('usage_collect_start', async (event) => {
    if (collectingUsage) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    const gate = capabilityGate('usage')
    if (gate) return gate
    collectingUsage = true
    try {
      const result = await runUsageCollection((p) => {
        sendEvent(event, 'usage_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingUsage = false
    }
  })

  ipcMain.handle('diagnostics_collect_start', async (event) => {
    if (collectingDiagnostics) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    const gate = capabilityGate('diagnostics')
    if (gate) return gate
    collectingDiagnostics = true
    try {
      const result = await runDiagnosticsCollection((p) => {
        sendEvent(event, 'diagnostics_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingDiagnostics = false
    }
  })

  // ---- license capabilities (admin license config + SKU suggest) ----------
  ipcMain.handle('capabilities_get', () => {
    return { ...loadCapabilityProfile(), presets: PRESETS }
  })
  ipcMain.handle('capabilities_set', (_e, payload: unknown) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as {
      preset?: string
      toggles?: Record<string, unknown>
    }
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    try {
      let profile: CapabilityProfile
      if (p.preset && String(p.preset) !== PRESET_CUSTOM) {
        profile = profileFromPreset(String(p.preset), now)
      } else {
        const toggles = (p.toggles && typeof p.toggles === 'object' ? p.toggles : p) as Record<string, unknown>
        profile = profileFromToggles(toggles, now)
      }
      realdb.setSettingText('capabilities_json', JSON.stringify(profile))
      return { ok: true, capabilities: profile }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })
  ipcMain.handle('capabilities_suggest', async () => {
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    try {
      const skus = await listSubscribedSkus()
      return { ok: true, capabilities: suggestFromSkus(skus, realdb.agentInventoryDetected(), now) }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })

  // Portal sign-in consumption collection (PPAC → licensing API JSON).
  ipcMain.handle('consumption_collect_start', async (event) => {
    if (consuming) return { ok: false, error: 'already-running' }
    const tenantId = realdb.getSettingText('tenant_id')
    if (!tenantId) return { ok: false, error: 'no-tenant' }
    consuming = true
    const log = (line: string): void => {
      sendEvent(event, 'consumption_progress', { message: line })
    }
    try {
      const token = await captureBearerToken({
        loadUrl: 'https://admin.powerplatform.microsoft.com/resources/capacity',
        matchHost: 'licensing.powerplatform.microsoft.com',
        title: 'Power Platform 관리 센터 로그인',
        credentials: dataverseBrowserCreds(),
        onLog: log
      })
      log('소비 데이터를 수집하는 중…')
      const result = await collectConsumption(token, tenantId, log)
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      consuming = false
    }
  })

  // Stored service-account creds (shared with the eDiscovery ME3 download) for
  // unattended Dataverse/maker-portal auto-login. Undefined when not configured.
  function dataverseBrowserCreds(): { user: string; password: string } | undefined {
    const user = realdb.getSettingText('ediscovery_browser_user') || ''
    const blob = realdb.getSecretRaw('ediscovery_browser_password')
    if (!user || !blob || !blob.length) return undefined
    try {
      const password = dpapiUnprotect(blob)
      return password ? { user, password } : undefined
    } catch {
      return undefined
    }
  }

  // Dataverse transcript collection (maker portal → per-env Web API).
  ipcMain.handle('transcripts_collect_start', async (event, payload: unknown) => {
    if (collectingTranscripts) return { ok: false, error: 'already-running' }
    collectingTranscripts = true
    const p = (payload && typeof payload === 'object' ? payload : {}) as {
      teamsOnly?: boolean
      addSelfAsAdmin?: boolean
    }
    const logLines: Array<{ at: string; text: string }> = []
    const log = (line: string): void => {
      logLines.push({ at: new Date().toISOString(), text: line })
      sendEvent(event, 'transcripts_progress', { message: line })
    }
    const runId = realdb.dbReady() ? realdb.startRunLog('transcripts', 'manual') : 0
    try {
      const tokens = await captureDataverseTokens({
        credentials: dataverseBrowserCreds(),
        addSelfAsAdmin: p.addSelfAsAdmin === true,
        tenantId: realdb.getSettingText('tenant_id') ?? undefined,
        title: 'Power Apps 메이커 포털 — Teams 대화 수집',
        onLog: log
      })
      log('대화기록을 수집하는 중…')
      const result = await collectTranscripts(tokens, p.teamsOnly !== false, log)
      if (runId)
        realdb.finishRunLog(
          runId,
          result.errors ? 'warn' : 'success',
          result.errors,
          JSON.stringify({ environments: result.environments, transcripts: result.transcripts, rows: result.rows }),
          JSON.stringify(logLines)
        )
      return { ok: true, ...result }
    } catch (e) {
      if (runId) realdb.finishRunLog(runId, 'error', 1, JSON.stringify({ error: errMsg(e) }), JSON.stringify(logLines))
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingTranscripts = false
    }
  })

  // Dataverse flow-run collection (maker portal → per-env Web API).
  ipcMain.handle('flowruns_collect_start', async (event) => {
    if (collectingFlowRuns) return { ok: false, error: 'already-running' }
    collectingFlowRuns = true
    const log = (line: string): void => {
      sendEvent(event, 'flowruns_progress', { message: line })
    }
    try {
      const tokens = await captureDataverseTokens({
        credentials: dataverseBrowserCreds(),
        tenantId: realdb.getSettingText('tenant_id') ?? undefined,
        title: 'Power Apps 메이커 포털 — 플로우 실행 수집',
        onLog: log
      })
      log('플로우 실행 기록을 수집하는 중…')
      const result = await collectFlowRuns(tokens, log)
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingFlowRuns = false
    }
  })

  // Dataverse agent-definition risk collection (maker portal → bots/botcomponents).
  ipcMain.handle('agentdefs_collect_start', async (event) => {
    if (collectingAgentDefs) return { ok: false, error: 'already-running' }
    collectingAgentDefs = true
    const log = (line: string): void => {
      sendEvent(event, 'agentdefs_progress', { message: line })
    }
    try {
      const tokens = await captureDataverseTokens({
        credentials: dataverseBrowserCreds(),
        tenantId: realdb.getSettingText('tenant_id') ?? undefined,
        title: 'Power Apps 메이커 포털 — 에이전트 분석',
        onLog: log
      })
      log('에이전트 정의를 분석하는 중…')
      const result = await collectAgentDefinitions(tokens, log)
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingAgentDefs = false
    }
  })

  // Database management: stats / backup / restore / export.
  ipcMain.handle('db_stat', async () => {
    const stat = realdb.dbStat()
    let sizeBytes = 0
    let modified = ''
    if (stat.path) {
      try {
        const fs = await import('node:fs')
        const s = fs.statSync(stat.path)
        sizeBytes = s.size
        modified = s.mtime.toISOString()
      } catch {
        /* ignore */
      }
    }
    return { ...stat, sizeBytes, modified }
  })

  ipcMain.handle('backup_db', async () => {
    const src = realdb.currentDbPath()
    if (!src) return { ok: false, error: 'no-db' }
    const fs = await import('node:fs')
    const def = `store-backup-${new Date().toISOString().slice(0, 10)}.db`
    const res = await dialog.showSaveDialog({
      title: '데이터베이스 백업',
      defaultPath: def,
      filters: [{ name: 'SQLite DB', extensions: ['db'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
    try {
      realdb.checkpoint()
      fs.copyFileSync(src, res.filePath)
      return { ok: true, path: res.filePath, sizeBytes: fs.statSync(res.filePath).size }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })

  ipcMain.handle('restore_db', async () => {
    const dest = realdb.currentDbPath()
    if (!dest) return { ok: false, error: 'no-db' }
    const fs = await import('node:fs')
    const res = await dialog.showOpenDialog({
      title: '데이터베이스 복원',
      filters: [{ name: 'SQLite DB', extensions: ['db'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'canceled' }
    const src = res.filePaths[0]
    try {
      const head = Buffer.alloc(16)
      const fd = fs.openSync(src, 'r')
      fs.readSync(fd, head, 0, 16, 0)
      fs.closeSync(fd)
      if (head.toString('utf8', 0, 15) !== 'SQLite format 3') return { ok: false, error: 'not-sqlite' }
      realdb.closeDb()
      for (const ext of ['-wal', '-shm']) {
        try {
          fs.rmSync(dest + ext, { force: true })
        } catch {
          /* ignore */
        }
      }
      fs.copyFileSync(src, dest)
      realdb.reopen()
      resetAuth()
      return { ok: true }
    } catch (e) {
      realdb.reopen()
      return { ok: false, error: errMsg(e) }
    }
  })

  ipcMain.handle('db_wipe', async () => {
    try {
      const res = realdb.wipeData()
      realdb.checkpoint()
      return res
    } catch (e) {
      return { ok: false, deleted: 0, counts: {}, error: errMsg(e) }
    }
  })

  ipcMain.handle('export_table', async (_e, table: unknown, format: unknown) => {
    const t = String(table)
    const fmt = format === 'json' ? 'json' : 'csv'
    const fs = await import('node:fs')
    const res = await dialog.showSaveDialog({
      title: '데이터 내보내기',
      defaultPath: `${t}.${fmt}`,
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
    try {
      const rows = realdb.exportTableRows(t)
      const text = fmt === 'json' ? JSON.stringify(rows, null, 2) : '\ufeff' + toCsv(rows)
      fs.writeFileSync(res.filePath, text, 'utf-8')
      return { ok: true, path: res.filePath, rows: rows.length }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0c0e',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/app.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  const rendererFile = join(__dirname, '../renderer/index.html')
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const rendererEntry = devUrl || pathToFileURL(rendererFile).toString()

  win.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedPrimaryNavigation(targetUrl, rendererEntry)) return
    event.preventDefault()
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl)
  })

  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(rendererFile)
  }
  return win
}

/**
 * Only one copy of the app may own a profile's SQLite store. The portable build
 * makes double-launching easy, and two writers on the same store.db produce
 * SQLITE_BUSY failures and half-applied collection runs.
 */
function focusExistingWindow(): void {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

let shuttingDown = false
function shutdownDb(): void {
  if (shuttingDown) return
  shuttingDown = true
  if (purviewAttributionTimer) clearTimeout(purviewAttributionTimer)
  purviewAttributionTimer = null
  try {
    realdb.checkpoint()
    realdb.closeDb()
  } catch (e) {
    logError('db shutdown', e)
  }
}

// A rejected promise inside a collector must not take the whole app down:
// Node's default for unhandled rejections is to throw and exit.
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason))
process.on('uncaughtException', (e) => logError('uncaughtException', e))

// Claim the profile store before doing anything else. A second launch simply
// surfaces the window that already owns the database.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', focusExistingWindow)

  app.whenReady().then(async () => {
    registerHandlers()

    if (!app.isPackaged) {
      const { runDevHarness } = await import('./devHarness')
      if (await runDevHarness()) return
    }

    createWindow()
    schedulePurviewAttribution()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', shutdownDb)
}
