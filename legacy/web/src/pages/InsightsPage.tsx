import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from "recharts";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { FilterBar } from "../components/FilterBar";
import { KpiCard } from "../components/KpiCard";
import {
  type AnalyticsFilters,
  getInteractionApps,
  getUserActivityOverview,
  getUserDailyActivity,
  getUserDailyAppUsage,
  getUsersInScope,
  isBridgeAvailable,
  type UserActivityOverviewRow,
  type UserDailyActivityRow,
  type UserDailyAppUsageRow,
} from "../lib/bridge";
import { defaultDateRange, formatKstDateTime, formatNumber } from "../lib/format";
import { useCapabilities } from "../lib/CapabilityContext";

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function InsightsPage() {
  const { t } = useTranslation("insights");
  const initialFilters: AnalyticsFilters = useMemo(() => {
    const range = defaultDateRange();
    return {
      date_from: range.date_from,
      date_to: range.date_to,
      user_id: null,
      app: null,
      search: null,
    };
  }, []);

  const [draftFilters, setDraftFilters] = useState<AnalyticsFilters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<AnalyticsFilters>(initialFilters);

  const enabled = BRIDGE_AVAILABLE;

  // Source routing: tenants without Copilot seats have no Graph API
  // interactions, so their analytics are based on e-Discovery capture instead.
  const { profile, isConfigured } = useCapabilities();
  const insightsSource = isConfigured && !profile.copilot_seats ? "ediscovery" : null;
  const scopedFilters: AnalyticsFilters = useMemo(
    () => ({ ...appliedFilters, source_type: insightsSource }),
    [appliedFilters, insightsSource],
  );
  const usersQuery = useQuery({
    queryKey: ["users-in-scope"],
    queryFn: getUsersInScope,
    enabled,
  });
  const appsQuery = useQuery({
    queryKey: ["interaction-apps", appliedFilters.date_from, appliedFilters.date_to, appliedFilters.user_id, insightsSource],
    queryFn: () =>
      getInteractionApps({
        date_from: appliedFilters.date_from,
        date_to: appliedFilters.date_to,
        user_id: appliedFilters.user_id,
        source_type: insightsSource,
      }),
    enabled,
  });
  const overviewQuery = useQuery({
    queryKey: ["user-activity-overview", scopedFilters],
    queryFn: () => getUserActivityOverview(scopedFilters),
    enabled,
  });
  const dailyQuery = useQuery({
    queryKey: ["user-daily-activity", scopedFilters],
    queryFn: () => getUserDailyActivity(scopedFilters),
    enabled,
  });
  const appUsageQuery = useQuery({
    queryKey: ["user-daily-app-usage", scopedFilters],
    queryFn: () => getUserDailyAppUsage(scopedFilters),
    enabled,
  });

  useEffect(() => {
    setDraftFilters(appliedFilters);
  }, [appliedFilters]);

  const overview = overviewQuery.data ?? [];
  const daily = dailyQuery.data ?? [];
  const appUsage = appUsageQuery.data ?? [];

  const kpis = useMemo(() => deriveKpis(overview, appUsage), [overview, appUsage]);
  const dailyTrend = useMemo(() => buildDailyTrend(daily), [daily]);
  const appBars = useMemo(() => buildAppBars(appUsage), [appUsage]);
  const userColumns = useMemo(() => buildUserColumns(t), [t]);
  const dailyColumns = useMemo(() => buildDailyColumns(t), [t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <FilterBar
        filters={draftFilters}
        onChange={setDraftFilters}
        onSubmit={() => setAppliedFilters(draftFilters)}
        onReset={() => {
          const next = { ...initialFilters };
          setDraftFilters(next);
          setAppliedFilters(next);
        }}
        users={usersQuery.data ?? []}
        apps={appsQuery.data ?? []}
      />
      <section style={{ padding: "18px 24px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        {!BRIDGE_AVAILABLE && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "var(--warn-soft)",
              color: "var(--warn)",
              fontSize: 12,
            }}
          >
            {t("bridge.offlineBefore")}<code>--web</code>{t("bridge.offlineMiddle")}<code>COPILOT_WATCHTOWER_WEB_DEV_URL</code>{t("bridge.offlineAfter")}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KpiCard label={t("kpi.activeUsers")} value={formatNumber(kpis.activeUsers)} hint={t("kpi.activeUsersHint", { n: formatNumber(kpis.totalUsers) })} />
          <KpiCard label={t("kpi.threads")} value={formatNumber(kpis.threads)} hint={t("kpi.threadsHint")} />
          <KpiCard label={t("kpi.messages")} value={formatNumber(kpis.messages)} hint={t("kpi.messagesHint", { n: formatNumber(kpis.prompts) })} />
          <KpiCard
            label={t("kpi.topApp")}
            value={kpis.topApp ?? "—"}
            hint={kpis.topApp ? `${formatNumber(kpis.topAppMessages)} messages` : ""}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
          <Card title={t("charts.dailyTitle")}>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={dailyTrend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={11} />
                  <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="messages" name={t("charts.messagesSeries")} stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="threads" name={t("charts.threadsSeries")} stroke="#0ea5e9" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title={t("charts.appMessagesTitle")}>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={appBars} layout="vertical" margin={{ top: 4, right: 16, left: 16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    stroke="var(--text-muted)"
                    fontSize={11}
                    width={120}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    formatter={(value: number) => [formatNumber(value), t("charts.messagesSeries")]}
                    labelFormatter={(label: string, payload) => {
                      const raw = payload?.[0]?.payload?.raw;
                      return raw ? `${label} (${raw})` : label;
                    }}
                  />
                  <Bar dataKey="messages" fill="#2563eb" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        <Card title={t("tables.userSummaryTitle")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("tables.userCount", { n: overview.length })}</span>}>
          <DataTable<UserActivityOverviewRow>
            rows={overview}
            rowKey={(row) => row.user_id}
            initialSort={{ key: "messages", direction: "desc" }}
            columns={userColumns}
            maxHeight={360}
          />
        </Card>

        <Card title={t("tables.dailyDetailTitle")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("tables.rowCount", { n: daily.length })}</span>}>
          <DataTable<UserDailyActivityRow>
            rows={daily}
            rowKey={(row) => `${row.user_id}-${row.day}`}
            initialSort={{ key: "day", direction: "desc" }}
            columns={dailyColumns}
            maxHeight={420}
          />
        </Card>
      </section>
    </div>
  );
}

function buildUserColumns(t: TFunction): Column<UserActivityOverviewRow>[] {
  return [
    { key: "name", header: t("columns.user"), cell: (r) => r.display_name || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
    { key: "upn", header: "UPN", cell: (r) => r.upn || "—", sortValue: (r) => (r.upn ?? "").toLowerCase() },
    { key: "active_days", header: t("columns.activeDays"), align: "right", cell: (r) => formatNumber(r.active_days), sortValue: (r) => r.active_days },
    { key: "threads", header: t("columns.threads"), align: "right", cell: (r) => formatNumber(r.thread_count), sortValue: (r) => r.thread_count },
    { key: "messages", header: t("columns.messages"), align: "right", cell: (r) => formatNumber(r.message_count), sortValue: (r) => r.message_count },
    { key: "prompts", header: t("columns.prompts"), align: "right", cell: (r) => formatNumber(r.prompt_count), sortValue: (r) => r.prompt_count },
    { key: "responses", header: t("columns.responses"), align: "right", cell: (r) => formatNumber(r.response_count), sortValue: (r) => r.response_count },
    { key: "apps", header: t("columns.apps"), align: "right", cell: (r) => formatNumber(r.app_count), sortValue: (r) => r.app_count },
    {
      key: "top_app",
      header: t("columns.topApp"),
      cell: (r) => r.top_app || "—",
      sortValue: (r) => (r.top_app ?? "").toLowerCase(),
      title: (r) => r.top_app_raw || undefined,
    },
    {
      key: "last_seen",
      header: t("columns.lastActivity"),
      cell: (r) => formatKstDateTime(r.last_activity_at),
      sortValue: (r) => r.last_activity_at ?? "",
    },
  ];
}

function buildDailyColumns(t: TFunction): Column<UserDailyActivityRow>[] {
  return [
    { key: "day", header: t("columns.date"), cell: (r) => r.day, sortValue: (r) => r.day },
    { key: "name", header: t("columns.user"), cell: (r) => r.display_name || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
    { key: "upn", header: "UPN", cell: (r) => r.upn || "—", sortValue: (r) => (r.upn ?? "").toLowerCase() },
    { key: "threads", header: t("columns.threads"), align: "right", cell: (r) => formatNumber(r.thread_count), sortValue: (r) => r.thread_count },
    { key: "messages", header: t("columns.messages"), align: "right", cell: (r) => formatNumber(r.message_count), sortValue: (r) => r.message_count },
    { key: "prompts", header: t("columns.prompts"), align: "right", cell: (r) => formatNumber(r.prompt_count), sortValue: (r) => r.prompt_count },
    { key: "responses", header: t("columns.responses"), align: "right", cell: (r) => formatNumber(r.response_count), sortValue: (r) => r.response_count },
    { key: "apps", header: t("columns.apps"), align: "right", cell: (r) => formatNumber(r.app_count), sortValue: (r) => r.app_count },
    {
      key: "top_app",
      header: t("columns.topApp"),
      cell: (r) => r.top_app || "—",
      sortValue: (r) => (r.top_app ?? "").toLowerCase(),
      title: (r) => r.top_app_raw || undefined,
    },
  ];
}

function deriveKpis(
  overview: UserActivityOverviewRow[],
  appUsage: UserDailyAppUsageRow[],
): { activeUsers: number; totalUsers: number; threads: number; messages: number; prompts: number; topApp: string | null; topAppMessages: number } {
  const totalUsers = overview.length;
  const activeUsers = overview.reduce((acc, row) => acc + (row.message_count > 0 ? 1 : 0), 0);
  const threads = overview.reduce((acc, row) => acc + row.thread_count, 0);
  const messages = overview.reduce((acc, row) => acc + row.message_count, 0);
  const prompts = overview.reduce((acc, row) => acc + row.prompt_count, 0);

  const totals = new Map<string, { label: string; messages: number }>();
  for (const row of appUsage) {
    const label = row.app || "(unknown)";
    const bucket = totals.get(label) ?? { label, messages: 0 };
    bucket.messages += row.message_count;
    totals.set(label, bucket);
  }
  const top = [...totals.values()].sort((a, b) => b.messages - a.messages)[0];
  return {
    activeUsers,
    totalUsers,
    threads,
    messages,
    prompts,
    topApp: top?.label ?? null,
    topAppMessages: top?.messages ?? 0,
  };
}

function buildDailyTrend(rows: UserDailyActivityRow[]): Array<{ day: string; messages: number; threads: number }> {
  const buckets = new Map<string, { messages: number; threads: number }>();
  for (const row of rows) {
    const entry = buckets.get(row.day) ?? { messages: 0, threads: 0 };
    entry.messages += row.message_count;
    entry.threads += row.thread_count;
    buckets.set(row.day, entry);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, value]) => ({ day, ...value }));
}

function buildAppBars(rows: UserDailyAppUsageRow[]): Array<{ label: string; raw: string; messages: number }> {
  const totals = new Map<string, { label: string; raw: string; messages: number }>();
  for (const row of rows) {
    const label = row.app || "(unknown)";
    const bucket = totals.get(label) ?? { label, raw: row.app_raw || "", messages: 0 };
    bucket.messages += row.message_count;
    totals.set(label, bucket);
  }
  return [...totals.values()].sort((a, b) => b.messages - a.messages).slice(0, 10);
}
