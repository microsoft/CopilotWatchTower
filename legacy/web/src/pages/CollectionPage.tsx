import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { KpiCard } from "../components/KpiCard";
import { buildKindLabels, LiveLogPanel } from "../components/LiveLogPanel";
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
import { copyText } from "../lib/clipboard";

const BRIDGE_AVAILABLE = isBridgeAvailable();

// Kinds whose page shows the audit-collection-state table.
const AUDIT_STATE_KINDS: ReadonlySet<CollectionKind> = new Set<CollectionKind>(["audit"]);
// Kinds collected via the Dataverse maker-portal browser sign-in, which can
// optionally add the signed-in user as admin to environments they lack access
// to. Mirrors the transcript collector's opt-in.
const DATAVERSE_SIGNIN_KINDS: ReadonlySet<CollectionKind> = new Set<CollectionKind>([
  "transcripts",
  "flow_runs",
  "agent_definitions",
]);

export function CollectionPage({ kind }: { kind: CollectionKind }) {
  const { t } = useTranslation("collection");
  const queryClient = useQueryClient();
  const toast = useToast();
  const showAuditState = AUDIT_STATE_KINDS.has(kind);
  const kindLabels = useMemo(() => buildKindLabels(t), [t]);
  const label = kindLabels[kind];

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
    enabled: BRIDGE_AVAILABLE && showAuditState,
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
        current = { percent: 100, message: t("progress.done") };
      } else if (e.type === "cycle_started") {
        current = { percent: 0, message: t("progress.start") };
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
    toast.push(t("toasts.finished", { label, errors }), errors ? "warn" : "success");
  }, [events, queryClient, toast, kind, label, t]);

  useEffect(() => {
    const fresh = kindEvents.filter((e) => e.type === "error" && !errorSeenRef.current.has(e.id));
    if (!fresh.length) return;
    for (const ev of fresh) errorSeenRef.current.add(ev.id);
    const last = fresh[fresh.length - 1];
    toast.push(String(last.payload?.line ?? t("toasts.collectError")), "danger", 6000);
  }, [kindEvents, toast, t]);

  async function runAction(actionLabel: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await action();
      if (!result.ok) {
        toast.push(t("toasts.actionFailed", { label: actionLabel, error: result.error ?? t("common:unknownError") }), "danger");
      } else {
        toast.push(t("toasts.actionRequested", { label: actionLabel }), "success");
        queryClient.invalidateQueries({ queryKey: ["ops-status"] });
      }
    } catch (err) {
      toast.push(t("toasts.actionException", { label: actionLabel, message: (err as Error).message }), "danger");
    }
  }

  async function copyLog() {
    const text = filteredEvents
      .map((e) => `[${e.at}] ${e.type} ${JSON.stringify(e.payload ?? {})}`)
      .join("\n");
    if (await copyText(text)) {
      toast.push(t("toasts.logCopied"), "success");
    } else {
      toast.push(t("toasts.copyFailed"), "danger");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0, overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(120px, 1fr))", gap: 12, flex: 1, minWidth: 320 }}>
            {kind === "conversation" ? (
              <>
                <KpiCard label={t("kpi.targetUsers")} value={formatNumber(summary?.users.total)} hint={t("kpi.active30d", { n: formatNumber(summary?.users.readiness.active_30d) })} />
                <KpiCard label={t("kpi.collectedConversations")} value={formatNumber(summary?.interactions)} hint={t("kpi.cumulative")} />
                <KpiCard label={t("kpi.threads")} value={formatNumber(summary?.threads)} hint={t("kpi.currentIndex")} />
              </>
            ) : (
              <>
                <KpiCard label={t("kpi.status")} value={running ? t("kpi.running") : t("kpi.idle")} tone={running ? "positive" : "neutral"} />
                <KpiCard label={t("kpi.progressRate")} value={progress ? `${Math.round(progress.percent)}%` : "—"} hint={progress?.message ?? ""} />
                <KpiCard
                  label={t("kpi.totalRunning")}
                  value={formatNumber(status.running.length)}
                  hint={status.running.length ? status.running.map((r) => kindLabels[r.kind] ?? r.kind).join(", ") : t("kpi.none")}
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
              runAction(t("actions.start", { label }), () =>
                startCollection(kind, DATAVERSE_SIGNIN_KINDS.has(kind) ? { addSelfAsAdmin } : undefined),
              )
            }
            onStop={() => runAction(t("actions.stop", { label }), () => stopCollection(kind))}
          >
            {DATAVERSE_SIGNIN_KINDS.has(kind) && (
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
                  {t("transcripts.addSelfAdmin")}
                  <span style={{ display: "block", color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
                    {t("transcripts.addSelfAdminHint")}
                  </span>
                </span>
              </label>
            )}
          </CollectionTile>
        </div>

        <Card title={t("cards.liveLog")} bodyStyle={{ minWidth: 0, overflow: "hidden" }}>
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
          title={t("cards.runHistory")}
          actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("cards.recentCount", { n: sessionRuns.length })}</span>}
        >
          <DataTable<RunLogRow>
            rows={sessionRuns}
            rowKey={(row) => String(row.id)}
            initialSort={{ key: "started_at", direction: "desc" }}
            columns={sessionRunColumns(label, t)}
            maxHeight="40vh"
            empty={t("runHistory.empty")}
          />
        </Card>

        {showAuditState && (
          <Card title={t("cards.auditState")}>
            <DataTable<AuditCollectionStateRow>
              rows={auditState}
              rowKey={(row) => row.source}
              columns={buildAuditStateColumns(t)}
              maxHeight="40vh"
            />
          </Card>
        )}

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">{t("bridgeOffline")}</div>
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
  const { t } = useTranslation("collection");
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
          {running ? t("tile.running") : t("tile.idle")}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={primaryButtonStyle} disabled={running} onClick={onStart}>
          {t("tile.start")}
        </button>
        <button style={secondaryButtonStyle} disabled={!running} onClick={onStop}>
          {t("tile.stop")}
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

function buildRunStatusMeta(t: TFunction): Record<string, { label: string; color: string }> {
  return {
    running: { label: t("runStatus.running"), color: "var(--warn)" },
    success: { label: t("runStatus.success"), color: "var(--ok)" },
    warn: { label: t("runStatus.warn"), color: "var(--warn)" },
    error: { label: t("runStatus.error"), color: "var(--danger)" },
  };
}

function formatRunLog(run: RunLogRow, t: TFunction): string {
  if (!run.logs.length) return t("runLog.empty");
  return run.logs.map((line) => `[${formatKstDateTime(line.at)}] ${line.text}`).join("\n");
}

function sessionRunColumns(label: string, t: TFunction): Column<RunLogRow>[] {
  const statusMeta = buildRunStatusMeta(t);
  return [
    {
      key: "started_at",
      header: t("runColumns.started"),
      cell: (r) => formatKstDateTime(r.started_at),
      sortValue: (r) => r.started_at,
    },
    {
      key: "finished_at",
      header: t("runColumns.finished"),
      cell: (r) => (r.finished_at ? formatKstDateTime(r.finished_at) : t("runColumns.inProgress")),
      sortValue: (r) => r.finished_at ?? "",
    },
    {
      key: "status",
      header: t("runColumns.status"),
      cell: (r) => {
        const meta = statusMeta[r.status] ?? { label: r.status, color: "var(--text-muted)" };
        return <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>;
      },
      sortValue: (r) => r.status,
    },
    { key: "summary", header: t("runColumns.summary"), cell: (r) => r.summary || "—" },
    {
      key: "log",
      header: t("runColumns.log"),
      align: "right",
      cell: (r) => <RawJsonButton raw={formatRunLog(r, t)} title={t("runLog.title", { label })} />,
    },
  ];
}

function buildAuditStateColumns(t: TFunction): Column<AuditCollectionStateRow>[] {
  return [
    { key: "source", header: t("auditColumns.source"), cell: (r) => r.source, sortValue: (r) => r.source },
    {
      key: "last_success",
      header: t("auditColumns.lastSuccess"),
      cell: (r) => formatKstDateTime(r.last_success_at),
      sortValue: (r) => r.last_success_at ?? "",
    },
    { key: "last_record_count", header: t("auditColumns.count"), align: "right", cell: (r) => formatNumber(r.last_record_count) },
    {
      key: "status",
      header: t("auditColumns.status"),
      cell: (r) => {
        if (r.last_error) {
          return <span style={{ color: "var(--danger)" }}>{t("auditColumns.error")}</span>;
        }
        if (r.pending_query_id) {
          return <span style={{ color: "var(--warn)" }}>{t("auditColumns.inProgress")}</span>;
        }
        return <span style={{ color: "var(--ok)" }}>{t("auditColumns.ok")}</span>;
      },
    },
  ];
}
