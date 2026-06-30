/**
 * Conversation threading, ported from services/threading_engine.py.
 * Session grouping → idle-gap (30m) + prompt-token Jaccard (>=0.3) clustering →
 * deterministic thread id = sha1(source_type \x1f user_id \x1f sorted session_ids).
 */
import { createHash } from 'node:crypto'
import * as db from './db'

const IDLE_GAP_MINUTES = 30
const TOPIC_JACCARD_THRESHOLD = 0.3
const TITLE_MAX_LEN = 80
const MIN_TOKEN_LEN = 2

const STOPWORDS = new Set<string>([
  // English
  'a','an','and','are','as','at','be','but','by','can','could','did','do','does','for','from','had','has','have',
  'he','her','him','his','how','i','if','in','into','is','it','its','just','let','like','make','may','me','my',
  'no','not','now','of','on','one','or','our','out','she','should','so','some','than','that','the','their','them',
  'then','there','these','they','this','those','to','too','two','up','us','use','was','way','we','were','what',
  'when','where','which','who','why','will','with','would','you','your','please','thanks','thank',
  // Korean
  '그리고','그러나','그래서','그런데','또한','이것','그것','저것','이거','그거','저거','있다','없다','하다','되다','이다',
  '입니다','합니다','있어요','없어요','주세요','해주세요','있는','없는','되는','하는','그','이','저','수','것',
  '등','더','또','및','위해','대한','대해','에서','에게','으로','로서','로써','에는','에서는','까지','부터','한테',
  '께서','보다','처럼','같이','마저','조차','라도','라서','하지만','그렇지만','그렇다면','안녕하세요','감사합니다'
])

const TOKEN_RE = /[A-Za-z]+|[\uac00-\ud7a3]+|[\u4e00-\u9fff]+/g

export interface TurnInput {
  id: string
  userId: string
  sessionId: string | null
  requestId: string | null
  createdAt: string
  interactionType: string | null
  app: string | null
  bodyText: string | null
}

export interface ThreadGroup {
  id: string
  userId: string
  startedAt: string
  endedAt: string
  app: string | null
  sessionIds: string[]
  interactionIds: string[]
  promptCount: number
  responseCount: number
  turnCount: number
  title: string | null
}

function tokenize(text: string | null): string[] {
  if (!text) return []
  const matches = text.match(TOKEN_RE)
  if (!matches) return []
  const out: string[] = []
  for (const raw of matches) {
    const tok = raw.toLowerCase()
    if (tok.length < MIN_TOKEN_LEN) continue
    if (STOPWORDS.has(tok)) continue
    out.push(tok)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function minutesBetween(endIso: string, startIso: string): number | null {
  const a = Date.parse(endIso)
  const b = Date.parse(startIso)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, (b - a) / 60000)
}

function trimTitle(text: string): string {
  const cleaned = text.split(/\s+/).filter(Boolean).join(' ')
  return cleaned.length <= TITLE_MAX_LEN ? cleaned : cleaned.slice(0, TITLE_MAX_LEN - 1) + '\u2026'
}

function makeThreadId(userId: string, parts: string[], sourceType: string): string {
  const h = createHash('sha1')
  h.update(sourceType, 'utf8')
  h.update(Buffer.from([0x1f]))
  h.update(userId, 'utf8')
  for (const p of [...parts].sort()) {
    h.update(Buffer.from([0x1f]))
    h.update(p, 'utf8')
  }
  return 'thr_' + h.digest('hex').slice(0, 32)
}

function mode(counter: Map<string, number>): string | null {
  let best: string | null = null
  let bestN = -1
  for (const [k, n] of counter) {
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  return best
}

interface SessionSummary {
  sessionId: string
  startedAt: string
  endedAt: string
  promptTokens: Set<string>
  turns: TurnInput[]
  dominantApp: string | null
  promptCount: number
  responseCount: number
}

const byTime = (a: { startedAt?: string; createdAt?: string }, b: { startedAt?: string; createdAt?: string }): number => {
  const av = a.startedAt ?? a.createdAt ?? ''
  const bv = b.startedAt ?? b.createdAt ?? ''
  return av < bv ? -1 : av > bv ? 1 : 0
}

function computeUserThreads(userId: string, turns: TurnInput[], sourceType: string): ThreadGroup[] {
  const sessions = new Map<string, TurnInput[]>()
  let nullCounter = 0
  for (const t of turns) {
    if (t.sessionId) {
      const arr = sessions.get(t.sessionId) ?? []
      arr.push(t)
      sessions.set(t.sessionId, arr)
    } else {
      nullCounter++
      sessions.set(`__null__${nullCounter}__${t.id}`, [t])
    }
  }

  const summaries: SessionSummary[] = []
  for (const [sid, ts] of sessions) {
    ts.sort(byTime)
    const promptTokens = new Set<string>()
    const appCounter = new Map<string, number>()
    let promptCount = 0
    let responseCount = 0
    for (const t of ts) {
      if (t.app) appCounter.set(t.app, (appCounter.get(t.app) ?? 0) + 1)
      const kind = (t.interactionType ?? '').toLowerCase()
      if (kind === 'userprompt') {
        promptCount++
        for (const tok of tokenize(t.bodyText)) promptTokens.add(tok)
      } else if (kind === 'airesponse') {
        responseCount++
      }
    }
    summaries.push({
      sessionId: sid,
      startedAt: ts[0].createdAt,
      endedAt: ts[ts.length - 1].createdAt,
      promptTokens,
      turns: ts,
      dominantApp: mode(appCounter),
      promptCount,
      responseCount
    })
  }
  summaries.sort(byTime)

  const clusters: SessionSummary[][] = []
  for (const s of summaries) {
    if (clusters.length === 0) {
      clusters.push([s])
      continue
    }
    const prevCluster = clusters[clusters.length - 1]
    const prev = prevCluster[prevCluster.length - 1]
    const gap = minutesBetween(prev.endedAt, s.startedAt)
    const sim = jaccard(prev.promptTokens, s.promptTokens)
    if (gap !== null && gap <= IDLE_GAP_MINUTES && sim >= TOPIC_JACCARD_THRESHOLD) {
      prevCluster.push(s)
    } else {
      clusters.push([s])
    }
  }

  return clusters.map((cluster) => finaliseThread(userId, cluster, sourceType))
}

function finaliseThread(userId: string, cluster: SessionSummary[], sourceType: string): ThreadGroup {
  const startedAt = cluster[0].startedAt
  const endedAt = cluster[cluster.length - 1].endedAt
  const sessionIds = cluster.map((c) => c.sessionId).filter((s) => !s.startsWith('__null__'))
  const interactionIds: string[] = []
  const appCounter = new Map<string, number>()
  let title: string | null = null
  let promptCount = 0
  let responseCount = 0
  for (const s of cluster) {
    promptCount += s.promptCount
    responseCount += s.responseCount
    if (s.dominantApp) appCounter.set(s.dominantApp, (appCounter.get(s.dominantApp) ?? 0) + s.turns.length)
    for (const t of s.turns) {
      interactionIds.push(t.id)
      if ((t.interactionType ?? '').toLowerCase() === 'userprompt' && title === null && t.bodyText) {
        title = trimTitle(t.bodyText)
      }
    }
  }
  if (title === null) {
    outer: for (const s of cluster) {
      for (const t of s.turns) {
        if (t.bodyText) {
          title = trimTitle(t.bodyText)
          break outer
        }
      }
    }
  }
  const parts = sessionIds.length ? sessionIds : interactionIds
  return {
    id: makeThreadId(userId, parts, sourceType),
    userId,
    startedAt,
    endedAt,
    app: mode(appCounter),
    sessionIds,
    interactionIds,
    promptCount,
    responseCount,
    turnCount: promptCount + responseCount,
    title
  }
}

export function computeThreads(turns: TurnInput[], sourceType: string): ThreadGroup[] {
  const byUser = new Map<string, TurnInput[]>()
  for (const t of turns) {
    if (!t.userId || !t.createdAt) continue
    const arr = byUser.get(t.userId) ?? []
    arr.push(t)
    byUser.set(t.userId, arr)
  }
  const out: ThreadGroup[] = []
  for (const [uid, ut] of byUser) out.push(...computeUserThreads(uid, ut, sourceType))
  out.sort((a, b) => (a.startedAt > b.startedAt ? -1 : a.startedAt < b.startedAt ? 1 : 0))
  return out
}

/** Rebuild conversation_threads for one user + source from stored interactions. */
export function recomputeThreads(userId: string, sourceType: string): number {
  const turns = db.interactionsForUser(userId, sourceType)
  const threads = computeThreads(turns, sourceType)
  db.deleteUserThreads(userId, sourceType)
  db.upsertThreads(threads, sourceType)
  const pairs: Array<[string, string]> = []
  for (const t of threads) for (const iid of t.interactionIds) pairs.push([iid, t.id])
  db.assignThreadsToInteractions(pairs)
  return threads.length
}
