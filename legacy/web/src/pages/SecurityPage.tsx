import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { RawJsonButton } from "../components/RawJsonModal";
import {
  type AdminDiagnosticRow,
  type AuditEventFilters,
  type AuditEventRow,
  type AuditSource,
  isBridgeAvailable,
  listAdminDiagnostics,
  listAuditEvents,
} from "../lib/bridge";
import { defaultDateRange, formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const SOURCES: Array<{ value: "" | AuditSource; labelKey: string }> = [
  { value: "", labelKey: "sources.all" },
  { value: "purview", labelKey: "sources.purview" },
  { value: "entra_audit", labelKey: "sources.entraAudit" },
  { value: "entra_signin", labelKey: "sources.entraSignin" },
];

export function SecurityPage() {
  const { t } = useTranslation("security");
  const initialFilters: AuditEventFilters = useMemo(() => {
    const range = defaultDateRange();
    return { ...range, source: null, search: null, limit: 500 };
  }, []);
  const [draft, setDraft] = useState<AuditEventFilters>(initialFilters);
  const [applied, setApplied] = useState<AuditEventFilters>(initialFilters);

  const eventsQuery = useQuery({
    queryKey: ["audit-events", applied],
    queryFn: () => listAuditEvents(applied),
    enabled: BRIDGE_AVAILABLE,
  });
  const diagnosticsQuery = useQuery({
    queryKey: ["admin-diagnostics"],
    queryFn: () => listAdminDiagnostics(),
    enabled: BRIDGE_AVAILABLE,
  });

  const events = eventsQuery.data ?? [];
  const diagnostics = diagnosticsQuery.data ?? [];
  const kpis = useMemo(() => deriveSecurityKpis(events), [events]);
  const diagnosticColumns = useMemo(() => buildDiagnosticColumns(t), [t]);
  const eventColumns = useMemo(() => buildEventColumns(t), [t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 24px",
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("filters.source")}</label>
        <select
          value={draft.source ?? ""}
          onChange={(e) => setDraft({ ...draft, source: (e.target.value || null) as AuditSource | null })}
          style={fieldStyle}
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {t(s.labelKey)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.date_from ?? ""}
          onChange={(e) => setDraft({ ...draft, date_from: e.target.value || null })}
          style={fieldStyle}
        />
        <span>~</span>
        <input
          type="date"
          value={draft.date_to ?? ""}
          onChange={(e) => setDraft({ ...draft, date_to: e.target.value || null })}
          style={fieldStyle}
        />
        <input
          type="search"
          value={draft.search ?? ""}
          onChange={(e) => setDraft({ ...draft, search: e.target.value || null })}
          placeholder={t("filters.searchPlaceholder")}
          style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
        />
        <button
          type="submit"
          style={{ padding: "6px 14px", borderRadius: 8, background: "var(--accent)", color: "white", border: 0, fontWeight: 600 }}
        >
          {t("filters.submit")}
        </button>
      </form>

      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KpiCard label={t("kpi.auditEvents")} value={formatNumber(kpis.total)} hint={t("kpi.auditEventsHint")} />
          <KpiCard label={t("kpi.blocked")} value={formatNumber(kpis.blocked)} tone={kpis.blocked ? "danger" : "neutral"} hint="result=denied/blocked" />
          <KpiCard label={t("kpi.uniqueUsers")} value={formatNumber(kpis.uniqueUsers)} hint={t("kpi.uniqueUsersHint")} />
          <KpiCard label={t("kpi.topOperation")} value={kpis.topOperation ?? "—"} hint={kpis.topOperation ? t("kpi.topOperationHint", { n: formatNumber(kpis.topOperationCount) }) : ""} />
        </div>

        <Card title={t("cards.diagnosticsTitle")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("cards.diagnosticsCount", { n: diagnostics.length })}</span>}>
          <DataTable<AdminDiagnosticRow>
            rows={diagnostics}
            rowKey={(row) => row.key}
            columns={diagnosticColumns}
            initialSort={{ key: "label", direction: "asc" }}
            maxHeight={240}
          />
        </Card>

        <Card title={t("cards.auditEventsTitle")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("cards.auditEventsCount", { n: events.length })}</span>}>
          <DataTable<AuditEventRow>
            rows={events}
            rowKey={(row) => row.id}
            initialSort={{ key: "event_time", direction: "desc" }}
            columns={eventColumns}
            maxHeight="50vh"
          />
        </Card>

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">{t("bridge.offline")}</div>
        )}
      </section>
    </div>
  );
}

const fieldStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
} as const;

const STATUS_TONE: Record<string, { color: string; bg: string }> = {
  ok: { color: "var(--ok)", bg: "var(--ok-soft)" },
  forbidden: { color: "var(--danger)", bg: "var(--danger-soft)" },
  not_found: { color: "var(--warn)", bg: "var(--warn-soft)" },
  error: { color: "var(--danger)", bg: "var(--danger-soft)" },
};

function buildDiagnosticColumns(t: TFunction): Column<AdminDiagnosticRow>[] {
  return [
  { key: "label", header: t("diagnosticColumns.label"), cell: (r) => r.label, sortValue: (r) => r.label.toLowerCase() },
  { key: "endpoint", header: t("diagnosticColumns.endpoint"), cell: (r) => r.endpoint },
  {
    key: "status",
    header: t("diagnosticColumns.status"),
    cell: (r) => {
      const tone = STATUS_TONE[r.status] ?? { color: "var(--text-muted)", bg: "var(--surface-muted)" };
      return (
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: tone.bg,
            color: tone.color,
            fontWeight: 600,
          }}
        >
          {r.status}
          {r.status_code != null ? ` ${r.status_code}` : ""}
        </span>
      );
    },
    sortValue: (r) => r.status,
  },
  { key: "summary", header: t("diagnosticColumns.summary"), cell: (r) => r.summary || r.error || "—" },
  { key: "captured_at", header: t("diagnosticColumns.capturedAt"), cell: (r) => formatKstDateTime(r.captured_at), sortValue: (r) => r.captured_at },
  ];
}

function buildEventColumns(t: TFunction): Column<AuditEventRow>[] {
  return [
    {
      key: "event_time",
      header: t("eventColumns.time"),
      cell: (r) => formatKstDateTime(r.event_time),
      sortValue: (r) => r.event_time,
    },
    { key: "source", header: t("eventColumns.source"), cell: (r) => r.source, sortValue: (r) => r.source },
    { key: "user", header: t("eventColumns.user"), cell: (r) => r.upn || r.user_id || "—", sortValue: (r) => (r.upn ?? r.user_id ?? "").toLowerCase() },
    { key: "operation", header: t("eventColumns.operation"), cell: (r) => r.operation || "—", sortValue: (r) => (r.operation ?? "").toLowerCase() },
    { key: "workload", header: "Workload", cell: (r) => r.workload || "—" },
    {
      key: "app",
      header: t("eventColumns.app"),
      cell: (r) => r.app || "—",
      title: (r) => r.app_raw,
      sortValue: (r) => (r.app ?? "").toLowerCase(),
    },
    {
      key: "result",
      header: t("eventColumns.result"),
      cell: (r) => {
        if (!r.result) return "—";
        const tone = r.result.toLowerCase().includes("success")
          ? { color: "var(--ok)", bg: "var(--ok-soft)" }
          : { color: "var(--warn)", bg: "var(--warn-soft)" };
        return (
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: tone.bg, color: tone.color, fontWeight: 600 }}>
            {r.result}
          </span>
        );
      },
      sortValue: (r) => r.result ?? "",
    },
    {
      key: "detail",
      header: "",
      cell: (r) => (
        <RawJsonButton raw={r.raw_json} title={t("eventColumns.rawTitle", { operation: r.operation || "" })} />
      ),
    },
  ];
}

function deriveSecurityKpis(rows: AuditEventRow[]) {
  const total = rows.length;
  let blocked = 0;
  const users = new Set<string>();
  const operations = new Map<string, number>();
  for (const row of rows) {
    const result = (row.result ?? "").toLowerCase();
    const op = (row.operation ?? "").toLowerCase();
    if (result.includes("denied") || result.includes("blocked") || result === "failure" || op.includes("block") || op.includes("deny")) {
      blocked += 1;
    }
    if (row.upn) users.add(row.upn.toLowerCase());
    if (row.operation) {
      operations.set(row.operation, (operations.get(row.operation) ?? 0) + 1);
    }
  }
  const top = [...operations.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    blocked,
    uniqueUsers: users.size,
    topOperation: top?.[0] ?? null,
    topOperationCount: top?.[1] ?? 0,
  };
}
