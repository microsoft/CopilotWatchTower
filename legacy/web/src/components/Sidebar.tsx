import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  Bot,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Database,
  DatabaseBackup,
  Download,
  FileSearch,
  Gauge,
  Home,
  Coins,
  Info,
  Lock,
  MessageSquareText,
  Activity,
  AlertTriangle,
  Workflow,
  ShieldAlert,
  SearchCheck,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import appLogo from "../assets/app-logo.png";
import { useCapabilities } from "../lib/CapabilityContext";

export type NavKey =
  | "home"
  | "insights"
  | "conversationsApi"
  | "conversationsEdiscovery"
  | "conversationsDataverse"
  | "agents"
  | "consumption"
  | "agentCredit"
  | "creditAlerts"
  | "security"
  | "reports"
  | "collectOverview"
  | "collectConversation"
  | "collectAudit"
  | "collectUsage"
  | "collectDiagnostics"
  | "collectConsumption"
  | "collectTranscripts"
  | "collectFlowRuns"
  | "collectAgentDefs"
  | "ediscovery"
  | "backupRestore"
  | "dataExport"
  | "settings";

interface NavItem {
  key: NavKey;
  icon: LucideIcon;
}

interface NavSection {
  id: string;
  icon: LucideIcon;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  { id: "dashboard", icon: Gauge, items: [{ key: "home", icon: Home }] },
  {
    id: "usageAnalysis",
    icon: BarChart3,
    items: [
      { key: "insights", icon: BarChart3 },
      { key: "conversationsApi", icon: MessageSquareText },
      { key: "conversationsEdiscovery", icon: SearchCheck },
      { key: "conversationsDataverse", icon: Bot },
      { key: "agents", icon: Bot },
    ],
  },
  {
    id: "governance",
    icon: ShieldCheck,
    items: [
      { key: "security", icon: ShieldCheck },
      { key: "reports", icon: ClipboardList },
      { key: "consumption", icon: Coins },
      { key: "agentCredit", icon: BarChart3 },
      { key: "creditAlerts", icon: AlertTriangle },
    ],
  },
  {
    id: "dataCollection",
    icon: Database,
    items: [
      { key: "collectOverview", icon: Info },
      { key: "collectConversation", icon: MessageSquareText },
      { key: "ediscovery", icon: FileSearch },
      { key: "collectTranscripts", icon: Bot },
      { key: "collectDiagnostics", icon: Bot },
      { key: "collectConsumption", icon: Coins },
      { key: "collectFlowRuns", icon: Workflow },
      { key: "collectAgentDefs", icon: ShieldAlert },
      { key: "collectAudit", icon: ShieldAlert },
      { key: "collectUsage", icon: Activity },
    ],
  },
  {
    id: "management",
    icon: Settings,
    items: [
      { key: "backupRestore", icon: DatabaseBackup },
      { key: "dataExport", icon: Download },
      { key: "settings", icon: Settings },
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
  const { t } = useTranslation("nav");
  const { gate } = useCapabilities();
  const [collapsed, setCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState(() => new Set(SECTIONS.map((section) => section.id)));

  function toggleSection(id: string) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className={`sidebar-shell${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar-brand">
        <div className="sidebar-logo" title="CopilotWatchTower">
          <img src={appLogo} alt="CopilotWatchTower" />
        </div>
        <div className="sidebar-brand-text">
          <div className="sidebar-title">{appName}</div>
          <div className="sidebar-subtitle">
            {profileLabel ? t("profilePrefix", { name: profileLabel }) : t("common:profileUnset")}
          </div>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label={t("menu")}>
        {SECTIONS.map((section) => {
          const SectionIcon = section.icon;
          const isOpen = openSections.has(section.id) || collapsed;
          const sectionTitle = t(`sections.${section.id}`);
          return (
            <div key={section.id}>
              <button
                className="sidebar-section-header"
                onClick={() => toggleSection(section.id)}
                title={sectionTitle}
                type="button"
              >
                <SectionIcon size={16} strokeWidth={2.2} />
                <span className="sidebar-section-label">{sectionTitle}</span>
                <ChevronRight className={`sidebar-chevron${isOpen ? " is-open" : ""}`} size={14} />
              </button>
              {isOpen && (
                <div className="sidebar-items">
                  {section.items.map((item) => {
                    const ItemIcon = item.icon;
                    const selected = active === item.key;
                    const itemLabel = t(`items.${item.key}`);
                    const locked = gate(item.key).locked;
                    return (
                      <button
                        key={item.key}
                        className={`sidebar-item${selected ? " is-active" : ""}${locked ? " is-locked" : ""}`}
                        onClick={() => onSelect(item.key)}
                        title={itemLabel}
                        type="button"
                        style={locked ? { opacity: 0.55 } : undefined}
                      >
                        <ItemIcon size={15} strokeWidth={2.2} />
                        <span className="sidebar-item-label">{itemLabel}</span>
                        {locked && (
                          <Lock size={12} strokeWidth={2.2} style={{ marginLeft: "auto", flexShrink: 0 }} />
                        )}
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
          <span className="sidebar-collapse-label">{t("collapse")}</span>
        </button>
      </div>
    </aside>
  );
}
