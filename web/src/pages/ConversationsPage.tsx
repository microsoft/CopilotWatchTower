import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import {
  type ConversationAuditEvent,
  type ConversationDetail,
  type ConversationFilters,
  type ConversationThreadSummary,
  type ConversationTurn,
  type UserSummary,
  getConversationDetail,
  getUsersInScope,
  isBridgeAvailable,
  listEdiscoveryUsers,
  listConversations,
} from "../lib/bridge";
import { defaultDateRange, formatKstDateTime, formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function ConversationsPage({ sourceType = "api" }: { sourceType?: "api" | "ediscovery" }) {
  const initialFilters: ConversationFilters = useMemo(() => {
    const range = defaultDateRange();
    return { ...range, search: null, user_id: null, app: null, source_type: sourceType, limit: 200 };
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
          placeholder={sourceType === "ediscovery" ? "복원 대화 제목 검색" : "제목 검색"}
          value={draft.search ?? ""}
          onChange={(e) => setDraft({ ...draft, search: e.target.value || null })}
          style={{ ...fieldStyle, flex: 1, minWidth: 240 }}
        />
        {sourceType === "ediscovery" && (
          <UserSelect
            users={usersQuery.data ?? []}
            value={draft.user_id ?? ""}
            onChange={(userId) => setDraft({ ...draft, user_id: userId || null })}
          />
        )}
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
            maxHeight="60vh"
          />
        </Card>
        <Card title={selectedThread ? "대화 상세" : "선택된 스레드 없음"}>
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
}: {
  users: UserSummary[];
  value: string;
  onChange: (userId: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...fieldStyle, minWidth: 220 }}
      title="eDiscovery 사용자"
    >
      <option value="">모든 eDiscovery 사용자</option>
      {users.map((user) => (
        <option key={user.id} value={user.id}>
          {user.display_name || user.upn || user.id}
        </option>
      ))}
    </select>
  );
}

function threadColumns(
  onSelect: (id: string) => void,
  selectedId: string | null,
): Column<ConversationThreadSummary>[] {
  return [
    {
      key: "title",
      header: "제목",
      cell: (r) => (
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
            maxWidth: 280,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={r.title}
        >
          {r.title || "(제목 없음)"}
        </button>
      ),
      sortValue: (r) => r.title.toLowerCase(),
    },
    {
      key: "user",
      header: "사용자",
      cell: (r) => r.display_name || r.upn || r.user_id,
      sortValue: (r) => (r.display_name || r.upn || r.user_id).toLowerCase(),
    },
    {
      key: "app",
      header: "앱",
      cell: (r) => r.app || "—",
      sortValue: (r) => (r.app ?? "").toLowerCase(),
      title: (r) => r.app_raw,
    },
    { key: "turns", header: "Turn", align: "right", cell: (r) => formatNumber(r.turn_count), sortValue: (r) => r.turn_count },
    { key: "prompts", header: "프롬프트", align: "right", cell: (r) => formatNumber(r.prompt_count), sortValue: (r) => r.prompt_count },
    {
      key: "started_at",
      header: "시작",
      cell: (r) => formatKstDateTime(r.started_at),
      sortValue: (r) => r.started_at,
    },
  ];
}

function ConversationDetailPanel({ detail }: { detail: ConversationDetail }) {
  const [auditOpen, setAuditOpen] = useState(false);
  if (!detail.thread) return null;
  const thread = detail.thread;
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
            maxHeight: auditOpen ? "42vh" : "58vh",
          }}
        >
          {detail.turns.map((turn) => (
            <TurnBubble key={turn.id} turn={turn} />
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

function TurnBubble({ turn }: { turn: ConversationTurn }) {
  const isUser = turn.interaction_type === "userPrompt";
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
      <header style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
        <strong style={{ color: "var(--text)" }}>{turn.interaction_type || "interaction"}</strong>
        {" · "}
        <span title={turn.app_raw}>{turn.app}</span>
        {" · "}
        {formatKstDateTime(turn.created_at)}
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
      <div style={{ fontSize: 12, color: "var(--text)" }}>{event.operation || "(operation)"}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {formatKstDateTime(event.event_time)}
        {event.workload ? ` · ${event.workload}` : ""}
        {event.app ? ` · ${event.app}` : ""}
      </div>
      {event.result && <div style={{ fontSize: 11, color: resultTone }}>{event.result}</div>}
    </div>
  );
}
