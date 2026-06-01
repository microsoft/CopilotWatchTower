import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { KIND_LABELS, LiveLogPanel } from "../components/LiveLogPanel";
import { RawJsonButton } from "../components/RawJsonModal";
import { useToast } from "../components/Toast";
import {
  type AuditCollectionStateRow,
  type CollectionKind,
  type CollectionStatus,
  getAuditCollectionState,
  getCollectionStatus,
  getOperationsSummary,
  isBridgeAvailable,
  listRunLogs,
  type RunLogRow,
  startCollection,
  stopCollection,
} from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";
import { useBridgeEvents } from "../lib/useBridgeEvents";

const BRIDGE_AVAILABLE = isBridgeAvailable();

interface KindConfig {
  showAuditState: boolean;
  description: string;
}

const KIND_CONFIG: Record<CollectionKind, KindConfig> = {
  conversation: {
    showAuditState: false,
    description: "Graph API로 사용자 Copilot 대화를 수집하고 스레드로 인덱싱합니다.",
  },
  audit: {
    showAuditState: true,
    description: "Purview·Entra 감사 로그에서 보안·접근 이벤트를 수집합니다.",
  },
  usage: {
    showAuditState: false,
    description: "Microsoft 365 Copilot 공식 사용량 보고서 스냅샷을 수집합니다.",
  },
  diagnostics: {
    showAuditState: false,
    description: "Copilot 관리 API(에이전트 등록·카탈로그)와 감사 로그에서 에이전트 인벤토리와 사용 신호를 수집합니다.",
  },
  consumption: {

    showAuditState: false,
    description: "PPAC 자동 로그인으로 Copilot Studio 메시지·AI Builder 크레딧·Power Platform 요청 소비량 리포트를 내려받습니다. 수집한 데이터는 파워플랫폼 크레딧 화면에서 확인합니다.",
  },
  transcripts: {
    showAuditState: false,
    description: "Dataverse 자동 로그인으로 Copilot Studio 커스텀 에이전트의 Teams 대화 기록(대화 트랜스크립트)을 수집합니다. 수집한 데이터는 대화 탐색(Teams) 화면에서 확인합니다.",
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
  const auditStateQuery = useQuery({
    queryKey: ["ops-audit-state"],
    queryFn: getAuditCollectionState,
    enabled: BRIDGE_AVAILABLE && config.showAuditState,
  });
  const runLogsQuery = useQuery({
    queryKey: ["run-logs", kind],
    queryFn: () => listRunLogs(kind, 30),
    enabled: BRIDGE_AVAILABLE,
    refetchInterval: 4000,
  });

  const summary = summaryQuery.data;
  const status: CollectionStatus = statusQuery.data ?? { running: [] };
  const auditState = auditStateQuery.data ?? [];
  const running = useMemo(() => status.running.some((row) => row.kind === kind), [status, kind]);
  const sessionRuns = runLogsQuery.data ?? [];

  const { events, clear, paused, togglePause } = useBridgeEvents();
  const cycleSeenRef = useRef<Set<number>>(new Set());
  const errorSeenRef = useRef<Set<number>>(new Set());

  const [logSearch, setLogSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [group, setGroup] = useState(true);
  // Opt-in (transcripts only): add myself as system administrator to
  // environments I lack access to, before collecting their transcripts.
  const [addSelfAsAdmin, setAddSelfAsAdmin] = useState(false);

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
    queryClient.invalidateQueries({ queryKey: ["ops-audit-state"] });
    queryClient.invalidateQueries({ queryKey: ["ops-summary"] });
    queryClient.invalidateQueries({ queryKey: ["ops-status"] });
    queryClient.invalidateQueries({ queryKey: ["run-logs", kind] });
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
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0, overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(120px, 1fr))", gap: 12, flex: 1, minWidth: 320 }}>
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

          <CollectionTile
            label={label}
            running={running}
            progress={progress}
            onStart={() =>
              runAction(`${label} 시작`, () =>
                startCollection(kind, kind === "transcripts" ? { addSelfAsAdmin } : undefined),
              )
            }
            onStop={() => runAction(`${label} 중단`, () => stopCollection(kind))}
          >
            {kind === "transcripts" && (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--text)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={addSelfAsAdmin}
                  onChange={(e) => setAddSelfAsAdmin(e.target.checked)}
                  disabled={running}
                  style={{ marginTop: 2 }}
                />
                <span>
                  권한이 없는 환경에 나를 시스템 관리자로 자동 추가
                  <span style={{ display: "block", color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
                    토큰을 발급받지 못한 환경에 한해, 관리 센터에서 본인을 시스템 관리자로 추가한 뒤 다시 수집을
                    시도합니다. 공유·운영 환경에 관리자 권한을 부여하는 작업이므로 필요할 때만 사용하세요.
                  </span>
                </span>
              </label>
            )}
          </CollectionTile>
        </div>

        <Card title="실시간 로그" bodyStyle={{ minWidth: 0, overflow: "hidden" }}>
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

        <Card
          title="실행 이력"
          actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>최근 {sessionRuns.length}건</span>}
        >
          <DataTable<RunLogRow>
            rows={sessionRuns}
            rowKey={(row) => String(row.id)}
            initialSort={{ key: "started_at", direction: "desc" }}
            columns={sessionRunColumns(label)}
            maxHeight="40vh"
            empty="아직 실행 기록이 없습니다. 수집을 시작하면 성공·실패와 관계없이 행이 추가됩니다."
          />
        </Card>

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
  children,
}: {
  label: string;
  running: boolean;
  progress?: { percent: number; message: string };
  onStart: () => void;
  onStop: () => void;
  children?: React.ReactNode;
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
        flex: "0 0 320px",
        minWidth: 280,
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
      {children}
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

const RUN_STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: "진행 중", color: "var(--warn)" },
  success: { label: "성공", color: "var(--ok)" },
  warn: { label: "오류 있음", color: "var(--warn)" },
  error: { label: "중단", color: "var(--danger)" },
};

function formatRunLog(run: RunLogRow): string {
  if (!run.logs.length) return "기록된 로그가 없습니다.";
  return run.logs.map((line) => `[${formatKstDateTime(line.at)}] ${line.text}`).join("\n");
}

function sessionRunColumns(label: string): Column<RunLogRow>[] {
  return [
    {
      key: "started_at",
      header: "시작",
      cell: (r) => formatKstDateTime(r.started_at),
      sortValue: (r) => r.started_at,
    },
    {
      key: "finished_at",
      header: "종료",
      cell: (r) => (r.finished_at ? formatKstDateTime(r.finished_at) : "진행 중"),
      sortValue: (r) => r.finished_at ?? "",
    },
    {
      key: "status",
      header: "상태",
      cell: (r) => {
        const meta = RUN_STATUS_META[r.status] ?? { label: r.status, color: "var(--text-muted)" };
        return <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>;
      },
      sortValue: (r) => r.status,
    },
    { key: "summary", header: "요약", cell: (r) => r.summary || "—" },
    {
      key: "log",
      header: "로그",
      align: "right",
      cell: (r) => <RawJsonButton raw={formatRunLog(r)} title={`${label} 실행 로그`} />,
    },
  ];
}

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
