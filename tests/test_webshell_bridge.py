"""Unit tests for the web shell bridge surface.

These exercise the QObject without spinning up a QWebEngineView. The
Bridge is plain ``QObject`` with ``@Slot`` decorators, so we can call
its methods directly and assert on the returned JSON strings.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from copilot_watchtower.db import (
    AuditEventRow,
    CopilotAdminDiagnosticRow,
    CopilotAgentRow,
    InteractionRow,
    Repository,
    UsageCountRow,
    UsageSnapshotRow,
    UserRow,
    initialize,
)
from copilot_watchtower.webshell.bridge import Bridge, BridgeContext


def _make_interaction(
    iid: str,
    user_id: str,
    ts: str,
    *,
    app: str,
    typ: str,
    session: str | None = None,
) -> InteractionRow:
    return InteractionRow(
        id=iid,
        user_id=user_id,
        session_id=session,
        request_id=None,
        created_at=ts,
        interaction_type=typ,
        app=app,
        body_text=f"prompt {iid}",
        body_content_type="text",
        attachments_json=None,
        raw_json=json.dumps({"id": iid}),
        fetched_at=ts,
        thread_id=None,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "bridge.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_users(
        [
            UserRow("u-1", "u1@x", "User 1", True, True, True),
            UserRow("u-2", "u2@x", "User 2", True, True, True),
            UserRow("u-out", "out@x", "Out", True, False, False),
        ]
    )
    repo.upsert_interactions(
        [
            _make_interaction(
                "i1", "u-1", "2026-05-01T09:00:00Z",
                app="IPM.SkypeTeams.Message.Copilot.WebChat", typ="userPrompt", session="s-1",
            ),
            _make_interaction(
                "i2", "u-1", "2026-05-01T09:01:00Z",
                app="IPM.SkypeTeams.Message.Copilot.WebChat", typ="aiResponse", session="s-1",
            ),
            _make_interaction(
                "i3", "u-2", "2026-05-02T10:00:00Z",
                app="Word", typ="userPrompt", session="s-2",
            ),
        ]
    )
    return repo


@pytest.fixture
def bridge(qtbot, repo: Repository) -> Bridge:
    del qtbot  # only here to ensure QApplication exists
    return Bridge(BridgeContext(repo=repo))


def test_bridge_system_info_returns_app_name(bridge: Bridge) -> None:
    info = json.loads(bridge.system_info())
    assert info["app"] == "CopilotWatchTower"
    assert info["profile"] is None


def test_bridge_users_in_scope_filters_out_of_scope(bridge: Bridge) -> None:
    users = json.loads(bridge.users_in_scope())
    ids = {u["id"] for u in users}
    assert ids == {"u-1", "u-2"}


def test_bridge_interaction_apps_label_raw_identifier(bridge: Bridge) -> None:
    payload = json.loads(
        bridge.analytics_interaction_apps(json.dumps({"date_from": "2026-05-01", "date_to": "2026-05-02"}))
    )
    by_value = {item["value"]: item["label"] for item in payload}
    assert by_value["IPM.SkypeTeams.Message.Copilot.WebChat"] == "Teams: Copilot Chat"
    assert by_value["Word"] == "Word"


def test_bridge_user_activity_overview_labels_top_app(bridge: Bridge) -> None:
    payload = json.loads(
        bridge.analytics_user_activity_overview(
            json.dumps({"date_from": "2026-05-01", "date_to": "2026-05-02"})
        )
    )
    rows = {row["user_id"]: row for row in payload}
    u1 = rows["u-1"]
    assert u1["message_count"] == 2
    assert u1["top_app"] == "Teams: Copilot Chat"
    assert u1["top_app_raw"] == "IPM.SkypeTeams.Message.Copilot.WebChat"


def test_bridge_user_daily_app_usage_exposes_label_and_raw(bridge: Bridge) -> None:
    payload = json.loads(
        bridge.analytics_user_daily_app_usage(
            json.dumps({"date_from": "2026-05-01", "date_to": "2026-05-02"})
        )
    )
    teams = next(row for row in payload if row["app_raw"].startswith("IPM.SkypeTeams"))
    assert teams["app"] == "Teams: Copilot Chat"
    assert teams["message_count"] >= 1


def test_bridge_conversations_list_and_detail(qtbot, tmp_path: Path) -> None:
    del qtbot
    db = tmp_path / "threads.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_users([UserRow("u-1", "u1@x", "User 1", True, True, True)])
    repo.upsert_interactions(
        [
            InteractionRow(
                id="i1", user_id="u-1", session_id="sess", request_id=None,
                created_at="2026-05-01T09:00:00Z", interaction_type="userPrompt",
                app="IPM.SkypeTeams.Message.Copilot.WebChat", body_text="hello",
                body_content_type="text", attachments_json=None,
                raw_json="{}", fetched_at="2026-05-01T09:00:00Z", thread_id=None,
            ),
            InteractionRow(
                id="i2", user_id="u-1", session_id="sess", request_id=None,
                created_at="2026-05-01T09:01:00Z", interaction_type="aiResponse",
                app="IPM.SkypeTeams.Message.Copilot.WebChat", body_text="hi",
                body_content_type="text", attachments_json=None,
                raw_json="{}", fetched_at="2026-05-01T09:01:00Z", thread_id=None,
            ),
        ]
    )
    from copilot_watchtower.services.threading_engine import TurnInput, compute_threads

    interactions = repo.interactions_for_user("u-1")
    turns = [
        TurnInput(
            id=i.id,
            user_id=i.user_id,
            session_id=i.session_id,
            request_id=i.request_id,
            created_at=i.created_at,
            interaction_type=i.interaction_type,
            app=i.app,
            body_text=i.body_text,
            grounding_text=None,
        )
        for i in interactions
    ]
    threads = compute_threads(turns)
    repo.upsert_threads(threads)
    mapping = [(iid, t.id) for t in threads for iid in t.interaction_ids]
    if mapping:
        repo.assign_threads_to_interactions(mapping)

    bridge = Bridge(BridgeContext(repo=repo))
    summaries = json.loads(bridge.conversations_list("{}"))
    assert summaries, "expected at least one thread summary"
    assert summaries[0]["app"] == "Teams: Copilot Chat"

    detail = json.loads(bridge.conversations_detail(summaries[0]["id"]))
    assert detail["thread"]["id"] == summaries[0]["id"]
    assert {turn["interaction_type"] for turn in detail["turns"]} == {"userPrompt", "aiResponse"}
    assert all(turn["app"] == "Teams: Copilot Chat" for turn in detail["turns"])


def test_bridge_agents_list_marks_state_and_threshold(qtbot, tmp_path: Path) -> None:
    del qtbot
    db = tmp_path / "agents.db"
    initialize(db)
    repo = Repository(db)
    captured_at = "2026-05-27T00:00:00Z"
    repo.upsert_copilot_agents(
        [
            CopilotAgentRow(
                id="agent-active", display_name="Active",
                app_identity="Copilot.Studio.agent-active", app_external_id=None, add_on_guid=None,
                source="agent_registrations", status=None, created_at=None, updated_at=None,
                raw_json=None, captured_at=captured_at,
            ),
            CopilotAgentRow(
                id="agent-never", display_name="Never",
                app_identity="Copilot.Studio.agent-never", app_external_id=None, add_on_guid=None,
                source="agent_registrations", status=None, created_at=None, updated_at=None,
                raw_json=None, captured_at=captured_at,
            ),
        ]
    )
    repo.upsert_audit_events(
        [
            AuditEventRow(
                id="a1", source="purview", event_time="2026-05-20T00:00:00Z",
                user_id="u-1", upn="u1@x", operation="CopilotInteraction", workload="Copilot",
                app=None, target_resources=None, client_ip=None, result=None,
                raw_json=json.dumps({"auditData": {"CopilotEventData": {"AgentId": "agent-active"}}}),
                fetched_at=captured_at,
            ),
        ]
    )
    repo.refresh_copilot_agent_usage_from_audit_events()

    bridge = Bridge(BridgeContext(repo=repo))
    rows = json.loads(bridge.agents_list(json.dumps({"threshold_days": 30})))
    by_id = {row["id"]: row for row in rows}
    assert by_id["agent-active"]["state"] == "active"
    assert by_id["agent-never"]["state"] == "never_used"
    assert all(row["threshold_days"] == 30 for row in rows)


def test_bridge_audit_events_list_returns_labeled_apps(qtbot, tmp_path: Path) -> None:
    del qtbot
    db = tmp_path / "audit.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_audit_events(
        [
            AuditEventRow(
                id="ev-1", source="purview", event_time="2026-05-01T10:00:00Z",
                user_id="u-1", upn="u1@x", operation="CopilotInteraction", workload="Copilot",
                app="IPM.SkypeTeams.Message.Copilot.WebChat", target_resources=None,
                client_ip="127.0.0.1", result="Success", raw_json='{"foo": 1}',
                fetched_at="2026-05-01T10:00:00Z",
            ),
            AuditEventRow(
                id="ev-blocked", source="purview", event_time="2026-05-02T10:00:00Z",
                user_id="u-2", upn="u2@x", operation="DLPRuleMatch", workload="OfficeNative",
                app="Excel", target_resources=None, client_ip=None, result="blocked",
                raw_json="{}", fetched_at="2026-05-02T10:00:00Z",
            ),
        ]
    )
    bridge = Bridge(BridgeContext(repo=repo))
    rows = json.loads(bridge.audit_events_list(json.dumps({})))
    by_id = {row["id"]: row for row in rows}
    assert by_id["ev-1"]["app"] == "Teams: Copilot Chat"
    assert by_id["ev-1"]["raw_json"]
    assert by_id["ev-blocked"]["result"] == "blocked"


def test_bridge_admin_diagnostics_round_trip(qtbot, tmp_path: Path) -> None:
    del qtbot
    db = tmp_path / "diag.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_copilot_admin_diagnostics(
        [
            CopilotAdminDiagnosticRow(
                key="catalog_packages", label="Copilot 패키지",
                endpoint="/copilot/admin/catalog/packages", status="ok",
                status_code=200, summary="7,646 packages", payload_json=None, error=None,
                captured_at="2026-05-27T00:00:00Z",
            )
        ]
    )
    bridge = Bridge(BridgeContext(repo=repo))
    rows = json.loads(bridge.admin_diagnostics_list())
    assert rows[0]["key"] == "catalog_packages"
    assert rows[0]["status"] == "ok"
    assert rows[0]["status_code"] == 200


def test_bridge_usage_endpoints(qtbot, tmp_path: Path) -> None:
    del qtbot
    db = tmp_path / "usage.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_usage_snapshots(
        [
            UsageSnapshotRow(
                snapshot_date="2026-05-01", user_id="u-1", upn="u1@x", period="D30",
                display_name="User 1",
                last_activity_overall="2026-05-01",
                last_activity_teams="2026-05-01",
                last_activity_word=None,
                last_activity_excel=None,
                last_activity_powerpoint=None,
                last_activity_outlook=None,
                last_activity_onenote=None,
                last_activity_loop=None,
                last_activity_bizchat="2026-05-01",
                raw_json=None,
            )
        ]
    )
    repo.upsert_usage_count_rows(
        [
            UsageCountRow(
                report_type="summary", report_refresh_date="2026-05-01", period="D30",
                report_date=None,
                any_app_enabled_users=100, any_app_active_users=25,
                teams_enabled_users=50, teams_active_users=10,
                word_enabled_users=None, word_active_users=None,
                powerpoint_enabled_users=None, powerpoint_active_users=None,
                outlook_enabled_users=None, outlook_active_users=None,
                excel_enabled_users=None, excel_active_users=None,
                onenote_enabled_users=None, onenote_active_users=None,
                loop_enabled_users=None, loop_active_users=None,
                copilot_chat_enabled_users=None, copilot_chat_active_users=None,
                raw_json=None,
            )
        ]
    )
    bridge = Bridge(BridgeContext(repo=repo))
    snapshots = json.loads(bridge.usage_snapshots_list(json.dumps({"period": "D30"})))
    assert snapshots[0]["upn"] == "u1@x"
    counts = json.loads(bridge.usage_counts_list(json.dumps({"report_type": "summary", "period": "D30"})))
    assert counts[0]["any_app_active_users"] == 25
    periods = json.loads(bridge.usage_periods_summary())
    assert periods["latest_snapshot_dates"]["D30"] == "2026-05-01"


def test_bridge_operations_summary_and_runs(qtbot, tmp_path: Path) -> None:
    del qtbot
    db = tmp_path / "ops.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_users([UserRow("u-1", "u1@x", "User 1", True, True, True)])
    repo.upsert_interactions(
        [
            InteractionRow(
                id="i1", user_id="u-1", session_id="s", request_id=None,
                created_at="2026-05-01T00:00:00Z", interaction_type="userPrompt",
                app="Word", body_text="hi", body_content_type="text",
                attachments_json=None, raw_json="{}", fetched_at="2026-05-01T00:00:00Z",
                thread_id=None,
            )
        ]
    )
    run_id = repo.start_run("manual")
    repo.finish_run(run_id, users=1, interactions=1, errors=0)

    bridge = Bridge(BridgeContext(repo=repo))
    summary = json.loads(bridge.operations_summary())
    assert summary["interactions"] == 1
    assert summary["users"]["total"] == 1

    runs = json.loads(bridge.operations_recent_runs(json.dumps({"limit": 10})))
    assert runs and runs[0]["trigger"] == "manual"

    profiles = json.loads(bridge.profiles_list())
    assert profiles == []

    settings = json.loads(bridge.settings_summary())
    assert settings["bootstrap_complete"] is False
