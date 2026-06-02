import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { type AgentFilters, type AgentRow, isBridgeAvailable, listAgents, openExternalUrl } from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();
const THRESHOLDS = [7, 14, 30, 60, 90];

export function AgentsPage() {
  const [draft, setDraft] = useState<AgentFilters>({ threshold_days: 30, include_all: true, search: null });
  const [applied, setApplied] = useState<AgentFilters>(draft);
  const [selected, setSelected] = useState<AgentRow | null>(null);

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
            onRowClick={(row) => setSelected(row)}
            selectedRowKey={selected?.id ?? null}
          />
        </Card>
        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 --web 으로 실행하세요.</div>
        )}
      </section>
      {selected && <AgentDetailDrawer agent={selected} onClose={() => setSelected(null)} />}
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
  {
    key: "open",
    header: "",
    align: "right",
    cell: (r) => (
      <button
        type="button"
        title="M365 관리 센터에서 열기"
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

const RAW_FIELD_LABELS: Array<{ keys: string[]; label: string }> = [
  { keys: ["publisherName", "publisher", "developerName", "PublisherName"], label: "게시자" },
  { keys: ["description", "shortDescription", "Description"], label: "설명" },
  { keys: ["version", "appVersion", "Version"], label: "버전" },
  { keys: ["distributionMethod", "DistributionMethod"], label: "배포 방식" },
  { keys: ["categories", "Categories"], label: "범주" },
];

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
  const raw = useMemo(() => parseRawAgent(agent.raw_json), [agent.raw_json]);
  const rawFields = RAW_FIELD_LABELS.map((f) => ({ label: f.label, value: pickRawValue(raw, f.keys) })).filter(
    (f) => f.value != null,
  );
  const state = STATE_LABEL[agent.state];

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
            title="닫기"
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
            M365 관리 센터에서 열기
          </button>

          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <DetailItem label="사용 이벤트" value={formatNumber(agent.usage_event_count)} />
            <DetailItem label="비활성일" value={agent.days_inactive == null ? "—" : `${formatNumber(agent.days_inactive)}일`} />
            <DetailItem label="마지막 활동" value={formatKstDateTime(agent.last_activity_at)} />
            <DetailItem label="활동 출처" value={agent.last_activity_source || "—"} />
            <DetailItem label="상태값" value={agent.status || "—"} />
            <DetailItem label="판정 근거" value={CONFIDENCE_HINT[agent.confidence]} />
          </section>

          {rawFields.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>카탈로그 정보</div>
              {rawFields.map((f) => (
                <DetailItem key={f.label} label={f.label} value={f.value as string} />
              ))}
            </section>
          )}

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>식별자</div>
            <DetailItem label="App Identity" value={agent.app_identity || "—"} mono />
            <DetailItem label="App External ID" value={agent.app_external_id || "—"} mono />
            <DetailItem label="Add-on GUID" value={agent.add_on_guid || "—"} mono />
            <DetailItem label="내부 ID" value={agent.id} mono />
          </section>

          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <DetailItem label="생성일" value={formatKstDateTime(agent.created_at)} />
            <DetailItem label="수정일" value={formatKstDateTime(agent.updated_at)} />
            <DetailItem label="감사 수집 시작" value={formatKstDateTime(agent.audit_coverage_start)} />
            <DetailItem label="감사 수집 종료" value={formatKstDateTime(agent.audit_coverage_end)} />
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
