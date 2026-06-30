import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ExternalLink, X } from "lucide-react";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import {
  type AgentFilters,
  type AgentIdentityEvent,
  type AgentRow,
  isBridgeAvailable,
  listAgentIdentityEvents,
  listAgents,
  openExternalUrl,
} from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();
const THRESHOLDS = [7, 14, 30, 60, 90];

export function AgentsPage() {
  const { t } = useTranslation("agents");
  const [draft, setDraft] = useState<AgentFilters>({ threshold_days: 30, include_all: true, search: null });
  const [applied, setApplied] = useState<AgentFilters>(draft);
  const [selected, setSelected] = useState<AgentRow | null>(null);

  const agentsQuery = useQuery({
    queryKey: ["agents-list", applied],
    queryFn: () => listAgents(applied),
    enabled: BRIDGE_AVAILABLE,
  });

  const identityEventsQuery = useQuery({
    queryKey: ["agent-identity-events"],
    queryFn: () => listAgentIdentityEvents(200),
    enabled: BRIDGE_AVAILABLE,
  });

  const agents = agentsQuery.data ?? [];
  const identityEvents = identityEventsQuery.data ?? [];
  const kpis = useMemo(() => deriveAgentKpis(agents), [agents]);
  const agentColumns = useMemo(() => buildAgentColumns(t), [t]);
  const identityColumns = useMemo(() => buildIdentityEventColumns(t), [t]);

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
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("filters.thresholdLabel")}</label>
        <select
          value={draft.threshold_days ?? 30}
          onChange={(e) => setDraft({ ...draft, threshold_days: Number(e.target.value) })}
          style={fieldStyle}
        >
          {THRESHOLDS.map((d) => (
            <option key={d} value={d}>
              {t("filters.days", { n: d })}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
          <input
            type="checkbox"
            checked={!draft.include_all}
            onChange={(e) => setDraft({ ...draft, include_all: !e.target.checked })}
            style={{ marginRight: 6 }}
          />
          {t("filters.staleOnly")}
        </label>
        <input
          type="search"
          placeholder={t("filters.searchPlaceholder")}
          value={draft.search ?? ""}
          onChange={(e) => setDraft({ ...draft, search: e.target.value || null })}
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
          <KpiCard label={t("kpi.total")} value={formatNumber(kpis.total)} hint={t("kpi.totalHint", { n: formatNumber(kpis.usageEvents) })} />
          <KpiCard label={t("kpi.active")} value={formatNumber(kpis.active)} hint={t("kpi.activeHint", { n: kpis.thresholdDays })} tone="positive" />
          <KpiCard label={t("kpi.stale")} value={formatNumber(kpis.stale)} hint={t("kpi.staleHint", { n: kpis.thresholdDays })} tone="warn" />
          <KpiCard label={t("kpi.neverUsed")} value={formatNumber(kpis.neverUsed)} hint={t("kpi.neverUsedHint")} tone="danger" />
        </div>
        <Card title={t("table.title")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("table.agentCount", { n: agents.length })}</span>}>
          <DataTable<AgentRow>
            rows={agents}
            rowKey={(row) => row.id}
            initialSort={{ key: "last_activity", direction: "desc" }}
            columns={agentColumns}
            maxHeight="55vh"
            onRowClick={(row) => setSelected(row)}
            selectedRowKey={selected?.id ?? null}
          />
        </Card>
        {identityEvents.length > 0 && (
          <Card
            title={t("identityEvents.title")}
            actions={
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {t("identityEvents.count", { n: identityEvents.length })}
              </span>
            }
          >
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "0 4px 8px" }}>
              {t("identityEvents.subtitle")}
            </div>
            <DataTable<AgentIdentityEvent>
              rows={identityEvents}
              rowKey={(row) => `${row.target_id ?? row.target_name}-${row.event_time}-${row.operation}`}
              initialSort={{ key: "time", direction: "desc" }}
              columns={identityColumns}
              maxHeight="40vh"
            />
          </Card>
        )}
        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">{t("bridgeOffline")}</div>
        )}
      </section>
      {selected && <AgentDetailDrawer agent={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function buildIdentityEventColumns(t: TFunction): Column<AgentIdentityEvent>[] {
  const actionColor: Record<AgentIdentityEvent["action"], string> = {
    created: "var(--ok)",
    deleted: "var(--danger)",
    updated: "var(--warn)",
    other: "var(--text-muted)",
  };
  return [
    {
      key: "time",
      header: t("identityEvents.columns.time"),
      sortValue: (row) => row.event_time,
      cell: (row) => formatKstDateTime(row.event_time),
    },
    {
      key: "action",
      header: t("identityEvents.columns.action"),
      sortValue: (row) => row.action,
      cell: (row) => (
        <span style={{ color: actionColor[row.action], fontWeight: 600 }}>
          {t(`identityEvents.action.${row.action}`)}
        </span>
      ),
    },
    {
      key: "agent",
      header: t("identityEvents.columns.agent"),
      sortValue: (row) => row.target_name,
      cell: (row) => (
        <span>
          {row.target_name}
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              color: row.agent_known ? "var(--ok)" : "var(--text-muted)",
            }}
          >
            {row.agent_known ? t("identityEvents.known") : t("identityEvents.unknown")}
          </span>
        </span>
      ),
    },
    {
      key: "actor",
      header: t("identityEvents.columns.actor"),
      sortValue: (row) => row.actor,
      cell: (row) => row.actor,
    },
    {
      key: "result",
      header: t("identityEvents.columns.result"),
      sortValue: (row) => row.result ?? "",
      cell: (row) => row.result ?? "\u2014",
    },
  ];
}

const fieldStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
} as const;

function buildStateLabel(t: TFunction): Record<AgentRow["state"], { label: string; bg: string; color: string }> {
  return {
    active: { label: t("status.active"), bg: "var(--ok-soft)", color: "var(--ok)" },
    stale: { label: t("status.stale"), bg: "var(--warn-soft)", color: "var(--warn)" },
    never_used: { label: t("status.never_used"), bg: "var(--danger-soft)", color: "var(--danger)" },
  };
}

function buildConfidenceHint(t: TFunction): Record<AgentRow["confidence"], string> {
  return {
    ok: t("confidence.ok"),
    limited_audit_window: t("confidence.limited_audit_window"),
    no_audit_data: t("confidence.no_audit_data"),
  };
}

function buildAgentColumns(t: TFunction): Column<AgentRow>[] {
  const stateLabel = buildStateLabel(t);
  const confidenceHint = buildConfidenceHint(t);
  return [
  {
    key: "name",
    header: t("columns.name"),
    cell: (r) => (
      <div>
        <div style={{ fontWeight: 600 }}>{r.display_name || r.id}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {r.app_identity || r.app_external_id || r.id}
        </div>
      </div>
    ),
    sortValue: (r) => (r.display_name || r.id).toLowerCase(),
  },
  {
    key: "source",
    header: t("columns.source"),
    cell: (r) => r.source.replace("_", " "),
    sortValue: (r) => r.source,
  },
  {
    key: "state",
    header: t("columns.state"),
    cell: (r) => {
      const s = stateLabel[r.state];
      return (
        <span
          title={confidenceHint[r.confidence]}
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: s.bg,
            color: s.color,
            fontWeight: 600,
          }}
        >
          {s.label}
        </span>
      );
    },
    sortValue: (r) => r.state,
  },
  {
    key: "usage",
    header: t("columns.usage"),
    align: "right",
    cell: (r) => formatNumber(r.usage_event_count),
    sortValue: (r) => r.usage_event_count,
  },
  {
    key: "days_inactive",
    header: t("columns.daysInactive"),
    align: "right",
    cell: (r) => (r.days_inactive == null ? "—" : formatNumber(r.days_inactive)),
    sortValue: (r) => r.days_inactive ?? -1,
  },
  {
    key: "last_activity",
    header: t("columns.lastActivity"),
    cell: (r) => formatKstDateTime(r.last_activity_at),
    sortValue: (r) => r.last_activity_at ?? "",
  },
  {
    key: "open",
    header: "",
    align: "right",
    cell: (r) => (
      <button
        type="button"
        title={t("openInAdminCenter")}
        onClick={(e) => {
          e.stopPropagation();
          void openExternalUrl(m365AdminUrl(r));
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 4,
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        <ExternalLink size={14} />
      </button>
    ),
  },
  ];
}

const M365_INTEGRATED_APPS = "https://admin.microsoft.com/#/Settings/IntegratedApps";

/**
 * Best-effort deep link into the Microsoft 365 admin center "Integrated apps"
 * surface for the given agent. When an app/add-on identifier is known we append
 * it (the admin portal opens the matching app detail pane); otherwise we fall
 * back to the Integrated apps list so the operator can locate it manually.
 */
function m365AdminUrl(agent: AgentRow): string {
  const appId = agent.app_external_id || agent.add_on_guid || agent.app_identity;
  if (appId) {
    return `${M365_INTEGRATED_APPS}/${encodeURIComponent(appId)}`;
  }
  return M365_INTEGRATED_APPS;
}

function buildRawFieldLabels(t: TFunction): Array<{ keys: string[]; label: string }> {
  return [
    { keys: ["publisherName", "publisher", "developerName", "PublisherName"], label: t("rawFields.publisher") },
    { keys: ["description", "shortDescription", "Description"], label: t("rawFields.description") },
    { keys: ["version", "appVersion", "Version"], label: t("rawFields.version") },
    { keys: ["distributionMethod", "DistributionMethod"], label: t("rawFields.distributionMethod") },
    { keys: ["categories", "Categories"], label: t("rawFields.categories") },
  ];
}

function pickRawValue(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      return value.map((v) => String(v)).join(", ");
    }
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function parseRawAgent(rawJson: string | null): Record<string, unknown> {
  if (!rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function DetailItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontSize: 12.5, color: "var(--text)", wordBreak: "break-all", fontFamily: mono ? "var(--mono, monospace)" : undefined }}>
        {value || "—"}
      </span>
    </div>
  );
}

function AgentDetailDrawer({ agent, onClose }: { agent: AgentRow; onClose: () => void }) {
  const { t } = useTranslation(["agents", "common"]);
  const raw = useMemo(() => parseRawAgent(agent.raw_json), [agent.raw_json]);
  const stateLabel = buildStateLabel(t);
  const confidenceHint = buildConfidenceHint(t);
  const rawFields = buildRawFieldLabels(t)
    .map((f) => ({ label: f.label, value: pickRawValue(raw, f.keys) }))
    .filter((f) => f.value != null);
  const state = stateLabel[agent.state];

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.28)", zIndex: 40, display: "flex", justifyContent: "flex-end" }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: "92vw",
          height: "100%",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--surface)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, wordBreak: "break-word" }}>{agent.display_name || agent.id}</div>
            <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: state.bg, color: state.color, fontWeight: 600 }}>
                {state.label}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{agent.source.replace("_", " ")}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("common:close")}
            style={{ border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
          <button
            type="button"
            onClick={() => void openExternalUrl(m365AdminUrl(agent))}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "9px 14px",
              borderRadius: 8,
              border: 0,
              background: "var(--accent)",
              color: "white",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <ExternalLink size={15} />
            {t("openInAdminCenter")}
          </button>

          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <DetailItem label={t("detail.usageEvents")} value={formatNumber(agent.usage_event_count)} />
            <DetailItem label={t("detail.daysInactive")} value={agent.days_inactive == null ? "—" : t("detail.daysValue", { n: formatNumber(agent.days_inactive) })} />
            <DetailItem label={t("detail.lastActivity")} value={formatKstDateTime(agent.last_activity_at)} />
            <DetailItem label={t("detail.activitySource")} value={agent.last_activity_source || "—"} />
            <DetailItem label={t("detail.statusValue")} value={agent.status || "—"} />
            <DetailItem label={t("detail.confidenceBasis")} value={confidenceHint[agent.confidence]} />
          </section>

          {rawFields.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{t("detail.catalogInfo")}</div>
              {rawFields.map((f) => (
                <DetailItem key={f.label} label={f.label} value={f.value as string} />
              ))}
            </section>
          )}

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{t("detail.identifiers")}</div>
            <DetailItem label="App Identity" value={agent.app_identity || "—"} mono />
            <DetailItem label="App External ID" value={agent.app_external_id || "—"} mono />
            <DetailItem label="Add-on GUID" value={agent.add_on_guid || "—"} mono />
            <DetailItem label={t("detail.internalId")} value={agent.id} mono />
          </section>

          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <DetailItem label={t("detail.createdAt")} value={formatKstDateTime(agent.created_at)} />
            <DetailItem label={t("detail.updatedAt")} value={formatKstDateTime(agent.updated_at)} />
            <DetailItem label={t("detail.auditStart")} value={formatKstDateTime(agent.audit_coverage_start)} />
            <DetailItem label={t("detail.auditEnd")} value={formatKstDateTime(agent.audit_coverage_end)} />
          </section>
        </div>
      </aside>
    </div>
  );
}

function deriveAgentKpis(rows: AgentRow[]) {
  const total = rows.length;
  let active = 0;
  let stale = 0;
  let neverUsed = 0;
  let usageEvents = 0;
  let thresholdDays = 30;
  for (const row of rows) {
    thresholdDays = row.threshold_days || thresholdDays;
    usageEvents += row.usage_event_count;
    switch (row.state) {
      case "active":
        active += 1;
        break;
      case "stale":
        stale += 1;
        break;
      case "never_used":
        neverUsed += 1;
        break;
    }
  }
  return { total, active, stale, neverUsed, usageEvents, thresholdDays };
}
