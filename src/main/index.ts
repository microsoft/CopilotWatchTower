import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, dirname } from 'path'
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','))
  return lines.join('\r\n')
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
      console.error(e)
      return []
    }
  }
  const obj = <T>(real: () => T): T | null => {
    if (!realdb.dbReady()) return null
    try {
      return real()
    } catch (e) {
      console.error(e)
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
        console.error('conversations_all', e)
        return []
      }
    }
    return arr(() => realdb.conversations({ limit: 2000 }))
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
      console.error('insights_data', e)
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
      console.error('agents_overview', e)
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
      console.error(e)
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
      console.error('security_events', e)
      return { kpis: { total: 0, blocked: 0, uniqueUsers: 0, topOperation: null, topOperationCount: 0 }, events: [] }
    }
  })
  ipcMain.handle('credits_overview', () => real(() => realdb.creditsOverview()))
  ipcMain.handle('consumption_explorer', () => {
    if (!realdb.dbReady()) return null
    try {
      return realdb.consumptionExplorer()
    } catch (e) {
      console.error('consumption_explorer', e)
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
      if (!event.sender.isDestroyed()) event.sender.send('ediscovery_progress', { message })
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
      if (!event.sender.isDestroyed()) event.sender.send('ediscovery_progress', data)
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
          if (!event.sender.isDestroyed()) event.sender.send('onboard_progress', { message, percent })
        },
        (dc) => {
          if (!event.sender.isDestroyed()) event.sender.send('onboard_device_code', dc)
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
        if (!event.sender.isDestroyed()) event.sender.send('collect_progress', p)
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
        if (!event.sender.isDestroyed()) event.sender.send('conversation_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingConversation = false
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
          if (!event.sender.isDestroyed()) event.sender.send('conversation_progress', p)
        },
        { userIds: [id] }
      )
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingConversation = false
    }
  })

  ipcMain.handle('audit_collect_start', async (event) => {
    if (collectingAudit) return { ok: false, error: 'already-running' }
    if (!hasCredentials()) return { ok: false, error: 'no-credentials' }
    collectingAudit = true
    try {
      const result = await runAuditCollection((p) => {
        if (!event.sender.isDestroyed()) event.sender.send('audit_progress', p)
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: errMsg(e) }
    } finally {
      collectingAudit = false
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
        if (!event.sender.isDestroyed()) event.sender.send('usage_progress', p)
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
        if (!event.sender.isDestroyed()) event.sender.send('diagnostics_progress', p)
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
      if (!event.sender.isDestroyed()) event.sender.send('consumption_progress', { message: line })
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
      if (!event.sender.isDestroyed()) event.sender.send('transcripts_progress', { message: line })
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
      if (!event.sender.isDestroyed()) event.sender.send('flowruns_progress', { message: line })
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
      if (!event.sender.isDestroyed()) event.sender.send('agentdefs_progress', { message: line })
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

function createWindow(): void {
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  registerHandlers()

  if (process.env.CWT_COLLECT_TEST) {
    const fs = await import('node:fs')
    const out = join(process.env.TEMP || '.', 'cwt_collect_out.txt')
    fs.writeFileSync(out, '')
    try {
      const res = await runCollection(
        'manual',
        (p) => fs.appendFileSync(out, `${p.phase} ${p.percent}% ${p.message}\n`),
        { maxUsers: Number(process.env.CWT_COLLECT_TEST) || 1, forceBackfill: true }
      )
      fs.appendFileSync(out, 'RESULT ' + JSON.stringify(res) + '\n')
    } catch (e) {
      fs.appendFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)) + '\n')
    }
    app.quit()
    return
  }

  if (process.env.CWT_AUDIT_TEST) {
    const fs = await import('node:fs')
    const { collectAudit } = await import('./collectors/audit')
    const out = join(process.env.TEMP || '.', 'cwt_audit_out.txt')
    fs.writeFileSync(out, '')
    try {
      const res = await collectAudit((line) => fs.appendFileSync(out, line + '\n'))
      fs.appendFileSync(out, 'RESULT ' + JSON.stringify(res) + '\n')
    } catch (e) {
      fs.appendFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)) + '\n')
    }
    app.quit()
    return
  }

  if (process.env.CWT_USAGE_TEST) {
    const fs = await import('node:fs')
    const { collectCopilotUsage } = await import('./collectors/usage')
    const out = join(process.env.TEMP || '.', 'cwt_usage_out.txt')
    fs.writeFileSync(out, '')
    try {
      const n = await collectCopilotUsage(process.env.CWT_USAGE_TEST === '1' ? 'D30' : process.env.CWT_USAGE_TEST!)
      fs.appendFileSync(out, 'RESULT rows=' + n + '\n')
    } catch (e) {
      fs.appendFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)) + '\n')
    }
    app.quit()
    return
  }

  if (process.env.CWT_DIAG_TEST) {
    const fs = await import('node:fs')
    const { collectAdminDiagnostics } = await import('./collectors/agents')
    const out = join(process.env.TEMP || '.', 'cwt_diag_out.txt')
    fs.writeFileSync(out, '')
    try {
      const res = await collectAdminDiagnostics((line) => fs.appendFileSync(out, line + '\n'))
      fs.appendFileSync(out, 'RESULT ' + JSON.stringify(res) + '\n')
    } catch (e) {
      fs.appendFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)) + '\n')
    }
    app.quit()
    return
  }

  if (process.env.CWT_CONV_TEST) {
    const fs = await import('node:fs')
    const out = join(process.env.TEMP || '.', 'cwt_conv_out.txt')
    try {
      const users = realdb.conversationUsers('api')
      const apps = realdb.conversationApps('api')
      const sampleUser = users[0]?.id
      const sampleApp = apps[0]?.value
      // Pull a search needle from the first thread title so the LIKE filter has a hit.
      const firstTitle = realdb.conversations({ limit: 1, source: 'api' })[0]?.title || ''
      const needle = firstTitle.split(' ')[0] || firstTitle.slice(0, 4)
      const r = {
        counts: {
          api: realdb.conversations({ limit: 2000, source: 'api' }).length,
          dataverse: realdb.conversations({ limit: 2000, source: 'dataverse' }).length,
          ediscovery: realdb.conversations({ limit: 2000, source: 'ediscovery' }).length,
          all: realdb.conversations({ limit: 2000 }).length
        },
        users: { count: users.length, sample: users.slice(0, 3) },
        apps,
        filters: {
          byUser: sampleUser
            ? realdb.conversations({ source: 'api', userId: sampleUser }).length
            : 'n/a',
          byApp: sampleApp ? realdb.conversations({ source: 'api', app: sampleApp }).length : 'n/a',
          searchTitle: needle
            ? realdb.conversations({ source: 'api', search: needle, scope: 'title' }).length
            : 'n/a',
          searchBody: needle
            ? realdb.conversations({ source: 'api', search: needle, scope: 'body' }).length
            : 'n/a',
          searchAll: needle
            ? realdb.conversations({ source: 'api', search: needle, scope: 'all' }).length
            : 'n/a',
          searchNoMatch: realdb.conversations({ source: 'api', search: '___zzz_nomatch___' }).length,
          dateFuture: realdb.conversations({ source: 'api', dateFrom: '2999-01-01' }).length
        },
        needle,
        backCompat: realdb.conversations(3, 'api').map((c) => ({ id: c.id, title: c.title }))
      }
      fs.writeFileSync(out, JSON.stringify(r, null, 2))
    } catch (e) {
      fs.writeFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)))
    }
    app.quit()
    return
  }

  if (process.env.CWT_PROFILE_TEST) {
    const fs = await import('node:fs')
    const np = await import('node:path')
    const out = join(process.env.TEMP || '.', 'cwt_profile_out.txt')
    try {
      const before = profiles.listProfiles()
      const temp = profiles.createProfile('__cwt_del_test__')
      const dir = np.join(profiles.rootDir(), 'profiles', temp.id)
      const afterCreate = profiles.listProfiles()
      const folderExists = fs.existsSync(dir)
      const dbExists = fs.existsSync(np.join(dir, 'store.db'))
      const deleted = profiles.deleteProfile(temp.id)
      const afterDelete = profiles.listProfiles()
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            beforeCount: before.profiles.length,
            activeBefore: before.activeId,
            tempId: temp.id,
            afterCreateCount: afterCreate.profiles.length,
            folderExists,
            dbExists,
            deleted,
            afterDeleteCount: afterDelete.profiles.length,
            activeAfter: afterDelete.activeId,
            folderGone: !fs.existsSync(dir),
            activeUnchanged: before.activeId === afterDelete.activeId,
            roundTripClean: before.profiles.length === afterDelete.profiles.length
          },
          null,
          2
        )
      )
    } catch (e) {
      fs.writeFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)))
    }
    app.quit()
    return
  }

  if (process.env.CWT_DTO_TEST) {
    const fs = await import('node:fs')
    const out = join(process.env.TEMP || '.', 'cwt_dto_out.txt')
    try {
      const result = {
        dashboard: realdb.dashboardSummary(),
        insights: realdb.insightsData({}),
        agents: realdb.agentsOverview({ thresholdDays: 30 }),
        identityEvents: realdb.agentIdentityEvents(200),
        security: realdb.securityEvents({ limit: 2000 }),
        consumption: realdb.consumptionExplorer(),
        audit: realdb.auditCollectStatus(),
        usage: realdb.usageCollectStatus(),
        diagnostics: realdb.diagnosticsStatus(),
        conversation: realdb.conversationCollectStatus(),
        agentCredit: realdb.agentCreditOverview(),
        alertsEvaluated: evaluateCreditAlerts(),
        alerts: realdb.listCreditAlerts('active')
      }
      fs.writeFileSync(out, JSON.stringify(result, null, 2))
    } catch (e) {
      fs.writeFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)))
    }
    app.quit()
    return
  }

  if (process.env.CWT_EXPORT_TEST) {
    const fs = await import('node:fs')
    const out = join(process.env.TEMP || '.', 'cwt_export_out.txt')
    try {
      const stat = realdb.dbStat()
      const rows = realdb.exportTableRows('copilot_admin_diagnostics')
      const csv = toCsv(rows)
      const csvPath = join(process.env.TEMP || '.', 'cwt_export_sample.csv')
      fs.writeFileSync(csvPath, '\ufeff' + csv, 'utf-8')
      fs.writeFileSync(
        out,
        JSON.stringify(
          { dbPath: stat.path, tables: stat.tables, sampleRows: rows.length, csvHead: csv.slice(0, 200), csvPath },
          null,
          2
        )
      )
    } catch (e) {
      fs.writeFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)))
    }
    app.quit()
    return
  }

  if (process.env.CWT_EDISC_TEST) {
    const fs = await import('node:fs')
    const { parseExportPackage, splitCopilotBody } = await import('./collectors/ediscoveryExport')
    const out = join(process.env.TEMP || '.', 'cwt_edisc_out.txt')
    function makeZip(name: string, content: string): Buffer {
      const nameBuf = Buffer.from(name, 'utf8')
      const data = Buffer.from(content, 'utf8')
      const lfh = Buffer.alloc(30)
      lfh.writeUInt32LE(0x04034b50, 0)
      lfh.writeUInt16LE(20, 4)
      lfh.writeUInt32LE(data.length, 18)
      lfh.writeUInt32LE(data.length, 22)
      lfh.writeUInt16LE(nameBuf.length, 26)
      const localPart = Buffer.concat([lfh, nameBuf, data])
      const cdh = Buffer.alloc(46)
      cdh.writeUInt32LE(0x02014b50, 0)
      cdh.writeUInt32LE(data.length, 20)
      cdh.writeUInt32LE(data.length, 24)
      cdh.writeUInt16LE(nameBuf.length, 28)
      cdh.writeUInt32LE(0, 42)
      const cdPart = Buffer.concat([cdh, nameBuf])
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(1, 8)
      eocd.writeUInt16LE(1, 10)
      eocd.writeUInt32LE(cdPart.length, 12)
      eocd.writeUInt32LE(localPart.length, 16)
      return Buffer.concat([localPart, cdPart, eocd])
    }
    try {
      const rec = {
        id: 'i1',
        conversationId: 'c1',
        createdDateTime: '2026-06-01T10:00:00Z',
        prompt: '계약서 요약해줘',
        response: '요약 결과입니다.',
        app: 'BizChat'
      }
      const zip = makeZip('items.json', JSON.stringify([rec]))
      const rows = parseExportPackage(zip, 'user-1')
      const split = splitCopilotBody('User: 안녕하세요\nCopilot: 반갑습니다')
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            rowCount: rows.length,
            rows: rows.map((r) => ({ type: r.interactionType, body: r.bodyText, session: r.sessionId, source: r.sourceType, req: r.requestId })),
            split
          },
          null,
          2
        )
      )
    } catch (e) {
      fs.writeFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)))
    }
    app.quit()
    return
  }

  if (process.env.CWT_DVPARSE_TEST) {
    const fs = await import('node:fs')
    const { parseConversationTranscript, parseEnvironmentsJson, parseFlowRunRecord } = await import('./collectors/dataverse')
    const { analyzeAgent } = await import('./collectors/agentRisk')
    const out = join(process.env.TEMP || '.', 'cwt_dvparse_out.txt')
    try {
      const content = JSON.stringify({
        activities: [
          { type: 'message', id: 'a1', from: { aadObjectId: 'aad-123', name: '홍길동' }, text: '안녕 에이전트', channelId: 'msteams', timestamp: 1780000000, conversation: { id: 'conv-1' } },
          { type: 'message', id: 'a2', from: { role: 0, name: 'Agent' }, recipient: { aadObjectId: 'aad-123' }, text: '안녕하세요!', channelId: 'msteams', timestamp: 1780000005 },
          { type: 'message', id: 'a3', from: { id: 'webuser' }, text: 'web only', channelId: 'webchat', timestamp: 1780000010 }
        ]
      })
      const all = parseConversationTranscript(content, { transcriptId: 't1', environmentId: 'env1', teamsOnly: false })
      const teams = parseConversationTranscript(content, { transcriptId: 't1', environmentId: 'env1', teamsOnly: true })
      const envs = parseEnvironmentsJson({
        value: [{ ApiUrl: 'https://contoso.crm.dynamics.com/api/data/v9.0/', Id: 'e1', FriendlyName: 'Contoso' }]
      })
      const flow = parseFlowRunRecord(
        {
          flowrunid: 'run-1',
          status: 'Failed',
          starttime: '2026-06-20T01:00:00Z',
          duration: '4200',
          modernflowtype: 2,
          _workflow_value: 'wf-1',
          '_workflow_value@OData.Community.Display.V1.FormattedValue': '주문 처리 플로우',
          _ownerid_value: 'owner-1',
          '_ownerid_value@OData.Community.Display.V1.FormattedValue': '김철수',
          createdon: '2026-06-20T01:00:05Z'
        },
        'env1',
        'Contoso'
      )
      const risk = analyzeAgent([
        { componenttype: 5 },
        { componenttype: 1, data: 'httprequest connectorid foreach while invoketool' }
      ])
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            allRows: all.rows.length,
            allTypes: all.rows.map((r) => r.interactionType),
            apps: all.rows.map((r) => r.app),
            createdAts: all.rows.map((r) => r.createdAt),
            participants: [...all.participants],
            teamsRows: teams.rows.length,
            teamsSkippedNonTeams: teams.skippedNonTeams,
            envs,
            flow,
            risk: {
              score: risk.score,
              band: risk.band,
              hasTrigger: risk.hasTrigger,
              external: risk.externalCallCount,
              tools: risk.toolCount,
              loops: risk.loopCount
            }
          },
          null,
          2
        )
      )
    } catch (e) {
      fs.writeFileSync(out, 'FAIL ' + (e instanceof Error ? e.stack : String(e)))
    }
    app.quit()
    return
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
