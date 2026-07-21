import { describe, expect, it } from 'vitest'
import {
  auditAgentEvidenceFromRaw,
  conversationAgentFromRaw,
  matchAuditAgentsToThreads,
  type AuditAgentReference,
  type InteractionAgentReference
} from '../src/main/agentIdentity'

describe('conversation agent identity', () => {
  it('uses the Dataverse Bot Framework sender when schematype is generic', () => {
    const result = conversationAgentFromRaw(
      JSON.stringify({
        environment_id: 'env-1',
        agent_id: 'powervirtualagents',
        agent_name: null,
        activity: { from: { id: 'bot-123', name: 'HR Assistant' } }
      }),
      'dataverse'
    )

    expect(result).toEqual({
      key: 'dataverse:env-1:bot-123',
      id: 'bot-123',
      name: 'HR Assistant'
    })
  })

  it('keeps an explicit Dataverse agent id when one is available', () => {
    const result = conversationAgentFromRaw(
      JSON.stringify({
        environment_id: 'env-1',
        agent_id: 'agent-guid',
        agent_name: 'Support Agent',
        activity: { from: { id: 'channel-account' } }
      }),
      'dataverse'
    )

    expect(result?.id).toBe('agent-guid')
    expect(result?.name).toBe('Support Agent')
  })

  it('extracts the eDiscovery Bot Framework identity', () => {
    const result = conversationAgentFromRaw(
      JSON.stringify({ itemData: { from: { internalId: '28:bot-guid', displayName: 'Service Desk' } } }),
      'ediscovery'
    )

    expect(result).toEqual({
      key: 'ediscovery::28:bot-guid',
      id: '28:bot-guid',
      name: 'Service Desk'
    })
  })

  it('does not mistake the shared Graph application identity for an agent', () => {
    const result = conversationAgentFromRaw(
      JSON.stringify({ from: { application: { id: 'm365-chat', displayName: 'Microsoft 365 Chat' } } }),
      'api'
    )

    expect(result).toBeNull()
  })

  it('returns null for malformed or unidentified records', () => {
    expect(conversationAgentFromRaw('{', 'api')).toBeNull()
    expect(conversationAgentFromRaw('{}', 'api')).toBeNull()
  })
})

describe('Purview agent evidence', () => {
  it('extracts an agent and explicit message/thread correlation ids', () => {
    const result = auditAgentEvidenceFromRaw(
      JSON.stringify({
        auditData: JSON.stringify({
          ChatThreadId: 'session-1',
          CopilotEventData: JSON.stringify({
            AgentId: 'agent-hr',
            AgentName: 'HR Assistant',
            ThreadId: 'session-2',
            Messages: [{ Id: 'message-1' }],
            MessageIds: ['message-2']
          })
        })
      })
    )

    expect(result).toEqual({
      agent: { key: 'api::agent-hr', id: 'agent-hr', name: 'HR Assistant' },
      messageIds: ['message-1', 'message-2'],
      threadIds: ['session-2', 'session-1']
    })
  })

  it('accepts Copilot Studio AppIdentity as an agent signal', () => {
    const result = auditAgentEvidenceFromRaw(
      JSON.stringify({ auditData: { CopilotEventData: { AppIdentity: 'Contoso.CopilotStudio.Agent' } } })
    )

    expect(result?.agent.id).toBe('Contoso.CopilotStudio.Agent')
  })

  it('uses target-agent fields emitted by current Purview records', () => {
    const result = auditAgentEvidenceFromRaw(
      JSON.stringify({
        auditData: {
          AgentName: 'fallback name',
          CopilotEventData: {
            TargetPlatformAgentId: 'T_agent-guid',
            TargetAgentName: '냥냥이 에이전트',
            ThreadId: 'session-1'
          }
        }
      })
    )

    expect(result?.agent).toEqual({
      key: 'api::t_agent-guid',
      id: 'T_agent-guid',
      name: '냥냥이 에이전트'
    })
  })

  it('ignores generic Copilot audit events without an agent signal', () => {
    const result = auditAgentEvidenceFromRaw(
      JSON.stringify({ auditData: { CopilotEventData: { AppHost: 'Microsoft 365 Chat', ThreadId: 's1' } } })
    )

    expect(result).toBeNull()
  })
})

describe('API thread agent matching', () => {
  const interactions: InteractionAgentReference[] = [
    {
      id: 'message-1',
      requestId: 'request-1',
      threadId: 'api-thread-1',
      sessionId: 'session-1',
      createdAt: '2026-07-21T01:00:00Z',
      userKeys: ['user-1', 'user1@example.com']
    }
  ]

  function audit(eventData: Record<string, unknown>, eventTime = '2026-07-21T01:00:00Z'): AuditAgentReference {
    return {
      eventTime,
      userKeys: ['user1@example.com'],
      rawJson: JSON.stringify({ auditData: { CopilotEventData: { AgentId: 'agent-1', ...eventData } } })
    }
  }

  it('matches an explicit message id before any time fallback', () => {
    const result = matchAuditAgentsToThreads(interactions, [audit({ MessageIds: ['message-1'] }, '2026-07-22T01:00:00Z')])

    expect(result.get('api-thread-1')?.id).toBe('agent-1')
  })

  it('matches an explicit session thread id', () => {
    const result = matchAuditAgentsToThreads(interactions, [audit({ ThreadId: 'session-1' }, '2026-07-22T01:00:00Z')])

    expect(result.get('api-thread-1')?.id).toBe('agent-1')
  })

  it('uses time proximity only for one same-user candidate thread', () => {
    const result = matchAuditAgentsToThreads(interactions, [audit({})])

    expect(result.get('api-thread-1')?.id).toBe('agent-1')
  })

  it('refuses ambiguous time-only attribution', () => {
    const ambiguous = [
      ...interactions,
      { ...interactions[0], id: 'message-2', threadId: 'api-thread-2', createdAt: '2026-07-21T01:01:00Z' }
    ]
    const result = matchAuditAgentsToThreads(ambiguous, [audit({})])

    expect(result.size).toBe(0)
  })
})