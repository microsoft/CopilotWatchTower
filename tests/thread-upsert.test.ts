import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as db from '../src/main/db'
import type { ThreadGroup } from '../src/main/threading'

let tempDir = ''
let dbPath = ''

const THREAD_ID = 'thread-attribution-1'

function thread(overrides: Partial<ThreadGroup> = {}): ThreadGroup {
  return {
    id: THREAD_ID,
    userId: 'user-000',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:05:00.000Z',
    app: 'BizChat',
    turnCount: 2,
    promptCount: 1,
    responseCount: 1,
    sessionIds: [],
    interactionIds: [],
    title: 'Original title',
    ...overrides
  }
}

function readThread(): Record<string, unknown> {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return raw.prepare('SELECT * FROM conversation_threads WHERE id = ?').get(THREAD_ID) as Record<string, unknown>
  } finally {
    raw.close()
  }
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cwt-thread-upsert-'))
  dbPath = join(tempDir, 'store.db')
  const raw = new DatabaseSync(dbPath)
  raw.exec(readFileSync(resolve('resources/schema.sql'), 'utf8'))
  raw.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('thread_agent_attribution_v1', '1')
  raw
    .prepare('INSERT INTO users(id,upn,display_name,enabled,has_copilot_license,in_scope) VALUES(?,?,?,?,?,?)')
    .run('user-000', 'user-000@example.com', 'User 000', 1, 1, 1)
  raw.close()

  process.env.CWT_DB_PATH = dbPath
  expect(db.openDb()).toBe(true)
})

afterAll(() => {
  db.closeDb()
  delete process.env.CWT_DB_PATH
  rmSync(tempDir, { recursive: true, force: true })
})

describe('upsertThreads', () => {
  it('preserves agent attribution across a re-collection', () => {
    db.upsertThreads([thread()], 'api')

    // Attribution is written by a separate backfill pass, not by the collector.
    const raw = new DatabaseSync(dbPath)
    raw
      .prepare('UPDATE conversation_threads SET agent_key=?, agent_id=?, agent_name=? WHERE id=?')
      .run('api::agent-7', 'agent-7', 'HR Assistant', THREAD_ID)
    raw.close()

    // Re-collect the same thread with refreshed counts, as a second run would.
    db.upsertThreads([thread({ title: 'Updated title', turnCount: 4, promptCount: 2, responseCount: 2 })], 'api')

    const row = readThread()
    expect(row.title).toBe('Updated title')
    expect(row.turn_count).toBe(4)
    // INSERT OR REPLACE is a DELETE+INSERT in SQLite, which used to blank these.
    expect(row.agent_key).toBe('api::agent-7')
    expect(row.agent_id).toBe('agent-7')
    expect(row.agent_name).toBe('HR Assistant')
  })

  it('still updates every collector-owned column', () => {
    db.upsertThreads(
      [thread({ app: 'Teams', title: 'Third pass', endedAt: '2026-01-02T00:00:00.000Z' })],
      'ediscovery'
    )

    const row = readThread()
    expect(row.app).toBe('Teams')
    expect(row.title).toBe('Third pass')
    expect(row.ended_at).toBe('2026-01-02T00:00:00.000Z')
    expect(row.source_type).toBe('ediscovery')
    expect(row.agent_name).toBe('HR Assistant')
  })
})

describe('query helpers', () => {
  it('escapes LIKE wildcards in operator-supplied search text', () => {
    // Without escaping, "%" and "_" silently match everything.
    expect(db.likeNeedle('50%')).toBe('%50\\%%')
    expect(db.likeNeedle('a_b')).toBe('%a\\_b%')
    expect(db.likeNeedle('C:\\temp')).toBe('%c:\\\\temp%')
    expect(db.likeNeedle('  Mixed Case  ')).toBe('%mixed case%')
  })

  it('uses an inclusive end-of-day bound so the last second is not dropped', () => {
    expect(db.endOfDay('2026-03-04')).toBe('2026-03-04T23:59:59.999Z')
    expect('2026-03-04T23:59:59.500Z' <= db.endOfDay('2026-03-04')).toBe(true)
  })
})
