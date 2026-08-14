import { describe, expect, it } from 'vitest'
import {
  BROAD_KNOWLEDGE_COUNT,
  EXCESSIVE_TOOL_COUNT,
  deriveFindings,
  highestSeverity,
  isPlaceholderSecret,
  scanSecrets,
  type Finding,
  type FindingsInput
} from '../src/main/agentFindings'
import { analyzeAgent } from '../src/main/collectors/agentRisk'

const CLEAN: FindingsInput = {
  hasTrigger: false,
  externalCallCount: 0,
  toolCount: 0,
  loopCount: 0,
  knowledgeCount: 0,
  generativeOrchestration: false,
  authenticationMode: 1
}

function keys(findings: Finding[]): string[] {
  return findings.map((f) => f.key)
}

describe('secret scanning', () => {
  it('flags a hardcoded client secret but not a Key Vault reference', () => {
    const real = scanSecrets([{ name: 'AuthTopic', data: '{"clientSecret":"s7Qx91LmZa04Tv"}' }])
    expect(real.map((h) => h.patternId)).toEqual(['client_secret'])

    const reference = scanSecrets([
      { name: 'AuthTopic', data: '{"clientSecret":"@Microsoft.KeyVault(SecretUri=https://v.vault.azure.net/x)"}' }
    ])
    expect(reference).toEqual([])
  })

  it('detects storage keys, private keys, JWTs, and AWS ids', () => {
    const hits = scanSecrets([
      { name: 'A', data: 'AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPqrst==' },
      { name: 'B', content: '-----BEGIN RSA PRIVATE KEY-----' },
      { name: 'C', data: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u' },
      { name: 'D', data: 'AKIAIOSFODNN7EXAMPLE' }
    ])
    expect(hits.map((h) => h.patternId).sort()).toEqual(['aws_access_key', 'azure_storage_key', 'jwt', 'private_key'])
  })

  it('treats template and filler values as placeholders', () => {
    for (const v of ['{{secret}}', '${API_KEY}', '<your-key>', 'changeme123', '********', '@keyvault(x)']) {
      expect(isPlaceholderSecret(v)).toBe(true)
    }
    expect(isPlaceholderSecret('s7Qx91LmZa04Tv')).toBe(false)
  })

  it('never puts the secret value into the evidence string', () => {
    const findings = deriveFindings([{ name: 'AuthTopic', data: '{"clientSecret":"s7Qx91LmZa04Tv"}' }], CLEAN)
    const secret = findings.find((f) => f.key === 'embedded_secret')
    expect(secret?.severity).toBe('critical')
    expect(secret?.evidence).not.toContain('s7Qx91LmZa04Tv')
    expect(secret?.evidence).toContain('client_secret')
  })
})

describe('finding derivation', () => {
  it('returns nothing for a benign agent', () => {
    expect(deriveFindings([], CLEAN)).toEqual([])
  })

  it('escalates an autonomous agent that calls out and loops', () => {
    const findings = deriveFindings([], { ...CLEAN, hasTrigger: true, externalCallCount: 3, loopCount: 2 })
    expect(keys(findings)).toEqual(
      expect.arrayContaining(['unattended_autonomy', 'autonomous_external_egress', 'unbounded_iteration'])
    )
    expect(findings.find((f) => f.key === 'autonomous_external_egress')?.severity).toBe('critical')
  })

  it('does not raise autonomy findings without a trigger', () => {
    const findings = deriveFindings([], { ...CLEAN, externalCallCount: 5, loopCount: 5 })
    expect(keys(findings)).not.toContain('unattended_autonomy')
    expect(keys(findings)).not.toContain('autonomous_external_egress')
    expect(keys(findings)).not.toContain('unbounded_iteration')
  })

  it('flags generative orchestration only when tools can actually run', () => {
    expect(keys(deriveFindings([], { ...CLEAN, generativeOrchestration: true }))).not.toContain(
      'generative_tool_execution'
    )
    expect(keys(deriveFindings([], { ...CLEAN, generativeOrchestration: true, toolCount: 1 }))).toContain(
      'generative_tool_execution'
    )
  })

  it('applies the documented tool and knowledge thresholds', () => {
    expect(keys(deriveFindings([], { ...CLEAN, toolCount: EXCESSIVE_TOOL_COUNT - 1 }))).not.toContain('excessive_tools')
    expect(keys(deriveFindings([], { ...CLEAN, toolCount: EXCESSIVE_TOOL_COUNT }))).toContain('excessive_tools')

    expect(keys(deriveFindings([], { ...CLEAN, knowledgeCount: BROAD_KNOWLEDGE_COUNT - 1 }))).not.toContain(
      'broad_knowledge_surface'
    )
    expect(keys(deriveFindings([], { ...CLEAN, knowledgeCount: BROAD_KNOWLEDGE_COUNT }))).toContain(
      'broad_knowledge_surface'
    )
  })

  it('reports unauthenticated access only when the column was collected', () => {
    expect(keys(deriveFindings([], { ...CLEAN, authenticationMode: 0 }))).toContain('unauthenticated_access')
    expect(keys(deriveFindings([], { ...CLEAN, authenticationMode: null }))).not.toContain('unauthenticated_access')
    expect(keys(deriveFindings([], { ...CLEAN, authenticationMode: undefined }))).not.toContain('unauthenticated_access')
  })

  it('orders findings most severe first', () => {
    const findings = deriveFindings([{ name: 'X', data: '{"password":"hunter2hunter2"}' }], {
      ...CLEAN,
      hasTrigger: true,
      toolCount: EXCESSIVE_TOOL_COUNT,
      knowledgeCount: BROAD_KNOWLEDGE_COUNT
    })
    const ranks = findings.map((f) => ({ critical: 3, high: 2, medium: 1, low: 0 })[f.severity])
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    expect(highestSeverity(findings)).toBe('critical')
  })

  it('returns null highest severity for an empty list', () => {
    expect(highestSeverity([])).toBeNull()
  })
})

describe('analyzeAgent integration', () => {
  it('attaches findings and serialized JSON without changing the numeric score', () => {
    const components = [
      { componenttype: 5, name: 'Scheduler', data: '{"kind":"recurrence"}' },
      { componenttype: 1, name: 'Caller', data: '{"connectionReference":"shared_http","clientSecret":"s7Qx91LmZa04Tv"}' }
    ]
    const withAuth = analyzeAgent(components, { authenticationMode: 0 })
    const withoutAuth = analyzeAgent(components)

    // Findings are an additional dimension — they must not shift risk_score,
    // which existing credit-alert thresholds are tuned against.
    expect(withAuth.score).toBe(withoutAuth.score)

    expect(keys(withAuth.findings)).toContain('embedded_secret')
    expect(keys(withAuth.findings)).toContain('unauthenticated_access')
    expect(keys(withoutAuth.findings)).not.toContain('unauthenticated_access')
    expect(JSON.parse(withAuth.findingsJson)).toEqual(withAuth.findings)
  })
})
