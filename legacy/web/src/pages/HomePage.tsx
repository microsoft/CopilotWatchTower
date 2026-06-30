import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Activity, AlertTriangle, Bot, Database, Info, MessageSquareText, UserMinus, Users } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "../components/Card";
import { KpiCard } from "../components/KpiCard";
import { LicenseBanner } from "../components/LicenseBanner";
import { CreditAlertBanner } from "../components/CreditAlertBanner";
import {
  type OperationsSummary,
  type UsageCountRow,
  type UserDailyAppUsageRow,
  getAdoptionInsights,
  getOperationsSummary,
  getUserDailyActivity,
  getUserDailyAppUsage,
  getUserActivityOverview,
  getUsagePeriodsSummary,
  isBridgeAvailable,
  listAuditEvents,
  listUsageCounts,
} from "../lib/bridge";
import { defaultDateRange, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function HomePage() {
  const { t } = useTranslation("home");
  const range = defaultDateRange();
  const overviewQuery = useQuery({
    queryKey: ["home-user-overview", range],
    queryFn: () => getUserActivityOverview({ ...range, limit: 500 }),
    enabled: BRIDGE_AVAILABLE,
  });
  const summaryQuery = useQuery({
    queryKey: ["home-summary"],
    queryFn: getOperationsSummary,
    enabled: BRIDGE_AVAILABLE,
  });
  const runsQuery = useQuery({
    queryKey: ["home-app-usage", range],
    queryFn: () => getUserDailyAppUsage({ ...range, limit: 5000 }),
    enabled: BRIDGE_AVAILABLE,
  });
  const dailyQuery = useQuery({
    queryKey: ["home-daily", range],
    queryFn: () => getUserDailyActivity({ ...range, limit: 2000 }),
    enabled: BRIDGE_AVAILABLE,
  });
  const periodsQuery = useQuery({
    queryKey: ["home-periods"],
    queryFn: getUsagePeriodsSummary,
    enabled: BRIDGE_AVAILABLE,
  });
  const usageQuery = useQuery({
    queryKey: ["home-usage-summary"],
    queryFn: () => listUsageCounts({ report_type: "summary", period: "D30" }),
    enabled: BRIDGE_AVAILABLE,
  });
  const blockedQuery = useQuery({
    queryKey: ["home-blocked"],
    queryFn: () => listAuditEvents({ date_from: range.date_from, date_to: range.date_to, search: null, limit: 1000 }),
    enabled: BRIDGE_AVAILABLE,
  });
  const adoptionQuery = useQuery({
    queryKey: ["home-adoption"],
    queryFn: () => getAdoptionInsights(30),
    enabled: BRIDGE_AVAILABLE,
  });

  const overview = overviewQuery.data ?? [];
  const daily = dailyQuery.data ?? [];
  const summary: OperationsSummary | undefined = summaryQuery.data;
  const appBreakdown = buildAppBreakdown(runsQuery.data ?? [], t("appUsage.otherApp"));
  const periodsLatest = (periodsQuery.data?.latest_snapshot_dates ?? {}) as Partial<
    Record<"D7" | "D30" | "D90" | "D180", string | null>
  >;
  const usage: UsageCountRow | undefined = usageQuery.data?.[0];
  const blocked = (blockedQuery.data ?? []).filter((e) => {
    const result = (e.result ?? "").toLowerCase();
    return result.includes("denied") || result.includes("blocked") || result === "failure";
  });

  const activeUsers = overview.filter((row) => row.message_count > 0).length;
  const totalMessages = overview.reduce((s, row) => s + row.message_count, 0);
  const totalThreads = overview.reduce((s, row) => s + row.thread_count, 0);
  const topUsers = [...overview].sort((a, b) => b.message_count - a.message_count).slice(0, 5);
  const trend = buildTrend(daily);

  const adoption = adoptionQuery.data?.adoption;
  const sessions = adoptionQuery.data?.sessions;
  const adoptionRatePct = adoption ? Math.round(adoption.adoption_rate * 100) : null;

  return (
    <div className="dashboard-page">
      <LicenseBanner />
      <CreditAlertBanner />
      <div className="dashboard-kpis">
        <KpiCard label={t("kpi.activeUsers")} value={formatNumber(activeUsers)} hint={t("kpi.activeUsersHint", { n: formatNumber(summary?.users.total) })} tone="positive" icon={<Users size={21} />} />
        <KpiCard label={t("kpi.totalTurns")} value={formatNumber(totalMessages)} hint={t("kpi.totalTurnsHint", { n: formatNumber(totalThreads) })} icon={<MessageSquareText size={21} />} />
        <KpiCard label={t("kpi.meaningfulInteractions")} value={formatNumber(sessions?.sessions)} hint={t("kpi.meaningfulInteractionsHint", { n: formatNumber(sessions?.prompts) })} tone="positive" icon={<Activity size={21} />} />
        <KpiCard
          label={t("kpi.licenseInactive")}
          value={formatNumber(adoption?.inactive)}
          hint={adoptionRatePct === null ? t("kpi.licenseInactiveHintBase") : t("kpi.licenseInactiveHintRate", { rate: adoptionRatePct, n: formatNumber(adoption?.licensed_total) })}
          tone={adoption && adoption.inactive > 0 ? "danger" : "neutral"}
          icon={<UserMinus size={21} />}
        />
        <KpiCard label={t("kpi.apiConversations")} value={formatNumber(summary?.interactions)} hint={t("kpi.apiConversationsHint", { n: formatNumber(summary?.threads) })} icon={<Database size={21} />} />
        <KpiCard label={t("kpi.riskSignals")} value={formatNumber(blocked.length)} tone={blocked.length ? "danger" : "neutral"} hint={t("kpi.riskSignalsHint")} icon={<AlertTriangle size={21} />} />
      </div>

      <div className="dashboard-main-grid">
        <Card title={t("charts.usageTrendTitle")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("charts.last30Days")}</span>}>
          <div className="chart-wrap">
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 12, right: 24, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={11} />
                <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "var(--border)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="messages" name={t("charts.legend.turns")} stroke="var(--accent)" strokeWidth={2.2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="threads" name={t("charts.legend.threads")} stroke="var(--teal)" strokeWidth={2.2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="prompts" name={t("charts.legend.prompts")} stroke="var(--violet)" strokeWidth={2.2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="dashboard-bottom-grid">
        <Card title={t("topUsers.title")} actions={<Bot size={16} color="var(--accent)" />}>
          <ul className="rank-list">
            {topUsers.length === 0 && <li className="empty-state">{t("topUsers.empty")}</li>}
            {topUsers.map((user, index) => {
              const max = Math.max(...topUsers.map((row) => row.message_count), 1);
              return (
                <li className="rank-item" key={user.user_id}>
                  <span className="rank-index">{index + 1}</span>
                  <span>
                    <strong>{user.display_name || user.upn || user.user_id}</strong>
                    <div className="rank-meter"><div className="rank-meter-fill" style={{ width: `${Math.round((user.message_count / max) * 100)}%` }} /></div>
                  </span>
                  <span className="tabular">{formatNumber(user.message_count)}</span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title={t("appUsage.title")} actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("appUsage.subtitle")}</span>}>
          <ul className="rank-list">
            {appBreakdown.length === 0 && <li className="empty-state">{t("appUsage.empty")}</li>}
            {appBreakdown.map((item, index) => {
              const max = Math.max(...appBreakdown.map((row) => row.messages), 1);
              return (
                <li className="rank-item" key={item.app}>
                  <span className="rank-index">{index + 1}</span>
                  <span>
                    <strong>{item.app}</strong>
                    <div className="rank-meter"><div className="rank-meter-fill" style={{ width: `${Math.round((item.messages / max) * 100)}%` }} /></div>
                  </span>
                  <span className="tabular">{formatNumber(item.messages)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title={t("report.title")}>
        {!usage && <div className="empty-state">{t("report.empty")}</div>}
        {usage && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13 }}>
            <span>{t("report.activeUsersLabel")} <strong>{formatNumber(usage.any_app_active_users)}</strong> / {t("report.enabledCount", { n: formatNumber(usage.any_app_enabled_users) })}</span>
            <span style={{ color: "var(--text-muted)" }}>Refresh: {usage.report_refresh_date}</span>
            <span style={{ color: "var(--text-muted)" }}>{t("report.snapshot", { d7: periodsLatest.D7 ?? "—", d30: periodsLatest.D30 ?? "—", d90: periodsLatest.D90 ?? "—" })}</span>
          </div>
        )}
      </Card>

      {!BRIDGE_AVAILABLE && <div className="empty-state">{t("bridge.notConnected")}</div>}

      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 14px", fontSize: 11, color: "var(--text-muted)" }}>
        <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{t("footer.note")}</span>
      </div>
    </div>
  );
}

function buildTrend(rows: Array<{ day: string; message_count: number; thread_count: number; prompt_count: number }>) {
  const byDay = new Map<string, { day: string; messages: number; threads: number; prompts: number }>();
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? { day: row.day.slice(5), messages: 0, threads: 0, prompts: 0 };
    bucket.messages += row.message_count;
    bucket.threads += row.thread_count;
    bucket.prompts += row.prompt_count;
    byDay.set(row.day, bucket);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function buildAppBreakdown(rows: UserDailyAppUsageRow[], otherLabel: string) {
  const byApp = new Map<string, number>();
  for (const row of rows) {
    const app = row.app || otherLabel;
    byApp.set(app, (byApp.get(app) ?? 0) + row.message_count);
  }
  return [...byApp.entries()]
    .map(([app, messages]) => ({ app, messages }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 6);
}
