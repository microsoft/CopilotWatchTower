from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from copilot_watchtower.db import (
    AuditEventRow,
    CopilotAgentRow,
    InteractionRow,
    Repository,
    ThreadRow,
    UserRow,
    initialize,
)


@pytest.fixture()
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


def _iso(year: int = 2026, month: int = 5, day: int = 1, hour: int = 12) -> str:
    return datetime(year, month, day, hour, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def test_user_upsert_and_scope(repo: Repository) -> None:
    repo.upsert_users(
        [
            UserRow(id="u1", upn="a@x.com", display_name="A", enabled=True, has_copilot_license=True, in_scope=True),
            UserRow(id="u2", upn="b@x.com", display_name="B", enabled=True, has_copilot_license=False, in_scope=True),
        ]
    )
    assert {u.id for u in repo.users_in_scope()} == {"u1", "u2"}
    repo.mark_out_of_scope({"u1"})
    assert {u.id for u in repo.users_in_scope()} == {"u1"}


def test_interaction_upsert_is_idempotent(repo: Repository) -> None:
    repo.upsert_users([UserRow("u1", "a@x.com", "A", True, True, True)])
    row = InteractionRow(
        id="i1", user_id="u1", session_id="s1", request_id="r1",
        created_at=_iso(), interaction_type="userPrompt", app="BizChat",
        body_text="Hello Copilot", body_content_type="text",
        attachments_json=None, raw_json="{}", fetched_at=_iso(),
    )
    repo.upsert_interactions([row])
    repo.upsert_interactions([row])
    assert repo.total_interactions() == 1
    assert repo.existing_interaction_ids(["i1", "missing"]) == {"i1"}


def test_interaction_and_thread_source_filters(repo: Repository) -> None:
    repo.upsert_users([UserRow("u1", "a@x.com", "A", True, True, True)])
    api_row = InteractionRow(
        id="api-1", user_id="u1", session_id="api-session", request_id="r1",
        created_at=_iso(), interaction_type="userPrompt", app="BizChat",
        body_text="api prompt", body_content_type="text",
        attachments_json=None, raw_json="{}", fetched_at=_iso(), source_type="api",
    )
    ediscovery_row = InteractionRow(
        id="ediscovery:1", user_id="u1", session_id="ediscovery-session", request_id="r2",
        created_at=_iso(hour=13), interaction_type="userPrompt", app="BizChat",
        body_text="restored prompt", body_content_type="text",
        attachments_json=None, raw_json=json.dumps({"source": "ediscovery"}), fetched_at=_iso(), source_type="ediscovery",
    )
    repo.upsert_interactions([api_row, ediscovery_row])

    assert repo.total_interactions() == 1
    assert repo.total_interactions(source_type="ediscovery") == 1
    assert repo.total_interactions(source_type=None) == 2
    assert [row.id for row in repo.list_interactions(source_type="api")] == ["api-1"]
    assert [row.id for row in repo.list_interactions(source_type="ediscovery")] == ["ediscovery:1"]

    api_thread = ThreadRow("thr-api", "u1", _iso(), _iso(), "BizChat", 1, 1, 0, ["api-session"], [], "api prompt", None, _iso())
    ediscovery_thread = ThreadRow("thr-ediscovery", "u1", _iso(hour=13), _iso(hour=13), "BizChat", 1, 1, 0, ["ediscovery-session"], [], "restored prompt", None, _iso())
    repo.upsert_threads([api_thread], source_type="api")
    repo.upsert_threads([ediscovery_thread], source_type="ediscovery")
    repo.assign_threads_to_interactions([("api-1", "thr-api"), ("ediscovery:1", "thr-ediscovery")])

    assert [row.id for row in repo.list_threads(source_type="api")] == ["thr-api"]
    assert [row.id for row in repo.list_threads(source_type="ediscovery")] == ["thr-ediscovery"]
    assert repo.thread_count() == 1
    assert repo.thread_count(source_type="ediscovery") == 1


def test_fts_search(repo: Repository) -> None:
    repo.upsert_users([UserRow("u1", "a@x.com", "A", True, True, True)])
    repo.upsert_interactions(
        [
            InteractionRow(
                id="i1", user_id="u1", session_id="s1", request_id="r1",
                created_at=_iso(), interaction_type="userPrompt", app="BizChat",
                body_text="quarterly report draft", body_content_type="text",
                attachments_json=None, raw_json="{}", fetched_at=_iso(),
            ),
            InteractionRow(
                id="i2", user_id="u1", session_id="s1", request_id="r2",
                created_at=_iso(hour=13), interaction_type="aiResponse", app="BizChat",
                body_text="here is the summary about sales", body_content_type="text",
                attachments_json=None, raw_json="{}", fetched_at=_iso(),
            ),
        ]
    )
    matches = repo.list_interactions(fts_query="quarterly")
    assert [r.id for r in matches] == ["i1"]
    no_match = repo.list_interactions(fts_query="invoices")
    assert no_match == []


def test_audit_events_for_thread_matches_user_and_expanded_time_window(repo: Repository) -> None:
    repo.upsert_audit_events(
        [
            AuditEventRow(
                id="ae-in-window",
                source="purview",
                event_time="2026-05-01T11:59:30Z",
                user_id="u1",
                upn="a@x.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app="BizChat",
                target_resources=None,
                client_ip=None,
                result="Success",
                raw_json="{}",
                fetched_at=_iso(),
            ),
            AuditEventRow(
                id="ae-other-user",
                source="purview",
                event_time="2026-05-01T12:00:30Z",
                user_id="u2",
                upn="b@x.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app="BizChat",
                target_resources=None,
                client_ip=None,
                result="Success",
                raw_json="{}",
                fetched_at=_iso(),
            ),
            AuditEventRow(
                id="ae-outside-window",
                source="purview",
                event_time="2026-05-01T11:55:00Z",
                user_id="u1",
                upn="a@x.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app="BizChat",
                target_resources=None,
                client_ip=None,
                result="Success",
                raw_json="{}",
                fetched_at=_iso(),
            ),
        ]
    )
    thread = ThreadRow(
        id="t1",
        user_id="u1",
        started_at="2026-05-01T12:00:00Z",
        ended_at="2026-05-01T12:01:00Z",
        app="BizChat",
        turn_count=2,
        prompt_count=1,
        response_count=1,
        session_ids=["s1"],
        topic_keywords=[],
        title="test",
        cluster_label=None,
        computed_at=_iso(),
        upn="a@x.com",
    )

    rows = repo.audit_events_for_thread(thread, window_seconds=180)

    assert [row.id for row in rows] == ["ae-in-window"]


def test_collection_state_watermark(repo: Repository) -> None:
    repo.upsert_users([UserRow("u1", "a@x.com", "A", True, True, True)])
    assert repo.get_collection_state("u1") == (None, False)
    repo.update_collection_state("u1", last_collected_at=_iso(), backfill_complete=True)
    watermark, done = repo.get_collection_state("u1")
    assert watermark is not None
    assert done is True


def test_run_lifecycle(repo: Repository) -> None:
    run_id = repo.start_run("manual")
    repo.finish_run(run_id, users=3, interactions=42, errors=1)
    runs = repo.recent_runs(limit=5)
    assert runs[0].id == run_id
    assert runs[0].interactions_fetched == 42
    assert runs[0].errors_count == 1


def test_stale_copilot_agent_classification(repo: Repository) -> None:
    captured_at = "2026-05-27T00:00:00Z"
    repo.upsert_copilot_agents(
        [
            CopilotAgentRow(
                id="agent-active",
                display_name="Active Agent",
                app_identity="Copilot.Studio.agent-active",
                app_external_id=None,
                add_on_guid=None,
                source="agent_registrations",
                status=None,
                created_at=None,
                updated_at=None,
                raw_json=None,
                captured_at=captured_at,
            ),
            CopilotAgentRow(
                id="agent-stale",
                display_name="Stale Agent",
                app_identity="Copilot.Studio.agent-stale",
                app_external_id=None,
                add_on_guid=None,
                source="agent_registrations",
                status=None,
                created_at=None,
                updated_at=None,
                raw_json=None,
                captured_at=captured_at,
            ),
            CopilotAgentRow(
                id="agent-never",
                display_name="Never Agent",
                app_identity="Copilot.Studio.agent-never",
                app_external_id=None,
                add_on_guid=None,
                source="agent_registrations",
                status=None,
                created_at=None,
                updated_at=None,
                raw_json=None,
                captured_at=captured_at,
            ),
        ]
    )
    repo.upsert_audit_events(
        [
            AuditEventRow(
                id="purview:active-agent",
                source="purview",
                event_time="2026-05-20T00:00:00Z",
                user_id="u-1",
                upn="alice@contoso.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app=None,
                target_resources=None,
                client_ip=None,
                result=None,
                raw_json=json.dumps({"auditData": {"CopilotEventData": {"AgentId": "agent-active"}}}),
                fetched_at=captured_at,
            ),
            AuditEventRow(
                id="purview:stale-agent",
                source="purview",
                event_time="2026-04-01T00:00:00Z",
                user_id="u-2",
                upn="bob@contoso.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app=None,
                target_resources=None,
                client_ip=None,
                result=None,
                raw_json=json.dumps({"auditData": {"CopilotEventData": {"AgentId": "agent-stale"}}}),
                fetched_at=captured_at,
            ),
        ]
    )

    repo.refresh_copilot_agent_usage_from_audit_events()

    d30_ids = {
        row.agent.id
        for row in repo.list_stale_copilot_agents(
            threshold_days=30,
            reference_time=captured_at,
        )
    }
    d60_ids = {
        row.agent.id
        for row in repo.list_stale_copilot_agents(
            threshold_days=60,
            reference_time=captured_at,
        )
    }

    assert d30_ids == {"agent-stale", "agent-never"}
    assert d60_ids == {"agent-never"}


def test_observed_copilot_agents_are_created_from_audit_events(repo: Repository) -> None:
    captured_at = "2026-05-27T00:00:00Z"
    repo.upsert_audit_events(
        [
            AuditEventRow(
                id="purview:observed-agent-1",
                source="purview",
                event_time="2026-05-20T00:00:00Z",
                user_id="u-1",
                upn="alice@contoso.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app="Office",
                target_resources=None,
                client_ip=None,
                result=None,
                raw_json=json.dumps(
                    {
                        "auditData": {
                            "CopilotEventData": {
                                "AgentId": "agent-hr",
                                "AgentName": "HR Helper",
                                "AppIdentity": "Copilot.Studio.agent-hr",
                            }
                        }
                    }
                ),
                fetched_at=captured_at,
            ),
            AuditEventRow(
                id="purview:observed-agent-2",
                source="purview",
                event_time="2026-05-21T00:00:00Z",
                user_id="u-2",
                upn="bob@contoso.com",
                operation="CopilotInteraction",
                workload="Copilot",
                app="Office",
                target_resources=None,
                client_ip=None,
                result=None,
                raw_json=json.dumps(
                    {
                        "auditData": {
                            "CopilotEventData": {
                                "AgentId": "agent-hr",
                                "AgentName": "HR Helper",
                                "AppIdentity": "Copilot.Studio.agent-hr",
                            }
                        }
                    }
                ),
                fetched_at=captured_at,
            ),
        ]
    )

    assert repo.upsert_observed_copilot_agents_from_audit_events() == 1

    agents = repo.list_copilot_agents()
    assert len(agents) == 1
    assert agents[0].id == "agent-hr"
    assert agents[0].display_name == "HR Helper"
    assert agents[0].app_identity == "Copilot.Studio.agent-hr"
    assert agents[0].source == "audit_observed"
    assert agents[0].status == "Observed"
    assert agents[0].usage_event_count == 2
    assert agents[0].last_activity_source == "purview:observed-agent-2"
