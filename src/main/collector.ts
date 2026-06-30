/**
 * Collection orchestration, ported from workers/collector.py.
 * Sync users → license → per-user interactions (watermark incremental) → finish.
 */
import * as db from './db'
import { listUsers, listInteractions, listCopilotLicensedUserIds, type RawInteraction } from './graph'
import { recomputeThreads } from './threading'
import { collectAudit } from './collectors/audit'
import { collectCopilotUsage } from './collectors/usage'
import { collectAdminDiagnostics } from './collectors/agents'
import { evaluateCreditAlerts } from './collectors/creditAlerts'

const WATERMARK_MARGIN_SEC = 300

export interface Progress {
  phase: 'users' | 'license' | 'interactions' | 'audit' | 'usage' | 'diagnostics' | 'done'
  message: string
  percent: number
}
export type ProgressCb = (p: Progress) => void

export interface CollectResult {
  users: number
  interactions: number
  audit: number
  usage: number
  agents: number
  errors: number
}

function stripMs(iso: string): string {
  return iso.replace(/\.\d+Z$/, 'Z').replace(/\.\d+\+00:00$/, 'Z')
}

function parseInteraction(raw: RawInteraction, userId: string): db.InteractionUpsert {
  const body = raw.body ?? {}
  const app = raw.appClass ?? raw.from?.application?.displayName ?? null
  return {
    id: String(raw.id),
    userId,
    sessionId: raw.sessionId ?? null,
    requestId: raw.requestId ?? null,
    createdAt: String(raw.createdDateTime),
    interactionType: raw.interactionType ?? null,
    app,
    bodyText: body.content ?? null,
    bodyContentType: body.contentType ?? null,
    attachmentsJson: raw.attachments && raw.attachments.length ? JSON.stringify(raw.attachments) : null,
    rawJson: JSON.stringify(raw),
    sourceType: 'api'
  }
}

export interface StepProgress {
  message: string
  percent: number
}
export type StepCb = (p: StepProgress) => void

/**
 * Conversation collection (Graph API): users → Copilot license → per-user
 * interactions (watermark incremental). Captures every streamed line into the
 * unified run-log table so the run history page can replay it later. Pass
 * ``opts.userIds`` to collect only specific users (skips the full directory +
 * license sync).
 */
export async function runConversationCollection(
  trigger: string,
  onProgress: StepCb,
  opts: { maxUsers?: number; forceBackfill?: boolean; userIds?: string[] } = {}
): Promise<{ users: number; interactions: number; errors: number }> {
  const runId = db.startRunLog('conversation', trigger)
  const logLines: Array<{ at: string; type: string; text: string }> = []
  let totalInteractions = 0
  let errors = 0
  // Every streamed line is both surfaced live and captured for the run history.
  const emit = (message: string, percent: number, type = 'log'): void => {
    logLines.push({ at: new Date().toISOString(), type, text: message })
    onProgress({ message, percent })
  }

  let scope: db.UserUpsert[]
  if (opts.userIds?.length) {
    scope = db.usersByIds(opts.userIds)
    emit(`지정 사용자 ${scope.length.toLocaleString('ko-KR')}명 수집`, 10)
  } else {
    emit('사용자 동기화 중…', 3)
    const users: db.UserUpsert[] = []
    for await (const u of listUsers()) users.push(u)
    db.upsertUsers(users)
    emit(`사용자 ${users.length.toLocaleString('ko-KR')}명 동기화 완료`, 6)

    emit('Copilot 라이선스 확인 중…', 8)
    let licensed: string[] = []
    try {
      licensed = await listCopilotLicensedUserIds()
      db.setCopilotLicensed(licensed)
    } catch {
      errors++
    }

    scope = licensed.length ? users.filter((u) => licensed.includes(u.id)) : users.filter((u) => u.enabled)
    if (opts.maxUsers) scope = scope.slice(0, opts.maxUsers)
    emit(
      `대상 사용자 ${scope.length.toLocaleString('ko-KR')}명 · Copilot 라이선스 ${licensed.length.toLocaleString('ko-KR')}명`,
      10
    )
  }

  let i = 0
  for (const u of scope) {
    i++
    const display = u.displayName ?? u.upn ?? u.id
    const pct = Math.min(98, 10 + Math.round((i / Math.max(1, scope.length)) * 88))
    try {
      const st = db.getCollectionState(u.id)
      let since: string | null = null
      if (!opts.forceBackfill && st.backfillComplete && st.watermark) {
        const d = new Date(st.watermark)
        d.setSeconds(d.getSeconds() - WATERMARK_MARGIN_SEC)
        since = stripMs(d.toISOString())
      }
      const batch: db.InteractionUpsert[] = []
      for await (const raw of listInteractions(u.id, since)) batch.push(parseInteraction(raw, u.id))
      let added = 0
      if (batch.length) {
        db.upsertInteractions(batch)
        const newest = batch.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), batch[0].createdAt)
        db.updateCollectionState(u.id, newest, true)
        recomputeThreads(u.id, 'api')
        totalInteractions += batch.length
        added = batch.length
      } else {
        db.updateCollectionState(u.id, st.watermark ?? new Date().toISOString(), true)
      }
      emit(`[${i}/${scope.length}] ${display} · ${added ? `+${added.toLocaleString('ko-KR')}건` : '신규 없음'}`, pct)
    } catch {
      errors++
      emit(`[${i}/${scope.length}] ${display} · 오류`, pct, 'error')
    }
  }

  emit(
    `완료 · 신규 상호작용 ${totalInteractions.toLocaleString('ko-KR')}건 · 오류 ${errors}`,
    100,
    errors ? 'warn' : 'done'
  )
  db.finishRunLog(
    runId,
    errors ? 'warn' : 'success',
    errors,
    JSON.stringify({ users: scope.length, interactions: totalInteractions }),
    JSON.stringify(logLines)
  )
  return { users: scope.length, interactions: totalInteractions, errors }
}

/** Audit collection (Purview unified audit + Entra audits/sign-ins). */
export async function runAuditCollection(onProgress: StepCb): Promise<{ audit: number; errors: number }> {
  onProgress({ message: '감사 로그 수집 중…', percent: 10 })
  let auditFetched = 0
  let errors = 0
  try {
    const a = await collectAudit((line) => onProgress({ message: line, percent: 55 }))
    auditFetched = a.fetched
    errors += a.errors
  } catch {
    errors++
  }
  onProgress({ message: '완료', percent: 100 })
  return { audit: auditFetched, errors }
}

/** Copilot usage reports (Reports.Read.All CSV → usage snapshots). */
export async function runUsageCollection(onProgress: StepCb): Promise<{ usage: number; errors: number }> {
  onProgress({ message: 'Copilot 사용 리포트 수집 중…', percent: 20 })
  let usageRows = 0
  let errors = 0
  try {
    usageRows = await collectCopilotUsage('D30')
  } catch {
    errors++
  }
  onProgress({ message: '완료', percent: 100 })
  return { usage: usageRows, errors }
}

/** Copilot admin diagnostics + agent inventory, then re-evaluate credit alerts. */
export async function runDiagnosticsCollection(onProgress: StepCb): Promise<{ agents: number; errors: number }> {
  onProgress({ message: '에이전트 인벤토리 수집 중…', percent: 20 })
  let agentCount = 0
  let errors = 0
  try {
    const d = await collectAdminDiagnostics((line) => onProgress({ message: line, percent: 60 }))
    agentCount = d.agents
  } catch {
    errors++
  }
  try {
    evaluateCreditAlerts()
  } catch {
    errors++
  }
  onProgress({ message: '완료', percent: 100 })
  return { agents: agentCount, errors }
}

/**
 * Full pipeline: runs every source in sequence. Retained for any automated/
 * full-collection path; the UI now triggers each source from its own page.
 */
export async function runCollection(
  trigger: string,
  onProgress: ProgressCb,
  opts: { maxUsers?: number; forceBackfill?: boolean } = {}
): Promise<CollectResult> {
  const conv = await runConversationCollection(
    trigger,
    (p) => onProgress({ phase: 'interactions', message: p.message, percent: Math.round(p.percent * 0.9) }),
    opts
  )
  const aud = await runAuditCollection((p) =>
    onProgress({ phase: 'audit', message: p.message, percent: 90 + Math.round(p.percent * 0.03) })
  )
  const usg = await runUsageCollection((p) =>
    onProgress({ phase: 'usage', message: p.message, percent: 95 + Math.round(p.percent * 0.02) })
  )
  const diag = await runDiagnosticsCollection((p) =>
    onProgress({ phase: 'diagnostics', message: p.message, percent: 98 + Math.round(p.percent * 0.02) })
  )
  onProgress({ phase: 'done', message: '완료', percent: 100 })
  return {
    users: conv.users,
    interactions: conv.interactions,
    audit: aud.audit,
    usage: usg.usage,
    agents: diag.agents,
    errors: conv.errors + aud.errors + usg.errors + diag.errors
  }
}
