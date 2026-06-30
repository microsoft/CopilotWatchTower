import { useEffect, useMemo, useState } from "react";

import { Sidebar, type NavKey } from "./components/Sidebar";
import { ContextHeader } from "./components/ContextHeader";
import { LockedNotice } from "./components/LockedNotice";
import { CreditAlertToaster } from "./components/CreditAlertToaster";
import { InsightsPage } from "./pages/InsightsPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { EdiscoveryPage } from "./pages/EdiscoveryPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ConsumptionPage } from "./pages/ConsumptionPage";
import { AgentCreditPage } from "./pages/AgentCreditPage";
import { CreditAlertsPage } from "./pages/CreditAlertsPage";
import { CollectionPage } from "./pages/CollectionPage";
import { CollectionOverviewPage } from "./pages/CollectionOverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BackupRestorePage } from "./pages/BackupRestorePage";
import { DataExportPage } from "./pages/DataExportPage";
import { HomePage } from "./pages/HomePage";
import { getSettingsSummary, getSystemInfo, isBridgeAvailable } from "./lib/bridge";
import { useCapabilities } from "./lib/CapabilityContext";
import { NavigationContext } from "./lib/NavigationContext";
import i18n, { toI18nLanguage } from "./i18n";

interface ProfileState {
  name: string | null;
  appName: string;
  bridgeOnline: boolean;
}

export function App() {
  const [active, setActive] = useState<NavKey>("home");
  const [profile, setProfile] = useState<ProfileState>({
    name: null,
    appName: "CopilotWatchTower",
    bridgeOnline: false,
  });

  useEffect(() => {
    if (!isBridgeAvailable()) {
      setProfile((p) => ({ ...p, bridgeOnline: false }));
      return;
    }
    getSystemInfo()
      .then((info) => setProfile({ name: info.profile, appName: info.app, bridgeOnline: true }))
      .catch(() => setProfile((p) => ({ ...p, bridgeOnline: false })));
    // Adopt the profile's persisted language so the whole UI renders in the
    // user's chosen locale on boot. The backend has already auto-detected the
    // OS language on first run, so this also honors that initial choice.
    getSettingsSummary()
      .then((settings) => i18n.changeLanguage(toI18nLanguage(settings?.language)))
      .catch(() => undefined);
  }, []);

  const Page = useMemo(() => PAGE_REGISTRY[active], [active]);
  const { gate } = useCapabilities();
  const lock = gate(active);

  return (
    <NavigationContext.Provider value={setActive}>
      <CreditAlertToaster />
      <div className="app-shell">
        <Sidebar active={active} onSelect={setActive} profileLabel={profile.name} appName={profile.appName} />
        <main className="app-main">
          <ContextHeader
            active={active}
            bridgeOnline={profile.bridgeOnline}
            profileLabel={profile.name}
            onManageProfile={() => setActive("settings")}
          />
          {lock.locked ? <LockedNotice navKey={active} required={lock.required} /> : <Page />}
        </main>
      </div>
    </NavigationContext.Provider>
  );
}

const PAGE_REGISTRY: Record<NavKey, () => JSX.Element> = {
  home: HomePage,
  insights: InsightsPage,
  conversationsApi: () => <ConversationsPage sourceType="api" />,
  conversationsEdiscovery: () => <ConversationsPage sourceType="ediscovery" />,
  conversationsDataverse: () => <ConversationsPage sourceType="dataverse" />,
  agents: AgentsPage,
  security: SecurityPage,
  reports: ReportsPage,
  consumption: ConsumptionPage,
  agentCredit: AgentCreditPage,
  creditAlerts: CreditAlertsPage,
  collectOverview: CollectionOverviewPage,
  collectConversation: () => <CollectionPage kind="conversation" />,
  collectAudit: () => <CollectionPage kind="audit" />,
  collectUsage: () => <CollectionPage kind="usage" />,
  collectDiagnostics: () => <CollectionPage kind="diagnostics" />,
  collectConsumption: () => <CollectionPage kind="consumption" />,
  collectTranscripts: () => <CollectionPage kind="transcripts" />,
  collectFlowRuns: () => <CollectionPage kind="flow_runs" />,
  collectAgentDefs: () => <CollectionPage kind="agent_definitions" />,
  ediscovery: EdiscoveryPage,
  backupRestore: BackupRestorePage,
  dataExport: DataExportPage,
  settings: SettingsPage,
};
