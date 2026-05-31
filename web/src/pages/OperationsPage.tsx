import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { KIND_LABELS, LiveLogPanel } from "../components/LiveLogPanel";
import { useToast } from "../components/Toast";
import {
  type AuditCollectionStateRow,
  type CollectionKind,
  type CollectionRun,
  type CollectionStatus,
  getAuditCollectionState,
  getCollectionStatus,
  getOperationsSummary,
  isBridgeAvailable,
  listRecentRuns,
  pingBridge,
  startCollection,
  stopCollection,
} from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";
import { useBridgeEvents } from "../lib/useBridgeEvents";

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function OperationsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const runsQuery = useQuery({ queryKey: ["ops-runs"], queryFn: () => listRecentRuns(50), enabled: BRIDGE_AVAILABLE });
  const auditStateQuery = useQuery({
    queryKey: ["ops-audit-state"],
    queryFn: getAuditCollectionState,
    enabled: BRIDGE_AVAILABLE,
  });
  const summaryQuery = useQuery({
    queryKey: ["ops-summary"],
    queryFn: getOperationsSummary,
    enabled: BRIDGE_AVAILABLE,
  });
  const statusQuery = useQuery({
    queryKey: ["ops-status"],
    queryFn: getCollectionStatus,
    enabled: BRIDGE_AVAILABLE,
    refetchInterval: 4000,
  });


  const runs = runsQuery.data ?? [];
  const auditState = auditStateQuery.data ?? [];
  const summary = summaryQuery.data;
  const status: CollectionStatus = statusQuery.data ?? { running: [] };
  const runningKinds = useMemo(() => new Set(status.running.map((row) => row.kind)), [status]);

  const { events, clear, paused, togglePause } = useBridgeEvents();
  const cycleSeenRef = useRef<Set<number>>(new Set());
  const errorSeenRef = useRef<Set<number>>(new Set());

  const [logKindFilter, setLogKindFilter] = useState<"" | CollectionKind | "system">("");
  const [logSearch, setLogSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [group, setGroup] = useState(true);
  const filteredEvents = useMemo(() => {
    const needle = logSearch.trim().toLowerCase();
    return events.filter((event) => {
      if (errorsOnly && event.type !== "error") return false;
      if (logKindFilter) {
        const kind = (event.payload?.kind as string | undefined) ?? "";
        if (logKindFilter === "system") {
          if (kind && kind !== "system") return false;
        } else if (kind !== logKindFilter) {
          return false;
        }
      }
      if (!needle) return true;
      const haystack = `${event.type} ${JSON.stringify(event.payload ?? {})}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [events, logKindFilter, logSearch, errorsOnly]);

  const progressByKind = useMemo(() => {
    const out = new Map<string, { percent: number; message: string }>();
    for (const e of events) {
      if (e.type === "progress") {
        const kind = String(e.payload?.kind ?? "conversation");
        out.set(kind, { percent: Number(e.payload?.percent ?? 0), message: String(e.payload?.message ?? "") });
      }
      if (e.type === "audit_progress") {
        const kind = String(e.payload?.kind ?? "audit");
        const fetched = Number(e.payload?.fetched ?? 0);
        out.set(kind, { percent: Math.min(100, fetched), message: `${e.payload?.source ?? ""} +${fetched}` });
      }
      if (e.type === "cycle_finished") {
        const kind = String(e.payload?.kind ?? "");
        if (kind) out.set(kind, { percent: 100, message: "완료" });
      }
      if (e.type === "cycle_started") {
        const kind = String(e.payload?.kind ?? "");
        if (kind) out.set(kind, { percent: 0, message: "시작" });
      }
    }
    return out;
  }, [events]);

  useEffect(() => {
    const finished = events.filter((e) => e.type === "cycle_finished");
    if (!finished.length) return;
    queryClient.invalidateQueries({ queryKey: ["ops-runs"] });
    queryClient.invalidateQueries({ queryKey: ["ops-audit-state"] });
    queryClient.invalidateQueries({ queryKey: ["ops-summary"] });
    queryClient.invalidateQueries({ queryKey: ["ops-status"] });
    const fresh = finished.filter((e) => !cycleSeenRef.current.has(e.id));
    if (!fresh.length) return;
    for (const ev of fresh) cycleSeenRef.current.add(ev.id);
    const last = fresh[fresh.length - 1];
    const payload = last.payload as Record<string, unknown>;
    const kind = (payload.kind as string | undefined) ?? "수집";
    const errors = Number(payload.errors ?? 0);
    toast.push(
      `${KIND_LABELS[kind as CollectionKind] ?? kind} 완료 (오류 ${errors})`,
      errors ? "warn" : "success",
    );
  }, [events, queryClient, toast]);

  useEffect(() => {
    const fresh = events.filter((e) => e.type === "error" && !errorSeenRef.current.has(e.id));
    if (!fresh.length) return;
    for (const ev of fresh) errorSeenRef.current.add(ev.id);
    const last = fresh[fresh.length - 1];
    toast.push(String(last.payload?.line ?? "수집 오류"), "danger", 6000);
  }, [events, toast]);

  async function runAction(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await action();
      if (!result.ok) {
        toast.push(`${label} 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
      } else {
        toast.push(`${label} 요청됨`, "success");
        queryClient.invalidateQueries({ queryKey: ["ops-status"] });
      }
    } catch (err) {
      toast.push(`${label} 예외: ${(err as Error).message}`, "danger");
    }
  }

  async function copyLog() {
    const text = events
      .map((e) => `[${e.at}] ${e.type} ${JSON.stringify(e.payload ?? {})}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.push("로그를 복사했습니다.", "success");
    } catch (err) {
      toast.push(`복사 실패: ${(err as Error).message}`, "danger");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KpiCard label="대상 사용자" value={formatNumber(summary?.users.total)} hint={`활성 30일 ${formatNumber(summary?.users.readiness.active_30d)}`} />
          <KpiCard label="수집 대화" value={formatNumber(summary?.interactions)} hint="누적" />
          <KpiCard label="스레드" value={formatNumber(summary?.threads)} hint="현재 인덱스" />
          <KpiCard
            label="진행 중"
            value={formatNumber(status.running.length)}
            hint={status.running.length ? status.running.map((r) => KIND_LABELS[r.kind] ?? r.kind).join(", ") : "없음"}
            tone={status.running.length ? "positive" : "neutral"}
          />
        </div>

        <Card title="수집 작업" actions={
          <button
            type="button"
            onClick={() => runAction("테스트 핀", () => pingBridge())}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              background: "var(--surface)",
              color: "var(--text-soft)",
              border: "1px solid var(--border)",
              fontSize: 12,
              cursor: "pointer",
            }}
            title="라이브 로그 채널이 쓰이는지 테스트 이벤트를 쇏습니다."
          >
            테스트 핀
          </button>
        }>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            {(Object.entries(KIND_LABELS) as Array<[CollectionKind, string]>).map(([kind, label]) => {
              const running = runningKinds.has(kind);
              const progress = progressByKind.get(kind);
              return (
                <CollectionTile
                  key={kind}
                  label={label}
                  running={running}
                  progress={progress}
                  onStart={() => runAction(`${label} 시작`, () => startCollection(kind))}
                  onStop={() => runAction(`${label} 중단`, () => stopCollection(kind))}
                />
              );
            })}
          </div>
        </Card>

        <Card title="실시간 로그">
          <LiveLogPanel
            events={filteredEvents}
            onClear={clear}
            onCopy={copyLog}
            paused={paused}
            onTogglePause={togglePause}
            group={group}
            onToggleGroup={() => setGroup((v) => !v)}
            kindFilter={logKindFilter}
            onKindFilterChange={setLogKindFilter}
            search={logSearch}
            onSearchChange={setLogSearch}
            errorsOnly={errorsOnly}
            onErrorsOnlyChange={setErrorsOnly}
            totalCount={events.length}
            filteredCount={filteredEvents.length}
          />
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, minHeight: 0 }}>
          <Card title="수집 이력" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{runs.length}건</span>}>
            <DataTable<CollectionRun>
              rows={runs}
              rowKey={(row) => String(row.id)}
              initialSort={{ key: "started_at", direction: "desc" }}
              columns={runColumns}
              maxHeight="45vh"
            />
          </Card>
          <Card title="감사 수집 상태">
            <DataTable<AuditCollectionStateRow>
              rows={auditState}
              rowKey={(row) => row.source}
              columns={auditStateColumns}
              maxHeight="45vh"
            />
          </Card>
        </div>

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 실행하세요.</div>
        )}
      </section>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "white",
  border: 0,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  fontWeight: 500,
};

function CollectionTile({
  label,
  running,
  progress,
  onStart,
  onStop,
}: {
  label: string;
  running: boolean;
  progress?: { percent: number; message: string };
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 12,
        background: "var(--surface-muted)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong>{label}</strong>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: running ? "var(--ok-soft)" : "var(--surface)",
            color: running ? "var(--ok)" : "var(--text-muted)",
            fontWeight: 600,
            border: "1px solid var(--border)",
          }}
        >
          {running ? "실행 중" : "대기"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={primaryButtonStyle} disabled={running} onClick={onStart}>
          시작
        </button>
        <button style={secondaryButtonStyle} disabled={!running} onClick={onStop}>
          중단
        </button>
      </div>
      {progress && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div
            style={{
              height: 4,
              borderRadius: 2,
              background: "var(--border)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.max(2, Math.min(100, progress.percent))}%`,
                height: "100%",
                background: progress.percent >= 100 ? "var(--ok)" : "var(--accent)",
                transition: "width 200ms ease",
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {progress.message}
          </div>
        </div>
      )}
    </div>
  );
}

const runColumns: Column<CollectionRun>[] = [
  { key: "id", header: "#", align: "right", cell: (r) => String(r.id), sortValue: (r) => r.id },
  { key: "trigger", header: "트리거", cell: (r) => r.trigger, sortValue: (r) => r.trigger },
  { key: "started_at", header: "시작", cell: (r) => formatKstDateTime(r.started_at), sortValue: (r) => r.started_at },
  { key: "finished_at", header: "종료", cell: (r) => (r.finished_at ? formatKstDateTime(r.finished_at) : "진행 중") },
  { key: "users_processed", header: "사용자", align: "right", cell: (r) => formatNumber(r.users_processed) },
  { key: "interactions_fetched", header: "대화", align: "right", cell: (r) => formatNumber(r.interactions_fetched) },
  {
    key: "errors_count",
    header: "오류",
    align: "right",
    cell: (r) => (
      <span style={{ color: r.errors_count ? "var(--danger)" : "var(--text)" }}>{formatNumber(r.errors_count)}</span>
    ),
    sortValue: (r) => r.errors_count,
  },
];

const auditStateColumns: Column<AuditCollectionStateRow>[] = [
  { key: "source", header: "소스", cell: (r) => r.source, sortValue: (r) => r.source },
  {
    key: "last_success",
    header: "최근 성공",
    cell: (r) => formatKstDateTime(r.last_success_at),
    sortValue: (r) => r.last_success_at ?? "",
  },
  { key: "last_record_count", header: "건수", align: "right", cell: (r) => formatNumber(r.last_record_count) },
  {
    key: "status",
    header: "상태",
    cell: (r) => {
      if (r.last_error) {
        return <span style={{ color: "var(--danger)" }}>오류</span>;
      }
      if (r.pending_query_id) {
        return <span style={{ color: "var(--warn)" }}>진행 중</span>;
      }
      return <span style={{ color: "var(--ok)" }}>정상</span>;
    },
  },
];

