import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

const TABS: Array<{ key: TabKey; label: string; icon: typeof Coins }> = [
  { key: "overview", label: "개요", icon: Coins },
  { key: "messages", label: "에이전트(리소스)별", icon: CreditCard },
  { key: "environments", label: "환경별", icon: Network },
  { key: "users", label: "사용자별", icon: Users },
  { key: "credits", label: "AI Builder / API", icon: Cpu },
];

const CREDIT_REPORTS: Array<{ value: ConsumptionReportType; label: string }> = [
  { value: "AIByUserAndEnvironment", label: "AI Builder 크레딧" },
  { value: "ApiByLicensedUser", label: "API 요청 (라이선스)" },
  { value: "ApiByNonLicensedUser", label: "API 요청 (비라이선스)" },
  { value: "ApiByFlow", label: "API 요청 (Flow)" },
];

export function ConsumptionPage() {
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
        {TABS.map((t) => {
          const Icon = t.icon;
          const activeTab = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
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
              {t.label}
            </button>
          );
        })}
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0, overflowY: "auto" }}>
        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 --web 으로 실행하세요.</div>
        )}

        {tab === "overview" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <KpiCard
                label="최근 180일 메시지"
                value={formatNumber(summary?.total ?? 0)}
                hint={summary?.unit ? `단위: ${summary.unit}` : "Copilot Studio 청구 메시지"}
                icon={<Coins size={21} />}
              />
              <KpiCard
                label="월 예상 소비량"
                value={formatNumber(Math.round(summary?.projected_month ?? 0))}
                hint="선형 추정"
                tone="warn"
              />
              <KpiCard label="에이전트 수" value={formatNumber(agentCount)} hint="소비가 기록된 리소스" />
              <KpiCard label="환경 수" value={formatNumber(summary?.environments ?? 0)} hint="Power Platform 환경" />
            </div>

            <Card
              title="일별 소비 추이 (최근 180일)"
              actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{summary?.latest_date ?? "—"} 기준</span>}
            >
              <div style={{ height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ top: 12, right: 24, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} />
                    <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "var(--border)" }} />
                    <Line type="monotone" dataKey="total" name="소비량" stroke="var(--accent)" strokeWidth={2.2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card title="상위 소비 에이전트 TOP 10" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{topAgents.length}개</span>}>
              <ul className="rank-list">
                {topAgents.length === 0 && <li className="empty-state">표시할 데이터가 없습니다.</li>}
                {topAgents.map((a, index) => {
                  const max = Math.max(...topAgents.map((r) => r.quantity), 1);
                  return (
                    <li className="rank-item" key={`${a.environment_id ?? ""}-${a.product ?? index}`}>
                      <span className="rank-index">{index + 1}</span>
                      <span>
                        <strong>{a.product || "(미상 에이전트)"}</strong>
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
            title="에이전트(리소스)별 메시지 소비"
            actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{(messagesQuery.data ?? []).length}건</span>}
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
            title="환경별 메시지 소비"
            actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{(environmentsQuery.data ?? []).length}건</span>}
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
            title="사용자별 메시지 소비"
            actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{(usersQuery.data ?? []).length}건</span>}
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
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>보고서</label>
              <select
                value={creditReport}
                onChange={(e) => setCreditReport(e.target.value as ConsumptionReportType)}
                style={fieldStyle}
              >
                {CREDIT_REPORTS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <Card
              title={CREDIT_REPORTS.find((r) => r.value === creditReport)?.label ?? creditReport}
              actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{(creditsQuery.data ?? []).length}건</span>}
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

const consumptionColumns: Column<ConsumptionRow>[] = [
  { key: "usage_date", header: "일자", cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
  { key: "display_name", header: "사용자", cell: (r) => r.display_name || r.user_id || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
  { key: "upn", header: "UPN", cell: (r) => r.upn || "—" },
  { key: "environment_name", header: "환경", cell: (r) => r.environment_name || r.environment_id || "—" },
  { key: "product", header: "제품", cell: (r) => r.product || "—" },
  { key: "quantity", header: "소비량", align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
  { key: "unit", header: "단위", cell: (r) => r.unit || "—" },
];

function nonBillableQuantity(row: ConsumptionRow): number {
  if (!row.raw_json) return 0;
  try {
    const parsed = JSON.parse(row.raw_json) as { metadata?: { NonBillableQuantity?: number } };
    return Number(parsed?.metadata?.NonBillableQuantity ?? 0) || 0;
  } catch {
    return 0;
  }
}

const ENV_PRODUCT_LABELS: Record<string, string> = {
  consumed: "소비",
  allocated: "할당",
  available: "사용 가능",
};

const resourceColumns: Column<ConsumptionRow>[] = [
  { key: "product", header: "에이전트/리소스", cell: (r) => (r.product || "—").split("\n")[0], sortValue: (r) => (r.product ?? "").toLowerCase() },
  { key: "environment_id", header: "환경 ID", cell: (r) => r.environment_id || "—", sortValue: (r) => r.environment_id ?? "" },
  { key: "quantity", header: "청구 메시지", align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
  { key: "nonbillable", header: "비청구", align: "right", cell: (r) => formatNumber(nonBillableQuantity(r)), sortValue: (r) => nonBillableQuantity(r) },
  { key: "usage_date", header: "기준일", cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
];

const environmentColumns: Column<ConsumptionRow>[] = [
  { key: "environment_name", header: "환경", cell: (r) => r.environment_name || r.environment_id || "—", sortValue: (r) => (r.environment_name ?? r.environment_id ?? "").toLowerCase() },
  { key: "product", header: "항목", cell: (r) => ENV_PRODUCT_LABELS[r.product ?? ""] ?? (r.product || "—"), sortValue: (r) => r.product ?? "" },
  { key: "quantity", header: "메시지", align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
  { key: "usage_date", header: "기준일", cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
];

const userColumns: Column<ConsumptionRow>[] = [
  { key: "display_name", header: "사용자", cell: (r) => r.display_name || r.user_id || "—", sortValue: (r) => (r.display_name ?? r.user_id ?? "").toLowerCase() },
  { key: "upn", header: "UPN", cell: (r) => r.upn || "—", sortValue: (r) => (r.upn ?? "").toLowerCase() },
  { key: "quantity", header: "청구 메시지", align: "right", cell: (r) => formatNumber(r.quantity), sortValue: (r) => r.quantity },
  { key: "nonbillable", header: "비청구", align: "right", cell: (r) => formatNumber(nonBillableQuantity(r)), sortValue: (r) => nonBillableQuantity(r) },
  { key: "usage_date", header: "기준일", cell: (r) => r.usage_date, sortValue: (r) => r.usage_date },
];
