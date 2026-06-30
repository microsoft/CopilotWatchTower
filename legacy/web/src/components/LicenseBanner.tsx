import { useTranslation } from "react-i18next";
import { BadgeCheck, Settings } from "lucide-react";

import { useCapabilities, type CapabilityKey } from "../lib/CapabilityContext";
import { useNavigate } from "../lib/NavigationContext";

const CAPABILITY_KEYS: CapabilityKey[] = ["copilot_seats", "e5", "agent_inventory"];

export function LicenseBanner() {
  const { t } = useTranslation("capabilities");
  const { profile, isConfigured } = useCapabilities();
  const navigate = useNavigate();

  const activeChips = CAPABILITY_KEYS.filter((key) => profile[key]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px",
        marginBottom: 14,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
        <BadgeCheck size={15} strokeWidth={2.2} />
        {t("banner.label")}
      </span>

      {isConfigured ? (
        <>
          <strong style={{ color: "var(--text)" }}>{t(`preset.${profile.preset}`)}</strong>
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {activeChips.map((key) => (
              <span
                key={key}
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--accent-soft)",
                  color: "var(--accent-strong)",
                }}
              >
                {t(`capability.${key}`)}
              </span>
            ))}
          </span>
        </>
      ) : (
        <span style={{ color: "var(--warn)" }}>{t("banner.notConfigured")}</span>
      )}

      <button
        type="button"
        onClick={() => navigate("settings")}
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          background: "transparent",
          color: "var(--accent-strong)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <Settings size={13} strokeWidth={2.2} />
        {t("banner.configure")}
      </button>
    </div>
  );
}
