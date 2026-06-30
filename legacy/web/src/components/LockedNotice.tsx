import { useTranslation } from "react-i18next";
import { Lock, SearchCheck, Settings } from "lucide-react";

import type { CapabilityKey } from "../lib/CapabilityContext";
import { useNavigate } from "../lib/NavigationContext";
import type { NavKey } from "./Sidebar";

interface LockedNoticeProps {
  navKey: NavKey;
  required?: CapabilityKey;
}

// Conversation surfaces have a license-free alternative: e-Discovery capture.
const EDISCOVERY_ALT_KEYS: NavKey[] = ["conversationsApi", "collectConversation"];

export function LockedNotice({ navKey, required }: LockedNoticeProps) {
  const { t } = useTranslation("capabilities");
  const navigate = useNavigate();
  const capabilityLabel = required ? t(`capability.${required}`) : "";
  const showEdiscovery = EDISCOVERY_ALT_KEYS.includes(navKey);

  return (
    <div
      style={{
        margin: "32px auto",
        maxWidth: 560,
        padding: "28px 32px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          margin: "0 auto 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          background: "var(--warn-soft)",
          color: "var(--warn)",
        }}
      >
        <Lock size={22} strokeWidth={2.2} />
      </div>
      <h2 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--text)" }}>
        {t("locked.title")}
      </h2>
      {required && (
        <p style={{ margin: "0 0 20px", color: "var(--text-soft)", fontSize: 14 }}>
          {t("locked.needs", { capability: capabilityLabel })}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => navigate("settings")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 16px",
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: "var(--radius-sm)",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <Settings size={15} strokeWidth={2.2} />
          {t("locked.goSettings")}
        </button>

        {showEdiscovery && (
          <>
            <p style={{ margin: "10px 0 0", color: "var(--text-muted)", fontSize: 13 }}>
              {t("locked.ediscoveryAlt")}
            </p>
            <button
              type="button"
              onClick={() => navigate("conversationsEdiscovery")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                background: "var(--surface-muted)",
                color: "var(--accent-strong)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <SearchCheck size={15} strokeWidth={2.2} />
              {t("locked.goEdiscovery")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
