import { useState } from 'react'
import {
  Home,
  BarChart3,
  MessageSquareText,
  SearchCheck,
  Bot,
  ShieldCheck,
  ClipboardList,
  Coins,
  AlertTriangle,
  Info,
  FileSearch,
  Workflow,
  ShieldAlert,
  Activity,
  DatabaseBackup,
  Download,
  Palette,
  Settings,
  ChevronRight,
  Lock,
  type LucideIcon
} from 'lucide-react'
import type { SystemInfo } from '../types'
import appIcon from '../assets/app-icon.png'
import { ProfileMenu } from './ProfileMenu'
import { useCapabilities, gateFor } from '../lib/capabilities'

interface Item {
  key: string
  label: string
  icon: LucideIcon
}
interface Section {
  id: string
  title: string
  items: Item[]
}

const SECTIONS: Section[] = [
  { id: 'dashboard', title: '대시보드', items: [{ key: 'home', label: '대시보드', icon: Home }] },
  {
    id: 'usage',
    title: '사용량 분석',
    items: [
      { key: 'insights', label: '사용 인사이트', icon: BarChart3 },
      { key: 'conversationsApi', label: '대화 탐색(API)', icon: MessageSquareText },
      { key: 'conversationsEdiscovery', label: '대화 탐색(e-Discovery)', icon: SearchCheck },
      { key: 'conversationsDataverse', label: '대화 탐색(Teams)', icon: Bot },
      { key: 'agents', label: '에이전트', icon: Bot }
    ]
  },
  {
    id: 'governance',
    title: '거버넌스',
    items: [
      { key: 'security', label: '보안/감사', icon: ShieldCheck },
      { key: 'reports', label: '공식 보고서', icon: ClipboardList },
      { key: 'consumption', label: '파워플랫폼 크레딧', icon: Coins },
      { key: 'agentCredit', label: '에이전트 크레딧 분석', icon: BarChart3 },
      { key: 'creditAlerts', label: '크레딧 알람', icon: AlertTriangle }
    ]
  },
  {
    id: 'collection',
    title: '데이터 수집',
    items: [
      { key: 'collectOverview', label: '개요', icon: Info },
      { key: 'collectConversation', label: '대화 수집(API)', icon: MessageSquareText },
      { key: 'ediscovery', label: '대화 수집(e-Discovery)', icon: FileSearch },
      { key: 'collectTranscripts', label: '대화 수집(Teams)', icon: Bot },
      { key: 'collectDiagnostics', label: '에이전트', icon: Bot },
      { key: 'collectConsumption', label: '파워플랫폼 크레딧', icon: Coins },
      { key: 'collectFlowRuns', label: '에이전트 실행(플로우)', icon: Workflow },
      { key: 'collectAgentDefs', label: '에이전트 위험 분석', icon: ShieldAlert },
      { key: 'collectAudit', label: '감사 이벤트', icon: ShieldAlert },
      { key: 'collectUsage', label: '공식 사용량', icon: Activity }
    ]
  },
  {
    id: 'management',
    title: '관리',
    items: [
      { key: 'backupRestore', label: '백업·복원', icon: DatabaseBackup },
      { key: 'dataExport', label: '내보내기', icon: Download },
      { key: 'theme', label: '테마', icon: Palette },
      { key: 'settings', label: '설정', icon: Settings }
    ]
  }
]

interface Props {
  active: string
  onSelect: (key: string) => void
  info: SystemInfo | null
  onAddProfile: () => void
}

const SIDEBAR_OPEN_KEY = 'cwt-sidebar-open'

export function Sidebar({ active, onSelect, info, onAddProfile }: Props): JSX.Element {
  const caps = useCapabilities()
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_OPEN_KEY)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      /* ignore corrupt value */
    }
    return new Set(SECTIONS.map((s) => s.id))
  })

  function toggle(id: string): void {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(SIDEBAR_OPEN_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img className="brand-img" src={appIcon} alt="CopilotWatchTower" />
        </div>
        <div>
          <div className="brand-name">CopilotWatchTower</div>
          <div className="brand-sub">Copilot 거버넌스</div>
        </div>
      </div>

      {SECTIONS.map((section) => {
        const isOpen = open.has(section.id)
        return (
          <div className="nav-section" key={section.id}>
            <button className="nav-section-header" onClick={() => toggle(section.id)} type="button">
              <span>{section.title}</span>
              <ChevronRight className={`nav-chevron${isOpen ? ' open' : ''}`} size={14} />
            </button>
            {isOpen && (
              <div className="nav-items">
                {section.items.map((item) => {
                  const Icon = item.icon
                  const locked = gateFor(item.key, caps).locked
                  return (
                    <button
                      key={item.key}
                      className={`nav-item${active === item.key ? ' active' : ''}${locked ? ' locked' : ''}`}
                      onClick={() => onSelect(item.key)}
                      title={locked ? '현재 라이선스 구성에서 잠김' : undefined}
                    >
                      <Icon />
                      <span>{item.label}</span>
                      {locked && <Lock className="nav-lock" size={13} />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <div className="sidebar-foot">
        <ProfileMenu info={info} onAddProfile={onAddProfile} />
      </div>
    </aside>
  )
}
