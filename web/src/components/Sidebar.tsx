import { useState } from "react";
import {
  BarChart3,
  Bot,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  FileSearch,
  Gauge,
  Home,
  MessageSquareText,
  SearchCheck,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type NavKey =
  | "home"
  | "insights"
  | "conversationsApi"
  | "conversationsEdiscovery"
  | "agents"
  | "security"
  | "ediscovery"
  | "reports"
  | "operations"
  | "settings";

interface NavItem {
  key: NavKey;
  label: string;
  icon: LucideIcon;
}

interface NavSection {
  title: string;
  icon: LucideIcon;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  { title: "대시보드", icon: Gauge, items: [{ key: "home", label: "대시보드", icon: Home }] },
  {
    title: "사용량 분석",
    icon: BarChart3,
    items: [
      { key: "insights", label: "사용 인사이트", icon: BarChart3 },
      { key: "conversationsApi", label: "대화 탐색(API)", icon: MessageSquareText },
      { key: "agents", label: "에이전트", icon: Bot },
    ],
  },
  {
    title: "거버넌스",
    icon: ShieldCheck,
    items: [
      { key: "security", label: "보안/감사", icon: ShieldCheck },
      { key: "ediscovery", label: "eDiscovery 수집", icon: FileSearch },
      { key: "conversationsEdiscovery", label: "대화 탐색(e-Discovery)", icon: SearchCheck },
      { key: "reports", label: "공식 보고서", icon: ClipboardList },
    ],
  },
  {
    title: "관리",
    icon: Settings,
    items: [
      { key: "operations", label: "수집 운영", icon: ClipboardList },
      { key: "settings", label: "설정", icon: Settings },
    ],
  },
];

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
  profileLabel: string | null;
  appName: string;
}

export function Sidebar({ active, onSelect, profileLabel, appName }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState(() => new Set(SECTIONS.map((section) => section.title)));

  function toggleSection(title: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }

  return (
    <aside className={`sidebar-shell${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar-brand">
        <div className="sidebar-logo" title="CopilotWatchTower">
          <ShieldCheck size={20} strokeWidth={2.4} />
        </div>
        <div className="sidebar-brand-text">
          <div className="sidebar-title">{appName}</div>
          <div className="sidebar-subtitle">{profileLabel ? `프로필: ${profileLabel}` : "프로필 미지정"}</div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="주요 메뉴">
        {SECTIONS.map((section) => {
          const SectionIcon = section.icon;
          const isOpen = openSections.has(section.title) || collapsed;
          return (
            <div key={section.title}>
              <button
                className="sidebar-section-header"
                onClick={() => toggleSection(section.title)}
                title={section.title}
                type="button"
              >
                <SectionIcon size={16} strokeWidth={2.2} />
                <span className="sidebar-section-label">{section.title}</span>
                <ChevronRight className={`sidebar-chevron${isOpen ? " is-open" : ""}`} size={14} />
              </button>
              {isOpen && (
                <div className="sidebar-items">
                  {section.items.map((item) => {
                    const ItemIcon = item.icon;
                    const selected = active === item.key;
                    return (
                      <button
                        key={item.key}
                        className={`sidebar-item${selected ? " is-active" : ""}`}
                        onClick={() => onSelect(item.key)}
                        title={item.label}
                        type="button"
                      >
                        <ItemIcon size={15} strokeWidth={2.2} />
                        <span className="sidebar-item-label">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-collapse" type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          <span className="sidebar-collapse-label">메뉴 접기</span>
        </button>
      </div>
    </aside>
  );
}
