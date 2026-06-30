import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Coins, CreditCard, Cpu, Network, Users } from "lucide-react";
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
  type ConsumptionReportType,
  type ConsumptionRow,
  getConsumptionOverview,
  isBridgeAvailable,
  listConsumption,
} from "../lib/bridge";
import { formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

type TabKey = "overview" | "messages" | "environments" | "users" | "credits";

const TABS: Array<{ key: TabKey; icon: typeof Coins }> = [
  { key: "overview", icon: Coins },
  { key: "messages", icon: CreditCard },
  { key: "environments", icon: Network },
  { key: "users", icon: Users },
  { key: "credits", icon: Cpu },
];

const CREDIT_REPORTS: ConsumptionReportType[] = [
  "AIByUserAndEnvironment",
  "ApiByLicensedUser",
  "ApiByNonLicensedUser",
  "ApiByFlow",
];

export function ConsumptionPage() {
  const { t } = useTranslation("consumption");
  const [tab, setTab] = useState<TabKey>("overview");
  const [creditReport, setCreditReport] = useState<ConsumptionReportType>("AIByUserAndEnvironment");

  const overviewReport: ConsumptionReportType = "MCSMessages:resource";
  const overviewQuery = useQuery({
    queryKey: ["consumption-overview", overviewReport],
    queryFn: () => getConsumptionOverview(overviewReport, 180),
    enabled: BRIDGE_AVAILABLE,
  });

  const overviewResourcesQuery = useQuery({
    queryKey: ["consumption-list", "MCSMessages:resource", "overview"],
    queryFn: () => listConsumption({ report_type: "MCSMessages:resource", limit: 500 }),
    enabled: BRIDGE_AVAILABLE && tab === "overview",
  });

  const messagesQuery = useQuery({
    queryKey: ["consumption-list", "MCSMessages:resource"],
    queryFn: () => listConsumption({ report_type: "MCSMessages:resource", limit: 500 }),
    enabled: BRIDGE_AVAILABLE && tab === "messages",
  });

  const environmentsQuery = useQuery({
    queryKey: ["consumption-list", "MCSMessages:environment"],
    queryFn: () => listConsumption({ report_type: "MCSMessages:environment", limit: 500 }),
    enabled: BRIDGE_AVAILABLE && tab === "environments",
  });

  const usersQuery = useQuery({
    queryKey: ["consumption-list", "MCSMessages:user"],
    queryFn: () => listConsumption({ report_type: "MCSMessages:user", limit: 500 }),
    enabled: BRIDGE_AVAILABLE && tab === "users",
  });

  const creditsQuery = useQuery({
    queryKey: ["consumption-list", creditReport],
    queryFn: () => listConsumption({ report_type: creditReport, limit: 500 }),
    enabled: BRIDGE_AVAILABLE && tab === "credits",
  });

  const overview = overviewQuery.data;
  const summary = overview?.summary;
  const trend = overview?.trend ?? [];
  const topAgents = [...(overviewResourcesQuery.data ?? [])]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);
  const agentCount = (overviewResourcesQuery.data ?? []).length;

  const consumptionColumns = useMemo(() => buildConsumptionColumns(t), [t]);
  const resourceColumns = useMemo(() => buildResourceColumns(t), [t]);
  const environmentColumns = useMemo(() => buildEnvironmentColumns(t), [t]);
  const userColumns = useMemo(() => buildUserColumns(t), [t]);

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
        }}
      >
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const activeTab = tabItem.key === tab;
          return (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: activeTab ? "var(--accent)" : "var(--surface)",
                color: activeTab ? "white" : "var(--text)",
                fontWeight: activeTab ? 600 : 500,
                cursor: "pointer",
              }}
            >
              <Icon size={15} />
              {t(`tabs.${tabItem.key}`)}
            </button>
          );
        })}
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0, overflowY: "auto" }}>
        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">{t("bridgeOffline")}</div>
        )}

        {tab === "overview" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <KpiCard
                label={t("kpi.recentMessages")}
                value={formatNumber(summary?.total ?? 0)}
                hint={summary?.unit ? t("kpi.unitHint", { unit: summary.unit }) : t("kpi.billableMessagesHint")}
                icon={<Coins size={21} />}
              />
              <KpiCard
                label={t("kpi.projectedMonth")}
                value={formatNumber(Math.round(summary?.projected_month ?? 0))}
                hint={t("kpi.projectedMonthHint")}
                tone="warn"
              />
              <KpiCard label={t("kpi.agentCount")} value={formatNumber(agentCount)} hint={t("kpi.agentCountHint")} />
              <KpiCard label={t("kpi.environmentCount")} value={formatNumber(summary?.environments ?? 0)} hint={t("kpi.environmentCountHint")} />
            </div>

            <Card
              title={t("charts.trendTitle")}
              actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("charts.asOf", { date: summary?.latest_date ?? "—" })}</span>}
            >
              <div style={{ height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ top: 12, right: 24, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "var(--border)" }} />
                    <Line type="monotone" dataKey="total" name={t("charts.consumptionSeries")} stroke="var(--accent)" strokeWidth={2.2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title={t("charts.topAgentsTitle")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("badge.agentCount", { n: topAgents.length })}</span>}>
              <ul className="rank-list">
                {topAgents.length === 0 && <li className="empty-state">{t("emptyState")}</li>}
                {topAgents.map((a, index) => {
                  const max = Math.max(...topAgents.map((r) => r.quantity), 1);
                  return (
                    <li className="rank-item" key={`${a.environment_id ?? ""}-${a.product ?? index}`}>
                      <span className="rank-index">{index + 1}</span>
                      <span>
                        <strong>{a.product || t("labels.unknownAgent")}</strong>
                        <div className="rank-meter"><div className="rank-meter-fill" style={{ width: `${Math.round((a.quantity / max) * 100)}%` }} /></div>
                      </span>
                      <span className="tabular">{formatNumber(a.quantity)}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </>
        )}

        {tab === "messages" && (
          <Card
            title={t("cards.messagesTitle")}
            actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("badge.itemCount", { n: (messagesQuery.data ?? []).length })}</span>}
          >
            <DataTable<ConsumptionRow>
              rows={messagesQuery.data ?? []}
              rowKey={(row) => `${row.usage_date}-${row.environment_id ?? ""}-${row.product ?? ""}`}
              initialSort={{ key: "quantity", direction: "desc" }}
              columns={resourceColumns}
              maxHeight="60vh"
            />
          </Card>
        )}

        {tab === "environments" && (
          <Card
            title={t("cards.environmentsTitle")}
            actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("badge.itemCount", { n: (environmentsQuery.data ?? []).length })}</span>}
          >
            <DataTable<ConsumptionRow>
              rows={environmentsQuery.data ?? []}
              rowKey={(row) => `${row.environment_id ?? ""}-${row.product ?? ""}`}
              initialSort={{ key: "quantity", direction: "desc" }}
              columns={environmentColumns}
              maxHeight="60vh"
            />
          </Card>
        )}

        {tab === "users" && (
          <Card
            title={t("cards.usersTitle")}
            actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("badge.itemCount", { n: (usersQuery.data ?? []).length })}</span>}
          >
            <DataTable<ConsumptionRow>
              rows={usersQuery.data ?? []}
              rowKey={(row) => `${row.usage_date}-${row.user_id ?? ""}`}
              initialSort={{ key: "quantity", direction: "desc" }}
              columns={userColumns}
              maxHeight="60vh"
            />
          </Card>
        )}

        {tab === "credits" && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("field.report")}</label>
              <select
                value={creditReport}
                onChange={(e) => setCreditReport(e.target.value as ConsumptionReportType)}
                style={fieldStyle}
              >
                {CREDIT_REPORTS.map((value) => (
                  <option key={value} value={value}>
                    {t(`creditReports.${value}`)}
                  </option>
                ))}
              </select>
            </div>
            <Card
              title={t(`creditReports.${creditReport}`)}
              actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("badge.itemCount", { n: (creditsQuery.data ?? []).length })}</span>}
            >
              <DataTable<ConsumptionRow>
                rows={creditsQuery.data ?? []}
                rowKey={(row) => `${row.usage_date}-${row.user_id ?? ""}-${row.environment_id ?? ""}-${row.product ?? ""}`}
                initialSort={{ key: "usage_date", direction: "desc" }}
                columns={consumptionColumns}
                maxHeight="60vh"
              />
            </Card>
          </>
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

function buildConsumptionColumns(t: TFunction): Column<ConsumptionRow>[] {
  return [
    { key: "usage_date", header: t("columns.date"), cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
    { key: "display_name", header: t("columns.user"), cell: (r) => r.display_name || r.user_id || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
    { key: "upn", header: "UPN", cell: (r) => r.upn || "—" },
    { key: "environment_name", header: t("columns.environment"), cell: (r) => r.environment_name || r.environment_id || "—" },
    { key: "product", header: t("columns.product"), cell: (r) => r.product || "—" },
    { key: "quantity", header: t("columns.quantity"), align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
    { key: "unit", header: t("columns.unit"), cell: (r) => r.unit || "—" },
  ];
}

function nonBillableQuantity(row: ConsumptionRow): number {
  if (!row.raw_json) return 0;
  try {
    const parsed = JSON.parse(row.raw_json) as { metadata?: { NonBillableQuantity?: number } };
    return Number(parsed?.metadata?.NonBillableQuantity ?? 0) || 0;
  } catch {
    return 0;
  }
}

const ENV_PRODUCT_KEYS = ["consumed", "allocated", "available"];

function buildResourceColumns(t: TFunction): Column<ConsumptionRow>[] {
  return [
    { key: "product", header: t("columns.agentResource"), cell: (r) => (r.product || "—").split("\n")[0], sortValue: (r) => (r.product ?? "").toLowerCase() },
    { key: "environment_id", header: t("columns.environmentId"), cell: (r) => r.environment_id || "—", sortValue: (r) => r.environment_id ?? "" },
    { key: "quantity", header: t("columns.billableMessages"), align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
    { key: "nonbillable", header: t("columns.nonBillable"), align: "right", cell: (r) => formatNumber(nonBillableQuantity(r)), sortValue: (r) => nonBillableQuantity(r) },
    { key: "usage_date", header: t("columns.asOfDate"), cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
  ];
}

function buildEnvironmentColumns(t: TFunction): Column<ConsumptionRow>[] {
  return [
    { key: "environment_name", header: t("columns.environment"), cell: (r) => r.environment_name || r.environment_id || "—", sortValue: (r) => (r.environment_name ?? r.environment_id ?? "").toLowerCase() },
    {
      key: "product",
      header: t("columns.item"),
      cell: (r) => {
        const p = r.product ?? "";
        return ENV_PRODUCT_KEYS.includes(p) ? t(`envProduct.${p}`) : (r.product || "—");
      },
      sortValue: (r) => r.product ?? "",
    },
    { key: "quantity", header: t("columns.messages"), align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
    { key: "usage_date", header: t("columns.asOfDate"), cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
  ];
}

function buildUserColumns(t: TFunction): Column<ConsumptionRow>[] {
  return [
    { key: "display_name", header: t("columns.user"), cell: (r) => r.display_name || r.user_id || "—", sortValue: (r) => (r.display_name ?? r.user_id ?? "").toLowerCase() },
    { key: "upn", header: "UPN", cell: (r) => r.upn || "—", sortValue: (r) => (r.upn ?? "").toLowerCase() },
    { key: "quantity", header: t("columns.billableMessages"), align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
    { key: "nonbillable", header: t("columns.nonBillable"), align: "right", cell: (r) => formatNumber(nonBillableQuantity(r)), sortValue: (r) => nonBillableQuantity(r) },
    { key: "usage_date", header: t("columns.asOfDate"), cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
  ];
}
