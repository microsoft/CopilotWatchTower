import { app } from 'electron'
import { join } from 'path'
import * as realdb from './db'
import * as profiles from './profiles'
import { runCollection } from './collector'
import { evaluateCreditAlerts } from './collectors/creditAlerts'
import { toCsv } from './csv'

/**
 * Environment-variable driven smoke harness kept from the Python -> Electron
 * port. Each branch runs one backend path headlessly, dumps JSON to %TEMP% and
 * quits.
 *
 * It is imported lazily and ONLY in unpackaged builds (see index.ts), so a
 * stray CWT_* variable can never redirect a shipped app into a test mode.
 * Returns true when a branch ran — the caller must then not open a window.
 */
export async function runDevHarness(): Promise<boolean> {
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
    return true
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
    return true
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
    return true
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
    return true
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
    return true
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
    return true
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
    return true
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
    return true
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
    return true
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
    return true
  }

  return false
}
