-- CopilotWatchTower SQLite schema (v3)
-- Plain text storage for interaction bodies (user-confirmed). Secrets
-- are stored DPAPI-protected in the `settings` table BLOB column.
--
-- v2 additions:
--   * conversation_threads      — derived thread index for the chat UI
--   * interactions.thread_id    — back-pointer to a conversation_threads row
--   * audit_events              — Purview / Entra audit + sign-in events
--   * audit_collection_state    — per-source watermark + pending Purview query id
--   * copilot_usage_snapshots   — daily snapshot from /reports endpoints
--   * v_unified_activity        — view that merges interactions and audit_events
-- v3 additions:
--   * copilot_agents            — normalized agent inventory with derived usage timestamps

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value BLOB                       -- DPAPI ciphertext for secrets, UTF-8 text otherwise.
);

CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    upn                 TEXT,
    display_name        TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    has_copilot_license INTEGER NOT NULL DEFAULT 0,
    in_scope            INTEGER NOT NULL DEFAULT 1,
    last_seen           TEXT
);

CREATE INDEX IF NOT EXISTS ix_users_upn ON users(upn);
CREATE INDEX IF NOT EXISTS ix_users_in_scope ON users(in_scope);

CREATE TABLE IF NOT EXISTS interactions (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,
    session_id         TEXT,
    request_id         TEXT,
    created_at         TEXT NOT NULL,                     -- ISO-8601 UTC
    interaction_type   TEXT,                              -- userPrompt | aiResponse
    app                TEXT,                              -- BizChat, Word, Teams, ...
    body_text          TEXT,
    body_content_type  TEXT,
    attachments_json   TEXT,
    raw_json           TEXT,
    fetched_at         TEXT NOT NULL,
    thread_id          TEXT,                              -- v2: links into conversation_threads(id)
    source_type        TEXT NOT NULL DEFAULT 'api',        -- api | ediscovery
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_interactions_user_time ON interactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_interactions_created ON interactions(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_interactions_session ON interactions(session_id);
CREATE INDEX IF NOT EXISTS ix_interactions_app ON interactions(app);
CREATE INDEX IF NOT EXISTS ix_interactions_source_user_time ON interactions(source_type, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_interactions_source_thread ON interactions(source_type, thread_id);

CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts USING fts5(
    body_text,
    content='interactions',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS interactions_ai
AFTER INSERT ON interactions BEGIN
    INSERT INTO interactions_fts(rowid, body_text) VALUES (new.rowid, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS interactions_ad
AFTER DELETE ON interactions BEGIN
    INSERT INTO interactions_fts(interactions_fts, rowid, body_text)
        VALUES('delete', old.rowid, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS interactions_au
AFTER UPDATE ON interactions BEGIN
    INSERT INTO interactions_fts(interactions_fts, rowid, body_text)
        VALUES('delete', old.rowid, old.body_text);
    INSERT INTO interactions_fts(rowid, body_text) VALUES (new.rowid, new.body_text);
END;

CREATE TABLE IF NOT EXISTS collection_state (
    user_id            TEXT PRIMARY KEY,
    last_collected_at  TEXT,
    backfill_complete  INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    last_error_at      TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collection_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at           TEXT NOT NULL,
    finished_at          TEXT,
    users_processed      INTEGER NOT NULL DEFAULT 0,
    interactions_fetched INTEGER NOT NULL DEFAULT 0,
    errors_count         INTEGER NOT NULL DEFAULT 0,
    trigger              TEXT NOT NULL                    -- scheduled | manual | backfill
);

-- v4: unified per-kind run history with captured live-log lines. One row per
-- collection run for *every* kind (conversation, audit, usage, diagnostics,
-- consumption, transcripts). Survives restarts so the operator can inspect
-- past runs and their logs from the "실행 이력" panel.
CREATE TABLE IF NOT EXISTS collection_run_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    trigger      TEXT NOT NULL DEFAULT 'manual',
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL DEFAULT 'running',         -- running | success | warn | error
    error_count  INTEGER NOT NULL DEFAULT 0,
    summary      TEXT,
    logs_json    TEXT                                     -- JSON array of {at, type, text}
);

CREATE INDEX IF NOT EXISTS ix_run_logs_kind_started ON collection_run_logs(kind, started_at DESC);

-- ---------------------------------------------------------------------
-- v2: conversation threads (Phase A)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_threads (
    id              TEXT PRIMARY KEY,                    -- deterministic hash of (user_id, sessions...)
    user_id         TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT NOT NULL,
    app             TEXT,                                -- dominant app for the thread
    turn_count      INTEGER NOT NULL DEFAULT 0,
    prompt_count    INTEGER NOT NULL DEFAULT 0,
    response_count  INTEGER NOT NULL DEFAULT 0,
    session_ids     TEXT NOT NULL,                       -- JSON list of Graph session ids
    topic_keywords  TEXT,                                -- JSON list of top keywords
    title           TEXT,                                -- first user prompt summary
    cluster_label   TEXT,                                -- optional manual/auto label
    computed_at     TEXT NOT NULL,
    source_type     TEXT NOT NULL DEFAULT 'api',          -- api | ediscovery
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_threads_user_time ON conversation_threads(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_threads_started ON conversation_threads(started_at DESC);
CREATE INDEX IF NOT EXISTS ix_threads_source_user_time ON conversation_threads(source_type, user_id, started_at DESC);

-- ``thread_id`` is added by the migration step (cannot be expressed in a
-- single CREATE TABLE because v1 stores already exist without it).
CREATE INDEX IF NOT EXISTS ix_interactions_thread ON interactions(thread_id);

-- ---------------------------------------------------------------------
-- v2: audit events + collection state (Phase B)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
    id               TEXT PRIMARY KEY,                   -- source-prefixed unique id
    source           TEXT NOT NULL,                      -- purview | entra_audit | entra_signin
    event_time       TEXT NOT NULL,                      -- ISO-8601 UTC
    user_id          TEXT,
    upn              TEXT,
    operation        TEXT,                               -- CopilotInteraction, Add user, ...
    workload         TEXT,                               -- M365 workload (Audit.General, ...)
    app              TEXT,                               -- BizChat, Word, Teams, ...
    target_resources TEXT,                               -- JSON list of file/site/url refs
    client_ip        TEXT,
    result           TEXT,                               -- success | failure | denied (sign-ins)
    raw_json         TEXT,
    fetched_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_user_time ON audit_events(user_id, event_time DESC);
CREATE INDEX IF NOT EXISTS ix_audit_source_op ON audit_events(source, operation);
CREATE INDEX IF NOT EXISTS ix_audit_event_time ON audit_events(event_time DESC);

CREATE TABLE IF NOT EXISTS audit_collection_state (
    source                  TEXT PRIMARY KEY,            -- purview | entra_audit | entra_signin
    last_collected_at       TEXT,                        -- watermark
    pending_query_id        TEXT,                        -- Purview asyncQuery id (cross-cycle pickup)
    pending_submitted_at    TEXT,
    pending_window_start    TEXT,
    pending_window_end      TEXT,
    last_error              TEXT,
    last_error_at           TEXT,
    last_success_at         TEXT,
    last_record_count       INTEGER NOT NULL DEFAULT 0,
    enabled                 INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS copilot_usage_snapshots (
    id                         TEXT PRIMARY KEY,         -- stable hash of (snapshot_date|period|user_key)
    snapshot_date              TEXT NOT NULL,
    user_id                    TEXT,
    upn                        TEXT,
    user_key                   TEXT NOT NULL,            -- COALESCE(user_id, upn, '_total') filled by upsert
    period                     TEXT NOT NULL,            -- D7 | D30 | D90 | D180
    display_name               TEXT,
    last_activity_overall      TEXT,
    last_activity_teams        TEXT,
    last_activity_word         TEXT,
    last_activity_excel        TEXT,
    last_activity_powerpoint   TEXT,
    last_activity_outlook      TEXT,
    last_activity_onenote      TEXT,
    last_activity_loop         TEXT,
    last_activity_bizchat      TEXT,
    raw_json                   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_snapshot
    ON copilot_usage_snapshots(snapshot_date, period, user_key);
CREATE INDEX IF NOT EXISTS ix_usage_snapshot_user ON copilot_usage_snapshots(user_id);
CREATE INDEX IF NOT EXISTS ix_usage_snapshot_date ON copilot_usage_snapshots(snapshot_date DESC);

CREATE TABLE IF NOT EXISTS copilot_usage_user_counts (
    id                              TEXT PRIMARY KEY,       -- stable hash of (report_type|refresh|period|date)
    report_type                     TEXT NOT NULL,          -- summary | trend
    report_refresh_date             TEXT NOT NULL,
    period                          TEXT NOT NULL,          -- D7 | D30 | D90 | D180
    report_date                     TEXT,                   -- trend rows only
    any_app_enabled_users           INTEGER,
    any_app_active_users            INTEGER,
    teams_enabled_users             INTEGER,
    teams_active_users              INTEGER,
    word_enabled_users              INTEGER,
    word_active_users               INTEGER,
    powerpoint_enabled_users        INTEGER,
    powerpoint_active_users         INTEGER,
    outlook_enabled_users           INTEGER,
    outlook_active_users            INTEGER,
    excel_enabled_users             INTEGER,
    excel_active_users              INTEGER,
    onenote_enabled_users           INTEGER,
    onenote_active_users            INTEGER,
    loop_enabled_users              INTEGER,
    loop_active_users               INTEGER,
    copilot_chat_enabled_users      INTEGER,
    copilot_chat_active_users       INTEGER,
    raw_json                        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_user_counts
    ON copilot_usage_user_counts(id);
CREATE INDEX IF NOT EXISTS ix_usage_user_counts_period
    ON copilot_usage_user_counts(report_type, period, report_refresh_date DESC);
CREATE INDEX IF NOT EXISTS ix_usage_user_counts_date
    ON copilot_usage_user_counts(report_type, report_date DESC);

CREATE TABLE IF NOT EXISTS copilot_admin_diagnostics (
    key             TEXT PRIMARY KEY,       -- limited_mode | policy_settings | catalog_packages | agent_registrations
    label           TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    status          TEXT NOT NULL,          -- ok | forbidden | not_found | error
    status_code     INTEGER,
    summary         TEXT,
    payload_json    TEXT,
    error           TEXT,
    captured_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_copilot_admin_diagnostics_status
    ON copilot_admin_diagnostics(status, captured_at DESC);

CREATE TABLE IF NOT EXISTS copilot_agents (
    id                   TEXT PRIMARY KEY,
    display_name         TEXT,
    app_identity         TEXT,
    app_external_id      TEXT,
    add_on_guid          TEXT,
    source               TEXT NOT NULL DEFAULT 'agent_registrations',
    status               TEXT,
    created_at           TEXT,
    updated_at           TEXT,
    raw_json             TEXT,
    captured_at          TEXT NOT NULL,
    last_activity_at     TEXT,
    last_activity_source TEXT,
    usage_event_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_copilot_agents_activity
    ON copilot_agents(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS ix_copilot_agents_name
    ON copilot_agents(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_copilot_agents_identity
    ON copilot_agents(app_identity, app_external_id, add_on_guid);

-- Unified timeline view used by ConversationThreadsView and the dashboard.
-- Keeps interactions and audit events comparable: same columns, same time axis.
DROP VIEW IF EXISTS v_unified_activity;
CREATE VIEW v_unified_activity AS
    SELECT
        i.created_at        AS event_time,
        i.user_id           AS user_id,
        'conversation'      AS kind,
        i.app               AS app,
        i.interaction_type  AS operation,
        i.session_id        AS session_id,
        i.thread_id         AS thread_id,
        i.source_type       AS source_type,
        i.id                AS source_id,
        SUBSTR(COALESCE(i.body_text, ''), 1, 200) AS summary
    FROM interactions i
    UNION ALL
    SELECT
        a.event_time        AS event_time,
        a.user_id           AS user_id,
        'audit'             AS kind,
        a.app               AS app,
        a.operation         AS operation,
        NULL                AS session_id,
        NULL                AS thread_id,
        NULL                AS source_type,
        a.id                AS source_id,
        SUBSTR(COALESCE(a.target_resources, a.operation, ''), 1, 200) AS summary
    FROM audit_events a;

-- ---------------------------------------------------------------------
-- v4: eDiscovery collection jobs (on-demand single-user collection)
-- ---------------------------------------------------------------------
--
-- Tracks one on-demand eDiscovery collection per target user. The new
-- Microsoft Purview eDiscovery experience flow is asynchronous (create
-- case -> search -> export -> download -> parse), so the job row stores
-- every resource id plus a coarse ``status`` so a run interrupted mid
-- flight can be resumed on the next cycle.

CREATE TABLE IF NOT EXISTS ediscovery_jobs (
    id                  TEXT PRIMARY KEY,                   -- stable hash of (target_upn|window)
    target_upn          TEXT NOT NULL,
    target_user_id      TEXT,
    window_start        TEXT,                               -- ISO-8601 UTC (inclusive)
    window_end          TEXT,                               -- ISO-8601 UTC (exclusive)
    status              TEXT NOT NULL DEFAULT 'pending',    -- pending|case|searching|exporting|downloading|parsing|done|error
    case_id             TEXT,
    search_id           TEXT,
    operation_url       TEXT,                               -- current long-running operation URL
    export_url          TEXT,                               -- resolved export download URL
    interactions_added  INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    last_error_at       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ediscovery_jobs_upn
    ON ediscovery_jobs(target_upn, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ediscovery_jobs_status
    ON ediscovery_jobs(status, updated_at DESC);

-- ---------------------------------------------------------------------
-- v5: Power Platform consumption (agent cost-credit reporting)
-- ---------------------------------------------------------------------
--
-- Granular consumption rows downloaded from the unofficial Power Platform
-- Licensing API (PPAC consumption reports). One row per
-- (report_type, usage_date, environment, user, product). The licensing CSV
-- identifies users by AAD object id only, so the UI joins ``user_id`` back
-- to the existing ``users`` table for display names. Kept deliberately
-- separate from ``interactions`` — this is licensing/billing data, a
-- different domain with a different lifecycle.

CREATE TABLE IF NOT EXISTS power_platform_consumption (
    id                       TEXT PRIMARY KEY,    -- hash(report_type|usage_date|environment_id|user_key|product)
    report_type              TEXT NOT NULL,       -- MCSMessages | AIByUserAndEnvironment | ApiByLicensedUser | ...
    usage_date               TEXT NOT NULL,       -- the day the consumption occurred (YYYY-MM-DD)
    environment_id           TEXT,
    environment_name         TEXT,
    user_id                  TEXT,                -- AAD object id from the CSV (may be empty for env-level rows)
    user_key                 TEXT NOT NULL,       -- COALESCE(user_id, '_env:'||environment_id, '_total')
    product                  TEXT,                -- sub-product split where the report provides one
    quantity                 REAL NOT NULL DEFAULT 0,  -- messages / credits / requests consumed
    unit                     TEXT,                -- messages | credits | requests
    window_start             TEXT,                -- collection window (inclusive)
    window_end               TEXT,                -- collection window (exclusive)
    raw_json                 TEXT,                -- original CSV row as JSON for debugging
    captured_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pp_consumption
    ON power_platform_consumption(report_type, usage_date, user_key, COALESCE(product, ''));
CREATE INDEX IF NOT EXISTS ix_pp_consumption_date
    ON power_platform_consumption(report_type, usage_date DESC);
CREATE INDEX IF NOT EXISTS ix_pp_consumption_user
    ON power_platform_consumption(user_id);

INSERT OR IGNORE INTO schema_version(version) VALUES (1);
INSERT OR IGNORE INTO schema_version(version) VALUES (2);
INSERT OR IGNORE INTO schema_version(version) VALUES (3);
INSERT OR IGNORE INTO schema_version(version) VALUES (4);
INSERT OR IGNORE INTO schema_version(version) VALUES (5);
