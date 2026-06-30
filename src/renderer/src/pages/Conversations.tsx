import { useEffect, useState } from 'react'
import { Search, MessagesSquare } from 'lucide-react'
import { RawJsonButton } from '../components/RawJsonModal'
import { invoke } from '../lib/api'
import type { PageProps } from '../types'

interface Conversation {
  id?: string
  user: string
  title: string
  app: string
  agent?: string
  when: string
  tone: string
}

interface Turn {
  role: 'user' | 'bot'
  text: string
  raw?: string
}

interface UserOpt {
  id: string
  name: string
}
interface AppOpt {
  value: string
  label: string
}
type Scope = 'all' | 'title' | 'body'
interface Filters {
  search: string
  scope: Scope
  userId: string
  app: string
  dateFrom: string
  dateTo: string
}
const EMPTY_FILTERS: Filters = { search: '', scope: 'all', userId: '', app: '', dateFrom: '', dateTo: '' }

function scopeLabel(s: Scope): string {
  return s === 'all' ? '전체' : s === 'title' ? '제목' : '본문'
}
function scopePlaceholder(scope: Scope, source?: string): string {
  const restored = source === 'ediscovery'
  if (scope === 'title') return restored ? '복원된 대화 제목 검색' : '대화 제목 검색'
  if (scope === 'body') return restored ? '복원된 대화 본문 검색' : '대화 본문 검색'
  return restored ? '복원된 대화 제목·본문 검색' : '대화 제목·본문 검색'
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
  const [rows, setRows] = useState<Conversation[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [apps, setApps] = useState<AppOpt[]>([])
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [thread, setThread] = useState<Turn[]>([])

  // Reset filters + load the user/app option lists when the source changes.
  useEffect(() => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setSelected(null)
    invoke<UserOpt[]>('conversation_users', source)
      .then(setUsers)
      .catch(() => setUsers([]))
    invoke<AppOpt[]>('conversation_apps', source)
      .then(setApps)
      .catch(() => setApps([]))
  }, [source])

  // Server-side filtered fetch whenever the applied filters or source change.
  useEffect(() => {
    const payload = {
      source,
      search: applied.search.trim() || undefined,
      scope: applied.scope,
      userId: applied.userId || undefined,
      app: applied.app || undefined,
      dateFrom: applied.dateFrom || undefined,
      dateTo: applied.dateTo || undefined
    }
    invoke<Conversation[]>('conversations_all', payload)
      .then((r) => {
        setRows(r)
        setSelected(r[0] ?? null)
      })
      .catch(() => {
        setRows([])
        setSelected(null)
      })
  }, [source, applied])

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
    setApplied(draft)
  }
  const reset = (): void => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
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
          title="시작일"
        />
        <span className="filter-dash">~</span>
        <input
          type="date"
          className="filter-field"
          value={draft.dateTo}
          min={draft.dateFrom || undefined}
          onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
          title="종료일"
        />
        <div className="search filter-search">
          <Search size={15} />
          <input
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            placeholder={scopePlaceholder(draft.scope, source)}
          />
        </div>
        <div className="scope-toggle" role="group" aria-label="검색 범위">
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
          value={draft.userId}
          onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
          title="사용자 필터"
        >
          <option value="">{source === 'ediscovery' ? '복원된 모든 사용자' : '모든 사용자'}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select
          className="filter-field"
          value={draft.app}
          onChange={(e) => setDraft({ ...draft, app: e.target.value })}
          title="앱 필터"
        >
          <option value="">모든 앱</option>
          {apps.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="submit" className={`conv-btn primary${dirty ? ' dirty' : ''}`}>
          적용
        </button>
        <button type="button" className="conv-btn ghost" onClick={reset}>
          초기화
        </button>
        <span className="muted conv-count">{rows.length}개 대화</span>
      </form>

      <div className="conv-explorer">
        <div className="card conv-list-card">
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
                <div className="conv-app">{[c.agent, c.app, c.user].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
            {rows.length === 0 && (
              <div className="muted" style={{ padding: '20px', textAlign: 'center' }}>
                일치하는 대화가 없습니다.
              </div>
            )}
          </div>
        </div>

        <div className="card conv-detail">
          {selected ? (
            <>
              <div className="conv-detail-head">
                <div className="conv-detail-title">{selected.title}</div>
                <div className="conv-detail-meta">
                  {[selected.agent, selected.app, selected.user, selected.when, `${thread.length}개 메시지`]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="thread">
                {thread.length === 0 ? (
                  <div className="muted">표시할 메시지가 없습니다.</div>
                ) : (
                  thread.map((t, i) => (
                    <div key={i} className={`turn ${t.role}`}>
                      <div>
                        <div className="bubble">{t.text}</div>
                        <div className="turn-meta">
                          {t.role === 'user' ? selected.user : selected.agent || 'Copilot'}
                          {t.raw ? <RawJsonButton data={t.raw} title="원본 상호작용 JSON" /> : null}
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
              <div className="empty-title">대화를 선택하세요</div>
              <div className="empty-desc">왼쪽 목록에서 대화를 선택하면 전체 메시지가 여기에 표시됩니다.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
