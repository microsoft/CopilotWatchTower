import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import {
  type AdminDiagnosticRow,
  type AuditEventFilters,
  type AuditEventRow,
  type AuditSource,
  isBridgeAvailable,
  listAdminDiagnostics,
  listAuditEvents,
} from "../lib/bridge";
import { defaultDateRange, formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const SOURCES: Array<{ value: "" | AuditSource; label: string }> = [
  { value: "", label: "(전체 소스)" },
  { value: "purview", label: "Purview 감사" },
  { value: "entra_audit", label: "Entra 감사" },
  { value: "entra_signin", label: "Entra 로그인" },
];

export function SecurityPage() {
  const initialFilters: AuditEventFilters = useMemo(() => {
    const range = defaultDateRange();
    return { ...range, source: null, search: null, limit: 500 };
  }, []);
  const [draft, setDraft] = useState<AuditEventFilters>(initialFilters);
  const [applied, setApplied] = useState<AuditEventFilters>(initialFilters);
  const [selected, setSelected] = useState<AuditEventRow | null>(null);

  const eventsQuery = useQuery({
    queryKey: ["audit-events", applied],
    queryFn: () => listAuditEvents(applied),
    enabled: BRIDGE_AVAILABLE,
  });
  const diagnosticsQuery = useQuery({
    queryKey: ["admin-diagnostics"],
    queryFn: () => listAdminDiagnostics(),
    enabled: BRIDGE_AVAILABLE,
  });

  const events = eventsQuery.data ?? [];
  const diagnostics = diagnosticsQuery.data ?? [];
  const kpis = useMemo(() => deriveSecurityKpis(events), [events]);

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
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>소스</label>
        <select
          value={draft.source ?? ""}
          onChange={(e) => setDraft({ ...draft, source: (e.target.value || null) as AuditSource | null })}
          style={fieldStyle}
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.date_from ?? ""}
          onChange={(e) => setDraft({ ...draft, date_from: e.target.value || null })}
          style={fieldStyle}
        />
        <span>~</span>
        <input
          type="date"
          value={draft.date_to ?? ""}
          onChange={(e) => setDraft({ ...draft, date_to: e.target.value || null })}
          style={fieldStyle}
        />
        <input
          type="search"
          value={draft.search ?? ""}
          onChange={(e) => setDraft({ ...draft, search: e.target.value || null })}
          placeholder="사용자 / 작업 / 결과 / IP 검색"
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
          <KpiCard label="감사 이벤트" value={formatNumber(kpis.total)} hint="선택 범위" />
          <KpiCard label="차단/거부" value={formatNumber(kpis.blocked)} tone={kpis.blocked ? "danger" : "neutral"} hint="result=denied/blocked" />
          <KpiCard label="고유 사용자" value={formatNumber(kpis.uniqueUsers)} hint="upn 기준" />
          <KpiCard label="상위 작업" value={kpis.topOperation ?? "—"} hint={kpis.topOperation ? formatNumber(kpis.topOperationCount) + "건" : ""} />
        </div>

        <Card title="관리 진단" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{diagnostics.length}항목</span>}>
          <DataTable<AdminDiagnosticRow>
            rows={diagnostics}
            rowKey={(row) => row.key}
            columns={diagnosticColumns}
            initialSort={{ key: "label", direction: "asc" }}
            maxHeight={240}
          />
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, minHeight: 0 }}>
          <Card title="감사 이벤트" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{events.length}건</span>}>
            <DataTable<AuditEventRow>
              rows={events}
              rowKey={(row) => row.id}
              initialSort={{ key: "event_time", direction: "desc" }}
              columns={eventColumns(setSelected, selected?.id ?? null)}
              maxHeight="50vh"
            />
          </Card>
          <Card title={selected ? "이벤트 상세" : "선택된 이벤트 없음"}>
            {!selected && <div className="empty-state">왼쪽 표에서 이벤트를 선택하세요.</div>}
            {selected && <AuditEventDetail event={selected} />}
          </Card>
        </div>

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

const STATUS_TONE: Record<string, { color: string; bg: string }> = {
  ok: { color: "var(--ok)", bg: "var(--ok-soft)" },
  forbidden: { color: "var(--danger)", bg: "var(--danger-soft)" },
  not_found: { color: "var(--warn)", bg: "var(--warn-soft)" },
  error: { color: "var(--danger)", bg: "var(--danger-soft)" },
};

const diagnosticColumns: Column<AdminDiagnosticRow>[] = [
  { key: "label", header: "항목", cell: (r) => r.label, sortValue: (r) => r.label.toLowerCase() },
  { key: "endpoint", header: "엔드포인트", cell: (r) => r.endpoint },
  {
    key: "status",
    header: "상태",
    cell: (r) => {
      const tone = STATUS_TONE[r.status] ?? { color: "var(--text-muted)", bg: "var(--surface-muted)" };
      return (
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: tone.bg,
            color: tone.color,
            fontWeight: 600,
          }}
        >
          {r.status}
          {r.status_code != null ? ` ${r.status_code}` : ""}
        </span>
      );
    },
    sortValue: (r) => r.status,
  },
  { key: "summary", header: "요약", cell: (r) => r.summary || r.error || "—" },
  { key: "captured_at", header: "수집", cell: (r) => formatKstDateTime(r.captured_at), sortValue: (r) => r.captured_at },
];

function eventColumns(
  onSelect: (event: AuditEventRow) => void,
  selectedId: string | null,
): Column<AuditEventRow>[] {
  return [
    {
      key: "event_time",
      header: "시간",
      cell: (r) => formatKstDateTime(r.event_time),
      sortValue: (r) => r.event_time,
    },
    { key: "source", header: "소스", cell: (r) => r.source, sortValue: (r) => r.source },
    { key: "user", header: "사용자", cell: (r) => r.upn || r.user_id || "—", sortValue: (r) => (r.upn ?? r.user_id ?? "").toLowerCase() },
    { key: "operation", header: "작업", cell: (r) => r.operation || "—", sortValue: (r) => (r.operation ?? "").toLowerCase() },
    { key: "workload", header: "Workload", cell: (r) => r.workload || "—" },
    {
      key: "app",
      header: "앱",
      cell: (r) => r.app || "—",
      title: (r) => r.app_raw,
      sortValue: (r) => (r.app ?? "").toLowerCase(),
    },
    {
      key: "result",
      header: "결과",
      cell: (r) => {
        if (!r.result) return "—";
        const tone = r.result.toLowerCase().includes("success")
          ? { color: "var(--ok)", bg: "var(--ok-soft)" }
          : { color: "var(--warn)", bg: "var(--warn-soft)" };
        return (
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: tone.bg, color: tone.color, fontWeight: 600 }}>
            {r.result}
          </span>
        );
      },
      sortValue: (r) => r.result ?? "",
    },
    {
      key: "detail",
      header: "",
      cell: (r) => (
        <button
          type="button"
          onClick={() => onSelect(r)}
          style={{
            background: r.id === selectedId ? "var(--accent-soft)" : "transparent",
            color: "var(--accent-strong)",
            border: "1px solid var(--accent-soft)",
            borderRadius: 6,
            padding: "2px 8px",
            fontSize: 11,
          }}
        >
          상세
        </button>
      ),
    },
  ];
}

function AuditEventDetail({ event }: { event: AuditEventRow }) {
  let pretty = event.raw_json ?? "";
  if (pretty) {
    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {
      // leave raw if it's not valid JSON
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        <div><strong>{event.operation || "(operation)"}</strong></div>
        <div>{formatKstDateTime(event.event_time)}</div>
        <div>{event.upn || event.user_id || "—"}</div>
        {event.client_ip && <div>IP: {event.client_ip}</div>}
      </div>
      <pre
        style={{
          background: "var(--surface-muted)",
          padding: 10,
          borderRadius: 6,
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          maxHeight: "50vh",
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {pretty || "(raw_json 없음)"}
      </pre>
    </div>
  );
}

function deriveSecurityKpis(rows: AuditEventRow[]) {
  const total = rows.length;
  let blocked = 0;
  const users = new Set<string>();
  const operations = new Map<string, number>();
  for (const row of rows) {
    const result = (row.result ?? "").toLowerCase();
    const op = (row.operation ?? "").toLowerCase();
    if (result.includes("denied") || result.includes("blocked") || result === "failure" || op.includes("block") || op.includes("deny")) {
      blocked += 1;
    }
    if (row.upn) users.add(row.upn.toLowerCase());
    if (row.operation) {
      operations.set(row.operation, (operations.get(row.operation) ?? 0) + 1);
    }
  }
  const top = [...operations.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    blocked,
    uniqueUsers: users.size,
    topOperation: top?.[0] ?? null,
    topOperationCount: top?.[1] ?? 0,
  };
}
