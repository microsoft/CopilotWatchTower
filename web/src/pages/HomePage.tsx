import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Bot, Database, MessageSquareText, Users } from "lucide-react";
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
import {
  type CollectionRun,
  type OperationsSummary,
  type UsageCountRow,
  getOperationsSummary,
  getUserDailyActivity,
  getUserActivityOverview,
  getUsagePeriodsSummary,
  isBridgeAvailable,
  listRecentRuns,
  listAuditEvents,
  listUsageCounts,
} from "../lib/bridge";
import { defaultDateRange, formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function HomePage() {
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
  const runsQuery = useQuery({ queryKey: ["home-runs"], queryFn: () => listRecentRuns(8), enabled: BRIDGE_AVAILABLE });
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

  const overview = overviewQuery.data ?? [];
  const daily = dailyQuery.data ?? [];
  const summary: OperationsSummary | undefined = summaryQuery.data;
  const runs = runsQuery.data ?? [];
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
  const recentActivity = runs.slice(0, 6);

  return (
    <div className="dashboard-page">
      <div className="dashboard-kpis">
        <KpiCard label="활성 사용자" value={formatNumber(activeUsers)} hint={`대상 ${formatNumber(summary?.users.total)}명`} tone="positive" icon={<Users size={21} />} />
        <KpiCard label="총 턴" value={formatNumber(totalMessages)} hint={`스레드 ${formatNumber(totalThreads)}건`} icon={<MessageSquareText size={21} />} />
        <KpiCard label="API 대화" value={formatNumber(summary?.interactions)} hint={`스레드 ${formatNumber(summary?.threads)}`} icon={<Database size={21} />} />
        <KpiCard label="위험 신호" value={formatNumber(blocked.length)} tone={blocked.length ? "danger" : "neutral"} hint="차단/거부/실패" icon={<AlertTriangle size={21} />} />
      </div>

      <div className="dashboard-main-grid">
        <Card title="Copilot 사용 추이" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>최근 30일</span>}>
          <div className="chart-wrap">
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 12, right: 24, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={11} />
                <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "var(--border)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="messages" name="턴" stroke="var(--accent)" strokeWidth={2.2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="threads" name="스레드" stroke="var(--teal)" strokeWidth={2.2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="prompts" name="프롬프트" stroke="var(--violet)" strokeWidth={2.2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="dashboard-bottom-grid">
        <Card title="상위 사용자 TOP 5" actions={<Bot size={16} color="var(--accent)" />}>
          <ul className="rank-list">
            {topUsers.length === 0 && <li className="empty-state">표시할 사용자가 없습니다.</li>}
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

        <Card title="최근 활동" actions={<Activity size={16} color="var(--accent)" />}>
          <ul className="activity-list">
            {recentActivity.length === 0 && <li className="empty-state">최근 수집 이력이 없습니다.</li>}
            {recentActivity.map((run: CollectionRun) => (
              <li className="activity-item" key={run.id}>
                <span>
                  <strong>{run.trigger}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{formatKstDateTime(run.started_at)}</div>
                </span>
                <span className={`status-badge ${run.errors_count ? "warn" : "ok"}`}>{run.errors_count ? "확인" : "성공"}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="공식 보고서 (D30)">
        {!usage && <div className="empty-state">집계 결과가 없습니다.</div>}
        {usage && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13 }}>
            <span>활성 사용자 <strong>{formatNumber(usage.any_app_active_users)}</strong> / 활성화 {formatNumber(usage.any_app_enabled_users)}</span>
            <span style={{ color: "var(--text-muted)" }}>Refresh: {usage.report_refresh_date}</span>
            <span style={{ color: "var(--text-muted)" }}>스냅샷: D7 {periodsLatest.D7 ?? "—"} · D30 {periodsLatest.D30 ?? "—"} · D90 {periodsLatest.D90 ?? "—"}</span>
          </div>
        )}
      </Card>

      {!BRIDGE_AVAILABLE && <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 --web 으로 실행하세요.</div>}
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
