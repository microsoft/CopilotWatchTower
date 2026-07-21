export interface ConversationAgentIdentity {
  key: string
  id: string
  name: string | null
}

export interface AuditAgentEvidence {
  agent: ConversationAgentIdentity
  messageIds: string[]
  threadIds: string[]
}

export interface InteractionAgentReference {
  id: string
  requestId: string | null
  threadId: string
  sessionId: string | null
  createdAt: string
  userKeys: string[]
}

export interface AuditAgentReference {
  eventTime: string
  userKeys: string[]
  rawJson: string | null
}

type Dict = Record<string, unknown>

const GENERIC_AGENT_IDS = new Set(['powervirtualagents'])

function dict(value: unknown): Dict {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {}
}

function dictish(value: unknown): Dict {
  if (typeof value !== 'string') return dict(value)
  try {
    return dict(JSON.parse(value))
  } catch {
    return {}
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function usableAgentId(value: unknown): string | null {
  const id = text(value)
  return id && !GENERIC_AGENT_IDS.has(id.toLowerCase()) ? id : null
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const result = text(value)
    if (result) return result
  }
  return null
}

function identity(sourceType: string, id: string | null, name: string | null, namespace?: string | null): ConversationAgentIdentity | null {
  const resolvedId = id || name
  if (!resolvedId) return null
  const key = [sourceType || 'unknown', namespace || '', resolvedId.toLowerCase()].join(':')
  return { key, id: resolvedId, name }
}

export function conversationAgentFromRaw(rawJson: string | null, sourceType: string): ConversationAgentIdentity | null {
  if (!rawJson) return null
  let raw: Dict
  try {
    raw = dict(JSON.parse(rawJson))
  } catch {
    return null
  }

  if (sourceType === 'dataverse') {
    const activityFrom = dict(dict(raw.activity).from)
    return identity(
      sourceType,
      usableAgentId(raw.agent_id) || usableAgentId(activityFrom.id),
      text(raw.agent_name) || text(activityFrom.name),
      text(raw.environment_id)
    )
  }

  if (sourceType === 'ediscovery') {
    const itemData = dict(raw.itemData)
    const itemFrom = dict(itemData.from)
    return identity(
      sourceType,
      usableAgentId(itemFrom.internalId) || usableAgentId(itemData.messageFrom),
      text(itemFrom.displayName) || text(itemData.imdisplayname)
    )
  }

  if (sourceType === 'api') {
    return null
  }

  const activityFrom = dict(dict(raw.activity).from)
  return identity(
    sourceType,
    usableAgentId(raw.agent_id) || usableAgentId(activityFrom.id),
    text(raw.agent_name) || text(activityFrom.name)
  )
}

function auditMessageIds(eventData: Dict): string[] {
  const ids = new Set<string>()
  for (const key of ['Messages', 'MessageIds']) {
    const value = eventData[key]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      const id = typeof item === 'object' && item !== null ? text((item as Dict).Id) : text(item)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

export function auditAgentEvidenceFromRaw(rawJson: string | null): AuditAgentEvidence | null {
  if (!rawJson) return null
  let raw: Dict
  try {
    raw = dict(JSON.parse(rawJson))
  } catch {
    return null
  }

  const auditData = dictish(raw.auditData)
  const eventData = dictish(auditData.CopilotEventData)
  const appIdentity = firstText(eventData.AppIdentity, auditData.AppIdentity)
  const hasAgentSignal =
    !!firstText(
      eventData.TargetPlatformAgentId,
      eventData.TargetAgentName,
      eventData.AgentId,
      auditData.AgentId,
      eventData.AgentName,
      auditData.AgentName,
      eventData.AgentVersion,
      auditData.AgentVersion
    ) || !!(appIdentity && /copilotstudio|\.studio\./i.test(appIdentity))
  if (!hasAgentSignal) return null

  const agentId = firstText(
    eventData.TargetPlatformAgentId,
    eventData.AgentId,
    auditData.AgentId,
    eventData.AddOnGuid,
    auditData.AddOnGuid,
    eventData.AppExternalId,
    auditData.AppExternalId,
    appIdentity,
    eventData.AgentName,
    auditData.AgentName
  )
  const agentName = firstText(
    eventData.TargetAgentName,
    eventData.AgentName,
    auditData.AgentName,
    eventData.AddOnName,
    auditData.AddOnName,
    eventData.AppDisplayName,
    auditData.AppDisplayName,
    eventData.AppName,
    auditData.AppName
  )
  const agent = identity('api', usableAgentId(agentId), agentName)
  if (!agent) return null

  const threadIds = new Set<string>()
  for (const value of [eventData.ThreadId, auditData.ChatThreadId]) {
    const id = text(value)
    if (id) threadIds.add(id)
  }
  return { agent, messageIds: auditMessageIds(eventData), threadIds: [...threadIds] }
}

const AUDIT_TIME_MATCH_MS = 180_000

function normalizedKeys(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))
}

function parseTime(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function matchAuditAgentsToThreads(
  interactions: InteractionAgentReference[],
  auditEvents: AuditAgentReference[]
): Map<string, ConversationAgentIdentity> {
  const byMessage = new Map<string, Set<string>>()
  const bySession = new Map<string, Set<string>>()
  const usersByInteraction = interactions.map((interaction) => ({
    interaction,
    userKeys: normalizedKeys(interaction.userKeys),
    createdAt: parseTime(interaction.createdAt)
  }))
  const addTarget = (index: Map<string, Set<string>>, key: string | null, threadId: string): void => {
    if (!key) return
    const targets = index.get(key) ?? new Set<string>()
    targets.add(threadId)
    index.set(key, targets)
  }
  for (const interaction of interactions) {
    addTarget(byMessage, interaction.id, interaction.threadId)
    addTarget(byMessage, interaction.requestId, interaction.threadId)
    addTarget(bySession, interaction.sessionId, interaction.threadId)
  }

  const votes = new Map<string, Map<string, { agent: ConversationAgentIdentity; score: number }>>()
  for (const event of auditEvents) {
    const evidence = auditAgentEvidenceFromRaw(event.rawJson)
    if (!evidence) continue
    const explicitTargets = new Set<string>()
    for (const id of evidence.messageIds) for (const threadId of byMessage.get(id) ?? []) explicitTargets.add(threadId)
    for (const id of evidence.threadIds) for (const threadId of bySession.get(id) ?? []) explicitTargets.add(threadId)

    let targets = explicitTargets
    let score = 10
    if (!targets.size) {
      const eventTime = parseTime(event.eventTime)
      const eventUsers = normalizedKeys(event.userKeys)
      if (eventTime === null || !eventUsers.size) continue
      const nearbyThreads = new Set<string>()
      for (const candidate of usersByInteraction) {
        if (candidate.createdAt === null) continue
        if (![...candidate.userKeys].some((key) => eventUsers.has(key))) continue
        if (Math.abs(candidate.createdAt - eventTime) <= AUDIT_TIME_MATCH_MS) {
          nearbyThreads.add(candidate.interaction.threadId)
        }
      }
      if (nearbyThreads.size !== 1) continue
      targets = nearbyThreads
      score = 1
    }

    for (const threadId of targets) {
      const threadVotes = votes.get(threadId) ?? new Map<string, { agent: ConversationAgentIdentity; score: number }>()
      const current = threadVotes.get(evidence.agent.key)
      threadVotes.set(evidence.agent.key, {
        agent: evidence.agent,
        score: (current?.score ?? 0) + score
      })
      votes.set(threadId, threadVotes)
    }
  }

  const result = new Map<string, ConversationAgentIdentity>()
  for (const [threadId, threadVotes] of votes) {
    const ranked = [...threadVotes.values()].sort((a, b) => b.score - a.score)
    if (ranked.length === 1 || ranked[0].score > ranked[1].score) result.set(threadId, ranked[0].agent)
  }
  return result
}