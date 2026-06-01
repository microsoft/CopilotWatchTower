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
  startCollection,
  stopCollection,
} from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";
import { useBridgeEvents } from "../lib/useBridgeEvents";

const BRIDGE_AVAILABLE = isBridgeAvailable();

interface KindConfig {
  showRuns: boolean;
  showAuditState: boolean;
  description: string;
}

const KIND_CONFIG: Record<CollectionKind, KindConfig> = {
  conversation: {
    showRuns: true,
    showAuditState: false,
    description: "Graph API로 사용자 Copilot 대화를 수집하고 스레드로 인덱싱합니다.",
  },
  audit: {
    showRuns: false,
    showAuditState: true,
    description: "Purview·Entra 감사 로그에서 보안·접근 이벤트를 수집합니다.",
  },
  usage: {
    showRuns: false,
    showAuditState: false,
    description: "Microsoft 365 Copilot 공식 사용량 보고서 스냅샷을 수집합니다.",
  },
  diagnostics: {
    showRuns: false,
    showAuditState: false,
    description: "Copilot 관리 API(에이전트 등록·카탈로그)와 감사 로그에서 에이전트 인벤토리와 사용 신호를 수집합니다.",
  },
  consumption: {
    showRuns: false,
    showAuditState: false,
    description: "PPAC 자동 로그인으로 Copilot Studio 메시지·AI Builder 크레딧·Power Platform 요청 소비량 리포트를 내려받습니다. 수집한 데이터는 비용/소비량 화면에서 확인합니다.",
  },
};

export function CollectionPage({ kind }: { kind: CollectionKind }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const config = KIND_CONFIG[kind];
  const label = KIND_LABELS[kind];

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
  const runsQuery = useQuery({
    queryKey: ["ops-runs"],
    queryFn: () => listRecentRuns(50),
    enabled: BRIDGE_AVAILABLE && config.showRuns,
  });
  const auditStateQuery = useQuery({
    queryKey: ["ops-audit-state"],
    queryFn: getAuditCollectionState,
    enabled: BRIDGE_AVAILABLE && config.showAuditState,
  });

  const summary = summaryQuery.data;
  const status: CollectionStatus = statusQuery.data ?? { running: [] };
  const runs = runsQuery.data ?? [];
  const auditState = auditStateQuery.data ?? [];
  const running = useMemo(() => status.running.some((row) => row.kind === kind), [status, kind]);

  const { events, clear, paused, togglePause } = useBridgeEvents();
  const cycleSeenRef = useRef<Set<number>>(new Set());
  const errorSeenRef = useRef<Set<number>>(new Set());

  const [logSearch, setLogSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [group, setGroup] = useState(true);

  // Events for this collection kind (plus system events for context).
  const kindEvents = useMemo(
    () =>
      events.filter((event) => {
        const eventKind = (event.payload?.kind as string | undefined) ?? "";
        if (!eventKind || eventKind === "system") return event.type === "error" || event.type === "log";
        return eventKind === kind;
      }),
    [events, kind],
  );
  const filteredEvents = useMemo(() => {
    const needle = logSearch.trim().toLowerCase();
    return kindEvents.filter((event) => {
      if (errorsOnly && event.type !== "error") return false;
      if (!needle) return true;
      const haystack = `${event.type} ${JSON.stringify(event.payload ?? {})}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [kindEvents, logSearch, errorsOnly]);

  const progress = useMemo(() => {
    let current: { percent: number; message: string } | undefined;
    for (const e of events) {
      const eventKind = String(e.payload?.kind ?? (e.type === "audit_progress" ? "audit" : "conversation"));
      if (eventKind !== kind) continue;
      if (e.type === "progress") {
        current = { percent: Number(e.payload?.percent ?? 0), message: String(e.payload?.message ?? "") };
      } else if (e.type === "audit_progress") {
        const fetched = Number(e.payload?.fetched ?? 0);
        current = { percent: Math.min(100, fetched), message: `${e.payload?.source ?? ""} +${fetched}` };
      } else if (e.type === "cycle_finished") {
        current = { percent: 100, message: "완료" };
      } else if (e.type === "cycle_started") {
        current = { percent: 0, message: "시작" };
      }
    }
    return current;
  }, [events, kind]);

  useEffect(() => {
    const finished = events.filter((e) => e.type === "cycle_finished" && String(e.payload?.kind ?? "") === kind);
    if (!finished.length) return;
    queryClient.invalidateQueries({ queryKey: ["ops-runs"] });
    queryClient.invalidateQueries({ queryKey: ["ops-audit-state"] });
    queryClient.invalidateQueries({ queryKey: ["ops-summary"] });
    queryClient.invalidateQueries({ queryKey: ["ops-status"] });
    const fresh = finished.filter((e) => !cycleSeenRef.current.has(e.id));
    if (!fresh.length) return;
    for (const ev of fresh) cycleSeenRef.current.add(ev.id);
    const last = fresh[fresh.length - 1];
    const errors = Number((last.payload as Record<string, unknown>).errors ?? 0);
    toast.push(`${label} 완료 (오류 ${errors})`, errors ? "warn" : "success");
  }, [events, queryClient, toast, kind, label]);

  useEffect(() => {
    const fresh = kindEvents.filter((e) => e.type === "error" && !errorSeenRef.current.has(e.id));
    if (!fresh.length) return;
    for (const ev of fresh) errorSeenRef.current.add(ev.id);
    const last = fresh[fresh.length - 1];
    toast.push(String(last.payload?.line ?? "수집 오류"), "danger", 6000);
  }, [kindEvents, toast]);

  async function runAction(actionLabel: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await action();
      if (!result.ok) {
        toast.push(`${actionLabel} 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
      } else {
        toast.push(`${actionLabel} 요청됨`, "success");
        queryClient.invalidateQueries({ queryKey: ["ops-status"] });
      }
    } catch (err) {
      toast.push(`${actionLabel} 예외: ${(err as Error).message}`, "danger");
    }
  }

  async function copyLog() {
    const text = filteredEvents
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {kind === "conversation" ? (
            <>
              <KpiCard label="대상 사용자" value={formatNumber(summary?.users.total)} hint={`활성 30일 ${formatNumber(summary?.users.readiness.active_30d)}`} />
              <KpiCard label="수집 대화" value={formatNumber(summary?.interactions)} hint="누적" />
              <KpiCard label="스레드" value={formatNumber(summary?.threads)} hint="현재 인덱스" />
            </>
          ) : (
            <>
              <KpiCard label="상태" value={running ? "실행 중" : "대기"} tone={running ? "positive" : "neutral"} />
              <KpiCard label="진행률" value={progress ? `${Math.round(progress.percent)}%` : "—"} hint={progress?.message ?? ""} />
              <KpiCard
                label="전체 진행 중"
                value={formatNumber(status.running.length)}
                hint={status.running.length ? status.running.map((r) => KIND_LABELS[r.kind] ?? r.kind).join(", ") : "없음"}
                tone={status.running.length ? "positive" : "neutral"}
              />
            </>
          )}
        </div>

        <Card title={`${label} 작업`}>
          <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-muted)" }}>{config.description}</p>
          <CollectionTile
            label={label}
            running={running}
            progress={progress}
            onStart={() => runAction(`${label} 시작`, () => startCollection(kind))}
            onStop={() => runAction(`${label} 중단`, () => stopCollection(kind))}
          />
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
            kindFilter={kind}
            onKindFilterChange={() => undefined}
            search={logSearch}
            onSearchChange={setLogSearch}
            errorsOnly={errorsOnly}
            onErrorsOnlyChange={setErrorsOnly}
            totalCount={kindEvents.length}
            filteredCount={filteredEvents.length}
            hideKindFilter
          />
        </Card>

        {config.showRuns && (
          <Card title="수집 이력" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{runs.length}건</span>}>
            <DataTable<CollectionRun>
              rows={runs}
              rowKey={(row) => String(row.id)}
              initialSort={{ key: "started_at", direction: "desc" }}
              columns={runColumns}
              maxHeight="40vh"
            />
          </Card>
        )}

        {config.showAuditState && (
          <Card title="감사 수집 상태">
            <DataTable<AuditCollectionStateRow>
              rows={auditState}
              rowKey={(row) => row.source}
              columns={auditStateColumns}
              maxHeight="40vh"
            />
          </Card>
        )}

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
        padding: 14,
        background: "var(--surface-muted)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: 420,
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
          <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
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
