/**
 * Named security findings for Copilot Studio agents.
 *
 * Complements the numeric risk score in ``agentRisk.ts``. The score answers
 * "how likely is this agent to run away?"; findings answer "what specifically is
 * wrong and what do I do about it?" — each finding carries a stable key, a
 * category, a severity, and redacted evidence so the UI can render remediation
 * guidance without re-deriving anything.
 *
 * Pure and HTTP-free: every rule reads the same Dataverse ``botcomponent``
 * payloads the risk scorer already consumes, so this adds no extra collection.
 *
 * Findings deliberately do NOT feed back into ``risk_score``. That score gates
 * the existing credit-alert thresholds, and silently shifting it would change
 * alerting behaviour for already-tuned tenants.
 */
type Dict = Record<string, unknown>

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low'
export type FindingCategory = 'autonomy' | 'orchestration' | 'exposure' | 'credential'

export interface Finding {
  /** Stable identifier — the UI resolves title/remediation copy from this. */
  key: string
  category: FindingCategory
  severity: FindingSeverity
  /** How many times the rule matched (components, occurrences, or sources). */
  count: number
  /** Redacted, human-readable context. Never contains a secret value. */
  evidence: string | null
}

export interface FindingsInput {
  hasTrigger: boolean
  externalCallCount: number
  toolCount: number
  loopCount: number
  knowledgeCount: number
  generativeOrchestration: boolean
  /**
   * Dataverse ``bot.authenticationmode``. 0 = no authentication.
   * ``null``/``undefined`` when the column was unavailable, which suppresses
   * the auth finding rather than guessing.
   */
  authenticationMode?: number | null
}

// Rule thresholds — named so they are tunable and assertable from tests.
export const EXCESSIVE_TOOL_COUNT = 8
export const BROAD_KNOWLEDGE_COUNT = 3
/** Cap per-component scanning so a pathological payload can't stall collection. */
const MAX_SCAN_CHARS = 200_000

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
}

/** Static catalog — category/severity per finding key, mirrored by the i18n copy. */
export const FINDING_CATALOG: Record<string, { category: FindingCategory; severity: FindingSeverity }> = {
  embedded_secret: { category: 'credential', severity: 'critical' },
  autonomous_external_egress: { category: 'autonomy', severity: 'critical' },
  unattended_autonomy: { category: 'autonomy', severity: 'high' },
  unbounded_iteration: { category: 'autonomy', severity: 'high' },
  generative_tool_execution: { category: 'orchestration', severity: 'high' },
  unauthenticated_access: { category: 'exposure', severity: 'high' },
  excessive_tools: { category: 'orchestration', severity: 'medium' },
  broad_knowledge_surface: { category: 'exposure', severity: 'medium' }
}

// ---- secret detection --------------------------------------------------

interface SecretPattern {
  id: string
  re: RegExp
  /** Capture group holding the literal value, when the pattern extracts one. */
  valueGroup?: number
}

const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'private_key', re: /-----begin (?:rsa |ec |dsa |openssh )?private key-----/i },
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'azure_storage_key', re: /accountkey\s*=\s*([A-Za-z0-9+/]{40,}={0,2})/i, valueGroup: 1 },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'bearer_token', re: /\bbearer\s+([A-Za-z0-9\-._~+/]{30,}={0,2})/i, valueGroup: 1 },
  { id: 'client_secret', re: /["']?client[_-]?secret["']?\s*[:=]\s*["']([^"']{8,})["']/i, valueGroup: 1 },
  {
    id: 'credential_literal',
    re: /["']?(?:password|passwd|pwd|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']([^"']{8,})["']/i,
    valueGroup: 1
  }
]

/**
 * Reject values that are obviously references or fillers rather than live
 * secrets — Key Vault bindings, environment-variable tokens, and template
 * placeholders are the common false positives in exported agent definitions.
 */
export function isPlaceholderSecret(value: string): boolean {
  const s = value.trim().toLowerCase()
  if (!s) return true
  if (s.startsWith('@') || s.startsWith('{{') || s.startsWith('${') || s.startsWith('%') || s.startsWith('#{')) return true
  if (s.startsWith('<') && s.endsWith('>')) return true
  if (s.includes('keyvault') || s.includes('environmentvariable') || s.includes('secretref')) return true
  if (/^[*x•.\-_]+$/.test(s)) return true
  if (/^(your|placeholder|dummy|sample|example|changeme|todo|none|null|n\/a|test|xxx)/.test(s)) return true
  return false
}

function componentRawText(component: Dict): string {
  const parts: string[] = []
  for (const key of ['data', 'content', 'dependencies']) {
    const value = component[key]
    if (value === null || value === undefined) continue
    parts.push(typeof value === 'string' ? value : JSON.stringify(value))
  }
  const joined = parts.join('\n')
  return joined.length > MAX_SCAN_CHARS ? joined.slice(0, MAX_SCAN_CHARS) : joined
}

function componentLabel(component: Dict): string | null {
  for (const key of ['name', 'schemaname', 'botcomponentid']) {
    const value = component[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

interface SecretHit {
  patternId: string
  component: string | null
}

/** Scan components for hardcoded credentials. Returns redacted hits only. */
export function scanSecrets(components: Dict[]): SecretHit[] {
  const hits: SecretHit[] = []
  for (const component of components) {
    const text = componentRawText(component)
    if (!text) continue
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.re.exec(text)
      if (!match) continue
      if (pattern.valueGroup !== undefined) {
        const value = match[pattern.valueGroup]
        if (!value || isPlaceholderSecret(value)) continue
      }
      hits.push({ patternId: pattern.id, component: componentLabel(component) })
    }
  }
  return hits
}

// ---- derivation --------------------------------------------------------

function make(key: string, count: number, evidence: string | null): Finding {
  const meta = FINDING_CATALOG[key]
  return { key, category: meta.category, severity: meta.severity, count, evidence }
}

/**
 * Derive the finding list for one agent. Ordered most severe first so the UI can
 * render the list as-is.
 */
export function deriveFindings(components: Dict[], input: FindingsInput): Finding[] {
  const findings: Finding[] = []

  const secretHits = scanSecrets(components)
  if (secretHits.length) {
    const patterns = [...new Set(secretHits.map((h) => h.patternId))].sort()
    const components_ = [...new Set(secretHits.map((h) => h.component).filter((c): c is string => Boolean(c)))]
    const where = components_.length ? ` · ${components_.slice(0, 3).join(', ')}` : ''
    findings.push(make('embedded_secret', secretHits.length, `${patterns.join(', ')}${where}`))
  }

  if (input.hasTrigger) {
    findings.push(make('unattended_autonomy', 1, null))
    if (input.externalCallCount > 0) {
      findings.push(make('autonomous_external_egress', input.externalCallCount, `external calls: ${input.externalCallCount}`))
    }
    if (input.loopCount > 0) {
      findings.push(make('unbounded_iteration', input.loopCount, `loops: ${input.loopCount}`))
    }
  }

  if (input.generativeOrchestration && input.toolCount > 0) {
    findings.push(make('generative_tool_execution', input.toolCount, `tools: ${input.toolCount}`))
  }

  if (input.authenticationMode === 0) {
    findings.push(make('unauthenticated_access', 1, 'authenticationmode=0'))
  }

  if (input.toolCount >= EXCESSIVE_TOOL_COUNT) {
    findings.push(make('excessive_tools', input.toolCount, `tools: ${input.toolCount}`))
  }

  if (input.knowledgeCount >= BROAD_KNOWLEDGE_COUNT) {
    findings.push(make('broad_knowledge_surface', input.knowledgeCount, `knowledge sources: ${input.knowledgeCount}`))
  }

  return findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
}

/** Highest severity across findings, or null when clean. */
export function highestSeverity(findings: Finding[]): FindingSeverity | null {
  let best: FindingSeverity | null = null
  for (const f of findings) {
    if (!best || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[best]) best = f.severity
  }
  return best
}
