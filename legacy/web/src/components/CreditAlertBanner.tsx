import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

import { getCreditAlertsOverview, isBridgeAvailable } from "../lib/bridge";
import { useNavigate } from "../lib/NavigationContext";

const BRIDGE_AVAILABLE = isBridgeAvailable();

/**
 * Persistent home banner shown only when there are active credit alerts.
 * Mirrors the LicenseBanner pattern; clicking navigates to the alert center.
 * Polls so a scheduled/manual collection that fires alerts surfaces here.
 */
export function CreditAlertBanner() {
  const { t } = useTranslation("creditGov");
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["credit-alerts-overview"],
    queryFn: getCreditAlertsOverview,
    enabled: BRIDGE_AVAILABLE,
    refetchInterval: 15000,
  });

  const active = data?.active ?? 0;
  if (active <= 0) return null;
  const danger = data?.danger ?? 0;
  const accent = danger > 0 ? "var(--danger)" : "var(--warn)";

  return (
    <button
      type="button"
      onClick={() => navigate("creditAlerts")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        marginBottom: 14,
        background: danger > 0 ? "var(--danger-soft)" : "var(--warn-soft)",
        border: `1px solid ${accent}`,
        borderRadius: "var(--radius-md)",
        fontSize: 13,
        cursor: "pointer",
        color: "var(--text)",
      }}
    >
      <AlertTriangle size={18} color={accent} strokeWidth={2.2} />
      <strong style={{ color: accent }}>{t("banner.title", { count: active })}</strong>
      {danger > 0 && <span style={{ color: accent }}>· {t("banner.danger", { count: danger })}</span>}
      <span style={{ marginLeft: "auto", color: accent, fontWeight: 600 }}>{t("banner.cta")} →</span>
    </button>
  );
}
