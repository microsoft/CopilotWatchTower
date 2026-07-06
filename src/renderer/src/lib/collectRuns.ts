import { useSyncExternalStore } from 'react'
import { invoke, subscribe } from './api'
import i18n, { LOCALE_TAG, type AppLanguage } from '../i18n'
import { formatNumber } from './format'

export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export interface LogLine {
  time: string
  text: string
  level: LogLevel
}
export type RunKind =
  | 'conversation'
  | 'audit'
  | 'usage'
  | 'diagnostics'
  | 'transcripts'
  | 'flowruns'
  | 'agentdefs'
  | 'consumption'

export interface RunState {
  running: boolean
  percent: number | null
  lines: LogLine[]
}

interface RunResult {
  ok: boolean
  error?: string
  users?: number
  interactions?: number
  audit?: number
  usage?: number
  agents?: number
  environments?: number
  transcripts?: number
  rows?: number
  runs?: number
}
interface RunConfig {
  channel: string
  method: string
  startLine: () => string
  done: (r: RunResult) => string
}

function n(v: number): string {
  return formatNumber(v, i18n.language)
}

const CONFIG: Record<RunKind, RunConfig> = {
  conversation: {
    channel: 'conversation_progress',
    method: 'conversation_collect_start',
    startLine: () => i18n.t('liveLog:runs.conversation.start'),
    done: (r) => i18n.t('liveLog:runs.conversation.done', { users: n(r.users ?? 0), interactions: n(r.interactions ?? 0) })
  },
  audit: {
    channel: 'audit_progress',
    method: 'audit_collect_start',
    startLine: () => i18n.t('liveLog:runs.audit.start'),
    done: (r) => i18n.t('liveLog:runs.audit.done', { audit: n(r.audit ?? 0) })
  },
  usage: {
    channel: 'usage_progress',
    method: 'usage_collect_start',
    startLine: () => i18n.t('liveLog:runs.usage.start'),
    done: (r) => i18n.t('liveLog:runs.usage.done', { usage: n(r.usage ?? 0) })
  },
  diagnostics: {
    channel: 'diagnostics_progress',
    method: 'diagnostics_collect_start',
    startLine: () => i18n.t('liveLog:runs.diagnostics.start'),
    done: (r) => i18n.t('liveLog:runs.diagnostics.done', { agents: r.agents ?? 0 })
  },
  transcripts: {
    channel: 'transcripts_progress',
    method: 'transcripts_collect_start',
    startLine: () => i18n.t('liveLog:runs.transcripts.start'),
    done: (r) =>
      i18n.t('liveLog:runs.transcripts.done', {
        environments: r.environments ?? 0,
        transcripts: n(r.transcripts ?? 0),
        rows: n(r.rows ?? 0)
      })
  },
  flowruns: {
    channel: 'flowruns_progress',
    method: 'flowruns_collect_start',
    startLine: () => i18n.t('liveLog:runs.flowruns.start'),
    done: (r) => i18n.t('liveLog:runs.flowruns.done', { environments: r.environments ?? 0, runs: n(r.runs ?? 0) })
  },
  agentdefs: {
    channel: 'agentdefs_progress',
    method: 'agentdefs_collect_start',
    startLine: () => i18n.t('liveLog:runs.agentdefs.start'),
    done: (r) => i18n.t('liveLog:runs.agentdefs.done', { environments: r.environments ?? 0, agents: r.agents ?? 0 })
  },
  consumption: {
    channel: 'consumption_progress',
    method: 'consumption_collect_start',
    startLine: () => i18n.t('liveLog:runs.consumption.start'),
    done: (r) => i18n.t('liveLog:runs.consumption.done', { rows: n(r.rows ?? 0) })
  }
}

/**
 * Collection runs live here, at module scope, so they survive page
 * navigation: the backend keeps collecting and the live log keeps filling even
 * while the page is unmounted. Pages subscribe via {@link useCollectionRun}.
 */
const state: Record<RunKind, RunState> = {
  conversation: { running: false, percent: null, lines: [] },
  audit: { running: false, percent: null, lines: [] },
  usage: { running: false, percent: null, lines: [] },
  diagnostics: { running: false, percent: null, lines: [] },
  transcripts: { running: false, percent: null, lines: [] },
  flowruns: { running: false, percent: null, lines: [] },
  agentdefs: { running: false, percent: null, lines: [] },
  consumption: { running: false, percent: null, lines: [] }
}

const listeners = new Set<() => void>()
function emit(): void {
  for (const fn of listeners) fn()
}
function subscribeStore(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function stamp(): string {
  const tag = LOCALE_TAG[(i18n.language as AppLanguage) in LOCALE_TAG ? (i18n.language as AppLanguage) : 'ko']
  return new Date().toLocaleTimeString(tag, { hour12: false })
}
function levelOf(text: string): LogLevel {
  if (/오류|실패|error|fail/i.test(text)) return 'error'
  if (/경고|warn/i.test(text)) return 'warn'
  if (/완료|성공|done|✓/i.test(text)) return 'success'
  return 'info'
}
function push(kind: RunKind, text: string, level?: LogLevel): void {
  if (!text) return
  const s = state[kind]
  const lines = [...s.lines, { time: stamp(), text, level: level ?? levelOf(text) }]
  // Guard against unbounded growth on very large tenants.
  state[kind] = { ...s, lines: lines.length > 2000 ? lines.slice(lines.length - 2000) : lines }
  emit()
}
function errLabel(e?: string): string {
  if (e === 'no-credentials') return i18n.t('liveLog:errors.no-credentials')
  if (e === 'already-running') return i18n.t('liveLog:errors.already-running')
  return e ?? 'unknown'
}

/** Start a collection run for the given kind (no-op if one is already running). */
export async function startRun(kind: RunKind, payload?: unknown): Promise<void> {
  if (state[kind].running) return
  const cfg = CONFIG[kind]
  state[kind] = { running: true, percent: null, lines: [] }
  emit()
  push(kind, cfg.startLine())
  const unsub = subscribe<{ message: string; percent?: number }>(cfg.channel, (p) => {
    if (typeof p.percent === 'number') state[kind] = { ...state[kind], percent: p.percent }
    push(kind, p.message)
  })
  try {
    const r = await invoke<RunResult>(cfg.method, payload)
    if (r?.ok) push(kind, cfg.done(r), 'success')
    else push(kind, i18n.t('liveLog:errors.prefix', { message: errLabel(r?.error) }), 'error')
  } catch (e) {
    push(kind, i18n.t('liveLog:errors.prefix', { message: e instanceof Error ? e.message : String(e) }), 'error')
  } finally {
    unsub()
    state[kind] = { ...state[kind], running: false, percent: null }
    emit()
  }
}

/** Clear the log for a kind (ignored while a run is in progress). */
export function clearRun(kind: RunKind): void {
  if (state[kind].running) return
  state[kind] = { running: false, percent: null, lines: [] }
  emit()
}

/**
 * Start a targeted collection for a single user (uses the shared 'conversation'
 * run slot, so it streams to the same live console).
 */
export async function startConversationUser(userId: string, label: string): Promise<void> {
  const kind: RunKind = 'conversation'
  if (state[kind].running) return
  state[kind] = { running: true, percent: 0, lines: [] }
  emit()
  push(kind, i18n.t('liveLog:userScoped.start', { label }))
  const unsub = subscribe<{ message: string; percent: number }>('conversation_progress', (p) => {
    state[kind] = { ...state[kind], percent: p.percent }
    push(kind, p.message)
  })
  try {
    const r = await invoke<RunResult>('conversation_collect_user', userId)
    if (r?.ok) push(kind, i18n.t('liveLog:userScoped.done', { label, count: n(r.interactions ?? 0) }), 'success')
    else push(kind, i18n.t('liveLog:errors.prefix', { message: errLabel(r?.error) }), 'error')
  } catch (e) {
    push(kind, i18n.t('liveLog:errors.prefix', { message: e instanceof Error ? e.message : String(e) }), 'error')
  } finally {
    unsub()
    state[kind] = { ...state[kind], running: false, percent: null }
    emit()
  }
}

/** Subscribe a React component to a kind's run state. */
export function useCollectionRun(kind: RunKind): RunState {
  return useSyncExternalStore(subscribeStore, () => state[kind])
}

// ---- eDiscovery custom run -----------------------------------------------
// eDiscovery has a bespoke flow (UPN/date params, device-code, job resume) that
// does not fit the generic startRun(kind) shape, so it gets its own module-scope
// slot. Living here (not in the page) means the live log survives page remounts
// — e.g. the Topbar 새로고침 button (which remounts the page via its key) no
// longer wipes an in-progress eDiscovery log.
let edState: RunState = { running: false, percent: null, lines: [] }
function setEd(next: RunState): void {
  edState = next
  emit()
}
/** Read the eDiscovery run state (non-hook, for handler guards). */
export function getEdiscoveryRun(): RunState {
  return edState
}
/** Subscribe a React component to the eDiscovery run state. */
export function useEdiscoveryRun(): RunState {
  return useSyncExternalStore(subscribeStore, () => edState)
}
/** Mark the eDiscovery run as started; clears the log unless resuming. */
export function edBeginRun(reset: boolean): void {
  setEd({ running: true, percent: null, lines: reset ? [] : edState.lines })
}
/** Append a line to the eDiscovery live log. */
export function edLog(text: string, level?: LogLevel): void {
  if (!text) return
  const lines = [...edState.lines, { time: stamp(), text, level: level ?? levelOf(text) }]
  setEd({ ...edState, lines: lines.length > 2000 ? lines.slice(lines.length - 2000) : lines })
}
/** Mark the eDiscovery run as finished. */
export function edEndRun(): void {
  setEd({ ...edState, running: false, percent: null })
}
/** Clear the eDiscovery log (ignored while a run is in progress). */
export function edClearRun(): void {
  if (edState.running) return
  setEd({ running: false, percent: null, lines: [] })
}
