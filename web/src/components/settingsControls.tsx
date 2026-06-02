// Shared widgets used by both the Operations and Settings pages.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Column } from "./DataTable";
import type { ProfileSummary, SettingsSummary, SettingsUpdatePayload } from "../lib/bridge";
import { formatKstDateTime } from "../lib/format";

const SCOPE_MODES = ["LICENSED", "ALL_ACTIVE", "GROUP", "CUSTOM"];
const AUTO_BACKUP_MODES = [
  { value: "new", label: "매번 새 백업 파일 만들기" },
  { value: "overwrite", label: "마지막 자동 백업 1개만 덮어쓰기" },
] as const;

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
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!editing) {
    return (
      <button style={smallButtonStyle} onClick={() => setEditing(true)}>
        + 새 프로필
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
        placeholder="새 테넌트"
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      />
      <button type="submit" style={smallButtonStyle}>추가</button>
      <button type="button" style={smallButtonStyle} onClick={() => setEditing(false)}>취소</button>
    </form>
  );
}

export function profileColumnsFor(
  onSwitch: (p: ProfileSummary) => void,
  onRemove: (p: ProfileSummary) => void,
): Column<ProfileSummary>[] {
  return [
    {
      key: "name",
      header: "이름",
      cell: (r) => (
        <div>
          <div style={{ fontWeight: r.current ? 600 : 400 }}>
            {r.name}
            {r.current && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent-strong)" }}>(현재)</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.tenant_domain || r.display_name || r.id}</div>
        </div>
      ),
      sortValue: (r) => r.name.toLowerCase(),
    },
    {
      key: "bootstrap",
      header: "상태",
      cell: (r) => (r.bootstrap_complete ? "완료" : "초기화 필요"),
      sortValue: (r) => (r.bootstrap_complete ? 1 : 0),
    },
    {
      key: "last_used_at",
      header: "마지막 사용",
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
              전환
            </button>
          )}
          {!r.current && (
            <button style={{ ...smallButtonStyle, color: "var(--danger)" }} onClick={() => onRemove(r)}>
              삭제
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
  const [pollInterval, setPollInterval] = useState<number>(settings?.poll_interval_minutes ?? 15);
  const [scopeMode, setScopeMode] = useState<string>(settings?.scope_mode ?? "LICENSED");
  const [scopeGroup, setScopeGroup] = useState<string>(settings?.scope_group_id ?? "");
  const [scopeUpns, setScopeUpns] = useState<string>((settings?.scope_upns ?? []).join("\n"));
  const [autoBackupEnabled, setAutoBackupEnabled] = useState<boolean>(settings?.auto_backup_enabled ?? false);
  const [autoBackupMode, setAutoBackupMode] = useState<"new" | "overwrite">(settings?.auto_backup_mode ?? "new");

  useEffect(() => {
    if (!settings) return;
    setPollInterval(settings.poll_interval_minutes ?? 15);
    setScopeMode(settings.scope_mode ?? "LICENSED");
    setScopeGroup(settings.scope_group_id ?? "");
    setScopeUpns((settings.scope_upns ?? []).join("\n"));
    setAutoBackupEnabled(settings.auto_backup_enabled ?? false);
    setAutoBackupMode(settings.auto_backup_mode ?? "new");
  }, [settings]);

  if (!settings) return <div className="empty-state">설정을 불러오는 중…</div>;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          poll_interval_minutes: pollInterval,
          scope_mode: scopeMode,
          scope_group_id: scopeMode === "GROUP" ? scopeGroup.trim() || null : null,
          scope_upns: scopeMode === "CUSTOM" ? scopeUpns.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
          auto_backup_enabled: autoBackupEnabled,
          auto_backup_mode: autoBackupMode,
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <Field label="수집 주기 (분)">
        <input
          type="number"
          min={1}
          value={pollInterval}
          onChange={(e) => setPollInterval(Number(e.target.value))}
          style={inputStyle}
        />
      </Field>
      <Field label="수집 범위">
        <select value={scopeMode} onChange={(e) => setScopeMode(e.target.value)} style={inputStyle}>
          {SCOPE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </Field>
      {scopeMode === "GROUP" && (
        <Field label="Entra 그룹 ID">
          <input value={scopeGroup} onChange={(e) => setScopeGroup(e.target.value)} style={inputStyle} />
        </Field>
      )}
      {scopeMode === "CUSTOM" && (
        <Field label="UPN 목록 (한 줄당 한 명)">
          <textarea value={scopeUpns} onChange={(e) => setScopeUpns(e.target.value)} rows={4} style={inputStyle} />
        </Field>
      )}
      <Field label="수집 후 자동 백업">
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={autoBackupEnabled}
            onChange={(e) => setAutoBackupEnabled(e.target.checked)}
          />
          수집 작업이 끝날 때마다 현재 프로필 데이터를 자동으로 백업
        </label>
      </Field>
      {autoBackupEnabled && (
        <Field label="자동 백업 방식">
          <select
            value={autoBackupMode}
            onChange={(e) => setAutoBackupMode(e.target.value as "new" | "overwrite")}
            style={inputStyle}
          >
            {AUTO_BACKUP_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="submit" style={primaryButtonStyle}>저장</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        Tenant: {settings.tenant_id ?? "—"} · Client: {settings.client_id ?? "—"} · Secret 만료: {settings.secret_expires_at ?? "—"}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        자동 백업 파일은 현재 프로필의 exports 폴더에 저장됩니다. 덮어쓰기를 선택하면 `*-latest.cwtbackup` 파일 1개만 유지합니다.
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
