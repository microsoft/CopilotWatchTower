import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as db from '../src/main/db'

let tempDir = ''

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cwt-conversation-scale-'))
  const dbPath = join(tempDir, 'store.db')
  const raw = new DatabaseSync(dbPath)
  raw.exec(readFileSync(resolve('resources/schema.sql'), 'utf8'))
  raw.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('thread_agent_attribution_v1', '1')

  const insertUser = raw.prepare(
    'INSERT INTO users(id,upn,display_name,enabled,has_copilot_license,in_scope) VALUES(?,?,?,?,?,?)'
  )
  for (let userIndex = 0; userIndex < 120; userIndex++) {
    const id = `user-${String(userIndex).padStart(3, '0')}`
    insertUser.run(id, `${id}@example.com`, `User ${String(userIndex).padStart(3, '0')}`, 1, 1, 1)
  }

  const insertThread = raw.prepare(
    `INSERT INTO conversation_threads(
       id,user_id,started_at,ended_at,app,turn_count,prompt_count,response_count,session_ids,topic_keywords,
       title,cluster_label,agent_key,agent_id,agent_name,computed_at,source_type
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  let sequence = 0
  const addThread = (agentIndex: number, userIndex: number): void => {
    sequence++
    const agent = String(agentIndex).padStart(3, '0')
    const user = String(userIndex).padStart(3, '0')
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString()
    insertThread.run(
      `thread-${sequence}`,
      `user-${user}`,
      at,
      at,
      'BizChat',
      2,
      1,
      1,
      '[]',
      '[]',
      `Conversation ${sequence}`,
      null,
      `api::agent-${agent}`,
      `agent-${agent}`,
      `Agent ${agent}`,
      at,
      'api'
    )
  }

  for (let index = 0; index < 123; index++) addThread(0, 0)
  for (let userIndex = 1; userIndex < 120; userIndex++) addThread(0, userIndex)
  for (let agentIndex = 1; agentIndex < 105; agentIndex++) addThread(agentIndex, 0)
  raw.close()

  process.env.CWT_DB_PATH = dbPath
  expect(db.openDb()).toBe(true)
})

afterAll(() => {
  db.closeDb()
  delete process.env.CWT_DB_PATH
  rmSync(tempDir, { recursive: true, force: true })
})

describe('large conversation explorer queries', () => {
  it('returns complete facets independent of page size', () => {
    const agents = db.conversationAgentFacets({ source: 'api' })
    const users = db.conversationUserFacets({ source: 'api', agentKey: 'api::agent-000' })

    expect(agents).toHaveLength(105)
    expect(agents.reduce((sum, facet) => sum + facet.count, 0)).toBe(346)
    expect(users).toHaveLength(120)
    expect(users.reduce((sum, facet) => sum + facet.count, 0)).toBe(242)
  })

  it('returns bounded pages with an exact server total', () => {
    const filters = {
      source: 'api',
      agentKey: 'api::agent-000',
      userId: 'user-000',
      limit: 50
    }
    const second = db.conversationPage({ ...filters, offset: 50 })
    const third = db.conversationPage({ ...filters, offset: 100 })

    expect(second.total).toBe(123)
    expect(second.rows).toHaveLength(50)
    expect(third.total).toBe(123)
    expect(third.rows).toHaveLength(23)
  })
})