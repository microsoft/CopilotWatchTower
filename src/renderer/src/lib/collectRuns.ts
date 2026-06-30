import { useSyncExternalStore } from 'react'
import { invoke, subscribe } from './api'

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
  startLine: string
  done: (r: RunResult) => string
}

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

const CONFIG: Record<RunKind, RunConfig> = {
  conversation: {
    channel: 'conversation_progress',
    method: 'conversation_collect_start',
    startLine: '대화 수집을 시작합니다…',
    done: (r) => `완료: 사용자 ${n(r.users ?? 0)}명 · 신규 상호작용 ${n(r.interactions ?? 0)}건`
  },
  audit: {
    channel: 'audit_progress',
    method: 'audit_collect_start',
    startLine: '감사 이벤트 수집을 시작합니다…',
    done: (r) => `완료: 감사 이벤트 ${n(r.audit ?? 0)}건`
  },
  usage: {
    channel: 'usage_progress',
    method: 'usage_collect_start',
    startLine: '사용 리포트 수집을 시작합니다…',
    done: (r) => `완료: 스냅샷 ${n(r.usage ?? 0)}행`
  },
  diagnostics: {
    channel: 'diagnostics_progress',
    method: 'diagnostics_collect_start',
    startLine: '에이전트 진단을 시작합니다…',
    done: (r) => `완료: 에이전트 인벤토리 ${r.agents ?? 0}개`
  },
  transcripts: {
    channel: 'transcripts_progress',
    method: 'transcripts_collect_start',
    startLine: 'Teams 대화 수집을 시작합니다…',
    done: (r) => `완료: 환경 ${r.environments ?? 0} · 대화 ${n(r.transcripts ?? 0)} · 턴 ${n(r.rows ?? 0)}`
  },
  flowruns: {
    channel: 'flowruns_progress',
    method: 'flowruns_collect_start',
    startLine: '플로우 실행 수집을 시작합니다…',
    done: (r) => `완료: 환경 ${r.environments ?? 0} · 실행 ${n(r.runs ?? 0)}건`
  },
  agentdefs: {
    channel: 'agentdefs_progress',
    method: 'agentdefs_collect_start',
    startLine: '에이전트 정의 분석을 시작합니다…',
    done: (r) => `완료: 환경 ${r.environments ?? 0} · 에이전트 ${r.agents ?? 0}개 점수화`
  },
  consumption: {
    channel: 'consumption_progress',
    method: 'consumption_collect_start',
    startLine: '소비량 리포트 수집을 시작합니다…',
    done: (r) => `완료: 소비량 ${n(r.rows ?? 0)}행`
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
  return new Date().toLocaleTimeString('ko-KR', { hour12: false })
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
  if (e === 'no-credentials') return '앱 등록(자격 증명)이 필요합니다. 설정에서 구성하세요.'
  if (e === 'already-running') return '이미 수집이 실행 중입니다.'
  return e ?? 'unknown'
}

/** Start a collection run for the given kind (no-op if one is already running). */
export async function startRun(kind: RunKind, payload?: unknown): Promise<void> {
  if (state[kind].running) return
  const cfg = CONFIG[kind]
  state[kind] = { running: true, percent: null, lines: [] }
  emit()
  push(kind, cfg.startLine)
  const unsub = subscribe<{ message: string; percent?: number }>(cfg.channel, (p) => {
    if (typeof p.percent === 'number') state[kind] = { ...state[kind], percent: p.percent }
    push(kind, p.message)
  })
  try {
    const r = await invoke<RunResult>(cfg.method, payload)
    if (r?.ok) push(kind, cfg.done(r), 'success')
    else push(kind, `오류: ${errLabel(r?.error)}`, 'error')
  } catch (e) {
    push(kind, `오류: ${e instanceof Error ? e.message : String(e)}`, 'error')
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
  push(kind, `${label} 사용자만 수집합니다…`)
  const unsub = subscribe<{ message: string; percent: number }>('conversation_progress', (p) => {
    state[kind] = { ...state[kind], percent: p.percent }
    push(kind, p.message)
  })
  try {
    const r = await invoke<RunResult>('conversation_collect_user', userId)
    if (r?.ok) push(kind, `완료: ${label} · 신규 ${n(r.interactions ?? 0)}건`, 'success')
    else push(kind, `오류: ${errLabel(r?.error)}`, 'error')
  } catch (e) {
    push(kind, `오류: ${e instanceof Error ? e.message : String(e)}`, 'error')
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
