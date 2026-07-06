import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  icon: LucideIcon
}
interface Section {
  id: string
  items: Item[]
}

const SECTIONS: Section[] = [
  { id: 'dashboard', items: [{ key: 'home', icon: Home }] },
  {
    id: 'usage',
    items: [
      { key: 'insights', icon: BarChart3 },
      { key: 'conversationsApi', icon: MessageSquareText },
      { key: 'conversationsEdiscovery', icon: SearchCheck },
      { key: 'conversationsDataverse', icon: Bot },
      { key: 'agents', icon: Bot }
    ]
  },
  {
    id: 'governance',
    items: [
      { key: 'security', icon: ShieldCheck },
      { key: 'reports', icon: ClipboardList },
      { key: 'consumption', icon: Coins },
      { key: 'agentCredit', icon: BarChart3 },
      { key: 'creditAlerts', icon: AlertTriangle }
    ]
  },
  {
    id: 'collection',
    items: [
      { key: 'collectOverview', icon: Info },
      { key: 'collectConversation', icon: MessageSquareText },
      { key: 'ediscovery', icon: FileSearch },
      { key: 'collectTranscripts', icon: Bot },
      { key: 'collectDiagnostics', icon: Bot },
      { key: 'collectConsumption', icon: Coins },
      { key: 'collectFlowRuns', icon: Workflow },
      { key: 'collectAgentDefs', icon: ShieldAlert },
      { key: 'collectAudit', icon: ShieldAlert },
      { key: 'collectUsage', icon: Activity }
    ]
  },
  {
    id: 'management',
    items: [
      { key: 'backupRestore', icon: DatabaseBackup },
      { key: 'dataExport', icon: Download },
      { key: 'theme', icon: Palette },
      { key: 'settings', icon: Settings }
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
  const { t } = useTranslation('nav')
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
          <div className="brand-sub">{t('brandTagline')}</div>
        </div>
      </div>

      {SECTIONS.map((section) => {
        const isOpen = open.has(section.id)
        return (
          <div className="nav-section" key={section.id}>
            <button className="nav-section-header" onClick={() => toggle(section.id)} type="button">
              <span>{t(`sections.${section.id}`)}</span>
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
                      title={locked ? t('locked') : undefined}
                    >
                      <Icon />
                      <span>{t(`routes.${item.key}.title`)}</span>
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
