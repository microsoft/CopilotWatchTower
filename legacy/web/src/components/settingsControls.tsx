// Shared widgets used by both the Operations and Settings pages.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Column } from "./DataTable";
import type { ProfileSummary, SettingsSummary, SettingsUpdatePayload } from "../lib/bridge";
import { formatKstDateTime } from "../lib/format";
import i18n, { toBackendLanguage, toI18nLanguage } from "../i18n";

const SCOPE_MODES = ["LICENSED", "ALL_ACTIVE", "GROUP", "CUSTOM"];
const AUTO_BACKUP_MODES = ["new", "overwrite"] as const;
const LANGUAGES = ["ko_KR", "en_US"] as const;

export const smallButtonStyle: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text-soft)",
  border: "1px solid var(--border)",
  fontSize: 12,
};

export const primaryButtonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "white",
  border: 0,
  fontWeight: 600,
  cursor: "pointer",
};

export const secondaryButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  width: "100%",
  font: "inherit",
};

export function ProfileAddButton({ onAdd }: { onAdd: (name: string) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!editing) {
    return (
      <button style={smallButtonStyle} onClick={() => setEditing(true)}>
        {t("settings:addProfileButton")}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(name);
        setEditing(false);
        setName("");
      }}
      style={{ display: "flex", gap: 6 }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("settings:newTenantPlaceholder")}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      />
      <button type="submit" style={smallButtonStyle}>{t("common:add")}</button>
      <button type="button" style={smallButtonStyle} onClick={() => setEditing(false)}>{t("common:cancel")}</button>
    </form>
  );
}

export function profileColumnsFor(
  onSwitch: (p: ProfileSummary) => void,
  onRemove: (p: ProfileSummary) => void,
  t: TFunction,
): Column<ProfileSummary>[] {
  return [
    {
      key: "name",
      header: t("settings:col.name"),
      cell: (r) => (
        <div>
          <div style={{ fontWeight: r.current ? 600 : 400 }}>
            {r.name}
            {r.current && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent-strong)" }}>{t("settings:currentBadge")}</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.tenant_domain || r.display_name || r.id}</div>
        </div>
      ),
      sortValue: (r) => r.name.toLowerCase(),
    },
    {
      key: "bootstrap",
      header: t("settings:col.status"),
      cell: (r) => (r.bootstrap_complete ? t("settings:statusComplete") : t("settings:statusNeedsInit")),
      sortValue: (r) => (r.bootstrap_complete ? 1 : 0),
    },
    {
      key: "last_used_at",
      header: t("settings:col.lastUsed"),
      cell: (r) => formatKstDateTime(r.last_used_at),
      sortValue: (r) => r.last_used_at,
    },
    {
      key: "actions",
      header: "",
      cell: (r) => (
        <div style={{ display: "flex", gap: 6 }}>
          {!r.current && (
            <button style={smallButtonStyle} onClick={() => onSwitch(r)}>
              {t("common:switch")}
            </button>
          )}
          {!r.current && (
            <button style={{ ...smallButtonStyle, color: "var(--danger)" }} onClick={() => onRemove(r)}>
              {t("common:delete")}
            </button>
          )}
        </div>
      ),
    },
  ];
}

export function SettingsForm({
  settings,
  onSubmit,
}: {
  settings?: SettingsSummary;
  onSubmit: (payload: SettingsUpdatePayload) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [pollInterval, setPollInterval] = useState<number>(settings?.poll_interval_minutes ?? 15);
  const [scopeMode, setScopeMode] = useState<string>(settings?.scope_mode ?? "LICENSED");
  const [scopeGroup, setScopeGroup] = useState<string>(settings?.scope_group_id ?? "");
  const [scopeUpns, setScopeUpns] = useState<string>((settings?.scope_upns ?? []).join("\n"));
  const [language, setLanguage] = useState<string>(settings?.language ?? "ko_KR");
  const [autoBackupEnabled, setAutoBackupEnabled] = useState<boolean>(settings?.auto_backup_enabled ?? false);
  const [autoBackupMode, setAutoBackupMode] = useState<"new" | "overwrite">(settings?.auto_backup_mode ?? "new");
  const [creditAutoCollect, setCreditAutoCollect] = useState<boolean>(settings?.credit_auto_collect_enabled ?? false);
  const [creditInterval, setCreditInterval] = useState<number>(settings?.credit_auto_collect_interval_hours ?? 24);

  useEffect(() => {
    if (!settings) return;
    setPollInterval(settings.poll_interval_minutes ?? 15);
    setScopeMode(settings.scope_mode ?? "LICENSED");
    setScopeGroup(settings.scope_group_id ?? "");
    setScopeUpns((settings.scope_upns ?? []).join("\n"));
    setLanguage(settings.language ?? "ko_KR");
    setAutoBackupEnabled(settings.auto_backup_enabled ?? false);
    setAutoBackupMode(settings.auto_backup_mode ?? "new");
    setCreditAutoCollect(settings.credit_auto_collect_enabled ?? false);
    setCreditInterval(settings.credit_auto_collect_interval_hours ?? 24);
  }, [settings]);

  if (!settings) return <div className="empty-state">{t("settings:form.loading")}</div>;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // Apply the chosen language immediately so the UI updates without a
        // reload; the backend persists it via the payload below.
        i18n.changeLanguage(toI18nLanguage(language));
        onSubmit({
          poll_interval_minutes: pollInterval,
          scope_mode: scopeMode,
          scope_group_id: scopeMode === "GROUP" ? scopeGroup.trim() || null : null,
          scope_upns: scopeMode === "CUSTOM" ? scopeUpns.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
          language: toBackendLanguage(toI18nLanguage(language)),
          auto_backup_enabled: autoBackupEnabled,
          auto_backup_mode: autoBackupMode,
          credit_auto_collect_enabled: creditAutoCollect,
          credit_auto_collect_interval_hours: creditInterval,
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <Field label={t("settings:form.language")}>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} style={inputStyle}>
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {t(`settings:languages.${code}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("settings:form.pollInterval")}>
        <input
          type="number"
          min={1}
          value={pollInterval}
          onChange={(e) => setPollInterval(Number(e.target.value))}
          style={inputStyle}
        />
      </Field>
      <Field label={t("settings:form.scope")}>
        <select value={scopeMode} onChange={(e) => setScopeMode(e.target.value)} style={inputStyle}>
          {SCOPE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </Field>
      {scopeMode === "GROUP" && (
        <Field label={t("settings:form.groupId")}>
          <input value={scopeGroup} onChange={(e) => setScopeGroup(e.target.value)} style={inputStyle} />
        </Field>
      )}
      {scopeMode === "CUSTOM" && (
        <Field label={t("settings:form.upnList")}>
          <textarea value={scopeUpns} onChange={(e) => setScopeUpns(e.target.value)} rows={4} style={inputStyle} />
        </Field>
      )}
      <Field label={t("settings:form.autoBackup")}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={autoBackupEnabled}
            onChange={(e) => setAutoBackupEnabled(e.target.checked)}
          />
          {t("settings:form.autoBackupCheckbox")}
        </label>
      </Field>
      {autoBackupEnabled && (
        <Field label={t("settings:form.autoBackupMode")}>
          <select
            value={autoBackupMode}
            onChange={(e) => setAutoBackupMode(e.target.value as "new" | "overwrite")}
            style={inputStyle}
          >
            {AUTO_BACKUP_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`settings:autoBackupModes.${mode}`)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t("settings:form.creditAutoCollect")}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={creditAutoCollect}
            onChange={(e) => setCreditAutoCollect(e.target.checked)}
          />
          {t("settings:form.creditAutoCollectCheckbox")}
        </label>
      </Field>
      {creditAutoCollect && (
        <Field label={t("settings:form.creditInterval")}>
          <input
            type="number"
            min={1}
            value={creditInterval}
            onChange={(e) => setCreditInterval(Math.max(1, Number(e.target.value)))}
            style={inputStyle}
          />
        </Field>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="submit" style={primaryButtonStyle}>{t("common:save")}</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {t("settings:form.metaLine", {
          tenant: settings.tenant_id ?? "—",
          client: settings.client_id ?? "—",
          secret: settings.secret_expires_at ?? "—",
        })}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {t("settings:form.autoBackupHint")}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {t("settings:form.creditAutoCollectHint")}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
      <span>{label}</span>
      {children}
    </label>
  );
}
