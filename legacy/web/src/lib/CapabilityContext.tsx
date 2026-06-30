import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getCapabilities,
  isBridgeAvailable,
  subscribeBridgeEvents,
  type CapabilityProfile,
} from "./bridge";
import type { NavKey } from "../components/Sidebar";

export type CapabilityKey = "copilot_seats" | "e5" | "agent_inventory";

// Until the admin configures licensing, everything is enabled (source ===
// "default") so nothing is gated. Mirrors the backend default profile.
const DEFAULT_PROFILE: CapabilityProfile = {
  copilot_seats: true,
  e5: true,
  agent_inventory: true,
  preset: "custom",
  source: "default",
  updated_at: null,
};

// Navigation keys that require a license capability. Keys not listed are
// always available. `security` stays available (audit always works); its
// diagnostics-only limitation is surfaced inside the page, not by hiding nav.
// `insights` adapts to whatever conversation source exists, so it is not gated.
export const NAV_REQUIRED_CAPABILITY: Partial<Record<NavKey, CapabilityKey>> = {
  conversationsApi: "copilot_seats",
  collectConversation: "copilot_seats",
  reports: "copilot_seats",
  collectUsage: "copilot_seats",
  agents: "agent_inventory",
  collectDiagnostics: "agent_inventory",
};

export interface CapabilityGate {
  locked: boolean;
  required?: CapabilityKey;
}

interface CapabilityContextValue {
  profile: CapabilityProfile;
  isConfigured: boolean;
  loading: boolean;
  gate: (key: NavKey) => CapabilityGate;
  has: (capability: CapabilityKey) => boolean;
  refresh: () => void;
}

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const bridgeReady = isBridgeAvailable();

  const { data, isLoading } = useQuery({
    queryKey: ["capabilities"],
    queryFn: getCapabilities,
    enabled: bridgeReady,
    staleTime: 60_000,
  });

  const profile = data ?? DEFAULT_PROFILE;
  const isConfigured = profile.source !== "default";

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["capabilities"] });
  }, [queryClient]);

  // Refresh when the backend reports a capability change (e.g. another view).
  useEffect(() => {
    if (!bridgeReady) return;
    let unsubscribe: (() => void) | null = null;
    subscribeBridgeEvents((event) => {
      if (event.type === "capabilities.updated") refresh();
    })
      .then((off) => {
        unsubscribe = off;
      })
      .catch(() => undefined);
    return () => unsubscribe?.();
  }, [bridgeReady, refresh]);

  const has = useCallback(
    (capability: CapabilityKey) => Boolean(profile[capability]),
    [profile],
  );

  const gate = useCallback(
    (key: NavKey): CapabilityGate => {
      const required = NAV_REQUIRED_CAPABILITY[key];
      if (!required) return { locked: false };
      // No gating until the admin makes an explicit choice.
      if (!isConfigured) return { locked: false, required };
      return { locked: !profile[required], required };
    },
    [profile, isConfigured],
  );

  const value = useMemo(
    () => ({ profile, isConfigured, loading: isLoading, gate, has, refresh }),
    [profile, isConfigured, isLoading, gate, has, refresh],
  );

  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): CapabilityContextValue {
  const ctx = useContext(CapabilityContext);
  if (!ctx) {
    throw new Error("useCapabilities must be used inside <CapabilityProvider>");
  }
  return ctx;
}
