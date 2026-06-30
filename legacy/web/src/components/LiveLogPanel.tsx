import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import type { CollectionKind } from "../lib/bridge";
import { formatKstDateTime } from "../lib/format";
import type { LiveEvent } from "../lib/useBridgeEvents";

const KIND_KEYS: CollectionKind[] = ["conversation", "audit", "usage", "diagnostics", "consumption", "transcripts", "flow_runs", "agent_definitions"];

/** Localized collection-kind labels keyed by CollectionKind. */
export function buildKindLabels(t: TFunction): Record<CollectionKind, string> {
  return {
    conversation: t("liveLog:kinds.conversation"),
    audit: t("liveLog:kinds.audit"),
    usage: t("liveLog:kinds.usage"),
    diagnostics: t("liveLog:kinds.diagnostics"),
    consumption: t("liveLog:kinds.consumption"),
    transcripts: t("liveLog:kinds.transcripts"),
    flow_runs: t("liveLog:kinds.flow_runs"),
    agent_definitions: t("liveLog:kinds.agent_definitions"),
  };
}

const KIND_COLOR: Record<string, string> = {
  conversation: "#60a5fa",
  audit: "#a78bfa",
  usage: "#34d399",
  diagnostics: "#fbbf24",
  system: "#94a3b8",
};

const EDISCOVERY_STATUS_KEYS = [
  "pending",
  "case",
  "searching",
  "estimating",
  "exporting",
  "downloading",
  "parsing",
  "done",
  "error",
];

type Level = "info" | "warn" | "error" | "success" | "muted";

const LEVEL_STYLE: Record<Level, { icon: string; color: string; bg: string }> = {
  info: { icon: "›", color: "#cbd5f5", bg: "transparent" },
  warn: { icon: "!", color: "#fbbf24", bg: "rgba(251,191,36,0.08)" },
  error: { icon: "✕", color: "#f87171", bg: "rgba(248,113,113,0.10)" },
  success: { icon: "✓", color: "#34d399", bg: "rgba(52,211,153,0.10)" },
  muted: { icon: "·", color: "#64748b", bg: "transparent" },
};

interface LiveLogPanelProps {
  events: LiveEvent[];
  onClear: () => void;
  onCopy: () => void;
  paused: boolean;
  onTogglePause: () => void;
  group: boolean;
  onToggleGroup: () => void;
  kindFilter: "" | CollectionKind | "system";
  onKindFilterChange: (next: "" | CollectionKind | "system") => void;
  search: string;
  onSearchChange: (next: string) => void;
  errorsOnly: boolean;
  onErrorsOnlyChange: (next: boolean) => void;
  totalCount: number;
  filteredCount: number;
  hideKindFilter?: boolean;
}

interface NormalisedEvent {
  id: number;
  at: string;
  level: Level;
  kind: string;
  kindLabel: string;
  headline: string;
  detail?: string;
  raw: Record<string, unknown>;
  type: string;
  group?: number; // events with same group id can be collapsed when group=true
}

export function LiveLogPanel(props: LiveLogPanelProps) {
  const {
    events,
    onClear,
    onCopy,
    paused,
    onTogglePause,
    group,
    onToggleGroup,
    kindFilter,
    onKindFilterChange,
    search,
    onSearchChange,
    errorsOnly,
    onErrorsOnlyChange,
    totalCount,
    filteredCount,
    hideKindFilter,
  } = props;

  const { t } = useTranslation("liveLog");
  const kindLabels = useMemo(() => buildKindLabels(t), [t]);
  const normalised = useMemo(() => events.map((e) => normaliseEvent(e, t, kindLabels)), [events, t, kindLabels]);
  const collapsed = useMemo(() => (group ? collapseGroups(normalised) : normalised.map((e) => ({ event: e, count: 1 }))), [normalised, group]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  useEffect(() => {
    if (!stickToBottom || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [collapsed, stickToBottom]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distance < 40);
  }

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0, success: 0, muted: 0 } as Record<Level, number>;
    for (const evt of normalised) c[evt.level] += 1;
    return c;
  }, [normalised]);

  return (
    <div style={containerStyle}>
      <div style={toolbarStyle}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {!hideKindFilter && (
            <select value={kindFilter} onChange={(e) => onKindFilterChange(e.target.value as "" | CollectionKind | "system")} style={selectStyle}>
              <option value="">{t("toolbar.allKinds")}</option>
              {KIND_KEYS.map((k) => (
                <option key={k} value={k}>{kindLabels[k]}</option>
              ))}
              <option value="system">{t("toolbar.system")}</option>
            </select>
          )}
          <input
            type="search"
            placeholder={t("toolbar.search")}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ ...selectStyle, minWidth: 160 }}
          />
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => onErrorsOnlyChange(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            {t("toolbar.errorsOnly")}
          </label>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={group} onChange={() => onToggleGroup()} style={{ marginRight: 4 }} />
            {t("toolbar.group")}
          </label>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {filteredCount}/{totalCount}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button style={smallButton} onClick={onTogglePause}>{paused ? t("toolbar.resume") : t("toolbar.pause")}</button>
          <button style={smallButton} onClick={onCopy}>{t("toolbar.copy")}</button>
          <button style={smallButton} onClick={() => downloadLog(events)}>{t("toolbar.save")}</button>
          <button style={smallButton} onClick={onClear}>{t("toolbar.clear")}</button>
        </div>
      </div>

      <div style={countsBarStyle}>
        <CountChip level="info" label={t("counts.events")} value={counts.info + counts.success + counts.muted} />
        <CountChip level="warn" label={t("counts.warnings")} value={counts.warn} />
        <CountChip level="error" label={t("counts.errors")} value={counts.error} />
        <CountChip level="success" label={t("counts.done")} value={counts.success} />
        {paused && <span style={pausedBadgeStyle}>{t("counts.paused")}</span>}
      </div>

      <div ref={listRef} onScroll={onScroll} style={listStyle}>
        {collapsed.length === 0 && <div style={{ color: "#94a3b8", padding: 12 }}>{t("empty")}</div>}
        {collapsed.map(({ event, count }) => (
          <LogRow key={event.id} event={event} count={count} />
        ))}
      </div>
    </div>
  );
}

function LogRow({ event, count }: { event: NormalisedEvent; count: number }) {
  const { t } = useTranslation("liveLog");
  const [open, setOpen] = useState(false);
  const tone = LEVEL_STYLE[event.level];
  const kindColor = KIND_COLOR[event.kind] ?? "#94a3b8";
  const time = formatKstDateTime(event.at);
  return (
    <div
      style={{
        padding: "6px 12px",
        borderTop: "1px solid #1f2a3c",
        background: tone.bg,
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: "16px 86px 130px 1fr",
        gap: 10,
        alignItems: "start",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
      onClick={() => setOpen((v) => !v)}
      title={t("rowTitle")}
    >
      <span style={{ color: tone.color, textAlign: "center" }}>{tone.icon}</span>
      <span style={{ color: "#64748b" }}>{time.split(" ")[1] ?? time}</span>
      <span
        style={{
          color: kindColor,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {event.kindLabel}
      </span>
      <div style={{ color: tone.color, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
        <span>{event.headline}</span>
        {count > 1 && (
          <span style={{ color: "#94a3b8", marginLeft: 6 }}>×{count}</span>
        )}
        {event.detail && !open && (
          <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>{event.detail}</div>
        )}
        {open && (
          <pre style={{ margin: "6px 0 0", color: "#cbd5f5", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            type: {event.type}
            {"\n"}
            {JSON.stringify(event.raw, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function CountChip({ level, label, value }: { level: Level; label: string; value: number }) {
  const style = LEVEL_STYLE[level];
  return (
    <span
      style={{
        background: style.bg === "transparent" ? "rgba(148,163,184,0.10)" : style.bg,
        color: style.color,
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 999,
        fontWeight: 600,
      }}
    >
      {label} {value}
    </span>
  );
}

function normaliseEvent(event: LiveEvent, t: TFunction, kindLabels: Record<CollectionKind, string>): NormalisedEvent {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const kindRaw = (payload.kind as string | undefined) ?? "system";
  const kindLabel = kindLabels[kindRaw as CollectionKind] ?? (kindRaw === "system" ? t("liveLog:systemKind") : kindRaw.toUpperCase());
  const level = inferLevel(event.type, payload);
  const { headline, detail, group } = describeRichEvent(event.type, payload, t);
  return {
    id: event.id,
    at: event.at,
    level,
    kind: kindRaw,
    kindLabel,
    headline,
    detail,
    raw: payload,
    type: event.type,
    group,
  };
}

function inferLevel(type: string, payload: Record<string, unknown>): Level {
  if (type === "error") return "error";
  if (type === "cycle_finished") {
    const errors = Number(payload.errors ?? 0);
    return errors > 0 ? "warn" : "success";
  }
  if (type === "cycle_started") return "info";
  if (type === "collection.started" || type === "collection.finished" || type === "collection.stop_requested") return "muted";
  if (type === "progress" || type === "user_progress" || type === "audit_progress") return "muted";
  if (type === "log") return "info";
  if (type === "settings.updated" || type === "system_dialog.closed" || type === "profile.removed") return "info";
  return "info";
}

function describeRichEvent(
  type: string,
  payload: Record<string, unknown>,
  t: TFunction,
): { headline: string; detail?: string; group?: number } {
  switch (type) {
    case "log":
      return { headline: String(payload.line ?? ""), group: hash(`log:${payload.kind ?? ""}`) };
    case "error":
      return { headline: String(payload.line ?? t("event.errorFallback")), group: hash(`error:${payload.kind ?? ""}`) };
    case "progress":
      return {
        headline: t("event.progress", { message: payload.message ?? "" }),
        detail: `${payload.percent ?? 0}%`,
      };
    case "ediscovery_progress": {
      const statusRaw = String(payload.status ?? "");
      const statusLabel = EDISCOVERY_STATUS_KEYS.includes(statusRaw)
        ? t(`ediscoveryStatus.${statusRaw}`)
        : statusRaw;
      return {
        headline: t("event.ediscovery", { status: statusLabel, message: payload.message ?? "" }),
        group: hash(`ediscovery:${payload.status ?? ""}:${payload.target_upn ?? ""}`),
      };
    }
    case "user_progress":
      return {
        headline: t("event.user", { display: payload.display ?? "" }),
        detail: t("event.fetchedCount", { n: payload.fetched ?? 0 }),
      };
    case "audit_progress":
      return {
        headline: `${payload.source ?? "source"}`,
        detail: t("event.fetchedCount", { n: payload.fetched ?? 0 }),
      };
    case "cycle_started":
      return {
        headline: t("event.started", { kind: payload.kind ?? "" }),
        detail: payload.label ? String(payload.label) : payload.trigger ? `trigger=${payload.trigger}` : undefined,
      };
    case "cycle_finished": {
      if ("interactions" in payload) {
        return {
          headline: t("event.finished", { kind: payload.kind ?? "" }),
          detail: t("event.convDetail", {
            users: payload.users,
            interactions: payload.interactions,
            errors: payload.errors,
          }),
        };
      }
      return {
        headline: t("event.finished", { kind: payload.kind ?? "" }),
        detail: t("event.genericDetail", { label: payload.label ?? "", errors: payload.errors ?? 0 }),
      };
    }
    case "collection.started":
      return { headline: t("event.reqStart", { kind: payload.kind ?? "" }) };
    case "collection.stop_requested":
      return { headline: t("event.reqStop", { kind: payload.kind ?? "" }) };
    case "collection.finished":
      return { headline: t("event.ended", { kind: payload.kind ?? "" }) };
    case "settings.updated":
      return {
        headline: t("event.settingsUpdated"),
        detail: t("event.settingsDetail", {
          interval: payload.poll_interval_minutes,
          scope: payload.scope_mode,
        }),
      };
    case "system_dialog.closed":
      return {
        headline: t("event.dialog", { kind: payload.kind ?? "" }),
        detail: payload.saved ? t("event.saved") : undefined,
      };
    case "profile.removed":
      return { headline: t("event.profileRemoved"), detail: String(payload.profile_id ?? "") };
    default:
      return { headline: type, detail: JSON.stringify(payload) };
  }
}

function collapseGroups(events: NormalisedEvent[]): Array<{ event: NormalisedEvent; count: number }> {
  const out: Array<{ event: NormalisedEvent; count: number }> = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (
      last &&
      event.group !== undefined &&
      last.event.group === event.group &&
      last.event.headline === event.headline
    ) {
      last.count += 1;
      last.event = { ...event, id: last.event.id };
    } else {
      out.push({ event, count: 1 });
    }
  }
  return out;
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return h;
}

function downloadLog(events: LiveEvent[]) {
  const lines = events.map((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return `[${event.at}] ${event.type} ${JSON.stringify(payload)}`;
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `watchtower-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};

const countsBarStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};

const pausedBadgeStyle: CSSProperties = {
  background: "rgba(251,191,36,0.18)",
  color: "var(--warn)",
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  fontWeight: 600,
};

const listStyle: CSSProperties = {
  background: "#0b1220",
  color: "#e2e8f0",
  borderRadius: 8,
  minHeight: 120,
  maxHeight: 320,
  width: "100%",
  boxSizing: "border-box",
  flexShrink: 0,
  overflowY: "auto",
  overflowX: "hidden",
  border: "1px solid #1f2a3c",
};

const selectStyle: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 12,
};

const smallButton: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text-soft)",
  border: "1px solid var(--border)",
  fontSize: 12,
  cursor: "pointer",
};

const checkboxLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
};
