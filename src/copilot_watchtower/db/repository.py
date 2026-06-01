"""Data access layer: SQLite repository.

Thread-safe by always opening per-call connections (the SQLite driver
is happiest when each thread holds its own connection). For high-volume
inserts the collector worker batches into a single transaction.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from collections import Counter
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from importlib import resources
from pathlib import Path
from typing import Any

from ..audit_payload import audit_data_from_raw, audit_grounding_items, copilot_event_data
from ..insights import INTENT_ORDER, classify_work_intent, intent_label
from ..security.dpapi import ProtectedBlob
from ..usage_mapping import normalize_usage_row, period_from_report

log = logging.getLogger(__name__)

SCHEMA_RESOURCE = ("copilot_watchtower.db", "schema.sql")
SOURCE_API = "api"
SOURCE_EDISCOVERY = "ediscovery"
VALID_SOURCES = {SOURCE_API, SOURCE_EDISCOVERY}


@dataclass
class UserRow:
    id: str
    upn: str | None
    display_name: str | None
    enabled: bool
    has_copilot_license: bool
    in_scope: bool


@dataclass
class InteractionRow:
    id: str
    user_id: str
    session_id: str | None
    request_id: str | None
    created_at: str
    interaction_type: str | None
    app: str | None
    body_text: str | None
    body_content_type: str | None
    attachments_json: str | None
    raw_json: str | None
    fetched_at: str
    thread_id: str | None = None
    source_type: str = SOURCE_API


@dataclass
class ThreadRow:
    id: str
    user_id: str
    started_at: str
    ended_at: str
    app: str | None
    turn_count: int
    prompt_count: int
    response_count: int
    session_ids: list[str]
    topic_keywords: list[str]
    title: str | None
    cluster_label: str | None
    computed_at: str
    # Derived (joined from users) — populated by list_threads.
    display_name: str | None = None
    upn: str | None = None
    source_type: str = SOURCE_API
    # Derived (full-text search) — populated by list_threads when a body
    # search matches one of the thread's interactions.
    match_snippet: str | None = None
    body_match: bool = False


@dataclass
class AuditEventRow:
    id: str
    source: str
    event_time: str
    user_id: str | None
    upn: str | None
    operation: str | None
    workload: str | None
    app: str | None
    target_resources: str | None
    client_ip: str | None
    result: str | None
    raw_json: str | None
    fetched_at: str


@dataclass
class UsageSnapshotRow:
    snapshot_date: str
    user_id: str | None
    upn: str | None
    period: str
    display_name: str | None
    last_activity_overall: str | None
    last_activity_teams: str | None
    last_activity_word: str | None
    last_activity_excel: str | None
    last_activity_powerpoint: str | None
    last_activity_outlook: str | None
    last_activity_onenote: str | None
    last_activity_loop: str | None
    last_activity_bizchat: str | None
    raw_json: str | None = None


@dataclass
class UsageCountRow:
    report_type: str
    report_refresh_date: str
    period: str
    report_date: str | None
    any_app_enabled_users: int | None
    any_app_active_users: int | None
    teams_enabled_users: int | None
    teams_active_users: int | None
    word_enabled_users: int | None
    word_active_users: int | None
    powerpoint_enabled_users: int | None
    powerpoint_active_users: int | None
    outlook_enabled_users: int | None
    outlook_active_users: int | None
    excel_enabled_users: int | None
    excel_active_users: int | None
    onenote_enabled_users: int | None
    onenote_active_users: int | None
    loop_enabled_users: int | None
    loop_active_users: int | None
    copilot_chat_enabled_users: int | None
    copilot_chat_active_users: int | None
    raw_json: str | None = None


@dataclass
class ConsumptionRow:
    """A single Power Platform consumption record (one usage day/user/product)."""

    report_type: str
    usage_date: str
    environment_id: str | None
    environment_name: str | None
    user_id: str | None
    product: str | None
    quantity: float
    unit: str | None
    window_start: str | None = None
    window_end: str | None = None
    raw_json: str | None = None
    # Populated on read by joining the users table; ignored on write.
    display_name: str | None = None
    upn: str | None = None


@dataclass
class CopilotAdminDiagnosticRow:
    key: str
    label: str
    endpoint: str
    status: str
    status_code: int | None
    summary: str | None
    payload_json: str | None
    error: str | None
    captured_at: str


@dataclass
class CopilotAgentRow:
    id: str
    display_name: str | None
    app_identity: str | None
    app_external_id: str | None
    add_on_guid: str | None
    source: str
    status: str | None
    created_at: str | None
    updated_at: str | None
    raw_json: str | None
    captured_at: str
    last_activity_at: str | None = None
    last_activity_source: str | None = None
    usage_event_count: int = 0


@dataclass
class CopilotAgentActivityRow:
    agent: CopilotAgentRow
    threshold_days: int
    state: str
    is_stale: bool
    days_inactive: int | None
    confidence: str
    audit_coverage_start: str | None
    audit_coverage_end: str | None


@dataclass
class AuditCollectionState:
    source: str
    last_collected_at: str | None
    pending_query_id: str | None
    pending_submitted_at: str | None
    pending_window_start: str | None
    pending_window_end: str | None
    last_error: str | None
    last_error_at: str | None
    last_success_at: str | None
    last_record_count: int
    enabled: bool


@dataclass
class CollectionRunStats:
    id: int
    started_at: str
    finished_at: str | None
    users_processed: int
    interactions_fetched: int
    errors_count: int
    trigger: str


@dataclass
class EdiscoveryJob:
    id: str
    target_upn: str
    target_user_id: str | None
    window_start: str | None
    window_end: str | None
    status: str
    case_id: str | None
    search_id: str | None
    operation_url: str | None
    export_url: str | None
    interactions_added: int
    last_error: str | None
    last_error_at: str | None
    created_at: str
    updated_at: str


@contextmanager
def _connect(db_path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
    finally:
        conn.close()


def _load_schema_sql() -> str:
    return resources.files(SCHEMA_RESOURCE[0]).joinpath(SCHEMA_RESOURCE[1]).read_text(encoding="utf-8")


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply forward-only migrations on the connection.

    The schema script uses ``CREATE TABLE IF NOT EXISTS`` for everything,
    but it cannot add columns to tables that already exist. This helper
    closes that gap: when a v1 database is opened, it adds the v2
    ``interactions.thread_id`` column before the rest of the script
    declares indexes against it.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(interactions)").fetchall()}
    if cols and "thread_id" not in cols:
        log.info("Schema migration: adding interactions.thread_id (v1 -> v2)")
        conn.execute("ALTER TABLE interactions ADD COLUMN thread_id TEXT")
        cols.add("thread_id")
    if cols and "source_type" not in cols:
        log.info("Schema migration: adding interactions.source_type")
        conn.execute("ALTER TABLE interactions ADD COLUMN source_type TEXT NOT NULL DEFAULT 'api'")
        conn.execute(
            "UPDATE interactions SET source_type='ediscovery' "
            "WHERE id LIKE 'ediscovery:%' "
            "OR (json_valid(raw_json) AND json_extract(raw_json, '$.source') = 'ediscovery')"
        )

    thread_cols = {row[1] for row in conn.execute("PRAGMA table_info(conversation_threads)").fetchall()}
    if thread_cols and "source_type" not in thread_cols:
        log.info("Schema migration: adding conversation_threads.source_type")
        conn.execute("ALTER TABLE conversation_threads ADD COLUMN source_type TEXT NOT NULL DEFAULT 'api'")
        conn.execute(
            "UPDATE conversation_threads SET source_type='ediscovery' "
            "WHERE id IN ("
            "  SELECT DISTINCT thread_id FROM interactions "
            "  WHERE source_type='ediscovery' AND thread_id IS NOT NULL"
            ")"
        )


def initialize(db_path: Path) -> None:
    """Create tables/indexes/FTS if missing. Idempotent."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        _migrate(conn)
        conn.executescript(_load_schema_sql())


class Repository:
    """High-level operations against the SQLite store."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    # ---- settings ----------------------------------------------------

    def set_text_setting(self, key: str, value: str) -> None:
        with _connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value.encode("utf-8")),
            )

    def get_text_setting(self, key: str) -> str | None:
        with _connect(self.db_path) as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row is None or row["value"] is None:
            return None
        return bytes(row["value"]).decode("utf-8")

    def set_secret(self, key: str, blob: ProtectedBlob) -> None:
        with _connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, blob.data),
            )

    def get_secret(self, key: str) -> ProtectedBlob | None:
        with _connect(self.db_path) as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row is None or row["value"] is None:
            return None
        return ProtectedBlob(bytes(row["value"]))

    def delete_setting(self, key: str) -> None:
        with _connect(self.db_path) as conn:
            conn.execute("DELETE FROM settings WHERE key=?", (key,))

    # ---- destructive maintenance -------------------------------------

    def wipe_collected_data(self) -> dict[str, int]:
        """Erase all collected data while keeping app credentials/settings.

        Deletes from interactions, collection_state, collection_runs,
        users, and the interactions_fts shadow table. Settings (tenant
        id, client id, secrets, bootstrap_complete) are preserved so the
        app stays operable. Returns row counts deleted per table.
        """
        counts: dict[str, int] = {}
        with _connect(self.db_path) as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                for table in (
                    "interactions",
                    "conversation_threads",
                    "audit_events",
                    "audit_collection_state",
                    "copilot_usage_snapshots",
                    "copilot_usage_user_counts",
                    "copilot_admin_diagnostics",
                    "copilot_agents",
                    "ediscovery_jobs",
                    "collection_state",
                    "collection_runs",
                    "users",
                ):
                    # Tables created by v2 may not exist on very old
                    # installs that never re-ran the schema script.
                    try:
                        n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    except sqlite3.OperationalError:
                        continue
                    counts[table] = int(n)
                    conn.execute(f"DELETE FROM {table}")
                # Rebuild FTS index so storage shrinks and deleted bodies
                # are not recoverable via FTS internals.
                conn.execute(
                    "INSERT INTO interactions_fts(interactions_fts) VALUES('rebuild')"
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
            # VACUUM must run outside any transaction; reclaim file space
            # and let the WAL shrink on the next checkpoint.
            try:
                conn.execute("VACUUM")
            except sqlite3.OperationalError:
                # If another connection is holding a lock we silently
                # skip VACUUM \u2014 the data has still been deleted.
                log.warning("VACUUM skipped after wipe_collected_data (db busy)")
        log.info("Wiped collected data: %s", counts)
        return counts

    def wipe_credentials(self) -> int:
        """Erase app registration credentials and bootstrap state.

        Keeps any collected interactions/users; only removes the
        settings rows used to authenticate against Microsoft Graph.
        Returns the number of settings keys deleted.
        """
        keys = (
            "tenant_id",
            "client_id",
            "app_object_id",
            "sp_object_id",
            "display_name",
            "client_secret",
            "secret_expires_at",
            "bootstrap_complete",
        )
        deleted = 0
        with _connect(self.db_path) as conn:
            for key in keys:
                cur = conn.execute("DELETE FROM settings WHERE key=?", (key,))
                deleted += cur.rowcount or 0
        log.info("Wiped %d credential settings", deleted)
        return deleted

    # ---- users -------------------------------------------------------

    def upsert_users(self, users: Iterable[UserRow]) -> int:
        rows = [
            (u.id, u.upn, u.display_name, int(u.enabled), int(u.has_copilot_license), int(u.in_scope))
            for u in users
        ]
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO users(id, upn, display_name, enabled, has_copilot_license, in_scope, last_seen) "
                "VALUES(?,?,?,?,?,?, datetime('now')) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  upn=excluded.upn, "
                "  display_name=excluded.display_name, "
                "  enabled=excluded.enabled, "
                "  has_copilot_license=excluded.has_copilot_license, "
                "  in_scope=excluded.in_scope, "
                "  last_seen=datetime('now')",
                rows,
            )
        return len(rows)

    def mark_out_of_scope(self, in_scope_ids: set[str]) -> int:
        with _connect(self.db_path) as conn:
            if in_scope_ids:
                placeholders = ",".join("?" for _ in in_scope_ids)
                cur = conn.execute(
                    f"UPDATE users SET in_scope=0 WHERE id NOT IN ({placeholders}) AND in_scope=1",
                    tuple(in_scope_ids),
                )
            else:
                cur = conn.execute("UPDATE users SET in_scope=0 WHERE in_scope=1")
            return cur.rowcount

    def users_in_scope(self) -> list[UserRow]:
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, upn, display_name, enabled, has_copilot_license, in_scope "
                "FROM users WHERE in_scope=1 ORDER BY display_name COLLATE NOCASE"
            ).fetchall()
        return [
            UserRow(
                id=r["id"],
                upn=r["upn"],
                display_name=r["display_name"],
                enabled=bool(r["enabled"]),
                has_copilot_license=bool(r["has_copilot_license"]),
                in_scope=bool(r["in_scope"]),
            )
            for r in rows
        ]

    def users_with_interactions(self, *, source_type: str | None = None) -> list[UserRow]:
        source_clauses, source_params = _source_filter_clause(alias="i", source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT u.id, u.upn, u.display_name, u.enabled, u.has_copilot_license, u.in_scope, "
                "       MAX(i.created_at) AS last_activity_at "
                "FROM users u JOIN interactions i ON i.user_id = u.id "
                f"WHERE 1=1{source_sql} "
                "GROUP BY u.id ORDER BY last_activity_at DESC, COALESCE(u.display_name, u.upn, u.id) COLLATE NOCASE",
                source_params,
            ).fetchall()
        return [
            UserRow(
                id=r["id"],
                upn=r["upn"],
                display_name=r["display_name"],
                enabled=bool(r["enabled"]),
                has_copilot_license=bool(r["has_copilot_license"]),
                in_scope=bool(r["in_scope"]),
            )
            for r in rows
        ]

    def all_users(self) -> list[UserRow]:
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, upn, display_name, enabled, has_copilot_license, in_scope "
                "FROM users ORDER BY display_name COLLATE NOCASE"
            ).fetchall()
        return [
            UserRow(
                id=r["id"],
                upn=r["upn"],
                display_name=r["display_name"],
                enabled=bool(r["enabled"]),
                has_copilot_license=bool(r["has_copilot_license"]),
                in_scope=bool(r["in_scope"]),
            )
            for r in rows
        ]

    # ---- interactions ------------------------------------------------

    def upsert_interactions(self, items: Iterable[InteractionRow]) -> int:
        rows = [
            (
                i.id,
                i.user_id,
                i.session_id,
                i.request_id,
                i.created_at,
                i.interaction_type,
                i.app,
                i.body_text,
                i.body_content_type,
                i.attachments_json,
                i.raw_json,
                i.fetched_at,
                _normalise_source_type(i.source_type),
            )
            for i in items
        ]
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO interactions("
                "  id, user_id, session_id, request_id, created_at, interaction_type, "
                "  app, body_text, body_content_type, attachments_json, raw_json, fetched_at, source_type"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  user_id=excluded.user_id, "
                "  session_id=excluded.session_id, "
                "  request_id=excluded.request_id, "
                "  created_at=excluded.created_at, "
                "  interaction_type=excluded.interaction_type, "
                "  app=excluded.app, "
                "  body_text=excluded.body_text, "
                "  body_content_type=excluded.body_content_type, "
                "  attachments_json=excluded.attachments_json, "
                "  raw_json=excluded.raw_json, "
                "  fetched_at=excluded.fetched_at, "
                "  source_type=excluded.source_type",
                rows,
            )
        return len(rows)

    def existing_interaction_ids(self, ids: Iterable[str]) -> set[str]:
        unique_ids = tuple(sorted({item for item in ids if item}))
        if not unique_ids:
            return set()
        placeholders = ",".join("?" for _ in unique_ids)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                f"SELECT id FROM interactions WHERE id IN ({placeholders})",
                unique_ids,
            ).fetchall()
        return {str(row["id"]) for row in rows}

    def list_interactions(
        self,
        *,
        user_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        app: str | None = None,
        source_type: str | None = None,
        fts_query: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[InteractionRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if fts_query:
            clauses.append(
                "rowid IN (SELECT rowid FROM interactions_fts WHERE interactions_fts MATCH ?)"
            )
            params.append(fts_query)
        if user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        if date_from:
            clauses.append("created_at >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("created_at <= ?")
            params.append(date_to)
        if app:
            clauses.append("app = ?")
            params.append(app)
        if source_type:
            clauses.append("source_type = ?")
            params.append(_normalise_source_type(source_type))
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.extend([limit, offset])
        sql = (
            "SELECT id, user_id, session_id, request_id, created_at, interaction_type, "
            "       app, body_text, body_content_type, attachments_json, raw_json, fetched_at, "
            "       thread_id, source_type "
            f"FROM interactions {where} ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [
            InteractionRow(
                id=r["id"],
                user_id=r["user_id"],
                session_id=r["session_id"],
                request_id=r["request_id"],
                created_at=r["created_at"],
                interaction_type=r["interaction_type"],
                app=r["app"],
                body_text=r["body_text"],
                body_content_type=r["body_content_type"],
                attachments_json=r["attachments_json"],
                raw_json=r["raw_json"],
                fetched_at=r["fetched_at"],
                thread_id=r["thread_id"],
                source_type=r["source_type"],
            )
            for r in rows
        ]

    # ---- collection state -------------------------------------------

    def get_collection_state(self, user_id: str) -> tuple[str | None, bool]:
        with _connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT last_collected_at, backfill_complete FROM collection_state WHERE user_id=?",
                (user_id,),
            ).fetchone()
        if row is None:
            return None, False
        return row["last_collected_at"], bool(row["backfill_complete"])

    def update_collection_state(
        self,
        user_id: str,
        *,
        last_collected_at: str | None = None,
        backfill_complete: bool | None = None,
        last_error: str | None = None,
    ) -> None:
        with _connect(self.db_path) as conn:
            existing = conn.execute(
                "SELECT user_id FROM collection_state WHERE user_id=?", (user_id,)
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO collection_state(user_id, last_collected_at, backfill_complete, "
                    "  last_error, last_error_at) VALUES (?,?,?,?,?)",
                    (
                        user_id,
                        last_collected_at,
                        int(backfill_complete) if backfill_complete is not None else 0,
                        last_error,
                        datetime.now(timezone.utc).isoformat() if last_error else None,
                    ),
                )
                return
            sets: list[str] = []
            params: list[Any] = []
            if last_collected_at is not None:
                sets.append("last_collected_at=?")
                params.append(last_collected_at)
            if backfill_complete is not None:
                sets.append("backfill_complete=?")
                params.append(int(backfill_complete))
            if last_error is not None:
                sets.append("last_error=?")
                params.append(last_error)
                sets.append("last_error_at=?")
                params.append(datetime.now(timezone.utc).isoformat())
            if not sets:
                return
            params.append(user_id)
            conn.execute(f"UPDATE collection_state SET {', '.join(sets)} WHERE user_id=?", params)

    # ---- runs --------------------------------------------------------

    def start_run(self, trigger: str) -> int:
        with _connect(self.db_path) as conn:
            cur = conn.execute(
                "INSERT INTO collection_runs(started_at, trigger) VALUES (datetime('now'), ?)",
                (trigger,),
            )
            return int(cur.lastrowid)

    def finish_run(self, run_id: int, users: int, interactions: int, errors: int) -> None:
        with _connect(self.db_path) as conn:
            conn.execute(
                "UPDATE collection_runs SET finished_at=datetime('now'), "
                "users_processed=?, interactions_fetched=?, errors_count=? WHERE id=?",
                (users, interactions, errors, run_id),
            )

    def recent_runs(self, limit: int = 50) -> list[CollectionRunStats]:
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, started_at, finished_at, users_processed, interactions_fetched, "
                "errors_count, trigger FROM collection_runs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            CollectionRunStats(
                id=r["id"],
                started_at=r["started_at"],
                finished_at=r["finished_at"],
                users_processed=r["users_processed"],
                interactions_fetched=r["interactions_fetched"],
                errors_count=r["errors_count"],
                trigger=r["trigger"],
            )
            for r in rows
        ]

    # ---- statistics --------------------------------------------------

    def total_interactions(self, *, source_type: str | None = SOURCE_API) -> int:
        clauses, params = _source_filter_clause(source_type=source_type)
        where = f" WHERE {clauses[0]}" if clauses else ""
        with _connect(self.db_path) as conn:
            return int(conn.execute(f"SELECT COUNT(*) FROM interactions{where}", params).fetchone()[0])

    def total_users(self) -> int:
        with _connect(self.db_path) as conn:
            return int(conn.execute("SELECT COUNT(*) FROM users WHERE in_scope=1").fetchone()[0])

    def interactions_per_day(self, days: int = 30, *, source_type: str | None = SOURCE_API) -> list[tuple[str, int]]:
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT date(created_at) AS day, COUNT(*) AS n FROM interactions "
                f"WHERE created_at >= date('now', ?) {source_sql} "
                "GROUP BY day ORDER BY day",
                [f"-{days} day", *source_params],
            ).fetchall()
        return [(r["day"], r["n"]) for r in rows]

    def interactions_by_app(self, days: int = 30, *, source_type: str | None = SOURCE_API) -> list[tuple[str, int]]:
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT COALESCE(app, '(unknown)') AS app, COUNT(*) AS n FROM interactions "
                f"WHERE created_at >= date('now', ?) {source_sql} GROUP BY app ORDER BY n DESC",
                [f"-{days} day", *source_params],
            ).fetchall()
        return [(r["app"], r["n"]) for r in rows]

    def top_users(self, days: int = 30, limit: int = 10, *, source_type: str | None = SOURCE_API) -> list[tuple[str, str, int]]:
        source_clauses, source_params = _source_filter_clause(alias="i", source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT u.id, COALESCE(u.display_name, u.upn, u.id) AS name, COUNT(i.id) AS n "
                "FROM interactions i JOIN users u ON u.id = i.user_id "
                f"WHERE i.created_at >= date('now', ?) {source_sql} "
                "GROUP BY u.id ORDER BY n DESC LIMIT ?",
                [f"-{days} day", *source_params, limit],
            ).fetchall()
        return [(r["id"], r["name"], r["n"]) for r in rows]

    # ---- conversation threads (v2) ----------------------------------

    def upsert_threads(self, threads: Iterable[Any], *, source_type: str = SOURCE_API) -> int:
        """Insert or replace thread rows.

        Accepts ``threading_engine.ThreadGroup`` instances directly so
        the worker can pass results from compute_threads without an
        intermediate conversion.
        """
        rows: list[tuple[Any, ...]] = []
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        source = _normalise_source_type(source_type)
        for t in threads:
            rows.append(
                (
                    t.id,
                    t.user_id,
                    t.started_at,
                    t.ended_at,
                    t.app,
                    int(t.turn_count),
                    int(t.prompt_count),
                    int(t.response_count),
                    json.dumps(list(t.session_ids), ensure_ascii=False),
                    json.dumps(list(t.topic_keywords), ensure_ascii=False),
                    t.title,
                    getattr(t, "cluster_label", None),
                    now,
                    source,
                )
            )
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO conversation_threads("
                "  id, user_id, started_at, ended_at, app, turn_count, prompt_count, "
                "  response_count, session_ids, topic_keywords, title, cluster_label, computed_at, source_type"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  started_at=excluded.started_at, "
                "  ended_at=excluded.ended_at, "
                "  app=excluded.app, "
                "  turn_count=excluded.turn_count, "
                "  prompt_count=excluded.prompt_count, "
                "  response_count=excluded.response_count, "
                "  session_ids=excluded.session_ids, "
                "  topic_keywords=excluded.topic_keywords, "
                "  title=excluded.title, "
                "  cluster_label=COALESCE(excluded.cluster_label, conversation_threads.cluster_label), "
                "  computed_at=excluded.computed_at, "
                "  source_type=excluded.source_type",
                rows,
            )
        return len(rows)

    def assign_threads_to_interactions(
        self, mapping: Iterable[tuple[str, str]]
    ) -> int:
        """Stamp ``thread_id`` onto each interaction.

        ``mapping`` yields ``(interaction_id, thread_id)`` tuples.
        """
        rows = list(mapping)
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "UPDATE interactions SET thread_id=? WHERE id=?",
                [(thread_id, iid) for iid, thread_id in rows],
            )
        return len(rows)

    def delete_user_threads(self, user_id: str, *, source_type: str | None = None) -> int:
        """Remove threads + clear thread_id on a user's interactions.

        Used before re-computing threads for that user so we never leak
        stale clusters when interactions get re-fetched.
        """
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        interaction_source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        thread_source_clauses, thread_source_params = _source_filter_clause(alias="conversation_threads", source_type=source_type)
        thread_source_sql = "" if not thread_source_clauses else " AND " + " AND ".join(thread_source_clauses)
        with _connect(self.db_path) as conn:
            conn.execute(
                f"UPDATE interactions SET thread_id=NULL WHERE user_id=?{interaction_source_sql}",
                [user_id, *source_params],
            )
            cur = conn.execute(
                f"DELETE FROM conversation_threads WHERE user_id=?{thread_source_sql}",
                [user_id, *thread_source_params],
            )
            return cur.rowcount or 0

    def list_threads(
        self,
        *,
        user_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        app: str | None = None,
        search: str | None = None,
        search_scope: str = "title",
        source_type: str | None = SOURCE_API,
        limit: int = 200,
        offset: int = 0,
    ) -> list[ThreadRow]:
        search = (search or "").strip() or None
        scope = (search_scope or "title").strip().lower()
        if scope not in ("title", "body", "all"):
            scope = "title"
        norm_source = _normalise_source_type(source_type) if source_type else None

        with _connect(self.db_path) as conn:
            snippet_map: dict[str, str] = {}
            if search and scope in ("body", "all"):
                snippet_map = _fts_body_snippets(conn, search, norm_source)
            body_ids = list(snippet_map.keys())

            clauses: list[str] = []
            params: list[Any] = []
            if user_id:
                clauses.append("t.user_id = ?")
                params.append(user_id)
            if date_from:
                clauses.append("t.started_at >= ?")
                params.append(date_from)
            if date_to:
                clauses.append("t.started_at <= ?")
                params.append(date_to)
            if app:
                clauses.append("t.app = ?")
                params.append(app)
            if search:
                if scope == "title":
                    clauses.append("t.title LIKE ?")
                    params.append(f"%{search}%")
                elif scope == "body":
                    if not body_ids:
                        return []
                    placeholders = ",".join("?" for _ in body_ids)
                    clauses.append(f"t.id IN ({placeholders})")
                    params.extend(body_ids)
                else:  # all: title OR body
                    sub = ["t.title LIKE ?"]
                    params.append(f"%{search}%")
                    if body_ids:
                        placeholders = ",".join("?" for _ in body_ids)
                        sub.append(f"t.id IN ({placeholders})")
                        params.extend(body_ids)
                    clauses.append("(" + " OR ".join(sub) + ")")
            if norm_source:
                clauses.append("t.source_type = ?")
                params.append(norm_source)
            where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
            params.extend([limit, offset])
            sql = (
                "SELECT t.id, t.user_id, t.started_at, t.ended_at, t.app, t.turn_count, "
                "       t.prompt_count, t.response_count, t.session_ids, t.topic_keywords, "
                "       t.title, t.cluster_label, t.computed_at, t.source_type, u.display_name, u.upn "
                "FROM conversation_threads t LEFT JOIN users u ON u.id = t.user_id "
                f"{where} ORDER BY t.started_at DESC LIMIT ? OFFSET ?"
            )
            rows = conn.execute(sql, params).fetchall()

        threads = [_row_to_thread(r) for r in rows]
        for thread in threads:
            snippet = snippet_map.get(thread.id)
            if snippet:
                thread.match_snippet = snippet
                thread.body_match = True
        return threads

    def thread_apps(self, *, source_type: str | None = SOURCE_API) -> list[str]:
        """Distinct, non-null app identifiers for the thread app filter dropdown."""
        norm_source = _normalise_source_type(source_type) if source_type else None
        sql = "SELECT DISTINCT app FROM conversation_threads"
        params: list[Any] = []
        if norm_source:
            sql += " WHERE source_type = ?"
            params.append(norm_source)
        sql += " ORDER BY app"
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [r[0] for r in rows if r[0]]


    def get_thread(self, thread_id: str, *, source_type: str | None = None) -> ThreadRow | None:
        source_clauses, source_params = _source_filter_clause(alias="t", source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT t.id, t.user_id, t.started_at, t.ended_at, t.app, t.turn_count, "
                "       t.prompt_count, t.response_count, t.session_ids, t.topic_keywords, "
                "       t.title, t.cluster_label, t.computed_at, t.source_type, u.display_name, u.upn "
                "FROM conversation_threads t LEFT JOIN users u ON u.id = t.user_id "
                f"WHERE t.id = ?{source_sql}",
                [thread_id, *source_params],
            ).fetchone()
        return _row_to_thread(r) if r else None

    def thread_turns(self, thread_id: str, *, source_type: str | None = None) -> list[InteractionRow]:
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, user_id, session_id, request_id, created_at, interaction_type, "
                "       app, body_text, body_content_type, attachments_json, raw_json, "
                "       fetched_at, thread_id, source_type "
                f"FROM interactions WHERE thread_id = ?{source_sql} ORDER BY created_at ASC",
                [thread_id, *source_params],
            ).fetchall()
        return [
            InteractionRow(
                id=r["id"],
                user_id=r["user_id"],
                session_id=r["session_id"],
                request_id=r["request_id"],
                created_at=r["created_at"],
                interaction_type=r["interaction_type"],
                app=r["app"],
                body_text=r["body_text"],
                body_content_type=r["body_content_type"],
                attachments_json=r["attachments_json"],
                raw_json=r["raw_json"],
                fetched_at=r["fetched_at"],
                thread_id=r["thread_id"],
                source_type=r["source_type"],
            )
            for r in rows
        ]

    def thread_count(self, *, source_type: str | None = SOURCE_API) -> int:
        clauses, params = _source_filter_clause(source_type=source_type)
        where = f" WHERE {clauses[0]}" if clauses else ""
        with _connect(self.db_path) as conn:
            return int(
                conn.execute(f"SELECT COUNT(*) FROM conversation_threads{where}", params).fetchone()[0]
            )

    def interactions_for_user(self, user_id: str, *, source_type: str | None = None) -> list[InteractionRow]:
        """Pull every interaction for a single user (used by threader)."""
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, user_id, session_id, request_id, created_at, interaction_type, "
                "       app, body_text, body_content_type, attachments_json, raw_json, "
                "       fetched_at, thread_id, source_type "
                f"FROM interactions WHERE user_id = ?{source_sql} ORDER BY created_at ASC",
                [user_id, *source_params],
            ).fetchall()
        return [
            InteractionRow(
                id=r["id"],
                user_id=r["user_id"],
                session_id=r["session_id"],
                request_id=r["request_id"],
                created_at=r["created_at"],
                interaction_type=r["interaction_type"],
                app=r["app"],
                body_text=r["body_text"],
                body_content_type=r["body_content_type"],
                attachments_json=r["attachments_json"],
                raw_json=r["raw_json"],
                fetched_at=r["fetched_at"],
                thread_id=r["thread_id"],
                source_type=r["source_type"],
            )
            for r in rows
        ]

    # ---- audit events (v2) ------------------------------------------

    def upsert_audit_events(self, events: Iterable[AuditEventRow]) -> int:
        rows = [
            (
                e.id,
                e.source,
                e.event_time,
                e.user_id,
                e.upn,
                e.operation,
                e.workload,
                e.app,
                e.target_resources,
                e.client_ip,
                e.result,
                e.raw_json,
                e.fetched_at,
            )
            for e in events
        ]
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO audit_events("
                "  id, source, event_time, user_id, upn, operation, workload, app, "
                "  target_resources, client_ip, result, raw_json, fetched_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  source=excluded.source, "
                "  event_time=excluded.event_time, "
                "  user_id=excluded.user_id, "
                "  upn=excluded.upn, "
                "  operation=excluded.operation, "
                "  workload=excluded.workload, "
                "  app=excluded.app, "
                "  target_resources=excluded.target_resources, "
                "  client_ip=excluded.client_ip, "
                "  result=excluded.result, "
                "  raw_json=excluded.raw_json, "
                "  fetched_at=excluded.fetched_at",
                rows,
            )
        return len(rows)

    def list_audit_events(
        self,
        *,
        source: str | None = None,
        user_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        search: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[AuditEventRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if source:
            clauses.append("source = ?")
            params.append(source)
        if user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        if date_from:
            clauses.append("event_time >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("event_time <= ?")
            params.append(date_to)
        if search:
            needle = f"%{search.strip().lower()}%"
            clauses.append(
                "LOWER("
                "COALESCE(upn,'') || ' ' || COALESCE(user_id,'') || ' ' || "
                "COALESCE(operation,'') || ' ' || COALESCE(workload,'') || ' ' || "
                "COALESCE(app,'') || ' ' || COALESCE(result,'') || ' ' || "
                "COALESCE(client_ip,'')"
                ") LIKE ?"
            )
            params.append(needle)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.extend([limit, offset])
        sql = (
            "SELECT id, source, event_time, user_id, upn, operation, workload, app, "
            "       target_resources, client_ip, result, raw_json, fetched_at "
            f"FROM audit_events {where} ORDER BY event_time DESC LIMIT ? OFFSET ?"
        )
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_audit_event(r) for r in rows]

    def audit_events_for_user(self, user_id: str, upn: str | None = None) -> list[AuditEventRow]:
        identities = {user_id.lower()}
        if upn:
            identities.add(upn.lower())
        placeholders = ",".join("?" for _ in identities)
        params = list(identities) + list(identities)
        sql = (
            "SELECT id, source, event_time, user_id, upn, operation, workload, app, "
            "       target_resources, client_ip, result, raw_json, fetched_at "
            "FROM audit_events "
            "WHERE source = 'purview' AND ("
            f"LOWER(COALESCE(user_id,'')) IN ({placeholders}) OR "
            f"LOWER(COALESCE(upn,'')) IN ({placeholders})"
            ") ORDER BY event_time ASC"
        )
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [
            AuditEventRow(
                id=r["id"],
                source=r["source"],
                event_time=r["event_time"],
                user_id=r["user_id"],
                upn=r["upn"],
                operation=r["operation"],
                workload=r["workload"],
                app=r["app"],
                target_resources=r["target_resources"],
                client_ip=r["client_ip"],
                result=r["result"],
                raw_json=r["raw_json"],
                fetched_at=r["fetched_at"],
            )
            for r in rows
        ]

    def audit_events_for_thread(
        self,
        thread: ThreadRow,
        *,
        window_seconds: int = 180,
    ) -> list[AuditEventRow]:
        """Return Purview audit events close to a conversation thread.

        Purview events for Copilot interactions can land a little before or
        after the interactionHistory timestamp, so the query expands the window
        on both sides. Matching is user/upn scoped to avoid unrelated tenant
        events appearing in the thread transcript.
        """
        identities = {thread.user_id.lower()}
        if thread.upn:
            identities.add(thread.upn.lower())
        placeholders = ",".join("?" for _ in identities)
        params: list[Any] = [
            thread.started_at,
            f"-{window_seconds} seconds",
            thread.ended_at,
            f"+{window_seconds} seconds",
        ]
        params.extend(list(identities))
        params.extend(list(identities))
        sql = (
            "SELECT id, source, event_time, user_id, upn, operation, workload, app, "
            "       target_resources, client_ip, result, raw_json, fetched_at "
            "FROM audit_events "
            "WHERE source = 'purview' "
            "  AND datetime(event_time) BETWEEN datetime(?, ?) AND datetime(?, ?) "
            "  AND ("
            f"LOWER(COALESCE(user_id,'')) IN ({placeholders}) OR "
            f"LOWER(COALESCE(upn,'')) IN ({placeholders})"
            ") ORDER BY event_time ASC"
        )
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_audit_event(r) for r in rows]

    def get_audit_collection_state(self, source: str) -> AuditCollectionState | None:
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT source, last_collected_at, pending_query_id, pending_submitted_at, "
                "       pending_window_start, pending_window_end, last_error, last_error_at, "
                "       last_success_at, last_record_count, enabled "
                "FROM audit_collection_state WHERE source = ?",
                (source,),
            ).fetchone()
        if r is None:
            return None
        return AuditCollectionState(
            source=r["source"],
            last_collected_at=r["last_collected_at"],
            pending_query_id=r["pending_query_id"],
            pending_submitted_at=r["pending_submitted_at"],
            pending_window_start=r["pending_window_start"],
            pending_window_end=r["pending_window_end"],
            last_error=r["last_error"],
            last_error_at=r["last_error_at"],
            last_success_at=r["last_success_at"],
            last_record_count=int(r["last_record_count"] or 0),
            enabled=bool(r["enabled"]),
        )

    def update_audit_collection_state(self, state: AuditCollectionState) -> None:
        with _connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO audit_collection_state("
                "  source, last_collected_at, pending_query_id, pending_submitted_at, "
                "  pending_window_start, pending_window_end, last_error, last_error_at, "
                "  last_success_at, last_record_count, enabled"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(source) DO UPDATE SET "
                "  last_collected_at=excluded.last_collected_at, "
                "  pending_query_id=excluded.pending_query_id, "
                "  pending_submitted_at=excluded.pending_submitted_at, "
                "  pending_window_start=excluded.pending_window_start, "
                "  pending_window_end=excluded.pending_window_end, "
                "  last_error=excluded.last_error, "
                "  last_error_at=excluded.last_error_at, "
                "  last_success_at=excluded.last_success_at, "
                "  last_record_count=excluded.last_record_count, "
                "  enabled=excluded.enabled",
                (
                    state.source,
                    state.last_collected_at,
                    state.pending_query_id,
                    state.pending_submitted_at,
                    state.pending_window_start,
                    state.pending_window_end,
                    state.last_error,
                    state.last_error_at,
                    state.last_success_at,
                    int(state.last_record_count),
                    int(state.enabled),
                ),
            )

    # ---- eDiscovery jobs (v4) ---------------------------------------

    def upsert_ediscovery_job(self, job: EdiscoveryJob) -> None:
        with _connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO ediscovery_jobs("
                "  id, target_upn, target_user_id, window_start, window_end, status, "
                "  case_id, search_id, operation_url, export_url, interactions_added, "
                "  last_error, last_error_at, created_at, updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  target_user_id=excluded.target_user_id, "
                "  window_start=excluded.window_start, "
                "  window_end=excluded.window_end, "
                "  status=excluded.status, "
                "  case_id=excluded.case_id, "
                "  search_id=excluded.search_id, "
                "  operation_url=excluded.operation_url, "
                "  export_url=excluded.export_url, "
                "  interactions_added=excluded.interactions_added, "
                "  last_error=excluded.last_error, "
                "  last_error_at=excluded.last_error_at, "
                "  updated_at=excluded.updated_at",
                (
                    job.id,
                    job.target_upn,
                    job.target_user_id,
                    job.window_start,
                    job.window_end,
                    job.status,
                    job.case_id,
                    job.search_id,
                    job.operation_url,
                    job.export_url,
                    int(job.interactions_added),
                    job.last_error,
                    job.last_error_at,
                    job.created_at,
                    job.updated_at,
                ),
            )

    def get_ediscovery_job(self, job_id: str) -> EdiscoveryJob | None:
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT id, target_upn, target_user_id, window_start, window_end, status, "
                "       case_id, search_id, operation_url, export_url, interactions_added, "
                "       last_error, last_error_at, created_at, updated_at "
                "FROM ediscovery_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        return _row_to_ediscovery_job(r) if r is not None else None

    def list_ediscovery_jobs(self, *, limit: int = 50) -> list[EdiscoveryJob]:
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, target_upn, target_user_id, window_start, window_end, status, "
                "       case_id, search_id, operation_url, export_url, interactions_added, "
                "       last_error, last_error_at, created_at, updated_at "
                "FROM ediscovery_jobs ORDER BY created_at DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [_row_to_ediscovery_job(r) for r in rows]

    # ---- usage snapshots (v2) ---------------------------------------

    def upsert_usage_snapshots(self, snaps: Iterable[UsageSnapshotRow]) -> int:

        rows: list[tuple[Any, ...]] = []
        for s in snaps:
            user_key = s.user_id or s.upn or "_total"
            sid = hashlib.sha1(
                f"{s.snapshot_date}|{s.period}|{user_key}".encode("utf-8")
            ).hexdigest()[:32]
            rows.append(
                (
                    sid,
                    s.snapshot_date,
                    s.user_id,
                    s.upn,
                    user_key,
                    s.period,
                    s.display_name,
                    s.last_activity_overall,
                    s.last_activity_teams,
                    s.last_activity_word,
                    s.last_activity_excel,
                    s.last_activity_powerpoint,
                    s.last_activity_outlook,
                    s.last_activity_onenote,
                    s.last_activity_loop,
                    s.last_activity_bizchat,
                    s.raw_json,
                )
            )
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO copilot_usage_snapshots("
                "  id, snapshot_date, user_id, upn, user_key, period, display_name, "
                "  last_activity_overall, last_activity_teams, last_activity_word, "
                "  last_activity_excel, last_activity_powerpoint, last_activity_outlook, "
                "  last_activity_onenote, last_activity_loop, last_activity_bizchat, raw_json"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  display_name=excluded.display_name, "
                "  last_activity_overall=excluded.last_activity_overall, "
                "  last_activity_teams=excluded.last_activity_teams, "
                "  last_activity_word=excluded.last_activity_word, "
                "  last_activity_excel=excluded.last_activity_excel, "
                "  last_activity_powerpoint=excluded.last_activity_powerpoint, "
                "  last_activity_outlook=excluded.last_activity_outlook, "
                "  last_activity_onenote=excluded.last_activity_onenote, "
                "  last_activity_loop=excluded.last_activity_loop, "
                "  last_activity_bizchat=excluded.last_activity_bizchat, "
                "  raw_json=excluded.raw_json",
                rows,
            )
        return len(rows)

    def latest_usage_snapshot_date(self, period: str = "D30") -> str | None:
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT MAX(snapshot_date) AS d FROM copilot_usage_snapshots WHERE period = ?",
                (period,),
            ).fetchone()
        return r["d"] if r and r["d"] else None

    def list_usage_snapshots(
        self,
        *,
        period: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        search: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[UsageSnapshotRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if period:
            clauses.append("period = ?")
            params.append(period)
        if date_from:
            clauses.append("snapshot_date >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("snapshot_date <= ?")
            params.append(date_to)
        if search:
            needle = f"%{search.strip().lower()}%"
            clauses.append(
                "LOWER(COALESCE(display_name,'') || ' ' || COALESCE(upn,'') || ' ' || "
                "COALESCE(user_id,'') || ' ' || COALESCE(user_key,'')) LIKE ?"
            )
            params.append(needle)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.extend([limit, offset])
        sql = (
            "SELECT snapshot_date, user_id, upn, period, display_name, "
            "       last_activity_overall, last_activity_teams, last_activity_word, "
            "       last_activity_excel, last_activity_powerpoint, last_activity_outlook, "
            "       last_activity_onenote, last_activity_loop, last_activity_bizchat, raw_json "
            f"FROM copilot_usage_snapshots {where} "
            "ORDER BY snapshot_date DESC, display_name COLLATE NOCASE, upn COLLATE NOCASE "
            "LIMIT ? OFFSET ?"
        )
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_usage_snapshot(r) for r in rows]

    # ---- Power Platform consumption -------------------------------

    def upsert_consumption_rows(self, rows_in: Iterable[ConsumptionRow]) -> int:
        """Insert/replace consumption rows. Returns the number written."""
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows: list[tuple[Any, ...]] = []
        for c in rows_in:
            user_key = c.user_id or (
                f"_env:{c.environment_id}" if c.environment_id else "_total"
            )
            product = c.product or ""
            row_id = hashlib.sha1(
                f"{c.report_type}|{c.usage_date}|{user_key}|{product}".encode("utf-8")
            ).hexdigest()[:32]
            rows.append(
                (
                    row_id,
                    c.report_type,
                    c.usage_date,
                    c.environment_id,
                    c.environment_name,
                    c.user_id,
                    user_key,
                    c.product,
                    float(c.quantity or 0.0),
                    c.unit,
                    c.window_start,
                    c.window_end,
                    c.raw_json,
                    now,
                )
            )
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO power_platform_consumption("
                "  id, report_type, usage_date, environment_id, environment_name, "
                "  user_id, user_key, product, quantity, unit, window_start, window_end, "
                "  raw_json, captured_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  environment_name=excluded.environment_name, "
                "  quantity=excluded.quantity, "
                "  unit=excluded.unit, "
                "  window_start=excluded.window_start, "
                "  window_end=excluded.window_end, "
                "  raw_json=excluded.raw_json, "
                "  captured_at=excluded.captured_at",
                rows,
            )
        return len(rows)

    def list_consumption_rows(
        self,
        *,
        report_type: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        user_id: str | None = None,
        search: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[ConsumptionRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if report_type:
            clauses.append("c.report_type = ?")
            params.append(report_type)
        if date_from:
            clauses.append("c.usage_date >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("c.usage_date <= ?")
            params.append(date_to)
        if user_id:
            clauses.append("c.user_id = ?")
            params.append(user_id)
        if search:
            needle = f"%{search.strip().lower()}%"
            clauses.append(
                "LOWER(COALESCE(u.display_name,'') || ' ' || COALESCE(u.upn,'') || ' ' || "
                "COALESCE(c.user_id,'') || ' ' || COALESCE(c.environment_name,'') || ' ' || "
                "COALESCE(c.product,'')) LIKE ?"
            )
            params.append(needle)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.extend([limit, offset])
        sql = (
            "SELECT c.report_type, c.usage_date, c.environment_id, c.environment_name, "
            "       c.user_id, c.product, c.quantity, c.unit, c.window_start, c.window_end, "
            "       c.raw_json, u.display_name AS display_name, u.upn AS upn "
            "FROM power_platform_consumption c "
            "LEFT JOIN users u ON u.id = c.user_id "
            f"{where} "
            "ORDER BY c.usage_date DESC, c.quantity DESC "
            "LIMIT ? OFFSET ?"
        )
        with _connect(self.db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_consumption(r) for r in rows]

    def consumption_daily_totals(
        self, *, report_type: str, days: int = 30
    ) -> list[tuple[str, float]]:
        """Return [(usage_date, total_quantity)] ascending for the last N days."""
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT usage_date, SUM(quantity) AS total "
                "FROM power_platform_consumption "
                "WHERE report_type = ? AND usage_date >= date('now', ?) "
                "GROUP BY usage_date ORDER BY usage_date ASC",
                (report_type, f"-{int(days)} day"),
            ).fetchall()
        return [(r["usage_date"], float(r["total"] or 0.0)) for r in rows]

    def consumption_top_users(
        self, *, report_type: str, days: int = 30, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Return the heaviest consumers for a report type over the window."""
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT c.user_id AS user_id, "
                "       COALESCE(u.display_name, c.user_id, '(환경 단위)') AS display_name, "
                "       u.upn AS upn, "
                "       SUM(c.quantity) AS total "
                "FROM power_platform_consumption c "
                "LEFT JOIN users u ON u.id = c.user_id "
                "WHERE c.report_type = ? AND c.usage_date >= date('now', ?) "
                "GROUP BY c.user_key "
                "ORDER BY total DESC LIMIT ?",
                (report_type, f"-{int(days)} day", int(limit)),
            ).fetchall()
        return [
            {
                "user_id": r["user_id"],
                "display_name": r["display_name"],
                "upn": r["upn"],
                "total": float(r["total"] or 0.0),
            }
            for r in rows
        ]

    def consumption_summary(self, *, report_type: str, days: int = 30) -> dict[str, Any]:
        """Aggregate KPIs for one report type over the window."""
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT SUM(quantity) AS total, "
                "       COUNT(DISTINCT CASE WHEN user_id IS NOT NULL AND user_id <> '' "
                "                           THEN user_id END) AS users, "
                "       COUNT(DISTINCT CASE WHEN environment_id IS NOT NULL AND environment_id <> '' "
                "                           THEN environment_id END) AS environments, "
                "       MAX(usage_date) AS latest_date, "
                "       MIN(usage_date) AS earliest_date, "
                "       MAX(unit) AS unit "
                "FROM power_platform_consumption "
                "WHERE report_type = ? AND usage_date >= date('now', ?)",
                (report_type, f"-{int(days)} day"),
            ).fetchone()
        total = float(r["total"] or 0.0) if r else 0.0
        earliest = r["earliest_date"] if r else None
        latest = r["latest_date"] if r else None
        # Linear projection to a 30-day month based on observed daily average.
        active_days = 0
        if earliest and latest:
            try:
                d0 = datetime.fromisoformat(earliest)
                d1 = datetime.fromisoformat(latest)
                active_days = max((d1 - d0).days + 1, 1)
            except ValueError:
                active_days = 0
        projected_month = (total / active_days * 30.0) if active_days else 0.0
        return {
            "report_type": report_type,
            "total": total,
            "users": int(r["users"] or 0) if r else 0,
            "environments": int(r["environments"] or 0) if r else 0,
            "latest_date": latest,
            "earliest_date": earliest,
            "unit": (r["unit"] if r else None),
            "projected_month": projected_month,
        }

    def upsert_usage_count_rows(self, rows_in: Iterable[UsageCountRow]) -> int:
        import hashlib

        rows: list[tuple[Any, ...]] = []
        for row in rows_in:
            row_id = hashlib.sha1(
                f"{row.report_type}|{row.report_refresh_date}|{row.period}|{row.report_date or '_summary'}".encode(
                    "utf-8"
                )
            ).hexdigest()[:32]
            rows.append(
                (
                    row_id,
                    row.report_type,
                    row.report_refresh_date,
                    row.period,
                    row.report_date,
                    row.any_app_enabled_users,
                    row.any_app_active_users,
                    row.teams_enabled_users,
                    row.teams_active_users,
                    row.word_enabled_users,
                    row.word_active_users,
                    row.powerpoint_enabled_users,
                    row.powerpoint_active_users,
                    row.outlook_enabled_users,
                    row.outlook_active_users,
                    row.excel_enabled_users,
                    row.excel_active_users,
                    row.onenote_enabled_users,
                    row.onenote_active_users,
                    row.loop_enabled_users,
                    row.loop_active_users,
                    row.copilot_chat_enabled_users,
                    row.copilot_chat_active_users,
                    row.raw_json,
                )
            )
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO copilot_usage_user_counts("
                "  id, report_type, report_refresh_date, period, report_date, "
                "  any_app_enabled_users, any_app_active_users, teams_enabled_users, teams_active_users, "
                "  word_enabled_users, word_active_users, powerpoint_enabled_users, powerpoint_active_users, "
                "  outlook_enabled_users, outlook_active_users, excel_enabled_users, excel_active_users, "
                "  onenote_enabled_users, onenote_active_users, loop_enabled_users, loop_active_users, "
                "  copilot_chat_enabled_users, copilot_chat_active_users, raw_json"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  any_app_enabled_users=excluded.any_app_enabled_users, "
                "  any_app_active_users=excluded.any_app_active_users, "
                "  teams_enabled_users=excluded.teams_enabled_users, "
                "  teams_active_users=excluded.teams_active_users, "
                "  word_enabled_users=excluded.word_enabled_users, "
                "  word_active_users=excluded.word_active_users, "
                "  powerpoint_enabled_users=excluded.powerpoint_enabled_users, "
                "  powerpoint_active_users=excluded.powerpoint_active_users, "
                "  outlook_enabled_users=excluded.outlook_enabled_users, "
                "  outlook_active_users=excluded.outlook_active_users, "
                "  excel_enabled_users=excluded.excel_enabled_users, "
                "  excel_active_users=excluded.excel_active_users, "
                "  onenote_enabled_users=excluded.onenote_enabled_users, "
                "  onenote_active_users=excluded.onenote_active_users, "
                "  loop_enabled_users=excluded.loop_enabled_users, "
                "  loop_active_users=excluded.loop_active_users, "
                "  copilot_chat_enabled_users=excluded.copilot_chat_enabled_users, "
                "  copilot_chat_active_users=excluded.copilot_chat_active_users, "
                "  raw_json=excluded.raw_json",
                rows,
            )
        return len(rows)

    def list_usage_count_rows(
        self,
        *,
        report_type: str | None = None,
        period: str | None = None,
        limit: int = 500,
    ) -> list[UsageCountRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if report_type:
            clauses.append("report_type = ?")
            params.append(report_type)
        if period:
            clauses.append("period = ?")
            params.append(period)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(limit)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT report_type, report_refresh_date, period, report_date, "
                "       any_app_enabled_users, any_app_active_users, teams_enabled_users, teams_active_users, "
                "       word_enabled_users, word_active_users, powerpoint_enabled_users, powerpoint_active_users, "
                "       outlook_enabled_users, outlook_active_users, excel_enabled_users, excel_active_users, "
                "       onenote_enabled_users, onenote_active_users, loop_enabled_users, loop_active_users, "
                "       copilot_chat_enabled_users, copilot_chat_active_users, raw_json "
                f"FROM copilot_usage_user_counts {where} "
                "ORDER BY report_refresh_date DESC, report_date DESC LIMIT ?",
                params,
            ).fetchall()
        return [_row_to_usage_count(r) for r in rows]

    def upsert_copilot_admin_diagnostics(
        self, rows_in: Iterable[CopilotAdminDiagnosticRow]
    ) -> int:
        rows = [
            (
                row.key,
                row.label,
                row.endpoint,
                row.status,
                row.status_code,
                row.summary,
                row.payload_json,
                row.error,
                row.captured_at,
            )
            for row in rows_in
        ]
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO copilot_admin_diagnostics("
                "  key, label, endpoint, status, status_code, summary, payload_json, error, captured_at"
                ") VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET "
                "  label=excluded.label, "
                "  endpoint=excluded.endpoint, "
                "  status=excluded.status, "
                "  status_code=excluded.status_code, "
                "  summary=excluded.summary, "
                "  payload_json=excluded.payload_json, "
                "  error=excluded.error, "
                "  captured_at=excluded.captured_at",
                rows,
            )
        return len(rows)

    def list_copilot_admin_diagnostics(self) -> list[CopilotAdminDiagnosticRow]:
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT key, label, endpoint, status, status_code, summary, payload_json, error, captured_at "
                "FROM copilot_admin_diagnostics ORDER BY label COLLATE NOCASE"
            ).fetchall()
        return [_row_to_admin_diagnostic(r) for r in rows]

    def upsert_copilot_agents(self, rows_in: Iterable[CopilotAgentRow]) -> int:
        rows = [
            (
                row.id,
                row.display_name,
                row.app_identity,
                row.app_external_id,
                row.add_on_guid,
                row.source,
                row.status,
                row.created_at,
                row.updated_at,
                row.raw_json,
                row.captured_at,
                row.last_activity_at,
                row.last_activity_source,
                int(row.usage_event_count or 0),
            )
            for row in rows_in
            if row.id
        ]
        if not rows:
            return 0
        with _connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO copilot_agents("
                "  id, display_name, app_identity, app_external_id, add_on_guid, source, status, "
                "  created_at, updated_at, raw_json, captured_at, last_activity_at, "
                "  last_activity_source, usage_event_count"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "  display_name=COALESCE(excluded.display_name, copilot_agents.display_name), "
                "  app_identity=COALESCE(excluded.app_identity, copilot_agents.app_identity), "
                "  app_external_id=COALESCE(excluded.app_external_id, copilot_agents.app_external_id), "
                "  add_on_guid=COALESCE(excluded.add_on_guid, copilot_agents.add_on_guid), "
                "  source=excluded.source, "
                "  status=COALESCE(excluded.status, copilot_agents.status), "
                "  created_at=COALESCE(excluded.created_at, copilot_agents.created_at), "
                "  updated_at=COALESCE(excluded.updated_at, copilot_agents.updated_at), "
                "  raw_json=excluded.raw_json, "
                "  captured_at=excluded.captured_at, "
                "  last_activity_at=COALESCE(excluded.last_activity_at, copilot_agents.last_activity_at), "
                "  last_activity_source=COALESCE(excluded.last_activity_source, copilot_agents.last_activity_source), "
                "  usage_event_count=CASE "
                "    WHEN excluded.usage_event_count > 0 THEN excluded.usage_event_count "
                "    ELSE copilot_agents.usage_event_count END",
                rows,
            )
        return len(rows)

    def replace_copilot_agents_for_source(self, source: str, rows_in: Iterable[CopilotAgentRow]) -> int:
        rows = [row for row in rows_in if row.source == source]
        with _connect(self.db_path) as conn:
            conn.execute("DELETE FROM copilot_agents WHERE source = ?", (source,))
        return self.upsert_copilot_agents(rows)

    def list_copilot_agents(
        self,
        *,
        search: str | None = None,
        limit: int = 1000,
        offset: int = 0,
    ) -> list[CopilotAgentRow]:
        clauses: list[str] = []
        params: list[Any] = []
        if search:
            needle = f"%{search.strip().lower()}%"
            clauses.append(
                "LOWER("
                "COALESCE(display_name,'') || ' ' || COALESCE(id,'') || ' ' || "
                "COALESCE(app_identity,'') || ' ' || COALESCE(app_external_id,'') || ' ' || "
                "COALESCE(add_on_guid,'') || ' ' || COALESCE(status,'')"
                ") LIKE ?"
            )
            params.append(needle)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.extend([limit, offset])
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, display_name, app_identity, app_external_id, add_on_guid, source, status, "
                "       created_at, updated_at, raw_json, captured_at, last_activity_at, "
                "       last_activity_source, usage_event_count "
                f"FROM copilot_agents {where} "
                "ORDER BY display_name COLLATE NOCASE, id COLLATE NOCASE LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        return [_row_to_copilot_agent(row) for row in rows]

    def refresh_copilot_agent_usage_from_audit_events(self) -> int:
        """Recompute agent last-activity fields from stored Purview audit events."""
        agents = self.list_copilot_agents(limit=10000)
        if not agents:
            return 0
        agent_keys = {
            agent.id: _agent_match_keys(
                agent.id,
                agent.display_name,
                agent.app_identity,
                agent.app_external_id,
                agent.add_on_guid,
            )
            for agent in agents
        }
        usage: dict[str, dict[str, Any]] = {
            agent.id: {"count": 0, "last_activity_at": None, "last_activity_source": None}
            for agent in agents
        }
        with _connect(self.db_path) as conn:
            event_rows = conn.execute(
                "SELECT id, event_time, app, raw_json FROM audit_events "
                "WHERE source = 'purview' "
                "  AND LOWER(COALESCE(operation,'')) = 'copilotinteraction' "
                "ORDER BY event_time ASC"
            ).fetchall()

        for event_row in event_rows:
            event_keys = _audit_agent_match_keys(event_row["app"], event_row["raw_json"])
            if not event_keys:
                continue
            for agent in agents:
                if not (agent_keys[agent.id] & event_keys):
                    continue
                current = usage[agent.id]
                current["count"] = int(current["count"] or 0) + 1
                last_activity = current["last_activity_at"]
                if last_activity is None or _is_after(event_row["event_time"], str(last_activity)):
                    current["last_activity_at"] = event_row["event_time"]
                    current["last_activity_source"] = event_row["id"]

        with _connect(self.db_path) as conn:
            conn.execute(
                "UPDATE copilot_agents SET last_activity_at = NULL, "
                "last_activity_source = NULL, usage_event_count = 0"
            )
            conn.executemany(
                "UPDATE copilot_agents SET last_activity_at = ?, last_activity_source = ?, "
                "usage_event_count = ? WHERE id = ?",
                [
                    (
                        values["last_activity_at"],
                        values["last_activity_source"],
                        int(values["count"] or 0),
                        agent_id,
                    )
                    for agent_id, values in usage.items()
                    if values["count"]
                ],
            )
        return sum(1 for values in usage.values() if values["count"])

    def upsert_observed_copilot_agents_from_audit_events(self) -> int:
        """Create agent rows from Purview CopilotInteraction agent signals.

        Some tenants deny or do not expose the Copilot admin inventory beta
        APIs, but Purview CopilotInteraction events can still carry AgentId,
        AgentName, or Copilot Studio AppIdentity values. Treat those as
        observed agents so the Agents view is not empty when real usage exists.
        """
        observed: dict[str, dict[str, Any]] = {}
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, event_time, app, raw_json, fetched_at FROM audit_events "
                "WHERE source = 'purview' "
                "  AND LOWER(COALESCE(operation,'')) = 'copilotinteraction' "
                "ORDER BY event_time ASC"
            ).fetchall()

        for event_row in rows:
            raw = _loads_json_object(event_row["raw_json"])
            audit_data = audit_data_from_raw(raw)
            event_data = copilot_event_data(audit_data)
            if not _has_agent_signal(audit_data, event_data):
                continue
            agent_id = _observed_agent_identifier(event_row["app"], audit_data, event_data)
            if not agent_id:
                continue
            current = observed.setdefault(
                agent_id,
                {
                    "count": 0,
                    "last_activity_at": None,
                    "last_activity_source": None,
                    "display_name": _observed_agent_display_name(event_row["app"], audit_data, event_data),
                    "app_identity": _first_present(event_data, "AppIdentity")
                    or _first_present(audit_data, "AppIdentity"),
                    "app_external_id": _first_present(
                        event_data, "AppExternalId", "AppExternalID"
                    )
                    or _first_present(audit_data, "AppExternalId", "AppExternalID"),
                    "add_on_guid": _first_present(event_data, "AddOnGuid")
                    or _first_present(audit_data, "AddOnGuid"),
                    "raw": {},
                    "captured_at": event_row["fetched_at"] or event_row["event_time"],
                },
            )
            current["count"] = int(current["count"] or 0) + 1
            if current["last_activity_at"] is None or _is_after(
                event_row["event_time"], str(current["last_activity_at"])
            ):
                current["last_activity_at"] = event_row["event_time"]
                current["last_activity_source"] = event_row["id"]
                current["captured_at"] = event_row["fetched_at"] or event_row["event_time"]
                current["raw"] = _observed_agent_raw(event_row["id"], event_row["app"], audit_data, event_data)
                current["display_name"] = _observed_agent_display_name(event_row["app"], audit_data, event_data)
                current["app_identity"] = _first_present(event_data, "AppIdentity") or _first_present(
                    audit_data, "AppIdentity"
                )

        agent_rows = [
            CopilotAgentRow(
                id=str(agent_id),
                display_name=_optional_str(values.get("display_name")),
                app_identity=_optional_str(values.get("app_identity")),
                app_external_id=_optional_str(values.get("app_external_id")),
                add_on_guid=_optional_str(values.get("add_on_guid")),
                source="audit_observed",
                status="Observed",
                created_at=None,
                updated_at=None,
                raw_json=json.dumps(values.get("raw") or {}, ensure_ascii=False, sort_keys=True),
                captured_at=str(values.get("captured_at") or values.get("last_activity_at")),
                last_activity_at=_optional_str(values.get("last_activity_at")),
                last_activity_source=_optional_str(values.get("last_activity_source")),
                usage_event_count=int(values.get("count") or 0),
            )
            for agent_id, values in observed.items()
            if self._can_upsert_observed_agent(str(agent_id))
        ]
        return self.upsert_copilot_agents(agent_rows)

    def _can_upsert_observed_agent(self, agent_id: str) -> bool:
        with _connect(self.db_path) as conn:
            row = conn.execute("SELECT source FROM copilot_agents WHERE id = ?", (agent_id,)).fetchone()
        return row is None or row["source"] == "audit_observed"

    def list_copilot_agent_activity(
        self,
        *,
        threshold_days: int = 30,
        include_all: bool = True,
        search: str | None = None,
        reference_time: str | None = None,
        limit: int = 1000,
    ) -> list[CopilotAgentActivityRow]:
        reference_dt = _parse_datetime(reference_time) or datetime.now(timezone.utc)
        cutoff_dt = reference_dt - timedelta(days=max(1, int(threshold_days)))
        coverage_start, coverage_end = self._copilot_agent_audit_coverage()
        coverage_start_dt = _parse_datetime(coverage_start)
        coverage_is_sufficient = bool(coverage_start_dt and coverage_start_dt <= cutoff_dt)
        rows: list[CopilotAgentActivityRow] = []
        for agent in self.list_copilot_agents(search=search, limit=limit):
            last_activity_dt = _parse_datetime(agent.last_activity_at)
            if last_activity_dt:
                days_inactive = max(0, (reference_dt.date() - last_activity_dt.date()).days)
                is_stale = last_activity_dt < cutoff_dt
                state = "stale" if is_stale else "active"
            else:
                days_inactive = None
                is_stale = True
                state = "never_used"
            if not include_all and not is_stale:
                continue
            if not is_stale:
                confidence = "ok"
            elif coverage_start is None:
                confidence = "no_audit_data"
            elif coverage_is_sufficient:
                confidence = "ok"
            else:
                confidence = "limited_audit_window"
            rows.append(
                CopilotAgentActivityRow(
                    agent=agent,
                    threshold_days=threshold_days,
                    state=state,
                    is_stale=is_stale,
                    days_inactive=days_inactive,
                    confidence=confidence,
                    audit_coverage_start=coverage_start,
                    audit_coverage_end=coverage_end,
                )
            )
        return rows

    def list_stale_copilot_agents(
        self,
        *,
        threshold_days: int = 30,
        search: str | None = None,
        reference_time: str | None = None,
        limit: int = 1000,
    ) -> list[CopilotAgentActivityRow]:
        return self.list_copilot_agent_activity(
            threshold_days=threshold_days,
            include_all=False,
            search=search,
            reference_time=reference_time,
            limit=limit,
        )

    def _copilot_agent_audit_coverage(self) -> tuple[str | None, str | None]:
        with _connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT MIN(event_time) AS start_time, MAX(event_time) AS end_time "
                "FROM audit_events WHERE source = 'purview' "
                "AND LOWER(COALESCE(operation,'')) = 'copilotinteraction'"
            ).fetchone()
        if not row:
            return None, None
        return row["start_time"], row["end_time"]

    # ---- dashboard metrics (v2) -------------------------------------

    def dau_wau_mau_series(self, days: int = 30) -> list[dict[str, Any]]:
        """Return per-day DAU / 7d WAU / 28d MAU windows for the last ``days``.

        Each row: ``{day, dau, wau, mau}`` where dau is distinct users with
        an interaction or audit event on that day, and wau/mau are rolling
        windows ending on that day.
        """
        with _connect(self.db_path) as conn:
            # Materialise distinct (day, user) pairs once.
            conn.execute("DROP TABLE IF EXISTS temp.day_users")
            conn.execute(
                "CREATE TEMP TABLE day_users AS "
                "SELECT date(event_time) AS day, user_id FROM v_unified_activity "
                "WHERE event_time >= date('now', ?) AND user_id IS NOT NULL "
                "GROUP BY day, user_id",
                (f"-{max(days, 28) + 28} day",),  # need lookback for rolling MAU
            )
            rows = conn.execute(
                "WITH days AS ("
                "  SELECT date('now', ?) AS day "
                "  UNION ALL "
                "  SELECT date(day, '+1 day') FROM days WHERE day < date('now')"
                ") "
                "SELECT d.day, "
                "  (SELECT COUNT(DISTINCT user_id) FROM day_users du WHERE du.day = d.day) AS dau, "
                "  (SELECT COUNT(DISTINCT user_id) FROM day_users du "
                "     WHERE du.day BETWEEN date(d.day, '-6 day') AND d.day) AS wau, "
                "  (SELECT COUNT(DISTINCT user_id) FROM day_users du "
                "     WHERE du.day BETWEEN date(d.day, '-27 day') AND d.day) AS mau "
                "FROM days d ORDER BY d.day",
                (f"-{days - 1} day",),
            ).fetchall()
            conn.execute("DROP TABLE IF EXISTS temp.day_users")
        return [
            {"day": r["day"], "dau": r["dau"], "wau": r["wau"], "mau": r["mau"]}
            for r in rows
        ]

    def active_users_by_app_series(self, days: int = 30) -> list[dict[str, Any]]:
        """Per-day distinct user counts split by app (top 6 apps + Other)."""
        with _connect(self.db_path) as conn:
            top_apps = [
                r["app"]
                for r in conn.execute(
                    "SELECT COALESCE(app, '(unknown)') AS app, COUNT(DISTINCT user_id) AS n "
                    "FROM interactions WHERE created_at >= date('now', ?) "
                    "GROUP BY app ORDER BY n DESC LIMIT 6",
                    (f"-{days} day",),
                ).fetchall()
            ]
            rows = conn.execute(
                "SELECT date(created_at) AS day, COALESCE(app, '(unknown)') AS app, "
                "       COUNT(DISTINCT user_id) AS n "
                "FROM interactions WHERE created_at >= date('now', ?) "
                "GROUP BY day, app ORDER BY day",
                (f"-{days} day",),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            app = r["app"] if r["app"] in top_apps else "Other"
            out.append({"day": r["day"], "app": app, "users": r["n"]})
        return out

    def usage_frequency_distribution(self, days: int = 30) -> list[tuple[str, int]]:
        """Bucket users by interactions-per-period: 0, 1-4, 5-19, 20-49, 50+."""
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "WITH per_user AS ("
                "  SELECT u.id, COUNT(i.id) AS n "
                "  FROM users u LEFT JOIN interactions i ON i.user_id = u.id "
                "    AND i.created_at >= date('now', ?) "
                "  WHERE u.in_scope = 1 "
                "  GROUP BY u.id"
                ") "
                "SELECT bucket, COUNT(*) AS users FROM ("
                "  SELECT CASE "
                "    WHEN n = 0 THEN '0' "
                "    WHEN n BETWEEN 1 AND 4 THEN '1-4' "
                "    WHEN n BETWEEN 5 AND 19 THEN '5-19' "
                "    WHEN n BETWEEN 20 AND 49 THEN '20-49' "
                "    ELSE '50+' END AS bucket "
                "  FROM per_user"
                ") GROUP BY bucket",
                (f"-{days} day",),
            ).fetchall()
        # Force canonical ordering of the buckets even when some are zero.
        order = ["0", "1-4", "5-19", "20-49", "50+"]
        by_bucket = {r["bucket"]: int(r["users"]) for r in rows}
        return [(b, by_bucket.get(b, 0)) for b in order]

    def action_type_distribution(self, days: int = 30) -> list[tuple[str, int]]:
        """Counts grouped by interaction_type (userPrompt vs aiResponse vs other)."""
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT COALESCE(interaction_type, '(unknown)') AS t, COUNT(*) AS n "
                "FROM interactions WHERE created_at >= date('now', ?) "
                "GROUP BY t ORDER BY n DESC",
                (f"-{days} day",),
            ).fetchall()
        return [(r["t"], int(r["n"])) for r in rows]

    def readiness_rate(self) -> dict[str, int]:
        """Return enabled / licensed / active30d / total user counts."""
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT "
                "  COUNT(*) AS total, "
                "  SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled, "
                "  SUM(CASE WHEN has_copilot_license=1 THEN 1 ELSE 0 END) AS licensed, "
                "  SUM(CASE WHEN in_scope=1 THEN 1 ELSE 0 END) AS in_scope "
                "FROM users"
            ).fetchone()
            active = conn.execute(
                "SELECT COUNT(DISTINCT user_id) AS n FROM interactions "
                "WHERE created_at >= date('now', '-29 day')"
            ).fetchone()
        return {
            "total": int(r["total"] or 0),
            "enabled": int(r["enabled"] or 0),
            "licensed": int(r["licensed"] or 0),
            "in_scope": int(r["in_scope"] or 0),
            "active_30d": int(active["n"] or 0),
        }

    def copilot_blocked_events_count(self, days: int = 30) -> int:
        """Approximate count of denied/blocked Copilot audit events.

        Looks for failure results or operation strings that imply a
        block. The exact taxonomy depends on the tenant's audit
        configuration, so this favours recall over precision.
        """
        with _connect(self.db_path) as conn:
            r = conn.execute(
                "SELECT COUNT(*) AS n FROM audit_events "
                "WHERE event_time >= date('now', ?) "
                "  AND (LOWER(COALESCE(result, '')) IN ('failure', 'denied', 'blocked') "
                "       OR LOWER(COALESCE(operation, '')) LIKE '%block%' "
                "       OR LOWER(COALESCE(operation, '')) LIKE '%deny%')",
                (f"-{days} day",),
            ).fetchone()
        return int(r["n"] or 0)

    def user_detail_grid(self, days: int = 30, limit: int = 200) -> list[dict[str, Any]]:
        """Per-user usage detail combining interactions, last activity, license.

        Mirrors the M365 Usage / Viva Insights "user detail" table:
        each row exposes counts per app + last interaction timestamp,
        sortable client-side.
        """
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT u.id, COALESCE(u.display_name, u.upn, u.id) AS name, u.upn, "
                "       u.enabled, u.has_copilot_license, "
                "       COUNT(i.id) AS interactions, "
                "       SUM(CASE WHEN LOWER(COALESCE(i.interaction_type,''))='userprompt' THEN 1 ELSE 0 END) AS prompts, "
                "       MAX(i.created_at) AS last_seen, "
                "       (SELECT COUNT(*) FROM conversation_threads t "
                "          WHERE t.user_id = u.id AND t.started_at >= date('now', ?)) AS threads "
                "FROM users u LEFT JOIN interactions i ON i.user_id = u.id "
                "  AND i.created_at >= date('now', ?) "
                "WHERE u.in_scope = 1 "
                "GROUP BY u.id ORDER BY interactions DESC LIMIT ?",
                (f"-{days} day", f"-{days} day", limit),
            ).fetchall()
        return [
            {
                "user_id": r["id"],
                "name": r["name"],
                "upn": r["upn"],
                "enabled": bool(r["enabled"]),
                "licensed": bool(r["has_copilot_license"]),
                "interactions": int(r["interactions"] or 0),
                "prompts": int(r["prompts"] or 0),
                "threads": int(r["threads"] or 0),
                "last_seen": r["last_seen"],
            }
            for r in rows
        ]

    def interaction_apps(
        self,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        user_id: str | None = None,
        source_type: str | None = SOURCE_API,
    ) -> list[str]:
        """Distinct Copilot host apps seen in collected interactions."""
        interaction_clauses, params = _interaction_filter_clauses(
            alias="i",
            date_from=date_from,
            date_to=date_to,
            user_id=user_id,
            app=None,
            source_type=source_type,
        )
        clauses = ["u.in_scope = 1", *interaction_clauses]
        where = " AND ".join(clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT COALESCE(NULLIF(TRIM(i.app), ''), '(unknown)') AS app "
                "FROM interactions i JOIN users u ON u.id = i.user_id "
                f"WHERE {where} GROUP BY app ORDER BY app COLLATE NOCASE",
                params,
            ).fetchall()
        return [str(r["app"]) for r in rows]

    def user_activity_overview(
        self,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        user_id: str | None = None,
        app: str | None = None,
        search: str | None = None,
        source_type: str | None = SOURCE_API,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """User-level activity summary for the selected date/app scope."""
        interaction_clauses, interaction_params = _interaction_filter_clauses(
            alias="i",
            date_from=date_from,
            date_to=date_to,
            user_id=user_id,
            app=app,
            source_type=source_type,
        )
        interaction_where = " AND ".join(interaction_clauses) if interaction_clauses else "1 = 1"
        user_clauses = ["u.in_scope = 1"]
        user_params: list[Any] = []
        if user_id:
            user_clauses.append("u.id = ?")
            user_params.append(user_id)
        if search:
            user_clauses.append(
                "LOWER(COALESCE(u.display_name, '') || ' ' || COALESCE(u.upn, '') || ' ' || u.id) LIKE ?"
            )
            user_params.append(f"%{search.lower()}%")
        user_where = " AND ".join(user_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "WITH filtered AS ("
                "  SELECT i.*, COALESCE(NULLIF(TRIM(i.app), ''), '(unknown)') AS app_name "
                "  FROM interactions i "
                f"  WHERE {interaction_where}"
                "), app_counts AS ("
                "  SELECT user_id, app_name, COUNT(*) AS app_messages, "
                "         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC, app_name COLLATE NOCASE) AS rn "
                "  FROM filtered GROUP BY user_id, app_name"
                ") "
                "SELECT u.id AS user_id, COALESCE(u.display_name, u.upn, u.id) AS display_name, u.upn, "
                "       u.enabled, u.has_copilot_license, "
                "       COUNT(f.id) AS message_count, "
                "       SUM(CASE WHEN LOWER(COALESCE(f.interaction_type, '')) = 'userprompt' THEN 1 ELSE 0 END) AS prompt_count, "
                "       SUM(CASE WHEN LOWER(COALESCE(f.interaction_type, '')) = 'airesponse' THEN 1 ELSE 0 END) AS response_count, "
                "       COUNT(DISTINCT date(f.created_at)) AS active_days, "
                "       COUNT(DISTINCT COALESCE(f.thread_id, f.session_id, f.id)) AS thread_count, "
                "       COUNT(DISTINCT f.app_name) AS app_count, "
                "       MAX(f.created_at) AS last_activity_at, "
                "       COALESCE(ac.app_name, '') AS top_app "
                "FROM users u "
                "LEFT JOIN filtered f ON f.user_id = u.id "
                "LEFT JOIN app_counts ac ON ac.user_id = u.id AND ac.rn = 1 "
                f"WHERE {user_where} "
                "GROUP BY u.id ORDER BY message_count DESC, display_name COLLATE NOCASE LIMIT ?",
                [*interaction_params, *user_params, limit],
            ).fetchall()
        return [
            {
                "user_id": r["user_id"],
                "display_name": r["display_name"],
                "upn": r["upn"],
                "enabled": bool(r["enabled"]),
                "licensed": bool(r["has_copilot_license"]),
                "active_days": int(r["active_days"] or 0),
                "thread_count": int(r["thread_count"] or 0),
                "message_count": int(r["message_count"] or 0),
                "prompt_count": int(r["prompt_count"] or 0),
                "response_count": int(r["response_count"] or 0),
                "app_count": int(r["app_count"] or 0),
                "top_app": r["top_app"] or "",
                "last_activity_at": r["last_activity_at"],
            }
            for r in rows
        ]

    def user_daily_activity(
        self,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        user_id: str | None = None,
        app: str | None = None,
        search: str | None = None,
        source_type: str | None = SOURCE_API,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Daily activity rows grouped by user and UTC date."""
        interaction_clauses, params = _interaction_filter_clauses(
            alias="i",
            date_from=date_from,
            date_to=date_to,
            user_id=user_id,
            app=app,
            source_type=source_type,
        )
        clauses = ["u.in_scope = 1", *interaction_clauses]
        if search:
            clauses.append(
                "LOWER(COALESCE(u.display_name, '') || ' ' || COALESCE(u.upn, '') || ' ' || u.id) LIKE ?"
            )
            params.append(f"%{search.lower()}%")
        where = " AND ".join(clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "WITH filtered AS ("
                "  SELECT i.*, date(i.created_at) AS day, "
                "         COALESCE(NULLIF(TRIM(i.app), ''), '(unknown)') AS app_name, "
                "         COALESCE(u.display_name, u.upn, u.id) AS display_name, u.upn "
                "  FROM interactions i JOIN users u ON u.id = i.user_id "
                f"  WHERE {where}"
                "), daily AS ("
                "  SELECT user_id, display_name, upn, day, COUNT(*) AS message_count, "
                "         SUM(CASE WHEN LOWER(COALESCE(interaction_type, '')) = 'userprompt' THEN 1 ELSE 0 END) AS prompt_count, "
                "         SUM(CASE WHEN LOWER(COALESCE(interaction_type, '')) = 'airesponse' THEN 1 ELSE 0 END) AS response_count, "
                "         COUNT(DISTINCT COALESCE(thread_id, session_id, id)) AS thread_count, "
                "         COUNT(DISTINCT app_name) AS app_count, "
                "         MAX(created_at) AS last_activity_at "
                "  FROM filtered GROUP BY user_id, day"
                "), app_counts AS ("
                "  SELECT user_id, day, app_name, COUNT(*) AS app_messages, "
                "         ROW_NUMBER() OVER (PARTITION BY user_id, day ORDER BY COUNT(*) DESC, app_name COLLATE NOCASE) AS rn "
                "  FROM filtered GROUP BY user_id, day, app_name"
                ") "
                "SELECT d.*, COALESCE(ac.app_name, '') AS top_app "
                "FROM daily d LEFT JOIN app_counts ac ON ac.user_id = d.user_id AND ac.day = d.day AND ac.rn = 1 "
                "ORDER BY d.day DESC, d.message_count DESC, d.display_name COLLATE NOCASE LIMIT ?",
                [*params, limit],
            ).fetchall()
        return [
            {
                "user_id": r["user_id"],
                "display_name": r["display_name"],
                "upn": r["upn"],
                "day": r["day"],
                "thread_count": int(r["thread_count"] or 0),
                "message_count": int(r["message_count"] or 0),
                "prompt_count": int(r["prompt_count"] or 0),
                "response_count": int(r["response_count"] or 0),
                "app_count": int(r["app_count"] or 0),
                "top_app": r["top_app"] or "",
                "last_activity_at": r["last_activity_at"],
            }
            for r in rows
        ]

    def user_daily_app_usage(
        self,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        user_id: str | None = None,
        app: str | None = None,
        search: str | None = None,
        source_type: str | None = SOURCE_API,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Daily app usage rows grouped by user, UTC date, and app."""
        interaction_clauses, params = _interaction_filter_clauses(
            alias="i",
            date_from=date_from,
            date_to=date_to,
            user_id=user_id,
            app=app,
            source_type=source_type,
        )
        clauses = ["u.in_scope = 1", *interaction_clauses]
        if search:
            clauses.append(
                "LOWER(COALESCE(u.display_name, '') || ' ' || COALESCE(u.upn, '') || ' ' || u.id) LIKE ?"
            )
            params.append(f"%{search.lower()}%")
        where = " AND ".join(clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT i.user_id, COALESCE(u.display_name, u.upn, u.id) AS display_name, u.upn, "
                "       date(i.created_at) AS day, COALESCE(NULLIF(TRIM(i.app), ''), '(unknown)') AS app, "
                "       COUNT(*) AS message_count, "
                "       SUM(CASE WHEN LOWER(COALESCE(i.interaction_type, '')) = 'userprompt' THEN 1 ELSE 0 END) AS prompt_count, "
                "       SUM(CASE WHEN LOWER(COALESCE(i.interaction_type, '')) = 'airesponse' THEN 1 ELSE 0 END) AS response_count, "
                "       COUNT(DISTINCT COALESCE(i.thread_id, i.session_id, i.id)) AS thread_count "
                "FROM interactions i JOIN users u ON u.id = i.user_id "
                f"WHERE {where} "
                "GROUP BY i.user_id, day, app "
                "ORDER BY day DESC, message_count DESC, display_name COLLATE NOCASE, app COLLATE NOCASE LIMIT ?",
                [*params, limit],
            ).fetchall()
        return [
            {
                "user_id": r["user_id"],
                "display_name": r["display_name"],
                "upn": r["upn"],
                "day": r["day"],
                "app": r["app"],
                "thread_count": int(r["thread_count"] or 0),
                "message_count": int(r["message_count"] or 0),
                "prompt_count": int(r["prompt_count"] or 0),
                "response_count": int(r["response_count"] or 0),
            }
            for r in rows
        ]

    def work_intent_distribution(self, days: int = 30, *, source_type: str | None = SOURCE_API) -> list[dict[str, Any]]:
        """Prompt-level work-intent distribution from collected conversation text."""
        buckets: dict[str, dict[str, Any]] = {
            key: {
                "key": key,
                "label": intent_label(key),
                "prompts": 0,
                "users": set(),
                "apps": Counter(),
            }
            for key in INTENT_ORDER
        }
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT user_id, COALESCE(app, '(unknown)') AS app, body_text "
                "FROM interactions "
                "WHERE created_at >= date('now', ?) "
                f"  AND LOWER(COALESCE(interaction_type, '')) = 'userprompt'{source_sql}",
                [f"-{days} day", *source_params],
            ).fetchall()
        for row in rows:
            intent = classify_work_intent(row["body_text"], row["app"])
            bucket = buckets[intent.key]
            bucket["prompts"] += 1
            if row["user_id"]:
                bucket["users"].add(row["user_id"])
            if row["app"]:
                bucket["apps"][row["app"]] += 1

        out: list[dict[str, Any]] = []
        for key in INTENT_ORDER:
            bucket = buckets[key]
            top_app = bucket["apps"].most_common(1)
            out.append(
                {
                    "key": key,
                    "label": bucket["label"],
                    "prompts": int(bucket["prompts"]),
                    "users": len(bucket["users"]),
                    "top_app": top_app[0][0] if top_app else "",
                }
            )
        return out

    def adoption_summary(self, days: int = 30, *, source_type: str | None = SOURCE_API) -> dict[str, Any]:
        """Adoption gap: licensed/in-scope users vs. those active in the window.

        Returns the licensed population, how many were active in the period,
        and the inactive remainder (the "adoption gap"). Powers a home
        dashboard KPI card highlighting under-utilised licenses.
        """
        source_clauses, source_params = _source_filter_clause(alias="i", source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT "
                "  COUNT(*) AS licensed_total, "
                "  SUM(CASE WHEN active.user_id IS NOT NULL THEN 1 ELSE 0 END) AS active "
                "FROM users u "
                "LEFT JOIN ("
                "  SELECT DISTINCT i.user_id FROM interactions i "
                f"  WHERE i.created_at >= date('now', ?){source_sql}"
                ") active ON active.user_id = u.id "
                "WHERE u.has_copilot_license = 1 AND u.in_scope = 1",
                [f"-{days} day", *source_params],
            ).fetchone()
        licensed_total = int(row["licensed_total"] or 0)
        active = int(row["active"] or 0)
        inactive = max(0, licensed_total - active)
        return {
            "licensed_total": licensed_total,
            "active": active,
            "inactive": inactive,
            "adoption_rate": (active / licensed_total) if licensed_total else 0.0,
            "days": days,
        }

    def licensed_inactive_users(
        self,
        days: int = 30,
        *,
        limit: int = 200,
        source_type: str | None = SOURCE_API,
    ) -> list[dict[str, Any]]:
        """Licensed, in-scope users with no collected activity in the window."""
        source_clauses, source_params = _source_filter_clause(alias="i", source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT u.id, COALESCE(u.display_name, u.upn, u.id) AS name, u.upn, "
                "       (SELECT MAX(i2.created_at) FROM interactions i2 "
                "          WHERE i2.user_id = u.id) AS last_seen "
                "FROM users u "
                "WHERE u.has_copilot_license = 1 AND u.in_scope = 1 "
                "  AND u.id NOT IN ("
                "    SELECT DISTINCT i.user_id FROM interactions i "
                f"    WHERE i.created_at >= date('now', ?){source_sql}"
                "  ) "
                "ORDER BY name LIMIT ?",
                [f"-{days} day", *source_params, limit],
            ).fetchall()
        return [
            {
                "user_id": r["id"],
                "name": r["name"],
                "upn": r["upn"],
                "last_seen": r["last_seen"],
            }
            for r in rows
        ]

    def meaningful_interaction_count(self, days: int = 30, *, source_type: str | None = SOURCE_API) -> dict[str, Any]:
        """Session-based "meaningful interaction" count (distinct prompt sessions).

        Mirrors the session-centric counting used by some external Copilot
        usage reports: each conversation session that contains at least one
        user prompt counts once. Shown alongside the raw turn count so both
        the per-turn and per-session views are visible in parallel.
        """
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT "
                "  COUNT(*) AS prompts, "
                "  COUNT(DISTINCT COALESCE(session_id, thread_id, id)) AS sessions, "
                "  COUNT(DISTINCT user_id) AS users "
                "FROM interactions "
                "WHERE created_at >= date('now', ?) "
                f"  AND LOWER(COALESCE(interaction_type,'')) = 'userprompt'{source_sql}",
                [f"-{days} day", *source_params],
            ).fetchone()
        return {
            "sessions": int(row["sessions"] or 0),
            "prompts": int(row["prompts"] or 0),
            "users": int(row["users"] or 0),
            "days": days,
        }

    def conversation_quality_summary(self, days: int = 30, *, source_type: str | None = SOURCE_API) -> dict[str, Any]:
        """Thread/session-level quality signals from raw interactions."""
        source_clauses, source_params = _source_filter_clause(source_type=source_type)
        source_sql = "" if not source_clauses else " AND " + " AND ".join(source_clauses)
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT COALESCE(thread_id, session_id, id) AS group_key, "
                "       COUNT(*) AS turns, "
                "       SUM(CASE WHEN LOWER(COALESCE(interaction_type,''))='userprompt' THEN 1 ELSE 0 END) AS prompts, "
                "       SUM(CASE WHEN LOWER(COALESCE(interaction_type,''))='airesponse' THEN 1 ELSE 0 END) AS responses, "
                "       COUNT(DISTINCT COALESCE(app, '(unknown)')) AS apps "
                f"FROM interactions WHERE created_at >= date('now', ?) {source_sql} "
                "GROUP BY group_key",
                [f"-{days} day", *source_params],
            ).fetchall()
        threads = len(rows)
        total_turns = sum(int(r["turns"] or 0) for r in rows)
        total_prompts = sum(int(r["prompts"] or 0) for r in rows)
        total_responses = sum(int(r["responses"] or 0) for r in rows)
        follow_up_threads = sum(1 for r in rows if int(r["prompts"] or 0) >= 2)
        one_shot_threads = sum(1 for r in rows if int(r["prompts"] or 0) == 1)
        multi_app_threads = sum(1 for r in rows if int(r["apps"] or 0) >= 2)
        prompt_without_response = sum(
            max(0, int(r["prompts"] or 0) - int(r["responses"] or 0)) for r in rows
        )
        return {
            "threads": threads,
            "turns": total_turns,
            "prompts": total_prompts,
            "responses": total_responses,
            "avg_turns": (total_turns / threads) if threads else 0.0,
            "follow_up_threads": follow_up_threads,
            "follow_up_ratio": (follow_up_threads / threads) if threads else 0.0,
            "one_shot_threads": one_shot_threads,
            "multi_app_threads": multi_app_threads,
            "prompt_without_response": prompt_without_response,
            "response_coverage": (total_responses / total_prompts) if total_prompts else 0.0,
        }

    def grounding_resource_summary(self, days: int = 30, limit: int = 10) -> dict[str, Any]:
        """Summarise resource grounding and governance signals from audit payloads."""
        resource_counts: Counter[str] = Counter()
        resource_meta: dict[str, dict[str, str]] = {}
        total_refs = 0
        grounded_events = 0
        sensitive_refs = 0
        web_search_events = 0
        jailbreak_events = 0
        agent_events = 0
        with _connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT raw_json FROM audit_events "
                "WHERE event_time >= date('now', ?) AND raw_json IS NOT NULL",
                (f"-{days} day",),
            ).fetchall()
        for row in rows:
            raw = _loads_json_object(row["raw_json"])
            if not raw:
                continue
            audit_data = audit_data_from_raw(raw)
            event_data = copilot_event_data(audit_data)
            if _uses_bing_web_search(event_data):
                web_search_events += 1
            if _has_jailbreak_signal(event_data):
                jailbreak_events += 1
            if _has_agent_signal(audit_data, event_data):
                agent_events += 1
            items = audit_grounding_items(raw)
            if items:
                grounded_events += 1
            for item in items:
                total_refs += 1
                if _has_sensitivity_signal(item):
                    sensitive_refs += 1
                key = _grounding_resource_key(item)
                resource_counts[key] += 1
                resource_meta.setdefault(
                    key,
                    {
                        "label": _grounding_resource_label(item),
                        "type": str(_first_present(item, "Type", "ResourceType") or ""),
                        "source": str(item.get("source") or ""),
                    },
                )
        top_resources = []
        for key, count in resource_counts.most_common(limit):
            meta = resource_meta.get(key, {})
            top_resources.append(
                {
                    "key": key,
                    "label": meta.get("label") or key,
                    "type": meta.get("type") or "",
                    "source": meta.get("source") or "",
                    "count": int(count),
                }
            )
        return {
            "audit_events": len(rows),
            "grounded_events": grounded_events,
            "resource_refs": total_refs,
            "sensitive_resource_refs": sensitive_refs,
            "web_search_events": web_search_events,
            "jailbreak_events": jailbreak_events,
            "agent_events": agent_events,
            "top_resources": top_resources,
        }

    def enablement_opportunities(self, days: int = 30) -> list[dict[str, Any]]:
        """Action-oriented findings from local conversation and audit signals."""
        rows = self.user_detail_grid(days=days, limit=10000)
        licensed_inactive = sum(
            1 for row in rows if row.get("licensed") and int(row.get("interactions") or 0) == 0
        )
        with _connect(self.db_path) as conn:
            breadth_rows = conn.execute(
                "SELECT u.id, COUNT(i.id) AS interactions, "
                "       SUM(CASE WHEN LOWER(COALESCE(i.interaction_type,''))='userprompt' THEN 1 ELSE 0 END) AS prompts, "
                "       COUNT(DISTINCT COALESCE(i.app, '(unknown)')) AS app_count "
                "FROM users u LEFT JOIN interactions i ON i.user_id = u.id "
                "  AND i.created_at >= date('now', ?) "
                "WHERE u.in_scope = 1 GROUP BY u.id",
                (f"-{days} day",),
            ).fetchall()
        single_app_power_users = sum(
            1
            for row in breadth_rows
            if int(row["prompts"] or 0) >= 5 and int(row["app_count"] or 0) <= 1
        )
        intents = {row["key"]: row for row in self.work_intent_distribution(days=days)}
        prompt_total = sum(int(row["prompts"] or 0) for row in intents.values())
        search_share = (
            int(intents.get("search", {}).get("prompts") or 0) / prompt_total
            if prompt_total
            else 0.0
        )
        quality = self.conversation_quality_summary(days=days)
        grounding = self.grounding_resource_summary(days=days)
        blocked = self.copilot_blocked_events_count(days=days)

        opportunities: list[dict[str, Any]] = []
        if licensed_inactive:
            opportunities.append(
                _opportunity(
                    "licensed_inactive",
                    "라이선스 보유 미활성 사용자",
                    "high",
                    licensed_inactive,
                    "라이선스는 있지만 수집된 대화가 없는 사용자입니다.",
                )
            )
        if single_app_power_users:
            opportunities.append(
                _opportunity(
                    "single_app_power_users",
                    "단일 앱 집중 사용자",
                    "medium",
                    single_app_power_users,
                    "사용량은 있으나 한 앱에 치우쳐 있어 활용 확장 교육 후보입니다.",
                )
            )
        if quality["threads"] >= 5 and quality["follow_up_ratio"] < 0.25:
            opportunities.append(
                _opportunity(
                    "low_follow_up",
                    "후속 질문 비율 낮음",
                    "medium",
                    int(round(quality["follow_up_ratio"] * 100)),
                    "단발성 사용이 많아 질문 정교화/반복 활용 교육이 필요할 수 있습니다.",
                    unit="%",
                )
            )
        if prompt_total >= 10 and search_share >= 0.6:
            opportunities.append(
                _opportunity(
                    "search_heavy",
                    "질문/찾기 편중",
                    "info",
                    int(round(search_share * 100)),
                    "검색형 사용이 높아 초안 작성, 요약, 분석 시나리오 확장 여지가 있습니다.",
                    unit="%",
                )
            )
        risk_count = int(blocked) + int(grounding["sensitive_resource_refs"])
        if risk_count:
            opportunities.append(
                _opportunity(
                    "risk_review",
                    "보안/민감 자료 검토",
                    "high",
                    risk_count,
                    "차단/거부 이벤트 또는 민감 label이 포함된 grounding 참조가 있습니다.",
                )
            )
        if not opportunities:
            opportunities.append(
                _opportunity(
                    "healthy_baseline",
                    "즉시 조치 항목 없음",
                    "info",
                    0,
                    "현재 수집 범위에서는 뚜렷한 운영 조치 후보가 없습니다.",
                )
            )
        severity_order = {"high": 0, "medium": 1, "info": 2}
        opportunities.sort(key=lambda row: (severity_order.get(row["severity"], 9), row["label"]))
        return opportunities


def _interaction_filter_clauses(
    *,
    alias: str,
    date_from: str | None,
    date_to: str | None,
    user_id: str | None,
    app: str | None,
    source_type: str | None = SOURCE_API,
) -> tuple[list[str], list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if date_from:
        clauses.append(f"date({alias}.created_at) >= ?")
        params.append(date_from)
    if date_to:
        clauses.append(f"date({alias}.created_at) <= ?")
        params.append(date_to)
    if user_id:
        clauses.append(f"{alias}.user_id = ?")
        params.append(user_id)
    if app:
        clauses.append(f"COALESCE(NULLIF(TRIM({alias}.app), ''), '(unknown)') = ?")
        params.append(app)
    source_clauses, source_params = _source_filter_clause(alias=alias, source_type=source_type)
    clauses.extend(source_clauses)
    params.extend(source_params)
    return clauses, params


def _normalise_source_type(value: str | None) -> str:
    source = (value or SOURCE_API).strip().lower()
    if source not in VALID_SOURCES:
        raise ValueError(f"Unknown interaction source_type: {value!r}")
    return source


# Maximum number of body-match threads to pull back for a single search. Keeps
# the follow-up "t.id IN (...)" parameter list comfortably under SQLite's
# variable cap and bounds snippet rendering work.
_FTS_BODY_LIMIT = 800


def _sanitize_fts_query(raw: str) -> str:
    """Build a safe FTS5 MATCH expression from arbitrary user input.

    Each whitespace token becomes a quoted prefix term (``"term"*``) joined by
    implicit AND. Quoting neutralises FTS5 operator characters so casual input
    never raises a syntax error, while prefix matching keeps results lenient.
    """
    tokens = re.findall(r"\w+", raw, flags=re.UNICODE)
    if not tokens:
        return ""
    return " ".join(f'"{token}"*' for token in tokens)


def _fts_body_snippets(
    conn: sqlite3.Connection,
    search: str,
    source_type: str | None,
) -> dict[str, str]:
    """Return {thread_id: snippet} for interactions whose body matches ``search``.

    The raw query is tried first so power users can use FTS5 syntax (AND/OR,
    "phrases", prefix*). If that is not a valid MATCH expression we fall back to
    a sanitised prefix query so ordinary text still works.
    """
    raw = search.strip()
    if not raw:
        return {}
    candidates: list[str] = [raw]
    sanitized = _sanitize_fts_query(raw)
    if sanitized and sanitized != raw:
        candidates.append(sanitized)

    source_sql = ""
    source_params: list[Any] = []
    if source_type:
        source_sql = " AND i.source_type = ?"
        source_params = [source_type]

    for match_query in candidates:
        try:
            cur = conn.execute(
                "SELECT i.thread_id AS tid, "
                "       snippet(interactions_fts, 0, '\u3010', '\u3011', ' \u2026 ', 12) AS snip "
                "FROM interactions_fts f "
                "JOIN interactions i ON i.rowid = f.rowid "
                "WHERE interactions_fts MATCH ? AND i.thread_id IS NOT NULL"
                f"{source_sql} "
                "LIMIT ?",
                [match_query, *source_params, _FTS_BODY_LIMIT],
            )
        except sqlite3.OperationalError:
            continue
        result: dict[str, str] = {}
        for row in cur.fetchall():
            tid = row["tid"]
            if tid and tid not in result:
                result[tid] = row["snip"]
        return result
    return {}



def _source_filter_clause(
    *,
    alias: str | None = None,
    source_type: str | None = SOURCE_API,
) -> tuple[list[str], list[Any]]:
    if source_type is None:
        return [], []
    column = f"{alias}.source_type" if alias else "source_type"
    return [f"{column} = ?"], [_normalise_source_type(source_type)]


def _row_to_thread(r: sqlite3.Row) -> ThreadRow:
    return ThreadRow(
        id=r["id"],
        user_id=r["user_id"],
        started_at=r["started_at"],
        ended_at=r["ended_at"],
        app=r["app"],
        turn_count=int(r["turn_count"] or 0),
        prompt_count=int(r["prompt_count"] or 0),
        response_count=int(r["response_count"] or 0),
        session_ids=_loads_json_list(r["session_ids"]),
        topic_keywords=_loads_json_list(r["topic_keywords"]),
        title=r["title"],
        cluster_label=r["cluster_label"],
        computed_at=r["computed_at"],
        display_name=r["display_name"] if "display_name" in r.keys() else None,
        upn=r["upn"] if "upn" in r.keys() else None,
        source_type=r["source_type"] if "source_type" in r.keys() else SOURCE_API,
    )


def _row_to_audit_event(r: sqlite3.Row) -> AuditEventRow:
    return AuditEventRow(
        id=r["id"],
        source=r["source"],
        event_time=r["event_time"],
        user_id=r["user_id"],
        upn=r["upn"],
        operation=r["operation"],
        workload=r["workload"],
        app=r["app"],
        target_resources=r["target_resources"],
        client_ip=r["client_ip"],
        result=r["result"],
        raw_json=r["raw_json"],
        fetched_at=r["fetched_at"],
    )


def _row_to_ediscovery_job(r: sqlite3.Row) -> EdiscoveryJob:
    return EdiscoveryJob(
        id=r["id"],
        target_upn=r["target_upn"],
        target_user_id=r["target_user_id"],
        window_start=r["window_start"],
        window_end=r["window_end"],
        status=r["status"],
        case_id=r["case_id"],
        search_id=r["search_id"],
        operation_url=r["operation_url"],
        export_url=r["export_url"],
        interactions_added=int(r["interactions_added"] or 0),
        last_error=r["last_error"],
        last_error_at=r["last_error_at"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def _loads_json_list(value: Any) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError):
        return []
    if isinstance(parsed, list):
        return [str(x) for x in parsed]
    return []


def _first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _grounding_resource_label(item: dict[str, Any]) -> str:
    return str(
        _first_present(
            item,
            "Name",
            "DisplayName",
            "Title",
            "FileName",
            "SiteUrl",
            "Url",
            "URL",
            "Id",
        )
        or "resource"
    )


def _grounding_resource_key(item: dict[str, Any]) -> str:
    return str(
        _first_present(
            item,
            "Id",
            "ResourceId",
            "ListItemUniqueId",
            "SiteUrl",
            "Url",
            "URL",
            "Name",
        )
        or json.dumps(item, sort_keys=True, ensure_ascii=False)
    )


def _has_sensitivity_signal(item: dict[str, Any]) -> bool:
    return any(
        "sensitivity" in str(key).lower() and value not in (None, "", [], {})
        for key, value in item.items()
    )


def _uses_bing_web_search(event_data: dict[str, Any]) -> bool:
    plugins = event_data.get("AISystemPlugin") or event_data.get("AISystemPlugins")
    values = plugins if isinstance(plugins, list) else [plugins]
    for value in values:
        if isinstance(value, dict):
            haystack = " ".join(str(v) for v in value.values())
        else:
            haystack = str(value or "")
        if "bingwebsearch" in haystack.lower():
            return True
    return False


def _has_jailbreak_signal(event_data: dict[str, Any]) -> bool:
    messages = event_data.get("Messages")
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict) and bool(message.get("JailbreakDetected")):
                return True
    return bool(event_data.get("JailbreakDetected"))


def _has_agent_signal(audit_data: dict[str, Any], event_data: dict[str, Any]) -> bool:
    for key in ("AgentId", "AgentName", "AgentVersion"):
        if event_data.get(key) or audit_data.get(key):
            return True
    app_identity = str(event_data.get("AppIdentity") or audit_data.get("AppIdentity") or "")
    return "CopilotStudio" in app_identity or ".Studio." in app_identity


def _opportunity(
    key: str,
    label: str,
    severity: str,
    count: int,
    description: str,
    *,
    unit: str = "",
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "severity": severity,
        "count": int(count),
        "unit": unit,
        "description": description,
    }


def _row_to_consumption(r: sqlite3.Row) -> ConsumptionRow:
    return ConsumptionRow(
        report_type=r["report_type"],
        usage_date=r["usage_date"],
        environment_id=r["environment_id"],
        environment_name=r["environment_name"],
        user_id=r["user_id"],
        product=r["product"],
        quantity=float(r["quantity"] or 0.0),
        unit=r["unit"],
        window_start=r["window_start"],
        window_end=r["window_end"],
        raw_json=r["raw_json"],
        display_name=r["display_name"],
        upn=r["upn"],
    )


def _row_to_usage_snapshot(r: sqlite3.Row) -> UsageSnapshotRow:
    raw = _loads_json_object(r["raw_json"])
    projected = normalize_usage_row(raw)
    period = period_from_report(projected.get("report_period"), r["period"])
    return UsageSnapshotRow(
        snapshot_date=projected.get("report_refresh_date") or r["snapshot_date"],
        user_id=r["user_id"],
        upn=r["upn"] or projected.get("upn"),
        period=period,
        display_name=r["display_name"] or projected.get("display_name"),
        last_activity_overall=r["last_activity_overall"] or projected.get("last_activity_overall"),
        last_activity_teams=r["last_activity_teams"] or projected.get("last_activity_teams"),
        last_activity_word=r["last_activity_word"] or projected.get("last_activity_word"),
        last_activity_excel=r["last_activity_excel"] or projected.get("last_activity_excel"),
        last_activity_powerpoint=r["last_activity_powerpoint"] or projected.get("last_activity_powerpoint"),
        last_activity_outlook=r["last_activity_outlook"] or projected.get("last_activity_outlook"),
        last_activity_onenote=r["last_activity_onenote"] or projected.get("last_activity_onenote"),
        last_activity_loop=r["last_activity_loop"] or projected.get("last_activity_loop"),
        last_activity_bizchat=r["last_activity_bizchat"] or projected.get("last_activity_bizchat"),
        raw_json=r["raw_json"],
    )


def _row_to_usage_count(r: sqlite3.Row) -> UsageCountRow:
    return UsageCountRow(
        report_type=r["report_type"],
        report_refresh_date=r["report_refresh_date"],
        period=r["period"],
        report_date=r["report_date"],
        any_app_enabled_users=_optional_int(r["any_app_enabled_users"]),
        any_app_active_users=_optional_int(r["any_app_active_users"]),
        teams_enabled_users=_optional_int(r["teams_enabled_users"]),
        teams_active_users=_optional_int(r["teams_active_users"]),
        word_enabled_users=_optional_int(r["word_enabled_users"]),
        word_active_users=_optional_int(r["word_active_users"]),
        powerpoint_enabled_users=_optional_int(r["powerpoint_enabled_users"]),
        powerpoint_active_users=_optional_int(r["powerpoint_active_users"]),
        outlook_enabled_users=_optional_int(r["outlook_enabled_users"]),
        outlook_active_users=_optional_int(r["outlook_active_users"]),
        excel_enabled_users=_optional_int(r["excel_enabled_users"]),
        excel_active_users=_optional_int(r["excel_active_users"]),
        onenote_enabled_users=_optional_int(r["onenote_enabled_users"]),
        onenote_active_users=_optional_int(r["onenote_active_users"]),
        loop_enabled_users=_optional_int(r["loop_enabled_users"]),
        loop_active_users=_optional_int(r["loop_active_users"]),
        copilot_chat_enabled_users=_optional_int(r["copilot_chat_enabled_users"]),
        copilot_chat_active_users=_optional_int(r["copilot_chat_active_users"]),
        raw_json=r["raw_json"],
    )


def _row_to_admin_diagnostic(r: sqlite3.Row) -> CopilotAdminDiagnosticRow:
    return CopilotAdminDiagnosticRow(
        key=r["key"],
        label=r["label"],
        endpoint=r["endpoint"],
        status=r["status"],
        status_code=_optional_int(r["status_code"]),
        summary=r["summary"],
        payload_json=r["payload_json"],
        error=r["error"],
        captured_at=r["captured_at"],
    )


def _row_to_copilot_agent(row: sqlite3.Row) -> CopilotAgentRow:
    return CopilotAgentRow(
        id=row["id"],
        display_name=row["display_name"],
        app_identity=row["app_identity"],
        app_external_id=row["app_external_id"],
        add_on_guid=row["add_on_guid"],
        source=row["source"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        raw_json=row["raw_json"],
        captured_at=row["captured_at"],
        last_activity_at=row["last_activity_at"],
        last_activity_source=row["last_activity_source"],
        usage_event_count=int(row["usage_event_count"] or 0),
    )


def _agent_match_keys(*values: Any) -> set[str]:
    keys: set[str] = set()
    for value in values:
        key = _normalised_match_key(value)
        if key:
            keys.add(key)
    return keys


def _audit_agent_match_keys(app: str | None, raw_json: str | None) -> set[str]:
    raw = _loads_json_object(raw_json)
    audit_data = audit_data_from_raw(raw)
    event_data = copilot_event_data(audit_data)
    values: list[Any] = []
    for payload in (event_data, audit_data):
        for key in (
            "AgentId",
            "AgentName",
            "AppIdentity",
            "AddOnName",
            "AddOnGuid",
            "AppExternalId",
            "AppName",
            "AppDisplayName",
        ):
            values.append(payload.get(key))
    if _looks_agent_specific(app):
        values.append(app)
    return _agent_match_keys(*values)


def _observed_agent_identifier(
    app: str | None,
    audit_data: dict[str, Any],
    event_data: dict[str, Any],
) -> str | None:
    value = (
        _first_present(event_data, "AgentId", "AddOnGuid", "AppExternalId", "AppIdentity", "AgentName")
        or _first_present(audit_data, "AgentId", "AddOnGuid", "AppExternalId", "AppIdentity", "AgentName")
    )
    if value:
        return str(value)
    return str(app) if _looks_agent_specific(app) else None


def _observed_agent_display_name(
    app: str | None,
    audit_data: dict[str, Any],
    event_data: dict[str, Any],
) -> str | None:
    value = (
        _first_present(event_data, "AgentName", "AddOnName", "AppDisplayName", "AppName")
        or _first_present(audit_data, "AgentName", "AddOnName", "AppDisplayName", "AppName")
    )
    if value:
        return str(value)
    if _looks_agent_specific(app):
        return str(app)
    value = _first_present(event_data, "AppIdentity") or _first_present(audit_data, "AppIdentity")
    return str(value) if value else None


def _observed_agent_raw(
    event_id: str,
    app: str | None,
    audit_data: dict[str, Any],
    event_data: dict[str, Any],
) -> dict[str, Any]:
    keys = (
        "AgentId",
        "AgentName",
        "AgentVersion",
        "AppIdentity",
        "AppExternalId",
        "AppDisplayName",
        "AppName",
        "AddOnGuid",
        "AddOnName",
    )
    observed = {key: event_data.get(key) or audit_data.get(key) for key in keys}
    observed = {key: value for key, value in observed.items() if value not in (None, "", [], {})}
    observed["sourceEventId"] = event_id
    if app:
        observed["app"] = app
    return observed


def _normalised_match_key(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, set)):
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if len(text) < 3:
        return None
    return text.strip("{}")


def _looks_agent_specific(value: str | None) -> bool:
    if not value:
        return False
    text = value.lower()
    return "agent" in text or "studio" in text or "addon" in text


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.fromisoformat(f"{text}T00:00:00+00:00")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_after(left: str | None, right: str | None) -> bool:
    left_dt = _parse_datetime(left)
    right_dt = _parse_datetime(right)
    if left_dt is None:
        return False
    if right_dt is None:
        return True
    return left_dt > right_dt


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_str(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _loads_json_object(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def attachments_to_json(payload: dict[str, Any] | None) -> str | None:
    if not payload:
        return None
    return json.dumps(payload, ensure_ascii=False)
