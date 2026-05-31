import { useEffect, useMemo, useState } from "react";

import { Sidebar, type NavKey } from "./components/Sidebar";
import { ContextHeader } from "./components/ContextHeader";
import { InsightsPage } from "./pages/InsightsPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { EdiscoveryPage } from "./pages/EdiscoveryPage";
import { ReportsPage } from "./pages/ReportsPage";
import { OperationsPage } from "./pages/OperationsPage";
import { SettingsPage } from "./pages/SettingsPage";
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
        <ContextHeader active={active} bridgeOnline={profile.bridgeOnline} />
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
  agents: AgentsPage,
  security: SecurityPage,
  ediscovery: EdiscoveryPage,
  reports: ReportsPage,
  operations: OperationsPage,
  settings: SettingsPage,
};
