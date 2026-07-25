import { useEffect, useState, useMemo } from 'react'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  UserRound,
  Users
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RawJsonButton } from '../components/RawJsonModal'
import { invoke } from '../lib/api'
import type { PageProps } from '../types'

interface Conversation {
  id?: string
  userId: string
  user: string
  title: string
  app: string
  agent?: string
  agentId?: string
  agentKey?: string
  when: string
  tone: string
}

interface Turn {
  role: 'user' | 'bot'
  text: string
  raw?: string
}

interface AppOpt {
  value: string
  label: string
}
type Scope = 'all' | 'title' | 'body'
interface Filters {
  search: string
  scope: Scope
  app: string
  dateFrom: string
  dateTo: string
}
const EMPTY_FILTERS: Filters = { search: '', scope: 'all', app: '', dateFrom: '', dateTo: '' }
const ALL_AGENT_KEY = '__all__'
const UNKNOWN_AGENT_KEY = '__unknown__'
const ALL_USER_KEY = '__all_users__'
const PENDING_USER_KEY = '__pending_user__'
const PAGE_SIZE = 50

interface ConversationFacet {
  key: string
  name: string
  count: number
}

interface ConversationPage {
  rows: Conversation[]
  total: number
  limit: number
  offset: number
}

function compactAgentId(value: string): string {
  const stripped = value.replace(/^28:/i, '')
  return stripped.length > 12 ? stripped.slice(0, 8) : stripped
}

function isTechnicalAgentName(name: string, id?: string): boolean {
  return (
    name === id ||
    /^28:/i.test(name) ||
    /^(?:28:)?[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name) ||
    name.toLowerCase() === 'powervirtualagents'
  )
}

export function Conversations({ source }: PageProps): JSX.Element {
  const { t } = useTranslation('conversations')
  function scopeLabel(s: Scope): string {
    return t(`scope.${s}`)
  }
  function scopePlaceholder(scope: Scope, src?: string): string {
    const restored = src === 'ediscovery'
    if (scope === 'title') return t(restored ? 'searchPlaceholder.restoredTitle' : 'searchPlaceholder.title')
    if (scope === 'body') return t(restored ? 'searchPlaceholder.restoredBody' : 'searchPlaceholder.body')
    return t(restored ? 'searchPlaceholder.restoredAll' : 'searchPlaceholder.all')
  }
  const [rows, setRows] = useState<Conversation[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [apps, setApps] = useState<AppOpt[]>([])
  const [agentFacets, setAgentFacets] = useState<ConversationFacet[]>([])
  const [userFacets, setUserFacets] = useState<ConversationFacet[]>([])
  const [agentSearch, setAgentSearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false)
  const [userPanelCollapsed, setUserPanelCollapsed] = useState(false)
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [selectedAgentKey, setSelectedAgentKey] = useState(ALL_AGENT_KEY)
  const [selectedUserKey, setSelectedUserKey] = useState(ALL_USER_KEY)
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [thread, setThread] = useState<Turn[]>([])
  const [threadError, setThreadError] = useState<string | null>(null)

  const agentDisplayName = (conversation: Conversation): string => {
    const name = conversation.agent?.trim()
    if (name && !isTechnicalAgentName(name, conversation.agentId)) return name
    if (conversation.agentId) return t('agents.unnamed', { id: compactAgentId(conversation.agentId) })
    return t(source === 'api' ? 'agents.apiUnknown' : 'agents.unknown')
  }
  const agentFacetName = (facet: ConversationFacet): string => {
    if (facet.key === UNKNOWN_AGENT_KEY) return t(source === 'api' ? 'agents.apiUnknown' : 'agents.unknown')
    const name = facet.name.trim()
    if (name && !isTechnicalAgentName(name)) return name
    return name ? t('agents.unnamed', { id: compactAgentId(name) }) : t('agents.unknown')
  }
  const basePayload = useMemo(
    () => ({
      source,
      search: applied.search.trim() || undefined,
      scope: applied.scope,
      app: applied.app || undefined,
      dateFrom: applied.dateFrom || undefined,
      dateTo: applied.dateTo || undefined
    }),
    [source, applied]
  )
  const agentTotal = agentFacets.reduce((sum, facet) => sum + facet.count, 0)
  const userTotal = userFacets.reduce((sum, facet) => sum + facet.count, 0)
  const selectedAgent = agentFacets.find((facet) => facet.key === selectedAgentKey)
  const agentNeedle = agentSearch.trim().toLowerCase()
  const userNeedle = userSearch.trim().toLowerCase()
  const filteredAgentFacets = agentFacets.filter((facet) =>
    `${agentFacetName(facet)} ${facet.key}`.toLowerCase().includes(agentNeedle)
  )
  const filteredUserFacets = userFacets.filter((facet) =>
    `${facet.name} ${facet.key}`.toLowerCase().includes(userNeedle)
  )
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const selectedAgentName = selected ? agentDisplayName(selected) : ''

  const selectAgent = (key: string): void => {
    setPage(0)
    setSelectedAgentKey(key)
    if (key === ALL_AGENT_KEY) {
      setSelectedUserKey(ALL_USER_KEY)
      return
    }
    setSelectedUserKey(PENDING_USER_KEY)
    setUserSearch('')
    if (window.innerWidth >= 1180) setUserPanelCollapsed(false)
  }

  const toggleAgentPanel = (): void => {
    setAgentPanelCollapsed((collapsed) => {
      const next = !collapsed
      if (!next && window.innerWidth < 1180) setUserPanelCollapsed(true)
      return next
    })
  }

  const toggleUserPanel = (): void => {
    setUserPanelCollapsed((collapsed) => {
      const next = !collapsed
      if (!next && window.innerWidth < 1180) setAgentPanelCollapsed(true)
      return next
    })
  }

  useEffect(() => {
    const collapseForNarrowWindow = (): void => {
      if (window.innerWidth < 1180) {
        setAgentPanelCollapsed(true)
        setUserPanelCollapsed(true)
      }
    }
    collapseForNarrowWindow()
    window.addEventListener('resize', collapseForNarrowWindow)
    return () => window.removeEventListener('resize', collapseForNarrowWindow)
  }, [])

  // Reset navigation and load app options when the source changes.
  useEffect(() => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setPage(0)
    setTotal(0)
    setAgentSearch('')
    setUserSearch('')
    setSelectedAgentKey(ALL_AGENT_KEY)
    setSelectedUserKey(ALL_USER_KEY)
    setSelected(null)
    invoke<AppOpt[]>('conversation_apps', source)
      .then(setApps)
      .catch(() => setApps([]))
  }, [source])

  // Agent facet counts always cover the full filtered result, not just one page.
  useEffect(() => {
    let active = true
    const load = (): void => {
      invoke<ConversationFacet[]>('conversation_agent_facets', basePayload)
        .then((facets) => {
          if (!active) return
          setAgentFacets(facets)
        })
        .catch(() => {
          if (!active) return
          setAgentFacets([])
        })
    }
    load()
    const timer = source === 'api' ? setInterval(load, 10_000) : null
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [source, basePayload])

  useEffect(() => {
    if (selectedAgentKey === ALL_AGENT_KEY) return
    if (agentFacets.some((facet) => facet.key === selectedAgentKey)) return
    setSelectedAgentKey(ALL_AGENT_KEY)
    setSelectedUserKey(ALL_USER_KEY)
    setPage(0)
  }, [agentFacets, selectedAgentKey])

  // User facets are loaded only for the selected agent and sorted by activity.
  useEffect(() => {
    let active = true
    const load = (): void => {
      invoke<ConversationFacet[]>('conversation_user_facets', {
        ...basePayload,
        agentKey: selectedAgentKey === ALL_AGENT_KEY ? undefined : selectedAgentKey
      })
        .then((facets) => {
          if (!active) return
          setUserFacets(facets)
          setSelectedUserKey((current) => {
            if (selectedAgentKey === ALL_AGENT_KEY) {
              return current === ALL_USER_KEY || facets.some((facet) => facet.key === current)
                ? current
                : ALL_USER_KEY
            }
            if (current === ALL_USER_KEY || facets.some((facet) => facet.key === current)) return current
            return facets[0]?.key ?? ALL_USER_KEY
          })
        })
        .catch(() => {
          if (!active) return
          setUserFacets([])
          setSelectedUserKey(ALL_USER_KEY)
        })
    }
    load()
    const timer = source === 'api' ? setInterval(load, 10_000) : null
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [source, basePayload, selectedAgentKey])

  // Fetch one bounded page for the selected agent/user scope.
  useEffect(() => {
    if (selectedAgentKey !== ALL_AGENT_KEY && selectedUserKey === PENDING_USER_KEY) {
      setRows([])
      setTotal(0)
      setSelected(null)
      return
    }
    let active = true
    const payload = {
      ...basePayload,
      agentKey: selectedAgentKey === ALL_AGENT_KEY ? undefined : selectedAgentKey,
      userId: selectedUserKey === ALL_USER_KEY ? undefined : selectedUserKey,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE
    }
    const load = (): void => {
      invoke<ConversationPage>('conversation_page', payload)
        .then((result) => {
          if (!active) return
          setRows(result.rows)
          setTotal(result.total)
        })
        .catch(() => {
          if (!active) return
          setRows([])
          setTotal(0)
          setSelected(null)
        })
    }
    load()
    const timer = source === 'api' ? setInterval(load, 10_000) : null
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [source, basePayload, selectedAgentKey, selectedUserKey, page])

  useEffect(() => {
    setSelected((current) => {
      const preserved = current?.id ? rows.find((conversation) => conversation.id === current.id) : null
      return preserved ?? rows[0] ?? null
    })
  }, [rows])

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1)
  }, [page, pageCount])

  useEffect(() => {
    setThreadError(null)
    if (!selected) {
      setThread([])
      return
    }
    // A conversation without a stable id cannot be resolved back to stored
    // interactions. Never synthesise turns here — this view is evidence.
    if (!selected.id) {
      setThread([])
      setThreadError(t('threadUnavailable'))
      return
    }
    let active = true
    invoke<Turn[]>('conversation_thread', selected.id)
      .then((rows) => {
        if (!active) return
        setThread(Array.isArray(rows) ? rows : [])
      })
      .catch((e: unknown) => {
        if (!active) return
        setThread([])
        setThreadError(t('threadLoadFailed', { message: e instanceof Error ? e.message : String(e) }))
      })
    return () => {
      active = false
    }
  }, [selected, t])

  const apply = (e: React.FormEvent): void => {
    e.preventDefault()
    setPage(0)
    setApplied(draft)
  }
  const reset = (): void => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setPage(0)
    setSelectedAgentKey(ALL_AGENT_KEY)
    setSelectedUserKey(ALL_USER_KEY)
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)

  return (
    <div className="content conv-page">
      <form className="conv-filters" onSubmit={apply}>
        <input
          type="date"
          className="filter-field"
          value={draft.dateFrom}
          max={draft.dateTo || undefined}
          onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
          title={t('filters.dateFrom')}
        />
        <span className="filter-dash">~</span>
        <input
          type="date"
          className="filter-field"
          value={draft.dateTo}
          min={draft.dateFrom || undefined}
          onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
          title={t('filters.dateTo')}
        />
        <div className="search filter-search">
          <Search size={15} />
          <input
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            placeholder={scopePlaceholder(draft.scope, source)}
          />
        </div>
        <div className="scope-toggle" role="group" aria-label={t('filters.searchScope')}>
          {(['all', 'title', 'body'] as Scope[]).map((s) => (
            <button
              type="button"
              key={s}
              className={draft.scope === s ? 'active' : ''}
              onClick={() => setDraft({ ...draft, scope: s })}
            >
              {scopeLabel(s)}
            </button>
          ))}
        </div>
        <select
          className="filter-field"
          value={draft.app}
          onChange={(e) => setDraft({ ...draft, app: e.target.value })}
          title={t('filters.appFilter')}
        >
          <option value="">{t('filters.allApps')}</option>
          {apps.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          {t('filters.apply')}
        </button>
        <button type="button" className="conv-btn ghost" onClick={reset}>
          {t('filters.reset')}
        </button>
        <span className="muted conv-count">{t('count', { count: total })}</span>
      </form>

      <div
        className={`conv-explorer conv-four-pane${agentPanelCollapsed ? ' agent-panel-collapsed' : ''}${
          userPanelCollapsed ? ' user-panel-collapsed' : ''
        }`}
      >
        <div className={`card conv-agent-card conv-facet-card${agentPanelCollapsed ? ' collapsed' : ''}`}>
          {agentPanelCollapsed ? (
            <div className="conv-panel-rail">
              <button
                type="button"
                className="conv-panel-toggle"
                onClick={toggleAgentPanel}
                title={t('panels.expandAgents')}
                aria-label={t('panels.expandAgents')}
              >
                <PanelLeftOpen size={16} />
              </button>
              <Bot size={16} />
              <span>{agentFacets.length}</span>
            </div>
          ) : (
            <div className="conv-nav-section">
              <div className="conv-agent-head">
                <div>
                  <div className="conv-agent-title">{t('agents.title')}</div>
                  <div className="conv-agent-summary">
                    {t(source === 'api' ? 'agents.auditGroups' : 'agents.groups', { total: agentFacets.length })}
                  </div>
                </div>
                <button
                  type="button"
                  className="conv-panel-toggle"
                  onClick={toggleAgentPanel}
                  title={t('panels.collapseAgents')}
                  aria-label={t('panels.collapseAgents')}
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
              <div className="conv-nav-search">
                <Search size={14} />
                <input
                  value={agentSearch}
                  onChange={(event) => setAgentSearch(event.target.value)}
                  placeholder={t('agents.search')}
                />
              </div>
              <div className="conv-agent-list" role="listbox" aria-label={t('agents.title')}>
                {!agentNeedle && (
                  <button
                    type="button"
                    className={`conv-agent-item${selectedAgentKey === ALL_AGENT_KEY ? ' active' : ''}`}
                    onClick={() => selectAgent(ALL_AGENT_KEY)}
                    aria-selected={selectedAgentKey === ALL_AGENT_KEY}
                  >
                    <MessagesSquare size={15} />
                    <span className="conv-agent-name">{t('agents.all')}</span>
                    <span className="conv-agent-count">{agentTotal}</span>
                  </button>
                )}
                {filteredAgentFacets.map((facet) => {
                  const FacetIcon = facet.key === UNKNOWN_AGENT_KEY ? CircleHelp : Bot
                  const name = agentFacetName(facet)
                  return (
                    <button
                      type="button"
                      key={facet.key}
                      className={`conv-agent-item${selectedAgentKey === facet.key ? ' active' : ''}`}
                      onClick={() => selectAgent(facet.key)}
                      aria-selected={selectedAgentKey === facet.key}
                      title={name}
                    >
                      <FacetIcon size={15} />
                      <span className="conv-agent-name">{name}</span>
                      <span className="conv-agent-count">{facet.count}</span>
                    </button>
                  )
                })}
                {filteredAgentFacets.length === 0 && <div className="conv-nav-empty">{t('agents.noMatch')}</div>}
              </div>
            </div>
          )}
        </div>

        <div className={`card conv-agent-card conv-facet-card${userPanelCollapsed ? ' collapsed' : ''}`}>
          {userPanelCollapsed ? (
            <div className="conv-panel-rail">
              <button
                type="button"
                className="conv-panel-toggle"
                onClick={toggleUserPanel}
                title={t('panels.expandUsers')}
                aria-label={t('panels.expandUsers')}
              >
                <PanelLeftOpen size={16} />
              </button>
              <Users size={16} />
              <span>{userFacets.length}</span>
            </div>
          ) : (
            <div className="conv-nav-section">
              <div className="conv-agent-head">
                <div>
                  <div className="conv-agent-title">{t('users.title')}</div>
                  <div className="conv-agent-summary">
                    {selectedAgent && selectedAgentKey !== ALL_AGENT_KEY
                      ? `${agentFacetName(selectedAgent)} · ${t('users.groups', { total: userFacets.length })}`
                      : t('users.groups', { total: userFacets.length })}
                  </div>
                </div>
                <button
                  type="button"
                  className="conv-panel-toggle"
                  onClick={toggleUserPanel}
                  title={t('panels.collapseUsers')}
                  aria-label={t('panels.collapseUsers')}
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
              <div className="conv-nav-search">
                <Search size={14} />
                <input
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder={t('users.search')}
                />
              </div>
              <div className="conv-agent-list" role="listbox" aria-label={t('users.title')}>
                {!userNeedle && (
                  <button
                    type="button"
                    className={`conv-agent-item${selectedUserKey === ALL_USER_KEY ? ' active' : ''}`}
                    onClick={() => {
                      setSelectedUserKey(ALL_USER_KEY)
                      setPage(0)
                    }}
                    aria-selected={selectedUserKey === ALL_USER_KEY}
                  >
                    <Users size={15} />
                    <span className="conv-agent-name">{t('users.all')}</span>
                    <span className="conv-agent-count">{userTotal}</span>
                  </button>
                )}
                {filteredUserFacets.map((facet) => (
                  <button
                    type="button"
                    key={facet.key}
                    className={`conv-agent-item${selectedUserKey === facet.key ? ' active' : ''}`}
                    onClick={() => {
                      setSelectedUserKey(facet.key)
                      setPage(0)
                    }}
                    aria-selected={selectedUserKey === facet.key}
                    title={facet.name}
                  >
                    <UserRound size={15} />
                    <span className="conv-agent-name">{facet.name || t('users.unknown')}</span>
                    <span className="conv-agent-count">{facet.count}</span>
                  </button>
                ))}
                {filteredUserFacets.length === 0 && <div className="conv-nav-empty">{t('users.noMatch')}</div>}
              </div>
            </div>
          )}
        </div>

        <div className="card conv-list-card">
          <div className="conv-pane-head">
            <div>
              <div className="conv-agent-title">{t('panels.conversations')}</div>
              <div className="conv-agent-summary">{t('count', { count: total })}</div>
            </div>
          </div>
          <div className="conv-list">
            {rows.map((c, i) => (
              <button
                key={c.id ?? i}
                className={`conv-item${selected === c ? ' active' : ''}`}
                onClick={() => setSelected(c)}
              >
                <div className="conv-item-top">
                  <span className="conv-title">{c.title}</span>
                  <span className="conv-time">{c.when}</span>
                </div>
                <div className="conv-app">{[agentDisplayName(c), c.app, c.user].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
            {rows.length === 0 && (
              <div className="muted" style={{ padding: '20px', textAlign: 'center' }}>
                {t('noMatch')}
              </div>
            )}
          </div>
          {total > PAGE_SIZE && (
            <div className="conv-list-pager">
              <button
                type="button"
                className="conv-page-btn"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                title={t('pagination.previous')}
                aria-label={t('pagination.previous')}
              >
                <ChevronLeft size={15} />
              </button>
              <span>{t('pagination.status', { page: page + 1, pages: pageCount, total })}</span>
              <button
                type="button"
                className="conv-page-btn"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                title={t('pagination.next')}
                aria-label={t('pagination.next')}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>

        <div className="card conv-detail">
          {selected ? (
            <>
              <div className="conv-detail-head">
                <div className="conv-detail-title">{selected.title}</div>
                <div className="conv-detail-meta">
                  {[selectedAgentName, selected.app, selected.user, selected.when, t('messageCount', { count: thread.length })]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="thread">
                {threadError ? (
                  <div className="muted">{threadError}</div>
                ) : thread.length === 0 ? (
                  <div className="muted">{t('noMessages')}</div>
                ) : (
                  thread.map((t2, i) => (
                    <div key={i} className={`turn ${t2.role}`}>
                      <div>
                        <div className="bubble">{t2.text}</div>
                        <div className="turn-meta">
                          {t2.role === 'user' ? selected.user : selectedAgentName || 'Copilot'}
                          {t2.raw ? <RawJsonButton data={t2.raw} title={t('rawInteractionTitle')} /> : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="empty">
              <div className="empty-icon">
                <MessagesSquare size={24} />
              </div>
              <div className="empty-title">{t('empty.title')}</div>
              <div className="empty-desc">{t('empty.desc')}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
