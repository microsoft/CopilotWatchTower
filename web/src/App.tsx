import { useEffect, useMemo, useState } from "react";

import { Sidebar, type NavKey } from "./components/Sidebar";
import { ContextHeader } from "./components/ContextHeader";
import { InsightsPage } from "./pages/InsightsPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { EdiscoveryPage } from "./pages/EdiscoveryPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ConsumptionPage } from "./pages/ConsumptionPage";
import { CollectionPage } from "./pages/CollectionPage";
import { CollectionOverviewPage } from "./pages/CollectionOverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BackupRestorePage } from "./pages/BackupRestorePage";
import { DataExportPage } from "./pages/DataExportPage";
import { HomePage } from "./pages/HomePage";
import { getSystemInfo, isBridgeAvailable } from "./lib/bridge";

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
  }, []);

  const Page = useMemo(() => PAGE_REGISTRY[active], [active]);

  return (
    <div className="app-shell">
      <Sidebar active={active} onSelect={setActive} profileLabel={profile.name} appName={profile.appName} />
      <main className="app-main">
        <ContextHeader
          active={active}
          bridgeOnline={profile.bridgeOnline}
          profileLabel={profile.name}
          onManageProfile={() => setActive("settings")}
        />
        <Page />
      </main>
    </div>
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
  collectOverview: CollectionOverviewPage,
  collectConversation: () => <CollectionPage kind="conversation" />,
  collectAudit: () => <CollectionPage kind="audit" />,
  collectUsage: () => <CollectionPage kind="usage" />,
  collectDiagnostics: () => <CollectionPage kind="diagnostics" />,
  collectConsumption: () => <CollectionPage kind="consumption" />,
  collectTranscripts: () => <CollectionPage kind="transcripts" />,
  ediscovery: EdiscoveryPage,
  backupRestore: BackupRestorePage,
  dataExport: DataExportPage,
  settings: SettingsPage,
};
