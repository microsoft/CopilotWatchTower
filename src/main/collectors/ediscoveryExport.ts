/**
 * Microsoft Purview eDiscovery export-package parser — port of the portable
 * core of services/ediscovery_export.py. Walks a downloaded export ZIP and
 * reconstructs ordered prompt/response turns so the threading engine groups
 * them like license-based Copilot interactions.
 *
 * Supported entry formats (no native deps — ZIP via node:zlib inflateRaw):
 *   .json / .jsonl — normalised {conversationId, createdDateTime, prompt,
 *                    response, app} records (the shaped Copilot form).
 *   .eml           — best-effort RFC822 header + plain-body parse.
 *   .msg           — Outlook MSG (OLE compound file) via `cfb`; extracts the
 *                    Teams/Copilot body stream (__substg1.0_8008001F).
 */
import { inflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import type { InteractionUpsert } from '../db'

const USER_PROMPT = 'userPrompt'
const AI_RESPONSE = 'aiResponse'
const DEFAULT_APP = 'BizChat'
const SOURCE_EDISCOVERY = 'ediscovery'

const PROMPT_MARKERS = ['user:', 'prompt:', '사용자:', '질문:']
const RESPONSE_MARKERS = ['copilot:', 'assistant:', 'response:', 'copilot 응답:', '응답:']

type Dict = Record<string, unknown>

interface ParsedTurn {
  interactionType: string
  bodyText: string
  createdAt: string
  requestId: string
}
interface ParsedItem {
  itemId: string
  conversationId: string | null
  createdAt: string
  app: string
  turns: ParsedTurn[]
  raw: Dict
}

function isoNow(): string {
  return new Date().toISOString()
}
function iso(value: unknown): string {
  if (value === null || value === undefined || value === '') return isoNow()
  const text = String(value).trim()
  // Teams/Copilot timestamps are epoch milliseconds (e.g. creationDate
  // 1782027647001). Date(string) can't parse those, so convert explicitly.
  // Keep millisecond precision: within a thread a prompt and its reply often
  // share the same second, and second-truncation makes `ORDER BY created_at`
  // tie and mis-order them.
  if (/^\d{12,}$/.test(text)) {
    const d = new Date(Number(text))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) return text
  return d.toISOString()
}

/** Split a combined Copilot body into ordered (type, text) turns. */
export function splitCopilotBody(body: string): Array<[string, string]> {
  if (!body || !body.trim()) return []
  const lines = body.split(/\r?\n/)
  const turns: Array<[string, string]> = []
  let currentType: string | null = null
  let buffer: string[] = []
  const flush = (): void => {
    if (currentType && buffer.length) {
      const text = buffer.join('\n').trim()
      if (text) turns.push([currentType, text])
    }
  }
  for (const line of lines) {
    const lowered = line.trim().toLowerCase()
    const mp = PROMPT_MARKERS.find((m) => lowered.startsWith(m))
    const mr = RESPONSE_MARKERS.find((m) => lowered.startsWith(m))
    if (mp !== undefined) {
      flush()
      currentType = USER_PROMPT
      buffer = [line.trim().slice(mp.length).trim()]
    } else if (mr !== undefined) {
      flush()
      currentType = AI_RESPONSE
      buffer = [line.trim().slice(mr.length).trim()]
    } else {
      buffer.push(line)
    }
  }
  flush()
  if (!turns.length) return [[AI_RESPONSE, body.trim()]]
  return turns
}

function turnsFromPairs(itemId: string, pairs: Array<[string, string]>, createdAt: string): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let pairIdx = 0
  let lastType: string | null = null
  for (const [turnType, text] of pairs) {
    if (turnType === USER_PROMPT || (turnType === AI_RESPONSE && lastType === AI_RESPONSE)) pairIdx++
    turns.push({ interactionType: turnType, bodyText: text, createdAt, requestId: `${itemId}#${pairIdx}` })
    lastType = turnType
  }
  return turns
}

function parseNormalisedRecord(rec: Dict, fallbackId: string): ParsedItem {
  const itemId = String(rec.id ?? rec.itemId ?? fallbackId)
  const conversationId = rec.conversationId ?? rec.conversation_id ?? rec.threadId
  const createdAt = iso(rec.createdDateTime ?? rec.created_at ?? rec.date)
  const app = (rec.app ?? rec.appHost ?? DEFAULT_APP) as string
  const pairs: Array<[string, string]> = []
  if (rec.prompt) pairs.push([USER_PROMPT, String(rec.prompt)])
  if (rec.response) pairs.push([AI_RESPONSE, String(rec.response)])
  const finalPairs = pairs.length ? pairs : splitCopilotBody(String(rec.body ?? ''))
  return {
    itemId,
    conversationId: conversationId ? String(conversationId) : null,
    createdAt,
    app: app ? String(app) : DEFAULT_APP,
    turns: turnsFromPairs(itemId, finalPairs, createdAt),
    raw: rec
  }
}

function parseEmlBytes(data: Buffer, name: string): ParsedItem | null {
  const text = data.toString('utf-8')
  const sepIdx = text.search(/\r?\n\r?\n/)
  const headerBlock = sepIdx >= 0 ? text.slice(0, sepIdx) : text
  const body = sepIdx >= 0 ? text.slice(sepIdx).replace(/^\r?\n\r?\n/, '') : ''
  const headers = new Map<string, string>()
  let lastKey = ''
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && lastKey) {
      headers.set(lastKey, `${headers.get(lastKey) ?? ''} ${line.trim()}`)
      continue
    }
    const m = /^([^:]+):\s?(.*)$/.exec(line)
    if (m) {
      lastKey = m[1].toLowerCase()
      headers.set(lastKey, m[2])
    }
  }
  const subject = headers.get('subject') ?? ''
  const messageId = (headers.get('message-id') ?? name).replace(/[<>]/g, '') || name
  const conversationId = headers.get('thread-index') ?? headers.get('x-conversation-id') ?? messageId
  const createdAt = iso(headers.get('date'))
  let pairs = body ? splitCopilotBody(body) : []
  if (subject && (!pairs.length || pairs[0][0] !== USER_PROMPT)) {
    pairs = [[USER_PROMPT, subject], ...pairs]
  }
  return {
    itemId: messageId,
    conversationId: conversationId ? String(conversationId) : null,
    createdAt,
    app: DEFAULT_APP,
    turns: turnsFromPairs(messageId, pairs, createdAt),
    raw: { subject, name }
  }
}

// ---- .msg (Outlook MSG / OLE compound file) parsing ---------------------
type CfbContainer = ReturnType<typeof CFB.read>

function msgStream(container: CfbContainer, name: string): Buffer | null {
  const e = container.FileIndex.find((f) => f.name === name)
  if (!e || !e.content) return null
  return Buffer.from(e.content as Uint8Array)
}
function cleanMsgText(value: string): string {
  return value.replace(/\u0000/g, '').replace(/[ \t\r\f\v]+/g, ' ').trim()
}
/** Parse a Teams/Copilot ItemData JSON blob (a `{SchemaVersion,ItemData}`
 * wrapper, or the item object directly). */
function parseItemDataText(text: string): Dict | null {
  try {
    const outer = JSON.parse(text.replace(/\u0000/g, '').trim()) as Dict
    let parsed: unknown = outer.ItemData
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (parsed && typeof parsed === 'object') return parsed as Dict
    // Some exports store the item fields on the outer object directly.
    if (
      outer &&
      (outer.threadId || outer.from || outer.content || outer.messagetype || outer.messageType || outer.creationDate)
    ) {
      return outer
    }
  } catch {
    /* not item data */
  }
  return null
}
/** Decode the Teams/Copilot ItemData. Normally in __substg1.0_8008001F, but some
 * items (esp. agent/Studio responses) store it in a DYNAMIC named property
 * instead — scan named PT_UNICODE props for the blob so those parse fully
 * (giving the real threadId, creationDate, sender and content). */
function teamsItemData(container: CfbContainer): Dict | null {
  const raw = msgStream(container, '__substg1.0_8008001F')
  if (raw && raw.length) {
    const p = parseItemDataText(raw.toString('utf16le'))
    if (p) return p
  }
  for (const f of container.FileIndex) {
    const n = (f as { name?: string }).name
    if (typeof n !== 'string' || !n.startsWith('__substg1.0_')) continue
    const tag = n.slice('__substg1.0_'.length)
    if (!/^[89A-Fa-f][0-9A-Fa-f]{3}001F$/i.test(tag) || !f.content) continue
    const text = Buffer.from(f.content as Uint8Array).toString('utf16le')
    if (text.indexOf('"ItemData"') < 0) continue // cheap pre-filter
    const p = parseItemDataText(text)
    if (p) return p
  }
  return null
}
function teamsTurnType(itemData: Dict): string {
  const sender = String(itemData.messageFrom ?? itemData.imdisplayname ?? '')
  const from = itemData.from
  if (from && typeof from === 'object') {
    const f = from as Dict
    const rt = String(f.recipientType ?? '').toLowerCase()
    const iid = String(f.internalId ?? '')
    if (rt === 'applications' || iid.startsWith('28:')) return AI_RESPONSE
  }
  if (sender.startsWith('28:')) return AI_RESPONSE
  return USER_PROMPT
}
/** Extract a SYSTIME (ClientSubmitTime 0x0039 / DeliveryTime 0x0E06) from props. */
function msgDate(container: CfbContainer): string {
  const props = msgStream(container, '__properties_version1.0')
  if (!props || props.length < 32) return ''
  let fallback = ''
  for (let off = 32; off + 16 <= props.length; off += 16) {
    if (props.readUInt16LE(off) !== 0x0040) continue // PT_SYSTIME
    const id = props.readUInt16LE(off + 2)
    if (id !== 0x0039 && id !== 0x0e06) continue
    const lo = props.readUInt32LE(off + 8)
    const hi = props.readUInt32LE(off + 12)
    const ms = (hi * 4294967296 + lo) / 10000 - 11644473600000
    if (ms > 0) {
      const isoStr = new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
      if (id === 0x0039) return isoStr // ClientSubmitTime preferred
      fallback = isoStr
    }
  }
  return fallback
}
function htmlUnescape(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n))
      } catch {
        return ''
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16))
      } catch {
        return ''
      }
    })
    .replace(/&amp;/gi, '&')
}
/** Decode bytes with the codec that yields the fewest U+FFFD replacement chars
 * and the most Hangul syllables (port of the Python multi-encoding scoring).
 * PidTagHtml bodies in Copilot/Teams exports are frequently EUC-KR/cp949, not
 * UTF-8 — decoding those as UTF-8 turns Korean into `����`. The WHATWG `euc-kr`
 * decoder covers the full cp949/UHC (and ks_c_5601) range. */
function decodeBestEffort(raw: Buffer): string {
  let best = ''
  let bestScore = -Infinity
  for (const enc of ['utf-8', 'euc-kr', 'windows-1252']) {
    let text: string
    try {
      text = new TextDecoder(enc).decode(raw)
    } catch {
      continue // codec label unsupported in this ICU build
    }
    let repl = 0
    let kor = 0
    for (const ch of text) {
      const c = ch.codePointAt(0) as number
      if (c === 0xfffd) repl++
      else if (c >= 0xac00 && c <= 0xd7a3) kor++
    }
    const score = -10 * repl + kor
    if (score > bestScore) {
      best = text
      bestScore = score
    }
  }
  return best
}
/** Rich-message fallback: strip the .msg HTML body (PidTagHtml 10130102) to text.
 * Copilot adaptive-card answers carry empty `content`/plain-body but a full HTML
 * body, so without this the substantive answer turn is dropped (port of Python
 * _html_body_text). The HTML charset varies (UTF-8 / EUC-KR), so pick the best
 * decode rather than assuming UTF-8. */
function htmlBodyText(container: CfbContainer): string {
  const raw = msgStream(container, '__substg1.0_10130102')
  if (!raw || !raw.length) return ''
  let text = decodeBestEffort(raw)
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  text = text.replace(/<[^>]+>/g, ' ')
  text = htmlUnescape(text)
  return text.replace(/[ \t\r\f\v]+/g, ' ').trim()
}
const TEAMS_THREAD_ID_RE = /19:[A-Za-z0-9_+\-/=.]+@(?:thread\.[a-z0-9]+|unq\.gbl\.spaces)/i
/** Decode a single property stream as text (utf16le for PT_UNICODE / PT_MV_UNICODE,
 * best-effort for PT_STRING8). */
function propText(f: { content?: unknown }, tag: string): string {
  const buf = f.content ? Buffer.from(f.content as Uint8Array) : null
  if (!buf || !buf.length) return ''
  return /001E$/i.test(tag) ? decodeBestEffort(buf) : buf.toString('utf16le')
}
/** Some response .msg items carry no 8008001F ItemData blob; the Teams thread id
 * (``19:…@thread.v2``) is instead embedded in one of the named string properties.
 * Scan every string property for it so the message merges into the same
 * conversation as its prompt instead of becoming a single-message thread. */
function teamsThreadIdFromProps(container: CfbContainer): string {
  for (const f of container.FileIndex) {
    const n = (f as { name?: string }).name
    if (typeof n !== 'string' || !n.startsWith('__substg1.0_')) continue
    const tag = n.slice('__substg1.0_'.length)
    if (!/(001F|001E|101F)(-[0-9A-Fa-f]{8})?$/i.test(tag)) continue
    const m = TEAMS_THREAD_ID_RE.exec(propText(f, tag))
    if (m) return m[0]
  }
  return ''
}
/** PidTagConversationTopic (0070), unicode or 8-bit codepage. */
function conversationTopic(container: CfbContainer): string {
  const u = msgStream(container, '__substg1.0_0070001F')
  if (u && u.length) return cleanMsgText(u.toString('utf16le'))
  const a = msgStream(container, '__substg1.0_0070001E')
  if (a && a.length) return cleanMsgText(decodeBestEffort(a))
  return ''
}
/** PidTagConversationIndex (0071, PT_BINARY): bytes 6..22 are the conversation
 * root GUID, shared by every message in the same conversation. */
function conversationIndexGuid(container: CfbContainer): string {
  const b = msgStream(container, '__substg1.0_00710102')
  if (!b || b.length < 22) return ''
  return b.subarray(6, 22).toString('hex')
}
const CARD_TEXT_KEYS = new Set(['text', 'title', 'subtitle', 'description', 'description1'])
function collectCardText(node: unknown, out: string[], key?: string): void {
  if (typeof node === 'string') {
    const s = node.trim()
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        collectCardText(JSON.parse(s), out, key)
        return
      } catch {
        /* not nested JSON — treat as plain text below */
      }
    }
    if (key && CARD_TEXT_KEYS.has(key) && s) out.push(s)
  } else if (Array.isArray(node)) {
    for (const x of node) collectCardText(x, out, key)
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) collectCardText(v, out, k.toLowerCase())
  }
}
/** A Teams Copilot answer is often an adaptive card wrapped in a SWIFT URIObject
 * (`<URIObject type="SWIFT.1"><Swift b64="…">`); the visible answer lives in the
 * card's TextBlocks. Decode the b64 + extract that text instead of storing the
 * raw markup (which is what Purview's plain-text view shows). */
function unwrapSwiftCard(text: string): string {
  if (!text || text.indexOf('URIObject') < 0) return text
  const m = /b64="([^"]+)"/i.exec(text) || /b64='([^']+)'/i.exec(text)
  if (!m) return text
  let obj: unknown
  try {
    obj = JSON.parse(Buffer.from(m[1], 'base64').toString('utf-8'))
  } catch {
    return text
  }
  const out: string[] = []
  collectCardText(obj, out)
  const seen: string[] = []
  for (const t of out) if (!seen.includes(t)) seen.push(t)
  return seen.join('\n').trim() || text
}
function parseMsgBytes(data: Buffer, name: string): ParsedItem | null {
  let container: CfbContainer
  try {
    container = CFB.read(data, { type: 'buffer' })
  } catch {
    return null
  }
  const uni = (tag: string): string => {
    const b = msgStream(container, '__substg1.0_' + tag)
    return b ? cleanMsgText(b.toString('utf16le')) : ''
  }
  const subject = uni('0037001F') // PidTagSubject
  const messageId = (uni('1035001F').replace(/[<>]/g, '') || name).trim() || name
  const itemData = teamsItemData(container)
  if (itemData) {
    // Real message time: Teams stores epoch-ms in creationDate / eventCreatedTime.
    const ts =
      itemData.creationDate ??
      itemData.eventCreatedTime ??
      itemData.originalarrivaltime ??
      itemData.composetime ??
      itemData.createdDateTime
    const createdAt = iso(ts ?? (msgDate(container) || undefined))
    const body = unwrapSwiftCard(
      cleanMsgText(String(itemData.content ?? '')) || uni('1000001F') || htmlBodyText(container)
    )
    const conversationId = cleanMsgText(String(itemData.threadId ?? '')) || messageId
    const turns: ParsedTurn[] = body
      ? [{ interactionType: teamsTurnType(itemData), bodyText: body, createdAt, requestId: messageId }]
      : []
    return {
      itemId: messageId,
      conversationId,
      createdAt,
      app: DEFAULT_APP,
      turns,
      raw: { subject, name, messageId, itemData }
    }
  }
  // Non-Teams item: split the plain body on User:/Copilot: markers.
  const createdAt = iso(msgDate(container) || undefined)
  const body = unwrapSwiftCard(uni('1000001F') || htmlBodyText(container)) // PidTagBody, HTML, then SWIFT card
  let pairs = body ? splitCopilotBody(body) : []
  if (subject && (!pairs.length || pairs[0][0] !== USER_PROMPT)) pairs = [[USER_PROMPT, subject], ...pairs]
  // These items have no 8008001F ItemData blob; the Teams thread id is embedded
  // in a named string property. Scan for it so the message merges into the same
  // conversation as its prompt, then fall back to the Exchange ConversationIndex
  // GUID / topic, and finally the message id.
  const scannedThreadId = teamsThreadIdFromProps(container)
  const topic = conversationTopic(container)
  const convGuid = conversationIndexGuid(container)
  const conversationId = scannedThreadId || convGuid || topic || messageId
  return {
    itemId: messageId,
    conversationId,
    createdAt,
    app: DEFAULT_APP,
    turns: turnsFromPairs(messageId, pairs, createdAt),
    raw: { subject, name }
  }
}

/** Minimal dependency-free ZIP reader (central directory + raw inflate). */
export function readZipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = []
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return out
  const count = buf.readUInt16LE(eocd + 10)
  let cd = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) break
    const method = buf.readUInt16LE(cd + 10)
    const compSize = buf.readUInt32LE(cd + 20)
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const lho = buf.readUInt32LE(cd + 42)
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen)
    const lfnLen = buf.readUInt16LE(lho + 26)
    const lefLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lfnLen + lefLen
    const comp = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    try {
      data = method === 0 ? Buffer.from(comp) : inflateRawSync(comp)
    } catch {
      data = Buffer.alloc(0)
    }
    out.push({ name, data })
    cd += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Parse a list of package entries into ParsedItems. */
export function parseExportEntries(
  entries: Array<{ name: string; data: Buffer }>,
  onLog?: (line: string) => void
): ParsedItem[] {
  const items: ParsedItem[] = []
  // Diagnostic: surface the entry-type breakdown so a "0 interactions" result
  // is explainable (e.g. all .msg, or an unexpected format).
  const counts: Record<string, number> = {}
  for (const e of entries) {
    if (e.name.endsWith('/') || !e.data.length) continue
    const ext = e.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '(none)'
    counts[ext] = (counts[ext] ?? 0) + 1
  }
  const summary = Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
  if (summary) onLog?.(`패키지 항목 유형: ${summary}`)
  let msgDropped = 0
  for (const entry of entries) {
    const lower = entry.name.toLowerCase()
    if (lower.endsWith('/') || entry.data.length === 0) continue
    try {
      if (lower.endsWith('.json')) {
        const parsed = JSON.parse(entry.data.toString('utf-8'))
        const recs = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Dict)?.value) ? ((parsed as Dict).value as unknown[]) : [parsed]
        recs.forEach((r, i) => {
          if (r && typeof r === 'object') items.push(parseNormalisedRecord(r as Dict, `${entry.name}#${i}`))
        })
      } else if (lower.endsWith('.jsonl')) {
        entry.data
          .toString('utf-8')
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .forEach((line, i) => {
            try {
              const r = JSON.parse(line)
              if (r && typeof r === 'object') items.push(parseNormalisedRecord(r as Dict, `${entry.name}#${i}`))
            } catch {
              /* skip bad line */
            }
          })
      } else if (lower.endsWith('.eml')) {
        const item = parseEmlBytes(entry.data, entry.name)
        if (item) items.push(item)
      } else if (lower.endsWith('.msg')) {
        const item = parseMsgBytes(entry.data, entry.name)
        if (item && item.turns.length) items.push(item)
        else msgDropped++
      } else if (lower.endsWith('.zip')) {
        // Nested export package (some tenants wrap items in per-source zips).
        items.push(...parseExportEntries(readZipEntries(entry.data), onLog))
      }
    } catch (e) {
      onLog?.(`항목 파싱 실패 ${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (msgDropped) onLog?.(`본문 없는 .msg ${msgDropped}개 건너뜀`)
  return items
}

/** Parse a downloaded export ZIP into interaction upserts for the target user. */
export function parseExportPackage(
  zipBytes: Buffer,
  targetUserId: string,
  onLog?: (line: string) => void
): InteractionUpsert[] {
  const items = parseExportEntries(readZipEntries(zipBytes), onLog)
  const rows: InteractionUpsert[] = []
  for (const item of items) {
    item.turns.forEach((turn, idx) => {
      rows.push({
        id: `ediscovery:${item.itemId}:${idx}`,
        userId: targetUserId,
        sessionId: item.conversationId || item.itemId,
        requestId: turn.requestId,
        createdAt: turn.createdAt,
        interactionType: turn.interactionType,
        app: item.app,
        bodyText: turn.bodyText,
        bodyContentType: 'text',
        attachmentsJson: null,
        rawJson: JSON.stringify(item.raw),
        sourceType: SOURCE_EDISCOVERY
      })
    })
  }
  return rows
}
