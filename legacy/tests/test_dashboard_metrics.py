"""Unit tests for the v2 dashboard repository helpers.

We seed a small fixture of interactions, audit events and users, then
verify each metric method returns the expected shape and totals. These
are the data sources for the web shell `사용 인사이트` screen and the
`Bridge` analytics endpoints; if a
column or filter regresses, the dashboard's numbers move silently —
so the tests assert against concrete totals, not just types.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from copilot_watchtower.app_labels import display_app_name
from copilot_watchtower.db import (
    AuditEventRow,
    InteractionRow,
    Repository,
    UserRow,
    initialize,
)


def _iso(days_ago: int = 0) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


@pytest.fixture
def seeded_repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    repo = Repository(db)
    # 3 in-scope users, 1 out-of-scope to confirm the in_scope filter.
    repo.upsert_users(
        [
            UserRow(
                id=f"u-{i}",
                upn=f"u{i}@x",
                display_name=f"User {i}",
                enabled=True,
                has_copilot_license=True,
                in_scope=True,
            )
            for i in range(1, 4)
        ]
        + [
            UserRow(
                id="u-out",
                upn="out@x",
                display_name="Out Of Scope",
                enabled=True,
                has_copilot_license=False,
                in_scope=False,
            )
        ]
    )

    # Build interactions:
    #   u-1: 6 today, 1 yesterday  → bucket 5-19
    #   u-2: 3 yesterday            → bucket 1-4
    #   u-3: 0                      → bucket "0"
    rows: list[InteractionRow] = []
    base = datetime.now(UTC).replace(microsecond=0)
    for i in range(6):
        ts = (base - timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(
            _make_interaction(
                f"i-1-{i}",
                "u-1",
                ts,
                app="Word",
                typ="userPrompt",
                session="s-1",
                text="회의 내용을 요약하고 action item 정리해줘",
            )
        )
    rows.append(
        _make_interaction(
            "i-1-y",
            "u-1",
            _iso(1),
            app="Word",
            typ="aiResponse",
            session="s-1",
            text="요약 결과입니다.",
        )
    )
    for i in range(3):
        ts = (base - timedelta(days=1, hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(
            _make_interaction(
                f"i-2-{i}",
                "u-2",
                ts,
                app="Excel",
                typ="userPrompt",
                session="s-2",
                text="Analyze spreadsheet trends and create a chart",
            )
        )
    repo.upsert_interactions(rows)

    # Audit events: one Copilot interaction record + one blocked event.
    repo.upsert_audit_events(
        [
            AuditEventRow(
                id="ae-ok",
                source="purview",
                event_time=_iso(0),
                user_id="u-1",
                upn="u1@x",
                operation="CopilotInteraction",
                workload="OfficeNative",
                app="Word",
                target_resources=None,
                client_ip=None,
                result="Success",
                raw_json=json.dumps(
                    {
                        "auditData": {
                            "CopilotEventData": {
                                "AccessedResources": [
                                    {
                                        "Name": "Roadmap.docx",
                                        "Type": "docx",
                                        "SensitivityLabelId": "label-1",
                                    }
                                ],
                                "AISystemPlugin": [{"Id": "BingWebSearch"}],
                                "Messages": [
                                    {"ID": "m1", "JailbreakDetected": False}
                                ],
                            }
                        }
                    }
                ),
                fetched_at=_iso(0),
            ),
            AuditEventRow(
                id="ae-blocked",
                source="purview",
                event_time=_iso(1),
                user_id="u-2",
                upn="u2@x",
                operation="DLPRuleMatch",
                workload="OfficeNative",
                app="Excel",
                target_resources=None,
                client_ip=None,
                result="blocked",
                raw_json="{}",
                fetched_at=_iso(1),
            ),
        ]
    )
    return repo


@pytest.fixture
def user_analytics_repo(tmp_path: Path) -> Repository:
    db = tmp_path / "user-analytics.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_users(
        [
            UserRow("u-1", "u1@x", "User 1", True, True, True),
            UserRow("u-2", "u2@x", "User 2", True, True, True),
            UserRow("u-3", "u3@x", "User 3", True, True, True),
            UserRow("u-out", "out@x", "Out", True, False, False),
        ]
    )
    repo.upsert_interactions(
        [
            _make_interaction(
                "ua-1",
                "u-1",
                "2026-05-01T09:00:00Z",
                app="Word",
                typ="userPrompt",
                session="s-word",
                text="요약해줘",
            ),
            _make_interaction(
                "ua-2",
                "u-1",
                "2026-05-01T09:01:00Z",
                app="Word",
                typ="aiResponse",
                session="s-word",
                text="요약 결과",
            ),
            _make_interaction(
                "ua-3",
                "u-1",
                "2026-05-01T10:00:00Z",
                app="Excel",
                typ="userPrompt",
                session="s-excel",
                text="Analyze this table",
            ),
            _make_interaction(
                "ua-4",
                "u-1",
                "2026-05-02T11:00:00Z",
                app="Teams",
                typ="userPrompt",
                session="s-teams",
                text="회의 정리",
            ),
            _make_interaction(
                "ua-5",
                "u-2",
                "2026-05-02T12:00:00Z",
                app="Teams",
                typ="userPrompt",
                session="s-u2-teams",
                text="Draft a message",
            ),
            _make_interaction(
                "ua-6",
                "u-2",
                "2026-05-02T12:01:00Z",
                app="Teams",
                typ="aiResponse",
                session="s-u2-teams",
                text="Draft result",
            ),
            _make_interaction(
                "ua-out",
                "u-out",
                "2026-05-01T08:00:00Z",
                app="Word",
                typ="userPrompt",
                session="s-out",
            ),
        ]
    )
    return repo


def _make_interaction(
    iid: str,
    user_id: str,
    ts: str,
    *,
    app: str,
    typ: str,
    session: str | None = None,
    text: str | None = None,
) -> InteractionRow:
    return InteractionRow(
        id=iid,
        user_id=user_id,
        session_id=session,
        request_id=None,
        created_at=ts,
        interaction_type=typ,
        app=app,
        body_text=text or f"prompt {iid}",
        body_content_type="text",
        attachments_json=None,
        raw_json=json.dumps({"id": iid}),
        fetched_at=ts,
        thread_id=None,
    )


# ----------------------------------------------------------------------


def test_dau_wau_mau_series_today_is_two(seeded_repo: Repository) -> None:
    series = seeded_repo.dau_wau_mau_series(days=7)
    assert series, "expected at least one day in the series"
    last = series[-1]
    # SQLite's date('now') is UTC; compare against the UTC date too.
    today_utc = datetime.now(UTC).date().isoformat()
    assert last["day"] == today_utc
    # u-1 has interactions today; u-1 also has an audit event today.
    assert last["dau"] >= 1
    # WAU / MAU windows must contain DAU.
    assert last["wau"] >= last["dau"]
    assert last["mau"] >= last["wau"]


def test_usage_frequency_distribution_buckets(seeded_repo: Repository) -> None:
    buckets = dict(seeded_repo.usage_frequency_distribution(days=30))
    # 5 canonical buckets always present:
    assert set(buckets.keys()) == {"0", "1-4", "5-19", "20-49", "50+"}
    # u-1 = 7 interactions → 5-19; u-2 = 3 → 1-4; u-3 = 0 → "0".
    assert buckets["0"] == 1
    assert buckets["1-4"] == 1
    assert buckets["5-19"] == 1
    assert buckets["20-49"] == 0
    assert buckets["50+"] == 0


def test_action_type_distribution(seeded_repo: Repository) -> None:
    dist = dict(seeded_repo.action_type_distribution(days=30))
    # 6 userPrompt for u-1 + 3 userPrompt for u-2 = 9; 1 aiResponse for u-1.
    assert dist.get("userPrompt", 0) == 9
    assert dist.get("aiResponse", 0) == 1


def test_readiness_rate_counts_in_scope_users(seeded_repo: Repository) -> None:
    r = seeded_repo.readiness_rate()
    assert r["total"] == 4
    assert r["in_scope"] == 3
    assert r["licensed"] == 3
    # u-1 + u-2 have interactions in the last 29 days.
    assert r["active_30d"] == 2


def test_blocked_events_count_matches_audit_events(seeded_repo: Repository) -> None:
    assert seeded_repo.copilot_blocked_events_count(days=30) == 1


def test_user_detail_grid_orders_by_interactions(seeded_repo: Repository) -> None:
    rows = seeded_repo.user_detail_grid(days=30)
    # in_scope filter only: 3 rows, ordered desc by interactions.
    assert len(rows) == 3
    assert [r["user_id"] for r in rows] == ["u-1", "u-2", "u-3"]
    assert rows[0]["interactions"] == 7
    assert rows[1]["interactions"] == 3
    assert rows[2]["interactions"] == 0
    # Prompt count subset of interactions.
    assert rows[0]["prompts"] == 6


def test_active_users_by_app_series_grouped(seeded_repo: Repository) -> None:
    rows = seeded_repo.active_users_by_app_series(days=7)
    apps = {r["app"] for r in rows}
    # Word + Excel both surface; nothing else seeded.
    assert "Word" in apps
    assert "Excel" in apps
    # Per-day, per-app distinct user counts must be ≥1 wherever they
    # appear. Use a sample sanity check.
    by_app = {r["app"]: 0 for r in rows}
    for r in rows:
        by_app[r["app"]] += r["users"]
    assert by_app["Word"] >= 1
    assert by_app["Excel"] >= 1


def test_work_intent_distribution_uses_prompt_text(seeded_repo: Repository) -> None:
    rows = {row["key"]: row for row in seeded_repo.work_intent_distribution(days=30)}
    assert rows["summarize"]["prompts"] == 6
    assert rows["analyze"]["prompts"] == 3
    assert rows["summarize"]["top_app"] == "Word"


def test_conversation_quality_summary_groups_by_session(seeded_repo: Repository) -> None:
    summary = seeded_repo.conversation_quality_summary(days=30)
    assert summary["threads"] == 2
    assert summary["follow_up_threads"] == 2
    assert summary["prompt_without_response"] == 8
    assert summary["response_coverage"] == pytest.approx(1 / 9)


def test_grounding_resource_summary_extracts_audit_signals(seeded_repo: Repository) -> None:
    summary = seeded_repo.grounding_resource_summary(days=30)
    assert summary["grounded_events"] == 1
    assert summary["resource_refs"] == 1
    assert summary["sensitive_resource_refs"] == 1
    assert summary["web_search_events"] == 1
    assert summary["top_resources"][0]["label"] == "Roadmap.docx"


def test_enablement_opportunities_are_action_oriented(seeded_repo: Repository) -> None:
    keys = {row["key"] for row in seeded_repo.enablement_opportunities(days=30)}
    assert "licensed_inactive" in keys
    assert "single_app_power_users" in keys
    assert "risk_review" in keys


def test_adoption_summary_splits_licensed_active_inactive(seeded_repo: Repository) -> None:
    summary = seeded_repo.adoption_summary(days=30)
    # u-1, u-2, u-3 are licensed + in-scope; u-out is excluded.
    assert summary["licensed_total"] == 3
    # u-1 and u-2 have interactions; u-3 has none.
    assert summary["active"] == 2
    assert summary["inactive"] == 1
    assert summary["adoption_rate"] == pytest.approx(2 / 3)


def test_licensed_inactive_users_lists_only_idle_licensed(seeded_repo: Repository) -> None:
    rows = seeded_repo.licensed_inactive_users(days=30)
    assert [r["user_id"] for r in rows] == ["u-3"]
    assert rows[0]["name"] == "User 3"


def test_meaningful_interaction_count_is_session_based(seeded_repo: Repository) -> None:
    result = seeded_repo.meaningful_interaction_count(days=30)
    # u-1's 6 prompts collapse to 1 session (s-1); u-2's 3 prompts → 1 session (s-2).
    assert result["sessions"] == 2
    # Raw prompt count is still exposed for the parallel turn view.
    assert result["prompts"] == 9
    assert result["users"] == 2


def test_user_activity_overview_counts_threads_messages_apps(user_analytics_repo: Repository) -> None:
    rows = user_analytics_repo.user_activity_overview(
        date_from="2026-05-01",
        date_to="2026-05-02",
    )

    assert [row["user_id"] for row in rows] == ["u-1", "u-2", "u-3"]
    u1 = rows[0]
    assert u1["active_days"] == 2
    assert u1["thread_count"] == 3
    assert u1["message_count"] == 4
    assert u1["prompt_count"] == 3
    assert u1["response_count"] == 1
    assert u1["app_count"] == 3
    assert u1["top_app"] == "Word"
    assert rows[2]["message_count"] == 0


def test_user_daily_activity_breaks_down_each_day(user_analytics_repo: Repository) -> None:
    rows = user_analytics_repo.user_daily_activity(
        date_from="2026-05-01",
        date_to="2026-05-02",
    )
    by_key = {(row["user_id"], row["day"]): row for row in rows}

    u1_day1 = by_key[("u-1", "2026-05-01")]
    assert u1_day1["thread_count"] == 2
    assert u1_day1["message_count"] == 3
    assert u1_day1["prompt_count"] == 2
    assert u1_day1["response_count"] == 1
    assert u1_day1["app_count"] == 2
    assert u1_day1["top_app"] == "Word"
    assert by_key[("u-1", "2026-05-02")]["top_app"] == "Teams"
    assert by_key[("u-2", "2026-05-02")]["message_count"] == 2
    assert all(row["user_id"] != "u-out" for row in rows)


def test_user_daily_app_usage_supports_app_filter(user_analytics_repo: Repository) -> None:
    apps = set(
        user_analytics_repo.interaction_apps(
            date_from="2026-05-01",
            date_to="2026-05-02",
        )
    )
    assert apps == {"Excel", "Teams", "Word"}

    rows = user_analytics_repo.user_daily_app_usage(
        date_from="2026-05-01",
        date_to="2026-05-02",
        user_id="u-1",
    )
    by_key = {(row["day"], row["app"]): row for row in rows}
    assert by_key[("2026-05-01", "Word")]["message_count"] == 2
    assert by_key[("2026-05-01", "Word")]["prompt_count"] == 1
    assert by_key[("2026-05-01", "Word")]["response_count"] == 1
    assert by_key[("2026-05-01", "Excel")]["thread_count"] == 1

    teams_rows = user_analytics_repo.user_daily_app_usage(
        date_from="2026-05-01",
        date_to="2026-05-02",
        app="Teams",
    )
    assert {row["app"] for row in teams_rows} == {"Teams"}
    assert sum(row["message_count"] for row in teams_rows) == 3


def test_raw_graph_app_identifiers_get_readable_labels() -> None:
    assert display_app_name("IPM.SkypeTeams.Message.Copilot.WebChat") == "Teams: Copilot Chat"
    assert display_app_name("IPM.SkypeTeams.Message.Copilot.Word") == "Teams: Word"
    assert display_app_name("BizChat") == "Copilot Chat"


def test_expanded_app_labels_cover_more_surfaces() -> None:
    assert display_app_name("forms") == "Forms"
    assert display_app_name("planner") == "Planner"
    assert display_app_name("stream") == "Stream"
    assert display_app_name("whiteboard") == "Whiteboard"
    assert display_app_name("sharepoint") == "SharePoint"
    assert display_app_name("share point") == "SharePoint"
