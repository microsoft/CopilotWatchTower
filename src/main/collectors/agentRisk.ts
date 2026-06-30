/**
 * Static risk scoring for Copilot Studio agents — port of services/agent_risk.py.
 * Pure, HTTP-free heuristic over Dataverse botcomponent OBI payloads. Predicts
 * which agents are likely to run away before they do (predictive alert tier).
 */
type Dict = Record<string, unknown>

const CT_SKILL = 1
const CT_TRIGGER = 5
const CT_SKILL_V2 = 13
const CT_CUSTOM_GPT = 15
const CT_KNOWLEDGE_SOURCE = 16
const CT_EXTERNAL_TRIGGER = 17

const TRIGGER_TYPES = new Set([CT_TRIGGER, CT_EXTERNAL_TRIGGER])
const TOOL_TYPES = new Set([CT_SKILL, CT_SKILL_V2])

const TRIGGER_KEYWORDS = ['trigger', 'recurrence', 'scheduled', 'autostart', 'onschedule', 'externaltrigger']
const EXTERNAL_CALL_KEYWORDS = [
  'connectionreference',
  'connectorid',
  'apiid',
  'httprequest',
  'http.request',
  'microsoft.http',
  'invokeconnector',
  'sendhttprequest',
  'openapi',
  'restapi'
]
const TOOL_KEYWORDS = ['invoketool', 'aiplugin', 'pluginaction', 'skillinvocation', 'executeaction', 'powerautomate', 'flowaction']
const LOOP_KEYWORDS = ['foreach', 'while', 'loop', 'repeat', 'iterate', 'until']
const GENERATIVE_KEYWORDS = [
  'generativeactions',
  'generativeorchestration',
  'generative_mode',
  '"orchestration":"generative"',
  'customgpt',
  'gptcomponent',
  'deepreasoning'
]

const W_AUTONOMY = 30.0
const W_EXTERNAL = 30.0
const W_TOOLS = 20.0
const W_LOOPS = 30.0
const W_GENERATIVE = 15.0
const W_KNOWLEDGE = 10.0

export interface RiskFactor {
  key: string
  score: number
  count: number
  detail: string | null
}
export interface RiskProfile {
  componentCount: number
  hasTrigger: boolean
  externalCallCount: number
  toolCount: number
  loopCount: number
  knowledgeCount: number
  generativeOrchestration: boolean
  score: number
  band: string
  factors: RiskFactor[]
  factorsJson: string
}

function componentText(component: Dict): string {
  const parts: string[] = []
  for (const key of ['data', 'content', 'dependencies']) {
    const value = component[key]
    if (value === null || value === undefined) continue
    parts.push(typeof value === 'string' ? value : JSON.stringify(value))
  }
  return parts.join('\n').toLowerCase()
}
function countKeywords(text: string, keywords: string[]): number {
  let total = 0
  for (const kw of keywords) total += text.split(kw).length - 1
  return total
}
function componentType(component: Dict): number | null {
  const raw = component.componenttype ?? component.componentType
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : null
}
function bandFor(score: number): string {
  if (score >= 75) return 'critical'
  if (score >= 50) return 'high'
  if (score >= 25) return 'medium'
  return 'low'
}
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function analyzeAgent(components: Dict[]): RiskProfile {
  const types: Array<number | null> = []
  let triggerKw = 0
  let externalKw = 0
  let toolKw = 0
  let loopKw = 0
  let generativeKw = 0
  for (const component of components) {
    types.push(componentType(component))
    const text = componentText(component)
    triggerKw += countKeywords(text, TRIGGER_KEYWORDS)
    externalKw += countKeywords(text, EXTERNAL_CALL_KEYWORDS)
    toolKw += countKeywords(text, TOOL_KEYWORDS)
    loopKw += countKeywords(text, LOOP_KEYWORDS)
    generativeKw += countKeywords(text, GENERATIVE_KEYWORDS)
  }
  const typeSet = new Set(types.filter((t): t is number => t !== null))

  const hasTrigger = [...TRIGGER_TYPES].some((t) => typeSet.has(t)) || triggerKw > 0
  const autonomyScore = hasTrigger ? W_AUTONOMY : 0

  const externalCount = externalKw
  const externalScore = Math.min(externalCount, 10) * (W_EXTERNAL / 10)

  const toolCount = toolKw + types.filter((t) => t !== null && TOOL_TYPES.has(t)).length
  const toolScore = Math.min(toolCount, 8) * (W_TOOLS / 8)

  const loopCount = loopKw
  const loopScore = Math.min(loopCount, 5) * (W_LOOPS / 5)

  const generative = typeSet.has(CT_CUSTOM_GPT) || generativeKw > 0
  const generativeScore = generative ? W_GENERATIVE : 0

  const knowledgeCount = types.filter((t) => t === CT_KNOWLEDGE_SOURCE).length
  const knowledgeScore = Math.min(knowledgeCount, 5) * (W_KNOWLEDGE / 5)

  const rawTotal = autonomyScore + externalScore + toolScore + loopScore + generativeScore + knowledgeScore
  const score = round2(Math.min(rawTotal, 100))

  const factors: RiskFactor[] = [
    {
      key: 'autonomy',
      score: round2(autonomyScore),
      count: types.filter((t) => t !== null && TRIGGER_TYPES.has(t)).length || (triggerKw ? 1 : 0),
      detail: hasTrigger ? 'trigger' : null
    },
    { key: 'external_calls', score: round2(externalScore), count: externalCount, detail: null },
    { key: 'tools', score: round2(toolScore), count: toolCount, detail: null },
    { key: 'loops', score: round2(loopScore), count: loopCount, detail: null },
    { key: 'generative_orchestration', score: round2(generativeScore), count: generative ? 1 : 0, detail: null },
    { key: 'knowledge', score: round2(knowledgeScore), count: knowledgeCount, detail: null }
  ]

  return {
    componentCount: components.length,
    hasTrigger,
    externalCallCount: externalCount,
    toolCount,
    loopCount,
    knowledgeCount,
    generativeOrchestration: generative,
    score,
    band: bandFor(score),
    factors,
    factorsJson: JSON.stringify(factors)
  }
}

const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

export function parentBotId(component: Dict): string | null {
  for (const key of ['_parentbotid_value', 'parentbotid', '_ParentBotId_value']) {
    const value = component[key]
    if (value) {
      const match = GUID_RE.exec(String(value))
      return match ? match[0] : String(value)
    }
  }
  return null
}
