import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { type AgentFilters, type AgentRow, isBridgeAvailable, listAgents } from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();
const THRESHOLDS = [7, 14, 30, 60, 90];

export function AgentsPage() {
  const [draft, setDraft] = useState<AgentFilters>({ threshold_days: 30, include_all: true, search: null });
  const [applied, setApplied] = useState<AgentFilters>(draft);

  const agentsQuery = useQuery({
    queryKey: ["agents-list", applied],
    queryFn: () => listAgents(applied),
    enabled: BRIDGE_AVAILABLE,
  });

  const agents = agentsQuery.data ?? [];
  const kpis = useMemo(() => deriveAgentKpis(agents), [agents]);

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
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>비활성 기준</label>
        <select
          value={draft.threshold_days ?? 30}
          onChange={(e) => setDraft({ ...draft, threshold_days: Number(e.target.value) })}
          style={fieldStyle}
        >
          {THRESHOLDS.map((d) => (
            <option key={d} value={d}>
              {d}일
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
          비활성/미사용만 보기
        </label>
        <input
          type="search"
          placeholder="이름 / 식별자 검색"
          value={draft.search ?? ""}
          onChange={(e) => setDraft({ ...draft, search: e.target.value || null })}
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
          <KpiCard label="총 에이전트" value={formatNumber(kpis.total)} hint={`사용 이벤트 ${formatNumber(kpis.usageEvents)}건`} />
          <KpiCard label="활성" value={formatNumber(kpis.active)} hint={`${kpis.thresholdDays}일 기준`} tone="positive" />
          <KpiCard label="비활성" value={formatNumber(kpis.stale)} hint={`기준 초과 ${kpis.thresholdDays}일`} tone="warn" />
          <KpiCard label="미사용" value={formatNumber(kpis.neverUsed)} hint="활동 기록 없음" tone="danger" />
        </div>
        <Card title="에이전트 활동" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{agents.length}건</span>}>
          <DataTable<AgentRow>
            rows={agents}
            rowKey={(row) => row.id}
            initialSort={{ key: "last_activity", direction: "desc" }}
            columns={agentColumns}
            maxHeight="55vh"
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

const STATE_LABEL: Record<AgentRow["state"], { label: string; bg: string; color: string }> = {
  active: { label: "활성", bg: "var(--ok-soft)", color: "var(--ok)" },
  stale: { label: "비활성", bg: "var(--warn-soft)", color: "var(--warn)" },
  never_used: { label: "미사용", bg: "var(--danger-soft)", color: "var(--danger)" },
};

const CONFIDENCE_HINT: Record<AgentRow["confidence"], string> = {
  ok: "감사 데이터로 확인됨",
  limited_audit_window: "감사 수집 범위가 짧아 판단 보류",
  no_audit_data: "감사 이벤트가 없어 판단 불가",
};

const agentColumns: Column<AgentRow>[] = [
  {
    key: "name",
    header: "에이전트",
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
    header: "출처",
    cell: (r) => r.source.replace("_", " "),
    sortValue: (r) => r.source,
  },
  {
    key: "state",
    header: "상태",
    cell: (r) => {
      const s = STATE_LABEL[r.state];
      return (
        <span
          title={CONFIDENCE_HINT[r.confidence]}
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
    header: "사용 이벤트",
    align: "right",
    cell: (r) => formatNumber(r.usage_event_count),
    sortValue: (r) => r.usage_event_count,
  },
  {
    key: "days_inactive",
    header: "비활성일",
    align: "right",
    cell: (r) => (r.days_inactive == null ? "—" : formatNumber(r.days_inactive)),
    sortValue: (r) => r.days_inactive ?? -1,
  },
  {
    key: "last_activity",
    header: "마지막 활동",
    cell: (r) => formatKstDateTime(r.last_activity_at),
    sortValue: (r) => r.last_activity_at ?? "",
  },
];

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
