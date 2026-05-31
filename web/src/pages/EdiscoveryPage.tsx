import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { LiveLogPanel } from "../components/LiveLogPanel";
import { useToast } from "../components/Toast";
import {
  type EdiscoveryJobRow,
  type EdiscoveryStatus,
  getEdiscoveryStatus,
  isBridgeAvailable,
  startEdiscoveryCollection,
  stopEdiscoveryCollection,
} from "../lib/bridge";
import { formatKstDateTime, formatNumber } from "../lib/format";
import { useBridgeEvents } from "../lib/useBridgeEvents";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const EDISCOVERY_TERMINAL = new Set(["done", "error"]);

const EDISCOVERY_STATUS_LABELS: Record<string, string> = {
  pending: "대기",
  case: "케이스 생성",
  searching: "검색",
  exporting: "내보내기",
  downloading: "다운로드",
  parsing: "파싱",
};

interface LiveProgress {
  status: string;
  message: string;
  percent: number | null;
}

export function EdiscoveryPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const ediscoveryQuery = useQuery({
    queryKey: ["ediscovery-status"],
    queryFn: getEdiscoveryStatus,
    enabled: BRIDGE_AVAILABLE,
    refetchInterval: 4000,
  });
  const ediscovery: EdiscoveryStatus = ediscoveryQuery.data ?? { jobs: [] };
  const jobs = ediscovery.jobs;

  const { events, clear, paused, togglePause } = useBridgeEvents();
  const [logSearch, setLogSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [group, setGroup] = useState(true);
  const errorSeenRef = useRef<Set<number>>(new Set());

  const ediscoveryEvents = useMemo(
    () => events.filter((e) => (e.payload?.kind as string | undefined) === "ediscovery" || e.type === "ediscovery_progress"),
    [events],
  );

  // Live progress for the currently-running stage (download/parse). The
  // download stage emits "downloading" lines that carry a percentage we can
  // surface as a determinate bar; other stages render an indeterminate bar.
  const liveProgress = useMemo<LiveProgress | null>(() => {
    if (!jobs.some((j) => j.running)) return null;
    for (let i = ediscoveryEvents.length - 1; i >= 0; i -= 1) {
      const ev = ediscoveryEvents[i];
      if (ev.type !== "ediscovery_progress") continue;
      const status = String(ev.payload?.status ?? "");
      const message = String(ev.payload?.message ?? "");
      const pctMatch = message.match(/\((\d+)%\)/);
      return {
        status,
        message,
        percent: pctMatch ? Number(pctMatch[1]) : null,
      };
    }
    return null;
  }, [ediscoveryEvents, jobs]);
  const filteredEvents = useMemo(() => {
    const needle = logSearch.trim().toLowerCase();
    return ediscoveryEvents.filter((event) => {
      if (errorsOnly && event.type !== "error") return false;
      if (!needle) return true;
      const haystack = `${event.type} ${JSON.stringify(event.payload ?? {})}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [ediscoveryEvents, logSearch, errorsOnly]);

  // Refresh the jobs table whenever an eDiscovery cycle finishes.
  useEffect(() => {
    const finished = events.filter((e) => e.type === "cycle_finished" && (e.payload?.kind as string | undefined) === "ediscovery");
    if (!finished.length) return;
    queryClient.invalidateQueries({ queryKey: ["ediscovery-status"] });
  }, [events, queryClient]);

  useEffect(() => {
    const fresh = events.filter(
      (e) => e.type === "error" && (e.payload?.kind as string | undefined) === "ediscovery" && !errorSeenRef.current.has(e.id),
    );
    if (!fresh.length) return;
    for (const ev of fresh) errorSeenRef.current.add(ev.id);
    const last = fresh[fresh.length - 1];
    toast.push(String(last.payload?.line ?? "eDiscovery 오류"), "danger", 6000);
  }, [events, toast]);

  async function runAction(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await action();
      if (!result.ok) {
        toast.push(`${label} 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
      } else {
        toast.push(`${label} 요청됨`, "success");
        queryClient.invalidateQueries({ queryKey: ["ediscovery-status"] });
      }
    } catch (err) {
      toast.push(`${label} 예외: ${(err as Error).message}`, "danger");
    }
  }

  async function copyLog() {
    const text = filteredEvents.map((e) => `[${e.at}] ${e.type} ${JSON.stringify(e.payload ?? {})}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.push("로그를 복사했습니다.", "success");
    } catch (err) {
      toast.push(`복사 실패: ${(err as Error).message}`, "danger");
    }
  }

  const runningCount = jobs.filter((j) => j.running).length;
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <KpiCard label="작업" value={formatNumber(jobs.length)} hint="누적 수집 작업" />
          <KpiCard label="진행 중" value={formatNumber(runningCount)} hint={runningCount ? "수집 실행 중" : "없음"} tone={runningCount ? "positive" : "neutral"} />
          <KpiCard label="완료" value={formatNumber(doneCount)} hint="성공적으로 마침" />
          <KpiCard label="오류" value={formatNumber(errorCount)} hint="재개 가능" tone={errorCount ? "danger" : "neutral"} />
        </div>

        <EdiscoveryStartCard
          onStart={(payload) => runAction("eDiscovery 수집 시작", () => startEdiscoveryCollection(payload))}
        />

        {liveProgress && <EdiscoveryLiveProgress progress={liveProgress} />}

        <EdiscoveryJobsCard
          jobs={jobs}
          onResume={(row) =>
            runAction("eDiscovery 재개", () =>
              startEdiscoveryCollection({
                target_upn: row.target_upn,
                window_start: row.window_start,
                window_end: row.window_end,
                job_id: row.id,
              }),
            )
          }
          onStop={(jobId) => runAction("eDiscovery 수집 중단", () => stopEdiscoveryCollection(jobId))}
        />

        <Card title="실시간 로그 (eDiscovery)">
          <LiveLogPanel
            events={filteredEvents}
            onClear={clear}
            onCopy={copyLog}
            paused={paused}
            onTogglePause={togglePause}
            group={group}
            onToggleGroup={() => setGroup((v) => !v)}
            kindFilter=""
            onKindFilterChange={() => undefined}
            search={logSearch}
            onSearchChange={setLogSearch}
            errorsOnly={errorsOnly}
            onErrorsOnlyChange={setErrorsOnly}
            totalCount={ediscoveryEvents.length}
            filteredCount={filteredEvents.length}
          />
        </Card>

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 실행하세요.</div>
        )}
      </section>
    </div>
  );
}

function EdiscoveryStartCard({
  onStart,
}: {
  onStart: (payload: { target_upn: string; window_start?: string | null; window_end?: string | null }) => void;
}) {
  const [upn, setUpn] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  function submit() {
    const target = upn.trim();
    if (!target) return;
    onStart({ target_upn: target, window_start: start || null, window_end: end || null });
  }

  return (
    <Card title="새 수집 시작 (라이선스 없는 사용자)">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Copilot 라이선스가 없는 사용자의 프롬프트/응답 본문을 Microsoft Purview eDiscovery로 수집합니다. 대상
          사용자(UPN)와 선택적 기간을 지정한 뒤 시작하세요. 같은 사용자/기간이라도 시작할 때마다 별도 작업으로
          추적되어 각각 독립적으로 재개할 수 있습니다. 위임 로그인이 만료되면 수집이 중단되며, 설정 → 권한
          재등록에서 다시 로그인한 뒤 이어서 진행할 수 있습니다.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "2 1 240px" }}>
            <span style={ediscoveryLabelStyle}>대상 사용자 (UPN)</span>
            <input
              type="email"
              value={upn}
              placeholder="user@contoso.com"
              onChange={(e) => setUpn(e.target.value)}
              style={ediscoveryInputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 130px" }}>
            <span style={ediscoveryLabelStyle}>시작일 (선택)</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={ediscoveryInputStyle} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 130px" }}>
            <span style={ediscoveryLabelStyle}>종료일 (선택)</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={ediscoveryInputStyle} />
          </label>
          <button style={primaryButtonStyle} disabled={!upn.trim()} onClick={submit}>
            수집 시작
          </button>
        </div>
      </div>
    </Card>
  );
}

function EdiscoveryJobsCard({
  jobs,
  onResume,
  onStop,
}: {
  jobs: EdiscoveryJobRow[];
  onResume: (row: EdiscoveryJobRow) => void;
  onStop: (jobId: string) => void;
}) {
  const anyRunning = jobs.some((j) => j.running);

  return (
    <Card
      title="수집 작업 이력"
      actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{jobs.length}건</span>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {jobs.length > 0 ? (
          <DataTable<EdiscoveryJobRow>
            rows={jobs}
            rowKey={(row) => row.id}
            initialSort={{ key: "updated_at", direction: "desc" }}
            columns={[
              { key: "target_upn", header: "대상", cell: (r) => r.target_upn, sortValue: (r) => r.target_upn },
              {
                key: "status",
                header: "상태",
                cell: (r) => (
                  <EdiscoveryStatusBadge
                    status={r.status}
                    running={r.running}
                    interactionsAdded={r.interactions_added}
                  />
                ),
                sortValue: (r) => r.status,
              },
              {
                key: "window",
                header: "기간",
                cell: (r) =>
                  r.window_start || r.window_end ? `${r.window_start ?? "…"} ~ ${r.window_end ?? "…"}` : "전체",
              },
              {
                key: "interactions_added",
                header: "추가",
                align: "right",
                cell: (r) => formatNumber(r.interactions_added),
                sortValue: (r) => r.interactions_added,
              },
              {
                key: "updated_at",
                header: "갱신",
                cell: (r) => formatKstDateTime(r.updated_at),
                sortValue: (r) => r.updated_at,
              },
              {
                key: "actions",
                header: "",
                cell: (r) =>
                  r.running ? (
                    <button style={secondaryButtonStyle} onClick={() => onStop(r.id)}>
                      중단
                    </button>
                  ) : r.status !== "done" || r.interactions_added === 0 ? (
                    <button style={secondaryButtonStyle} onClick={() => onResume(r)}>
                      재개
                    </button>
                  ) : null,
              },
            ]}
            maxHeight="38vh"
          />
        ) : (
          <div className="empty-state">아직 수집 작업이 없습니다. 위에서 새 수집을 시작하세요.</div>
        )}
        {anyRunning && (
          <div style={{ fontSize: 11, color: "var(--warn)" }}>
            진행 중인 eDiscovery 작업이 있습니다. 완료까지 수 분이 걸릴 수 있습니다.
          </div>
        )}
      </div>
    </Card>
  );
}

function EdiscoveryLiveProgress({ progress }: { progress: LiveProgress }) {
  const stageLabel = EDISCOVERY_STATUS_LABELS[progress.status] ?? progress.status ?? "진행 중";
  const determinate = progress.percent !== null;
  const pct = determinate ? Math.max(0, Math.min(100, progress.percent as number)) : 0;
  return (
    <Card title={`진행 상황 · ${stageLabel}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text)", wordBreak: "break-all" }}>
            {progress.message || "처리 중…"}
          </span>
          {determinate && (
            <span style={{ fontSize: 16, fontWeight: 700, color: "var(--accent)", whiteSpace: "nowrap" }}>{pct}%</span>
          )}
        </div>
        <div style={progressTrackStyle}>
          {determinate ? (
            <div style={{ ...progressFillStyle, width: `${pct}%` }} />
          ) : (
            <div style={progressIndeterminateStyle} />
          )}
        </div>
      </div>
    </Card>
  );
}

function EdiscoveryStatusBadge({
  status,
  running,
  interactionsAdded,
}: {
  status: string;
  running: boolean;
  interactionsAdded?: number;
}) {
  let color = "var(--text-muted)";
  let label = status;
  if (status === "done" && !running && interactionsAdded === 0) {
    // Finished but collected nothing — usually a silently-failed download
    // (e.g. expired delegated login). Flag it so the 재개 button makes sense.
    color = "var(--warn)";
    label = "완료 · 0건";
  } else if (status === "done") {
    color = "var(--ok)";
    label = "완료";
  } else if (status === "error") {
    color = "var(--danger)";
    label = "오류";
  } else if (running || !EDISCOVERY_TERMINAL.has(status)) {
    color = "var(--warn)";
    label = EDISCOVERY_STATUS_LABELS[status] ?? status;
  }
  return <span style={{ color, fontWeight: 600 }}>{label}</span>;
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

const ediscoveryLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontWeight: 600,
};

const ediscoveryInputStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
};

const progressTrackStyle: React.CSSProperties = {
  position: "relative",
  height: 10,
  borderRadius: 999,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  overflow: "hidden",
};

const progressFillStyle: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "var(--accent)",
  transition: "width 0.3s ease",
};

const progressIndeterminateStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: "40%",
  borderRadius: 999,
  background: "var(--accent)",
  animation: "ediscovery-indeterminate 1.2s ease-in-out infinite",
};

