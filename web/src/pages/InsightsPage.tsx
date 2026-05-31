import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function InsightsPage() {
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

  const usersQuery = useQuery({
    queryKey: ["users-in-scope"],
    queryFn: getUsersInScope,
    enabled,
  });
  const appsQuery = useQuery({
    queryKey: ["interaction-apps", appliedFilters.date_from, appliedFilters.date_to, appliedFilters.user_id],
    queryFn: () =>
      getInteractionApps({
        date_from: appliedFilters.date_from,
        date_to: appliedFilters.date_to,
        user_id: appliedFilters.user_id,
      }),
    enabled,
  });
  const overviewQuery = useQuery({
    queryKey: ["user-activity-overview", appliedFilters],
    queryFn: () => getUserActivityOverview(appliedFilters),
    enabled,
  });
  const dailyQuery = useQuery({
    queryKey: ["user-daily-activity", appliedFilters],
    queryFn: () => getUserDailyActivity(appliedFilters),
    enabled,
  });
  const appUsageQuery = useQuery({
    queryKey: ["user-daily-app-usage", appliedFilters],
    queryFn: () => getUserDailyAppUsage(appliedFilters),
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
            Python 브리지에 연결되어 있지 않습니다. 데스크톱 앱에서 <code>--web</code> 옵션으로 실행하거나, 개발 시 <code>COPILOT_WATCHTOWER_WEB_DEV_URL</code>을 설정하세요.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KpiCard label="활성 사용자" value={formatNumber(kpis.activeUsers)} hint={`대상 ${formatNumber(kpis.totalUsers)}명`} />
          <KpiCard label="스레드" value={formatNumber(kpis.threads)} hint="선택 범위" />
          <KpiCard label="메시지" value={formatNumber(kpis.messages)} hint={`프롬프트 ${formatNumber(kpis.prompts)}건`} />
          <KpiCard
            label="상위 앱"
            value={kpis.topApp ?? "—"}
            hint={kpis.topApp ? `${formatNumber(kpis.topAppMessages)} messages` : ""}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
          <Card title="날짜별 스레드 / 메시지">
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={dailyTrend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={11} />
                  <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="messages" name="메시지" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="threads" name="스레드" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="앱별 메시지">
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
                    formatter={(value: number) => [formatNumber(value), "메시지"]}
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

        <Card title="사용자 요약" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{overview.length}명</span>}>
          <DataTable<UserActivityOverviewRow>
            rows={overview}
            rowKey={(row) => row.user_id}
            initialSort={{ key: "messages", direction: "desc" }}
            columns={userColumns}
            maxHeight={360}
          />
        </Card>

        <Card title="일자별 상세" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{daily.length}행</span>}>
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

const userColumns: Column<UserActivityOverviewRow>[] = [
  { key: "name", header: "사용자", cell: (r) => r.display_name || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
  { key: "upn", header: "UPN", cell: (r) => r.upn || "—", sortValue: (r) => (r.upn ?? "").toLowerCase() },
  { key: "active_days", header: "활성일", align: "right", cell: (r) => formatNumber(r.active_days), sortValue: (r) => r.active_days },
  { key: "threads", header: "스레드", align: "right", cell: (r) => formatNumber(r.thread_count), sortValue: (r) => r.thread_count },
  { key: "messages", header: "메시지", align: "right", cell: (r) => formatNumber(r.message_count), sortValue: (r) => r.message_count },
  { key: "prompts", header: "프롬프트", align: "right", cell: (r) => formatNumber(r.prompt_count), sortValue: (r) => r.prompt_count },
  { key: "responses", header: "응답", align: "right", cell: (r) => formatNumber(r.response_count), sortValue: (r) => r.response_count },
  { key: "apps", header: "앱", align: "right", cell: (r) => formatNumber(r.app_count), sortValue: (r) => r.app_count },
  {
    key: "top_app",
    header: "상위 앱",
    cell: (r) => r.top_app || "—",
    sortValue: (r) => (r.top_app ?? "").toLowerCase(),
    title: (r) => r.top_app_raw || undefined,
  },
  {
    key: "last_seen",
    header: "마지막 활동",
    cell: (r) => formatKstDateTime(r.last_activity_at),
    sortValue: (r) => r.last_activity_at ?? "",
  },
];

const dailyColumns: Column<UserDailyActivityRow>[] = [
  { key: "day", header: "날짜", cell: (r) => r.day, sortValue: (r) => r.day },
  { key: "name", header: "사용자", cell: (r) => r.display_name || "—", sortValue: (r) => (r.display_name ?? "").toLowerCase() },
  { key: "upn", header: "UPN", cell: (r) => r.upn || "—", sortValue: (r) => (r.upn ?? "").toLowerCase() },
  { key: "threads", header: "스레드", align: "right", cell: (r) => formatNumber(r.thread_count), sortValue: (r) => r.thread_count },
  { key: "messages", header: "메시지", align: "right", cell: (r) => formatNumber(r.message_count), sortValue: (r) => r.message_count },
  { key: "prompts", header: "프롬프트", align: "right", cell: (r) => formatNumber(r.prompt_count), sortValue: (r) => r.prompt_count },
  { key: "responses", header: "응답", align: "right", cell: (r) => formatNumber(r.response_count), sortValue: (r) => r.response_count },
  { key: "apps", header: "앱", align: "right", cell: (r) => formatNumber(r.app_count), sortValue: (r) => r.app_count },
  {
    key: "top_app",
    header: "상위 앱",
    cell: (r) => r.top_app || "—",
    sortValue: (r) => (r.top_app ?? "").toLowerCase(),
    title: (r) => r.top_app_raw || undefined,
  },
];

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
