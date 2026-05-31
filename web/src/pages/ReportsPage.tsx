import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import {
  type UsageCountRow,
  type UsagePeriod,
  type UsageReportType,
  type UsageSnapshotRow,
  getUsagePeriodsSummary,
  isBridgeAvailable,
  listUsageCounts,
  listUsageSnapshots,
} from "../lib/bridge";
import { formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const PERIODS: UsagePeriod[] = ["D7", "D30", "D90", "D180"];
const REPORT_TYPES: Array<{ value: UsageReportType; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "trend", label: "Trend" },
];

export function ReportsPage() {
  const [period, setPeriod] = useState<UsagePeriod>("D30");
  const [reportType, setReportType] = useState<UsageReportType>("summary");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");

  const snapshotsQuery = useQuery({
    queryKey: ["usage-snapshots", period, appliedSearch],
    queryFn: () =>
      listUsageSnapshots({ period, search: appliedSearch || null, limit: 500 }),
    enabled: BRIDGE_AVAILABLE,
  });
  const countsQuery = useQuery({
    queryKey: ["usage-counts", reportType, period],
    queryFn: () => listUsageCounts({ report_type: reportType, period }),
    enabled: BRIDGE_AVAILABLE,
  });
  const periodsQuery = useQuery({
    queryKey: ["usage-periods"],
    queryFn: () => getUsagePeriodsSummary(),
    enabled: BRIDGE_AVAILABLE,
  });

  const snapshots = snapshotsQuery.data ?? [];
  const counts = countsQuery.data ?? [];
  const latest = periodsQuery.data?.latest_snapshot_dates ?? ({} as Record<UsagePeriod, string | null>);

  const kpis = useMemo(() => deriveReportKpis(counts), [counts]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setAppliedSearch(search.trim());
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
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>기간</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value as UsagePeriod)} style={fieldStyle}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>집계 보고서</label>
        <select value={reportType} onChange={(e) => setReportType(e.target.value as UsageReportType)} style={fieldStyle}>
          {REPORT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="사용자 / UPN 검색"
          style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
        />
        <button
          type="submit"
          style={{ padding: "6px 14px", borderRadius: 8, background: "var(--accent)", color: "white", border: 0, fontWeight: 600 }}
        >
          조회
        </button>
      </form>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KpiCard label="최신 스냅샷" value={latest[period] ?? "—"} hint={`기간 ${period}`} />
          <KpiCard label="활성 사용자" value={formatNumber(kpis.activeUsers)} hint={kpis.refreshDate ? `${kpis.refreshDate} 기준` : ""} />
          <KpiCard label="활성화 사용자" value={formatNumber(kpis.enabledUsers)} hint="Any app" />
          <KpiCard label="활성률" value={kpis.adoptionRate != null ? `${kpis.adoptionRate.toFixed(1)}%` : "—"} hint="활성/활성화" />
        </div>

        <Card title={`사용량 user detail (${period})`} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{snapshots.length}건</span>}>
          <DataTable<UsageSnapshotRow>
            rows={snapshots}
            rowKey={(row) => `${row.snapshot_date}-${row.user_id || row.upn || ""}-${row.display_name || ""}`}
            initialSort={{ key: "last_activity_overall", direction: "desc" }}
            columns={snapshotColumns}
            maxHeight="40vh"
          />
        </Card>

        <Card title={`${reportType === "summary" ? "Summary" : "Trend"} (${period})`} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{counts.length}건</span>}>
          <DataTable<UsageCountRow>
            rows={counts}
            rowKey={(row) => `${row.report_type}-${row.report_refresh_date}-${row.report_date ?? "summary"}-${row.period}`}
            initialSort={{ key: "report_date", direction: "desc" }}
            columns={countColumns}
            maxHeight="40vh"
          />
        </Card>

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 --web 으로 실행하세요.</div>
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

const snapshotColumns: Column<UsageSnapshotRow>[] = [
  { key: "snapshot_date", header: "스냅샷", cell: (r) => r.snapshot_date, sortValue: (r) => r.snapshot_date },
  { key: "display_name", header: "사용자", cell: (r) => r.display_name || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
  { key: "upn", header: "UPN", cell: (r) => r.upn || "—" },
  { key: "last_activity_overall", header: "최근 활동", cell: (r) => r.last_activity_overall || "—", sortValue: (r) => r.last_activity_overall ?? "" },
  { key: "last_activity_teams", header: "Teams", cell: (r) => r.last_activity_teams || "—" },
  { key: "last_activity_word", header: "Word", cell: (r) => r.last_activity_word || "—" },
  { key: "last_activity_excel", header: "Excel", cell: (r) => r.last_activity_excel || "—" },
  { key: "last_activity_powerpoint", header: "PowerPoint", cell: (r) => r.last_activity_powerpoint || "—" },
  { key: "last_activity_outlook", header: "Outlook", cell: (r) => r.last_activity_outlook || "—" },
  { key: "last_activity_bizchat", header: "BizChat", cell: (r) => r.last_activity_bizchat || "—" },
];

const countColumns: Column<UsageCountRow>[] = [
  { key: "report_refresh_date", header: "Refresh", cell: (r) => r.report_refresh_date, sortValue: (r) => r.report_refresh_date },
  { key: "report_date", header: "기간내 일자", cell: (r) => r.report_date ?? "(summary)", sortValue: (r) => r.report_date ?? "" },
  { key: "period", header: "기간", cell: (r) => r.period },
  { key: "any_app_active_users", header: "Active (Any)", align: "right", cell: (r) => formatNumber(r.any_app_active_users), sortValue: (r) => r.any_app_active_users ?? -1 },
  { key: "any_app_enabled_users", header: "Enabled (Any)", align: "right", cell: (r) => formatNumber(r.any_app_enabled_users) },
  { key: "teams_active_users", header: "Teams Active", align: "right", cell: (r) => formatNumber(r.teams_active_users) },
  { key: "word_active_users", header: "Word Active", align: "right", cell: (r) => formatNumber(r.word_active_users) },
  { key: "excel_active_users", header: "Excel Active", align: "right", cell: (r) => formatNumber(r.excel_active_users) },
  { key: "powerpoint_active_users", header: "PPT Active", align: "right", cell: (r) => formatNumber(r.powerpoint_active_users) },
  { key: "outlook_active_users", header: "Outlook Active", align: "right", cell: (r) => formatNumber(r.outlook_active_users) },
  { key: "copilot_chat_active_users", header: "Copilot Chat", align: "right", cell: (r) => formatNumber(r.copilot_chat_active_users) },
];

function deriveReportKpis(rows: UsageCountRow[]) {
  if (!rows.length) {
    return { activeUsers: 0, enabledUsers: 0, refreshDate: null as string | null, adoptionRate: null as number | null };
  }
  const latest = [...rows].sort((a, b) => (a.report_refresh_date < b.report_refresh_date ? 1 : -1))[0];
  const enabled = latest.any_app_enabled_users ?? 0;
  const active = latest.any_app_active_users ?? 0;
  return {
    activeUsers: active,
    enabledUsers: enabled,
    refreshDate: latest.report_refresh_date,
    adoptionRate: enabled > 0 ? (active / enabled) * 100 : null,
  };
}
