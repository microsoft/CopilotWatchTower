import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2 } from "lucide-react";

import { Card } from "./Card";
import { secondaryButtonStyle } from "./settingsControls";
import { useToast } from "./Toast";
import { useCapabilities, type CapabilityKey } from "../lib/CapabilityContext";
import {
  isBridgeAvailable,
  setCapabilities,
  suggestCapabilities,
  type CapabilityPreset,
} from "../lib/bridge";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const PRESET_KEYS: CapabilityPreset[] = ["me3", "me3_copilot", "me5_copilot", "agent365"];
const TOGGLE_KEYS: CapabilityKey[] = ["copilot_seats", "e5", "agent_inventory"];

// preset -> (copilot_seats, e5, agent_inventory). Mirrors the backend.
const PRESET_COMBOS: Record<string, [boolean, boolean, boolean]> = {
  me3: [false, false, false],
  me3_copilot: [true, false, false],
  me5_copilot: [true, true, false],
  agent365: [true, true, true],
};

function presetFor(seats: boolean, e5: boolean, agent: boolean): CapabilityPreset {
  for (const [preset, combo] of Object.entries(PRESET_COMBOS)) {
    if (combo[0] === seats && combo[1] === e5 && combo[2] === agent) {
      return preset as CapabilityPreset;
    }
  }
  return "custom";
}

export function LicenseConfigCard() {
  const { t } = useTranslation(["capabilities", "common"]);
  const toast = useToast();
  const { profile, isConfigured, refresh } = useCapabilities();

  const [seats, setSeats] = useState(profile.copilot_seats);
  const [e5, setE5] = useState(profile.e5);
  const [agent, setAgent] = useState(profile.agent_inventory);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);

  // Seed local edits from the loaded/saved profile.
  useEffect(() => {
    setSeats(profile.copilot_seats);
    setE5(profile.e5);
    setAgent(profile.agent_inventory);
  }, [profile.copilot_seats, profile.e5, profile.agent_inventory]);

  const toggleValue: Record<CapabilityKey, boolean> = {
    copilot_seats: seats,
    e5,
    agent_inventory: agent,
  };
  const setToggle: Record<CapabilityKey, (v: boolean) => void> = {
    copilot_seats: setSeats,
    e5: setE5,
    agent_inventory: setAgent,
  };

  const currentPreset = presetFor(seats, e5, agent);

  function applyPreset(preset: string) {
    const combo = PRESET_COMBOS[preset];
    if (!combo) return;
    setSeats(combo[0]);
    setE5(combo[1]);
    setAgent(combo[2]);
  }

  async function handleDetect() {
    setDetecting(true);
    try {
      const res = await suggestCapabilities();
      if (res.ok && res.capabilities) {
        setSeats(res.capabilities.copilot_seats);
        setE5(res.capabilities.e5);
        setAgent(res.capabilities.agent_inventory);
        toast.push(t("capabilities:settings.detected"), "info");
      } else {
        toast.push(res.error ?? t("capabilities:settings.detectFailed"), "danger");
      }
    } catch (err) {
      toast.push((err as Error).message, "danger");
    } finally {
      setDetecting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await setCapabilities({
        toggles: { copilot_seats: seats, e5, agent_inventory: agent },
      });
      if (res.ok) {
        toast.push(t("capabilities:settings.saved"), "success");
        refresh();
      } else {
        toast.push(res.error ?? t("capabilities:settings.saveFailed"), "danger");
      }
    } catch (err) {
      toast.push((err as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }

  const sourceLabel = t(`capabilities:settings.currentSource.${profile.source}`);

  return (
    <Card title={t("capabilities:settings.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13 }}>
        <p style={{ margin: 0, color: "var(--text-soft)" }}>
          {t("capabilities:settings.description")}
        </p>

        {!isConfigured && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--warn-soft)",
              color: "var(--warn)",
            }}
          >
            {t("capabilities:settings.notConfiguredHint")}
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ color: "var(--text-soft)" }}>{t("capabilities:settings.presetLabel")}</span>
          <select
            value={currentPreset}
            onChange={(e) => applyPreset(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 13,
            }}
          >
            {PRESET_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(`capabilities:preset.${key}`)}
              </option>
            ))}
            {currentPreset === "custom" && (
              <option value="custom">{t("capabilities:preset.custom")}</option>
            )}
          </select>
        </label>

        <fieldset
          style={{
            margin: 0,
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <legend style={{ padding: "0 6px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("capabilities:settings.advanced")}
          </legend>
          {TOGGLE_KEYS.map((key) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={toggleValue[key]}
                onChange={(e) => setToggle[key](e.target.checked)}
              />
              <span>{t(`capabilities:capability.${key}`)}</span>
            </label>
          ))}
        </fieldset>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !BRIDGE_AVAILABLE}
            style={{
              padding: "8px 16px",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-sm)",
              fontSize: 13,
              cursor: "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {t("capabilities:settings.save")}
          </button>
          <button
            type="button"
            onClick={handleDetect}
            disabled={detecting || !BRIDGE_AVAILABLE}
            style={{
              ...secondaryButtonStyle,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: detecting ? 0.6 : 1,
            }}
          >
            <Wand2 size={14} strokeWidth={2.2} />
            {detecting ? t("capabilities:settings.detecting") : t("capabilities:settings.detect")}
          </button>
          <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 12 }}>
            {sourceLabel}
          </span>
        </div>
      </div>
    </Card>
  );
}
