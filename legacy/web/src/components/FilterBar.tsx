import type { ChangeEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AnalyticsFilters, AppOption, UserSummary } from "../lib/bridge";

interface FilterBarProps {
  filters: AnalyticsFilters;
  onChange: (next: AnalyticsFilters) => void;
  onSubmit: () => void;
  onReset: () => void;
  users: UserSummary[];
  apps: AppOption[];
  extras?: ReactNode;
}

const labelStyle = { fontSize: 12, color: "var(--text-muted)" };
const fieldStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
};

export function FilterBar({ filters, onChange, onSubmit, onReset, users, apps, extras }: FilterBarProps) {
  const { t } = useTranslation("components");
  const update = (field: keyof AnalyticsFilters) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    onChange({ ...filters, [field]: event.target.value || null });
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <label style={labelStyle}>{t("filterBar.period")}</label>
      <input
        type="date"
        value={filters.date_from ?? ""}
        onChange={update("date_from")}
        style={{ ...fieldStyle, minWidth: 140 }}
      />
      <span style={{ color: "var(--text-muted)" }}>~</span>
      <input
        type="date"
        value={filters.date_to ?? ""}
        onChange={update("date_to")}
        style={{ ...fieldStyle, minWidth: 140 }}
      />

      <label style={labelStyle}>{t("filterBar.user")}</label>
      <select value={filters.user_id ?? ""} onChange={update("user_id")} style={fieldStyle}>
        <option value="">{t("filterBar.allOption")}</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name || u.upn || u.id}
          </option>
        ))}
      </select>

      <label style={labelStyle}>{t("filterBar.app")}</label>
      <select value={filters.app ?? ""} onChange={update("app")} style={fieldStyle}>
        <option value="">{t("filterBar.allOption")}</option>
        {apps.map((a) => (
          <option key={a.value} value={a.value} title={a.value}>
            {a.label}
          </option>
        ))}
      </select>

      <input
        type="search"
        value={filters.search ?? ""}
        onChange={update("search")}
        placeholder={t("filterBar.searchPlaceholder")}
        style={{ ...fieldStyle, flex: 1, minWidth: 180 }}
      />

      <button
        type="submit"
        style={{
          padding: "6px 14px",
          borderRadius: 8,
          background: "var(--accent)",
          color: "white",
          border: 0,
          fontWeight: 600,
        }}
      >
        {t("filterBar.submit")}
      </button>
      <button
        type="button"
        onClick={onReset}
        style={{
          padding: "6px 14px",
          borderRadius: 8,
          background: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
        }}
      >
        {t("filterBar.reset")}
      </button>
      {extras}
    </form>
  );
}
