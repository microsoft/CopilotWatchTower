import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import {
  type AgentRiskRow,
  type CreditDeltaRow,
  type FlowRunAgentSummary,
  type NewAgentRow,
  getCreditAgentAnalysis,
  getCreditAgentTrend,
  getCreditAlertsOverview,
  getCreditUserAnalysis,
  getCreditUserTrend,
  getFlowRunOverview,
  getNewAgents,
  isBridgeAvailable,
  listAgentRisk,
} from "../lib/bridge";
import { formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

type TabKey = "overview" | "agents" | "users" | "flows" | "risk";

const TABS: TabKey[] = ["overview", "agents", "users", "flows", "risk"];

const BAND_TONE: Record<string, "neutral" | "warn" | "danger"> = {
  low: "neutral",
  medium: "warn",
  high: "danger",
  critical: "danger",
};

function TierBadge({ tier }: { tier: "billing" | "realtime" | "predictive" }) {
  const { t } = useTranslation("creditGov");
  const color =
    tier === "billing" ? "var(--accent)" : tier === "realtime" ? "var(--ok)" : "var(--warn)";
  return (
    <span
      title={t(`tierHints.${tier}`)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "2px 10px",
      }}
    >
      {t(`tiers.${tier}`)}
    </span>
  );
}

function SpikeCell({ ratio }: { ratio: number | null }) {
  const { t } = useTranslation("creditGov");
  if (ratio == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const hot = ratio >= 2;
  return (
    <span
      style={{
        fontWeight: hot ? 700 : 500,
        color: ratio >= 3 ? "var(--danger)" : hot ? "var(--warn)" : "var(--text)",
      }}
    >
      {hot ? t("analysis.spikeBadge", { ratio: ratio.toFixed(1) }) : `×${ratio.toFixed(1)}`}
    </span>
  );
}

export function AgentCreditPage() {
  const { t } = useTranslation("creditGov");
  const [tab, setTab] = useState<TabKey>("overview");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedRisk, setSelectedRisk] = useState<AgentRiskRow | null>(null);

  const alertsOverview = useQuery({
    queryKey: ["credit-alerts-overview"],
    queryFn: getCreditAlertsOverview,
    enabled: BRIDGE_AVAILABLE,
  });
  const agentsQuery = useQuery({
    queryKey: ["credit-agents"],
    queryFn: () => getCreditAgentAnalysis(30, 200),
    enabled: BRIDGE_AVAILABLE && (tab === "overview" || tab === "agents"),
  });
  const usersQuery = useQuery({
    queryKey: ["credit-users"],
    queryFn: () => getCreditUserAnalysis(30, 200),
    enabled: BRIDGE_AVAILABLE && tab === "users",
  });
  const newAgentsQuery = useQuery({
    queryKey: ["credit-new-agents"],
    queryFn: () => getNewAgents(7),
    enabled: BRIDGE_AVAILABLE && tab === "overview",
  });
  const flowQuery = useQuery({
    queryKey: ["flow-overview"],
    queryFn: () => getFlowRunOverview(7, 200),
    enabled: BRIDGE_AVAILABLE && (tab === "overview" || tab === "flows"),
  });
  const riskQuery = useQuery({
    queryKey: ["agent-risk"],
    queryFn: () => listAgentRisk({ limit: 500 }),
    enabled: BRIDGE_AVAILABLE && (tab === "overview" || tab === "risk"),
  });
  const agentTrendQuery = useQuery({
    queryKey: ["credit-agent-trend", selectedAgent],
    queryFn: () => getCreditAgentTrend(selectedAgent ?? "", 30),
    enabled: BRIDGE_AVAILABLE && tab === "agents" && !!selectedAgent,
  });
  const userTrendQuery = useQuery({
    queryKey: ["credit-user-trend", selectedUser],
    queryFn: () => getCreditUserTrend(selectedUser ?? "", 30),
    enabled: BRIDGE_AVAILABLE && tab === "users" && !!selectedUser,
  });

  const agentColumns = useMemo(() => buildAgentColumns(t), [t]);
  const userColumns = useMemo(() => buildUserColumns(t), [t]);
  const newAgentColumns = useMemo(() => buildNewAgentColumns(t), [t]);
  const flowColumns = useMemo(() => buildFlowColumns(t), [t]);
  const riskColumns = useMemo(() => buildRiskColumns(t), [t]);

  const agents = agentsQuery.data ?? [];
  const topSpike = [...agents]
    .filter((a) => a.spike_ratio != null)
    .sort((a, b) => (b.spike_ratio ?? 0) - (a.spike_ratio ?? 0))[0];
  const highRiskCount = (riskQuery.data ?? []).filter((r) => r.risk_score >= 75).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 24px",
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {TABS.map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="toolbar-chip"
            style={{
              fontWeight: tab === key ? 700 : 500,
              borderColor: tab === key ? "var(--accent)" : "var(--border)",
              color: tab === key ? "var(--accent)" : "var(--text)",
            }}
          >
            {t(`analysis.tabs.${key}`)}
          </button>
        ))}
        <div style={{ marginLeft: "auto" }}>
          {tab === "flows" ? (
            <TierBadge tier="realtime" />
          ) : tab === "risk" ? (
            <TierBadge tier="predictive" />
          ) : (
            <TierBadge tier="billing" />
          )}
        </div>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0, overflowY: "auto" }}>
        {tab === "overview" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(150px, 1fr))", gap: 12 }}>
              <KpiCard
                label={t("analysis.kpi.activeAlerts")}
                value={formatNumber(alertsOverview.data?.active ?? 0)}
                tone={(alertsOverview.data?.danger ?? 0) > 0 ? "danger" : (alertsOverview.data?.active ?? 0) > 0 ? "warn" : "neutral"}
              />
              <KpiCard
                label={t("analysis.kpi.topSpikeAgent")}
                value={topSpike ? topSpike.name ?? "—" : "—"}
                hint={topSpike?.spike_ratio != null ? `×${topSpike.spike_ratio.toFixed(1)}` : ""}
                tone={topSpike && (topSpike.spike_ratio ?? 0) >= 3 ? "danger" : "neutral"}
              />
              <KpiCard label={t("analysis.kpi.newAgents")} value={formatNumber(newAgentsQuery.data?.length ?? 0)} />
              <KpiCard label={t("analysis.kpi.highRisk")} value={formatNumber(highRiskCount)} tone={highRiskCount > 0 ? "warn" : "neutral"} />
            </div>
            <Card title={t("analysis.spikeTop")}>
              <DataTable<CreditDeltaRow>
                columns={agentColumns}
                rows={[...agents].filter((a) => (a.spike_ratio ?? 0) >= 1.5).slice(0, 10)}
                rowKey={(r) => r.product ?? r.name ?? ""}
                empty={t("analysis.noData")}
                maxHeight="40vh"
              />
            </Card>
            <Card title={t("analysis.newAgentsTitle")}>
              <DataTable<NewAgentRow>
                columns={newAgentColumns}
                rows={newAgentsQuery.data ?? []}
                rowKey={(r) => r.product}
                empty={t("analysis.noData")}
                maxHeight="40vh"
              />
            </Card>
          </>
        )}

        {tab === "agents" && (
          <>
            <Card title={t("analysis.tabs.agents")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("analysis.deltaWindowDays", { days: 30 })}</span>}>
              <DataTable<CreditDeltaRow>
                columns={agentColumns}
                rows={agents}
                rowKey={(r) => r.product ?? r.name ?? ""}
                empty={t("analysis.noData")}
                initialSort={{ key: "lastDelta", direction: "desc" }}
                maxHeight="45vh"
                onRowClick={(r) => setSelectedAgent(r.product ?? null)}
                selectedRowKey={selectedAgent}
              />
            </Card>
            <Card title={selectedAgent ? t("analysis.trendTitle", { name: selectedAgent }) : t("analysis.trendHint")}>
              <TrendChart points={agentTrendQuery.data ?? []} />
            </Card>
          </>
        )}

        {tab === "users" && (
          <>
            <Card title={t("analysis.tabs.users")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("analysis.deltaWindowDays", { days: 30 })}</span>}>
              <DataTable<CreditDeltaRow>
                columns={userColumns}
                rows={usersQuery.data ?? []}
                rowKey={(r) => r.user_id ?? ""}
                empty={t("analysis.noData")}
                initialSort={{ key: "lastDelta", direction: "desc" }}
                maxHeight="45vh"
                onRowClick={(r) => setSelectedUser(r.user_id ?? null)}
                selectedRowKey={selectedUser}
              />
            </Card>
            <Card title={selectedUser ? t("analysis.trendTitle", { name: usersQuery.data?.find((u) => u.user_id === selectedUser)?.display_name ?? selectedUser }) : t("analysis.trendHint")}>
              <TrendChart points={userTrendQuery.data ?? []} />
            </Card>
          </>
        )}

        {tab === "flows" && <FlowMonitor data={flowQuery.data} columns={flowColumns} />}

        {tab === "risk" && (
          <>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("risk.subtitle")}</p>
            <Card title={t("risk.title")}>
              <DataTable<AgentRiskRow>
                columns={riskColumns}
                rows={riskQuery.data ?? []}
                rowKey={(r) => r.id}
                empty={t("risk.noData")}
                initialSort={{ key: "score", direction: "desc" }}
                maxHeight="45vh"
                onRowClick={(r) => setSelectedRisk(r)}
                selectedRowKey={selectedRisk?.id ?? null}
              />
            </Card>
            {selectedRisk && (
              <Card title={t("risk.detailTitle", { name: selectedRisk.bot_name ?? selectedRisk.id })}>
                <RiskFactors row={selectedRisk} />
              </Card>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function TrendChart({ points }: { points: { date: string; delta: number }[] }) {
  if (!points.length) {
    return <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>—</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
        <Tooltip />
        <Line type="monotone" dataKey="delta" stroke="var(--accent)" strokeWidth={2.2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function FlowMonitor({
  data,
  columns,
}: {
  data: import("../lib/bridge").FlowRunOverview | undefined;
  columns: Column<FlowRunAgentSummary>[];
}) {
  const { t } = useTranslation("creditGov");
  const ov = data?.overview;
  const trend = (data?.trend ?? []).map((p) => ({ date: p.date, delta: p.count }));
  return (
    <>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("flow.note")}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(110px, 1fr))", gap: 12 }}>
        <KpiCard label={t("flow.kpi.total")} value={formatNumber(ov?.total_runs ?? 0)} />
        <KpiCard label={t("flow.kpi.today")} value={formatNumber(ov?.runs_today ?? 0)} />
        <KpiCard label={t("flow.kpi.failed")} value={formatNumber(ov?.failed_runs ?? 0)} tone={(ov?.failed_runs ?? 0) > 0 ? "warn" : "neutral"} />
        <KpiCard label={t("flow.kpi.autonomous")} value={formatNumber(ov?.autonomous_runs ?? 0)} tone={(ov?.autonomous_runs ?? 0) > 0 ? "warn" : "neutral"} />
        <KpiCard label={t("flow.kpi.flows")} value={formatNumber(ov?.flow_count ?? 0)} />
      </div>
      <Card title={t("flow.trendTitle")}>
        <TrendChart points={trend} />
      </Card>
      <Card title={t("flow.agentsTitle")}>
        <DataTable<FlowRunAgentSummary>
          columns={columns}
          rows={data?.agents ?? []}
          rowKey={(r) => r.workflow_id ?? Math.random().toString()}
          empty={t("analysis.noData")}
          initialSort={{ key: "runsToday", direction: "desc" }}
          maxHeight="45vh"
        />
      </Card>
    </>
  );
}

function RiskFactors({ row }: { row: AgentRiskRow }) {
  const { t } = useTranslation("creditGov");
  const factors = row.risk_factors ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {factors.map((f) => (
        <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 180, fontSize: 12 }}>{t(`risk.factors.${f.key}`, f.key)}</span>
          <div style={{ flex: 1, height: 10, background: "var(--surface-2, var(--border))", borderRadius: 999, overflow: "hidden", minWidth: 0 }}>
            <div style={{ width: `${Math.min(100, f.score)}%`, height: "100%", background: f.score >= 25 ? "var(--danger)" : f.score >= 10 ? "var(--warn)" : "var(--accent)" }} />
          </div>
          <span style={{ width: 70, textAlign: "right", fontSize: 12, fontWeight: 600 }}>
            {f.score.toFixed(0)} ({f.count})
          </span>
        </div>
      ))}
    </div>
  );
}

function buildAgentColumns(t: TFunction): Column<CreditDeltaRow>[] {
  return [
    { key: "name", header: t("agentColumns.name"), cell: (r) => r.name ?? r.product ?? "—", sortValue: (r) => r.name ?? "" },
    { key: "environment", header: t("agentColumns.environment"), cell: (r) => r.environment_name ?? "—" },
    { key: "lastDelta", header: t("agentColumns.lastDelta"), align: "right", cell: (r) => formatNumber(r.last_delta), sortValue: (r) => r.last_delta },
    { key: "baseline", header: t("agentColumns.baseline"), align: "right", cell: (r) => formatNumber(r.baseline_daily), sortValue: (r) => r.baseline_daily },
    { key: "spike", header: t("agentColumns.spike"), align: "right", cell: (r) => <SpikeCell ratio={r.spike_ratio} />, sortValue: (r) => r.spike_ratio ?? 0 },
    { key: "latest", header: t("agentColumns.latest"), align: "right", cell: (r) => formatNumber(r.latest_quantity), sortValue: (r) => r.latest_quantity },
    { key: "lastDate", header: t("agentColumns.lastDate"), cell: (r) => r.last_date ?? "—" },
  ];
}

function buildUserColumns(t: TFunction): Column<CreditDeltaRow>[] {
  return [
    { key: "name", header: t("userColumns.name"), cell: (r) => r.display_name ?? r.user_id ?? "—", sortValue: (r) => r.display_name ?? "" },
    { key: "upn", header: t("userColumns.upn"), cell: (r) => r.upn ?? "—" },
    { key: "lastDelta", header: t("userColumns.lastDelta"), align: "right", cell: (r) => formatNumber(r.last_delta), sortValue: (r) => r.last_delta },
    { key: "baseline", header: t("userColumns.baseline"), align: "right", cell: (r) => formatNumber(r.baseline_daily), sortValue: (r) => r.baseline_daily },
    { key: "spike", header: t("userColumns.spike"), align: "right", cell: (r) => <SpikeCell ratio={r.spike_ratio} />, sortValue: (r) => r.spike_ratio ?? 0 },
    { key: "lastDate", header: t("userColumns.lastDate"), cell: (r) => r.last_date ?? "—" },
  ];
}

function buildNewAgentColumns(t: TFunction): Column<NewAgentRow>[] {
  return [
    { key: "name", header: t("newAgentColumns.name"), cell: (r) => r.name },
    { key: "environment", header: t("newAgentColumns.environment"), cell: (r) => r.environment_name ?? "—" },
    { key: "firstSeen", header: t("newAgentColumns.firstSeen"), cell: (r) => r.first_seen },
    { key: "latest", header: t("newAgentColumns.latest"), align: "right", cell: (r) => formatNumber(r.latest_quantity), sortValue: (r) => r.latest_quantity },
  ];
}

function buildFlowColumns(t: TFunction): Column<FlowRunAgentSummary>[] {
  return [
    { key: "flow", header: t("flow.columns.flow"), cell: (r) => r.workflow_name ?? r.workflow_id ?? "—", sortValue: (r) => r.workflow_name ?? "" },
    { key: "environment", header: t("flow.columns.environment"), cell: (r) => r.environment_name ?? "—" },
    { key: "type", header: t("flow.columns.type"), cell: (r) => (r.modern_flow_type != null ? t(`flow.flowType.${r.modern_flow_type}`, String(r.modern_flow_type)) : "—") },
    { key: "runsToday", header: t("flow.columns.runsToday"), align: "right", cell: (r) => formatNumber(r.runs_today), sortValue: (r) => r.runs_today },
    { key: "baseline", header: t("flow.columns.baseline"), align: "right", cell: (r) => r.baseline_daily.toFixed(1), sortValue: (r) => r.baseline_daily },
    { key: "failRate", header: t("flow.columns.failRate"), align: "right", cell: (r) => `${Math.round(r.fail_rate * 100)}%`, sortValue: (r) => r.fail_rate },
    { key: "autonomous", header: t("flow.columns.autonomous"), align: "right", cell: (r) => formatNumber(r.autonomous_runs), sortValue: (r) => r.autonomous_runs },
    { key: "total", header: t("flow.columns.total"), align: "right", cell: (r) => formatNumber(r.total_runs), sortValue: (r) => r.total_runs },
    { key: "lastRun", header: t("flow.columns.lastRun"), cell: (r) => (r.last_run ? r.last_run.replace("T", " ").slice(0, 16) : "—") },
  ];
}

function buildRiskColumns(t: TFunction): Column<AgentRiskRow>[] {
  return [
    { key: "name", header: t("risk.columns.name"), cell: (r) => r.bot_name ?? r.id, sortValue: (r) => r.bot_name ?? "" },
    { key: "environment", header: t("risk.columns.environment"), cell: (r) => r.environment_name ?? "—" },
    {
      key: "band",
      header: t("risk.columns.band"),
      cell: (r) => {
        const tone = BAND_TONE[r.risk_band ?? "low"] ?? "neutral";
        const color = tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--text-muted)";
        return <span style={{ color, fontWeight: 700 }}>{t(`bands.${r.risk_band ?? "low"}`)}</span>;
      },
      sortValue: (r) => r.risk_score,
    },
    { key: "score", header: t("risk.columns.score"), align: "right", cell: (r) => r.risk_score.toFixed(0), sortValue: (r) => r.risk_score },
    { key: "trigger", header: t("risk.columns.trigger"), cell: (r) => (r.has_trigger ? t("risk.yes") : t("risk.no")) },
    { key: "external", header: t("risk.columns.external"), align: "right", cell: (r) => formatNumber(r.external_call_count), sortValue: (r) => r.external_call_count },
    { key: "loops", header: t("risk.columns.loops"), align: "right", cell: (r) => formatNumber(r.loop_count), sortValue: (r) => r.loop_count },
    { key: "generative", header: t("risk.columns.generative"), cell: (r) => (r.generative_orchestration ? t("risk.yes") : t("risk.no")) },
  ];
}
