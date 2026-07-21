import { useEffect, useState } from 'react'
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

const THREADS: Record<string, Turn[]> = {
  '밀라노 쇼핑 일정 짜줘': [
    { role: 'user', text: '밀라노 2박 3일 쇼핑 위주 일정 짜줘. 명품 아울렛도 포함했으면 좋겠어.' },
    {
      role: 'bot',
      text:
        '밀라노 2박 3일 쇼핑 일정입니다.\n\n1일차: 몬테나폴레오네 거리(명품 부티크) → 두오모 → 갤러리아\n2일차: 세라발레 디자이너 아울렛(당일 왕복)\n3일차: 코르소 부에노스아이레스(중저가) → 출국\n\n각 일정에 이동 수단과 예상 소요 시간을 더 넣어드릴까요?'
    },
    { role: 'user', text: '둘째 날 아울렛 가는 교통편이랑 소요시간 알려줘.' },
    {
      role: 'bot',
      text:
        '세라발레 아울렛은 밀라노 시내에서 약 70km 거리입니다.\n\n• 셔틀버스: 두오모 인근 출발, 편도 약 1시간, 왕복 €20\n• 기차+버스: 중앙역 → 아르콰타 스크리비아(약 1시간) → 셔틀(15분)\n\n셔틀버스가 가장 편리합니다. 예약 링크를 정리해 드릴까요?'
    }
  ],
  '계약서 핵심 조항 요약해줘': [
    { role: 'user', text: '첨부한 계약서에서 핵심 조항만 요약해줘.' },
    {
      role: 'bot',
      text:
        '핵심 조항 요약입니다.\n\n1. 계약 기간: 2026-07-01 ~ 2027-06-30 (1년, 자동 갱신)\n2. 대금 지급: 매월 말일, 세금계산서 발행 후 30일 이내\n3. 위약금: 중도 해지 시 잔여 계약금액의 20%\n4. 비밀유지: 계약 종료 후 3년간\n\n특정 조항을 더 자세히 볼까요?'
    },
    { role: 'user', text: '위약금 조항만 더 자세히.' },
    {
      role: 'bot',
      text:
        '제8조(위약금) 상세입니다.\n\n• 산정: 잔여 계약 기간 × 월 계약금액 × 20%\n• 예외: 천재지변·법령 변경 등 불가항력 시 면제\n• 감면: 해지 30일 전 서면 통지 시 50% 감면\n\n원문(제8조, 4페이지)을 인용으로 표시해 드릴까요?'
    }
  ],
  '고객 불만 이메일 정중하게 회신': [
    { role: 'user', text: '배송 지연으로 화가 난 고객에게 보낼 정중한 사과 회신 작성해줘.' },
    {
      role: 'bot',
      text:
        '아래 초안을 제안합니다.\n\n제목: 배송 지연에 대해 진심으로 사과드립니다\n\n안녕하세요 고객님,\n\n주문하신 상품의 배송이 지연되어 불편을 끼쳐 드린 점 진심으로 사과드립니다. 확인 결과 예상 도착일은 6월 30일입니다.\n\n사과의 뜻으로 다음 구매 시 사용 가능한 10% 할인 쿠폰을 보내드렸습니다.\n\n감사합니다.\n\n톤을 더 격식 있게 또는 캐주얼하게 조정할까요?'
    }
  ],
  '월간 매출 데이터 피벗 분석': [
    { role: 'user', text: '첨부한 6월 매출 데이터로 카테고리별 피벗 분석해줘.' },
    {
      role: 'bot',
      text:
        '6월 매출 피벗 분석 결과입니다.\n\n• 총 매출: ₩4.82억 (전월 대비 +8.3%)\n• 1위 카테고리: 신선식품 ₩1.61억 (33%)\n• 성장률 1위: 가공식품 +21%\n• 하락: 음료 -4%\n\n주말 매출이 평일 대비 1.7배입니다. 카테고리×주차 교차표도 만들어 드릴까요?'
    },
    { role: 'user', text: '응, 주차별 교차표 만들어줘.' },
    {
      role: 'bot',
      text:
        '주차 × 카테고리 교차표를 시트2에 생성했습니다.\n\n가장 큰 변동은 4주차 신선식품(+38%)으로, 가정의 달 프로모션 영향으로 보입니다. 해당 셀에 메모를 추가했습니다.'
    }
  ]
}

function buildThread(c: Conversation): Turn[] {
  const t = THREADS[c.title]
  if (t) return t
  return [
    { role: 'user', text: c.title },
    {
      role: 'bot',
      text: `${c.app}에서 요청하신 내용을 처리했습니다. 결과 초안을 정리해 드렸으니 확인 후 수정할 부분을 알려주세요.`
    },
    { role: 'user', text: '좋아, 조금만 더 다듬어줘.' },
    { role: 'bot', text: '핵심 내용을 더 간결하게 정리하고 항목별로 구분했습니다. 추가로 반영할 부분이 있으면 말씀해 주세요.' }
  ]
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
  const basePayload = {
    source,
    search: applied.search.trim() || undefined,
    scope: applied.scope,
    app: applied.app || undefined,
    dateFrom: applied.dateFrom || undefined,
    dateTo: applied.dateTo || undefined
  }
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
  }, [source, applied])

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
  }, [source, applied, selectedAgentKey])

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
  }, [source, applied, selectedAgentKey, selectedUserKey, page])

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
    if (!selected) {
      setThread([])
      return
    }
    if (!selected.id) {
      setThread(buildThread(selected))
      return
    }
    invoke<Turn[]>('conversation_thread', selected.id)
      .then((t) => setThread(t ?? []))
      .catch(() => setThread([]))
  }, [selected])

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
                {thread.length === 0 ? (
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
