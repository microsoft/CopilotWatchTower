import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { RawJsonButton } from "../components/RawJsonModal";
import { useToast } from "../components/Toast";
import {
  type ConversationAuditEvent,
  type ConversationDetail,
  type ConversationFilters,
  type ConversationThreadSummary,
  type ConversationTurn,
  type ThreadExportFormat,
  type UserSummary,
  exportThread,
  getConversationDetail,
  getUsersInScope,
  isBridgeAvailable,
  listConversationApps,
  openExportsFolder,
  listEdiscoveryUsers,
  listConversations,
} from "../lib/bridge";
import { defaultDateRange, formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

type SearchScope = "title" | "body" | "all";

const SCOPE_OPTIONS: { value: SearchScope; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "title", label: "제목" },
  { value: "body", label: "본문" },
];

export function ConversationsPage({ sourceType = "api" }: { sourceType?: "api" | "ediscovery" | "dataverse" }) {
  const initialFilters: ConversationFilters = useMemo(() => {
    const range = defaultDateRange();
    return {
      ...range,
      search: null,
      search_scope: "all",
      user_id: null,
      app: null,
      source_type: sourceType,
      limit: 200,
    };
  }, [sourceType]);
  const [draft, setDraft] = useState<ConversationFilters>(initialFilters);
  const [applied, setApplied] = useState<ConversationFilters>(initialFilters);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);

  const threadsQuery = useQuery({
    queryKey: ["conversations-list", sourceType, applied],
    queryFn: () => listConversations(applied),
    enabled: BRIDGE_AVAILABLE,
  });
  const usersQuery = useQuery({
    queryKey: ["conversation-users", sourceType],
    queryFn: () => (sourceType === "ediscovery" ? listEdiscoveryUsers() : getUsersInScope()),
    enabled: BRIDGE_AVAILABLE,
  });
  const appsQuery = useQuery({
    queryKey: ["conversation-apps", sourceType],
    queryFn: () => listConversationApps(sourceType),
    enabled: BRIDGE_AVAILABLE,
  });

  const threads = threadsQuery.data ?? [];

  useEffect(() => {
    if (!threads.length) {
      setSelectedThread(null);
      return;
    }
    if (!selectedThread || !threads.some((t) => t.id === selectedThread)) {
      setSelectedThread(threads[0].id);
    }
  }, [threads, selectedThread]);

  const detailQuery = useQuery({
    queryKey: ["conversation-detail", sourceType, selectedThread],
    queryFn: () => getConversationDetail(selectedThread as string),
    enabled: BRIDGE_AVAILABLE && Boolean(selectedThread),
  });

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
          placeholder={searchPlaceholder(sourceType, draft.search_scope ?? "all")}
          value={draft.search ?? ""}
          onChange={(e) => setDraft({ ...draft, search: e.target.value || null })}
          style={{ ...fieldStyle, flex: 1, minWidth: 240 }}
          title={'본문 검색은 전문 검색(FTS)을 사용합니다. 예) 보안 정책,  "분기 보고서",  예산 OR 비용'}
        />
        <ScopeToggle
          value={(draft.search_scope as SearchScope) ?? "all"}
          onChange={(scope) => setDraft({ ...draft, search_scope: scope })}
        />
        <UserSelect
          users={usersQuery.data ?? []}
          value={draft.user_id ?? ""}
          onChange={(userId) => setDraft({ ...draft, user_id: userId || null })}
          allLabel={sourceType === "ediscovery" ? "모든 eDiscovery 사용자" : "모든 사용자"}
        />
        <AppSelect
          apps={appsQuery.data ?? []}
          value={draft.app ?? ""}
          onChange={(app) => setDraft({ ...draft, app: app || null })}
        />
        <button
          type="submit"
          style={{ padding: "6px 14px", borderRadius: 8, background: "var(--accent)", color: "white", border: 0, fontWeight: 600 }}
        >
          조회
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(initialFilters);
            setApplied(initialFilters);
          }}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
          }}
        >
          초기화
        </button>
      </form>
      <section style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr) 2fr", gap: 12, padding: "18px 24px", minHeight: 0, flex: 1 }}>
        <Card title="스레드" actions={<span style={{ fontSize: 11, color: "var(--text-muted)" }}>{threads.length}개</span>}>
          <DataTable<ConversationThreadSummary>
            rows={threads}
            rowKey={(row) => row.id}
            initialSort={{ key: "started_at", direction: "desc" }}
            columns={threadColumns(setSelectedThread, selectedThread)}
            onRowClick={(row) => setSelectedThread(row.id)}
            selectedRowKey={selectedThread}
            fill
            resizable
          />
        </Card>
        <Card
          title={selectedThread ? "대화 상세" : "선택된 스레드 없음"}
          actions={
            selectedThread && detailQuery.data?.thread ? (
              <ThreadExportControl threadId={selectedThread} />
            ) : undefined
          }
        >
          {detailQuery.isLoading && <div className="empty-state">불러오는 중…</div>}
          {!detailQuery.isLoading && (!selectedThread || !detailQuery.data?.thread) && (
            <div className="empty-state">왼쪽 목록에서 스레드를 선택하세요.</div>
          )}
          {detailQuery.data?.thread && <ConversationDetailPanel detail={detailQuery.data} />}
        </Card>
      </section>
      {!BRIDGE_AVAILABLE && (
        <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 --web 으로 실행하세요.</div>
      )}
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

function UserSelect({
  users,
  value,
  onChange,
  allLabel,
}: {
  users: UserSummary[];
  value: string;
  onChange: (userId: string) => void;
  allLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...fieldStyle, minWidth: 200 }}
      title="사용자 필터"
    >
      <option value="">{allLabel}</option>
      {users.map((user) => (
        <option key={user.id} value={user.id}>
          {user.display_name || user.upn || user.id}
        </option>
      ))}
    </select>
  );
}

function AppSelect({
  apps,
  value,
  onChange,
}: {
  apps: { value: string; label: string }[];
  value: string;
  onChange: (app: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...fieldStyle, minWidth: 140 }}
      title="앱 필터"
    >
      <option value="">모든 앱</option>
      {apps.map((app) => (
        <option key={app.value} value={app.value}>
          {app.label}
        </option>
      ))}
    </select>
  );
}

function ScopeToggle({ value, onChange }: { value: SearchScope; onChange: (scope: SearchScope) => void }) {
  return (
    <div
      role="group"
      aria-label="검색 범위"
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {SCOPE_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            style={{
              padding: "6px 12px",
              border: 0,
              background: active ? "var(--accent)" : "transparent",
              color: active ? "white" : "var(--text)",
              fontWeight: active ? 600 : 400,
              fontSize: 12,
              cursor: "pointer",
            }}
            title={`검색 범위: ${option.label}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function searchPlaceholder(sourceType: "api" | "ediscovery" | "dataverse", scope: SearchScope): string {
  const where = scope === "title" ? "제목" : scope === "body" ? "대화 본문" : "제목·본문";
  const prefix = sourceType === "ediscovery" ? "복원 대화 " : "";
  return `${prefix}${where} 검색`;
}

// Renders an FTS snippet, turning the 【…】 match markers into highlights.
function SnippetText({ snippet }: { snippet: string }) {
  const parts = snippet.split(/【|】/);
  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--text-muted)",
        lineHeight: 1.4,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
      title={snippet.replace(/【|】/g, "")}
    >
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark
            key={index}
            style={{ background: "var(--accent-soft)", color: "var(--accent-strong)", padding: "0 1px", borderRadius: 2 }}
          >
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

function threadColumns(
  onSelect: (id: string) => void,
  selectedId: string | null,
): Column<ConversationThreadSummary>[] {
  return [
    {
      key: "started_at",
      header: "시작",
      width: 150,
      cell: (r) => formatKstDateTime(r.started_at),
      sortValue: (r) => r.started_at,
    },
    {
      key: "user",
      header: "사용자",
      width: 80,
      cell: (r) => r.display_name || r.upn || r.user_id,
      sortValue: (r) => (r.display_name || r.upn || r.user_id).toLowerCase(),
    },
    {
      key: "title",
      header: "제목",
      width: 320,
      cell: (r) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: 320 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => onSelect(r.id)}
              style={{
                background: "transparent",
                border: 0,
                padding: 0,
                color: r.id === selectedId ? "var(--accent-strong)" : "var(--text)",
                fontWeight: r.id === selectedId ? 600 : 400,
                cursor: "pointer",
                textAlign: "left",
                maxWidth: 250,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={r.title}
            >
              {r.title || "(제목 없음)"}
            </button>
            {r.body_match && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "var(--accent-soft)",
                  color: "var(--accent-strong)",
                  whiteSpace: "nowrap",
                }}
                title="대화 본문에서 검색어가 발견되었습니다."
              >
                본문
              </span>
            )}
          </span>
          {r.match_snippet && <SnippetText snippet={r.match_snippet} />}
        </div>
      ),
      sortValue: (r) => r.title.toLowerCase(),
    },
    {
      key: "app",
      header: "앱",
      width: 150,
      cell: (r) => r.app || "—",
      sortValue: (r) => (r.app ?? "").toLowerCase(),
      title: (r) => r.app_raw,
    },
    { key: "turns", header: "Turn", align: "right", width: 80, cell: (r) => formatNumber(r.turn_count), sortValue: (r) => r.turn_count },
    { key: "prompts", header: "프롬프트", align: "right", width: 90, cell: (r) => formatNumber(r.prompt_count), sortValue: (r) => r.prompt_count },
  ];
}

const THREAD_EXPORT_FORMATS: ThreadExportFormat[] = ["md", "html", "json"];

function ThreadExportControl({ threadId }: { threadId: string }) {
  const toast = useToast();
  const [fmt, setFmt] = useState<ThreadExportFormat>("md");
  const [busy, setBusy] = useState(false);

  async function onExport() {
    setBusy(true);
    try {
      const result = await exportThread(threadId, fmt);
      if (result.ok) {
        toast.push(`스레드 내보내기 완료: ${result.filename ?? ""}`, "success");
        await openExportsFolder();
      } else {
        toast.push(`내보내기 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
      }
    } catch (err) {
      toast.push(`내보내기 예외: ${(err as Error).message}`, "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <select
        title="스레드 내보내기 형식"
        value={fmt}
        onChange={(e) => setFmt(e.target.value as ThreadExportFormat)}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        {THREAD_EXPORT_FORMATS.map((f) => (
          <option key={f} value={f}>
            {f.toUpperCase()}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={onExport}
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 12,
          fontWeight: 500,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "내보내는 중…" : "내보내기"}
      </button>
    </div>
  );
}

function ConversationDetailPanel({ detail }: { detail: ConversationDetail }) {
  const [auditOpen, setAuditOpen] = useState(false);
  if (!detail.thread) return null;
  const thread = detail.thread;
  const userLabel = thread.display_name || thread.upn || thread.user_id;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>{thread.title || "(제목 없음)"}</h4>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {thread.display_name || thread.upn || thread.user_id}
          {" · "}
          <span title={thread.app_raw}>{thread.app}</span>
          {" · "}
          {formatKstDateTime(thread.started_at)} ~ {formatKstDateTime(thread.ended_at)}
        </div>
        {thread.topic_keywords.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {thread.topic_keywords.slice(0, 8).map((kw) => (
              <span
                key={kw}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--accent-soft)",
                  color: "var(--accent-strong)",
                }}
              >
                {kw}
              </span>
            ))}
          </div>
        )}
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1 }}>
        <div
          style={{
            background: "var(--surface-muted)",
            borderRadius: "var(--radius-sm)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            overflowY: "auto",
            flex: 1,
            minHeight: 0,
          }}
        >
          {detail.turns.map((turn) => (
            <TurnBubble key={turn.id} turn={turn} userLabel={userLabel} />
          ))}
          {detail.turns.length === 0 && <div className="empty-state">표시할 turn이 없습니다.</div>}
        </div>
        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={() => setAuditOpen((value) => !value)}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              padding: "9px 12px",
              background: "transparent",
              border: 0,
              color: "var(--text)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>관련 감사 이벤트</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {detail.audit.length}개 · {auditOpen ? "접기" : "펼치기"}
            </span>
          </button>
          {auditOpen && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "2px 12px 10px", maxHeight: "22vh", overflowY: "auto" }}>
              {detail.audit.length === 0 && (
                <div className="empty-state" style={{ padding: 12 }}>이 시간대에 매칭된 감사 이벤트가 없습니다.</div>
              )}
              {detail.audit.map((event) => (
                <AuditRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TurnBubble({ turn, userLabel }: { turn: ConversationTurn; userLabel: string }) {
  const isUser = turn.interaction_type === "userPrompt";
  const speaker = isUser ? userLabel : "Copilot";
  return (
    <article
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "84%",
        background: isUser ? "var(--accent-soft)" : "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ color: "var(--text)" }}>{speaker}</strong>
          {" · "}
          <span title={turn.app_raw}>{turn.app}</span>
          {" · "}
          {formatKstDateTime(turn.created_at)}
        </span>
        <RawJsonButton raw={turn.raw_json} title={`원본 데이터 · ${speaker}`} />
      </header>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, color: "var(--text)" }}>{turn.body_text}</div>
    </article>
  );
}

function AuditRow({ event }: { event: ConversationAuditEvent }) {
  const resultTone =
    event.result?.toLowerCase().includes("success") ? "var(--ok)" : event.result ? "var(--warn)" : "var(--text-muted)";
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--text)" }}>{event.operation || "(operation)"}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {formatKstDateTime(event.event_time)}
            {event.workload ? ` · ${event.workload}` : ""}
            {event.app ? ` · ${event.app}` : ""}
          </div>
          {event.result && <div style={{ fontSize: 11, color: resultTone }}>{event.result}</div>}
        </div>
        <RawJsonButton raw={event.raw_json} title={`원본 감사 이벤트 · ${event.operation || ""}`} />
      </div>
    </div>
  );
}
