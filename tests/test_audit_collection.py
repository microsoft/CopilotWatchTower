"""Tests for the audit + usage report integration.

These cover the local parser/persistence layer end-to-end without
hitting Microsoft Graph. Graph is patched with a tiny fake whose only
job is to return the canned payloads we need for assertions.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from copilot_watchtower.db import AuditCollectionState, Repository, initialize
from copilot_watchtower.services import audit_query as aq
from copilot_watchtower.services import usage_reports as ur


class _FakeGraph:
    """Stub that satisfies the subset of GraphClient used by audit_query."""

    def __init__(
        self,
        *,
        directory_audits: list[dict[str, Any]] | None = None,
        sign_ins: list[dict[str, Any]] | None = None,
        purview_records: list[dict[str, Any]] | None = None,
        purview_status: str = "succeeded",
        usage_csv: bytes | None = None,
        summary_csv: bytes | None = None,
        trend_csv: bytes | None = None,
        raise_404_on_submit: bool = False,
        raise_403_substrate_on_submit: bool = False,
    ) -> None:
        self._directory_audits = directory_audits or []
        self._sign_ins = sign_ins or []
        self._purview_records = purview_records or []
        self._purview_status = purview_status
        self._usage_csv = usage_csv
        self._summary_csv = summary_csv
        self._trend_csv = trend_csv
        self.usage_periods_requested: list[str] = []
        self.summary_periods_requested: list[str] = []
        self.trend_periods_requested: list[str] = []
        self._raise_404 = raise_404_on_submit
        self._raise_403_substrate = raise_403_substrate_on_submit
        self.last_submission: dict[str, Any] | None = None

    def list_directory_audits(self, *, since: str | None = None, until: str | None = None):
        yield from self._directory_audits

    def list_sign_ins(self, *, since: str | None = None, until: str | None = None):
        yield from self._sign_ins

    def submit_audit_log_query(self, **kwargs: Any) -> str:
        if self._raise_404:
            from copilot_watchtower.services.graph import GraphError

            raise GraphError(404, "not provisioned")
        if self._raise_403_substrate:
            from copilot_watchtower.services.graph import GraphError

            # Mirrors what the M365 audit substrate returns when the
            # service principal isn't registered in Purview/Exchange.
            raise GraphError(
                403,
                {
                    "error": {
                        "code": "UnknownError",
                        "message": (
                            '{"Message":"App:a047400f-9dfa-4040-8be8-09e41ede14ee'
                            ' dont have any permissions"}'
                        ),
                    }
                },
            )
        self.last_submission = kwargs
        return "qid-1"

    def wait_for_audit_query(self, query_id: str, **_kwargs: Any) -> dict[str, Any]:
        return {"id": query_id, "status": self._purview_status}

    def get_audit_log_query(self, query_id: str) -> dict[str, Any]:
        return {"id": query_id, "status": self._purview_status}

    def list_audit_query_records(self, query_id: str):
        yield from self._purview_records

    def fetch_copilot_usage_user_detail(self, period: str = "D30") -> bytes:
        self.usage_periods_requested.append(period)
        if self._usage_csv is None:
            from copilot_watchtower.services.graph import GraphError

            raise GraphError(404, "not provisioned")
        return self._usage_csv

    def fetch_copilot_user_count_summary(self, period: str = "D30") -> bytes:
        self.summary_periods_requested.append(period)
        if self._summary_csv is None:
            from copilot_watchtower.services.graph import GraphError

            raise GraphError(404, "not provisioned")
        return _csv_with_report_period(self._summary_csv, period)

    def fetch_copilot_user_count_trend(self, period: str = "D30") -> bytes:
        self.trend_periods_requested.append(period)
        if self._trend_csv is None:
            from copilot_watchtower.services.graph import GraphError

            raise GraphError(404, "not provisioned")
        return _csv_with_report_period(self._trend_csv, period)

    def get_copilot_admin_limited_mode(self):
        from copilot_watchtower.services.graph import GraphError

        raise GraphError(403, {"error": {"message": "limited mode forbidden"}})

    def list_copilot_admin_policy_settings(self):
        from copilot_watchtower.services.graph import GraphError

        raise GraphError(404, {"error": {"message": "policy not found"}})

    def list_copilot_admin_catalog_packages(self):
        return [{"id": "pkg-agent", "displayName": "Delegated Agent", "elementTypes": ["DeclarativeCopilots"]}]

    def list_copilot_agent_registrations(self):
        from copilot_watchtower.services.graph import GraphError

        raise GraphError(404, {"error": {"message": "registrations not found"}})

    def close(self) -> None:
        return None


def _csv_with_report_period(data: bytes, period: str) -> bytes:
    period_value = period[1:] if period.upper().startswith("D") else period
    text = data.decode("utf-8")
    lines = text.splitlines()
    if not lines:
        return data
    out = [lines[0]]
    for line in lines[1:]:
        cols = line.split(",")
        if len(cols) >= 2:
            cols[1] = period_value
        out.append(",".join(cols))
    return ("\n".join(out) + "\n").encode("utf-8")


@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


# ---- Entra audits ------------------------------------------------------


def test_directory_audits_persisted(repo: Repository) -> None:
    fake = _FakeGraph(
        directory_audits=[
            {
                "id": "da-1",
                "activityDateTime": "2025-01-15T09:30:00Z",
                "activityDisplayName": "Add user",
                "category": "UserManagement",
                "loggedByService": "Core Directory",
                "result": "success",
                "initiatedBy": {"user": {"id": "u-admin", "userPrincipalName": "admin@x"}},
                "targetResources": [{"type": "User", "id": "u-new"}],
            }
        ]
    )
    outcome = aq.collect_entra_audits(repo, fake)  # type: ignore[arg-type]
    assert outcome.fetched == 1
    assert any("범위:" in detail for detail in outcome.details)
    assert any("영향 사용자: 1명" == detail for detail in outcome.details)
    assert any("Add user 1건" in detail for detail in outcome.details)
    rows = repo.list_audit_events(source="entra_audit")
    assert len(rows) == 1
    r = rows[0]
    assert r.upn == "admin@x"
    assert r.operation == "Add user"
    assert r.source == "entra_audit"
    # ID is namespaced
    assert r.id.startswith("entra_audit:")
    # raw_json preserved
    assert json.loads(r.raw_json)["id"] == "da-1"


def test_sign_ins_persisted(repo: Repository) -> None:
    fake = _FakeGraph(
        sign_ins=[
            {
                "id": "si-1",
                "createdDateTime": "2025-01-15T10:00:00Z",
                "userId": "u-1",
                "userPrincipalName": "alice@x",
                "appDisplayName": "Microsoft 365 Copilot",
                "clientAppUsed": "Browser",
                "ipAddress": "10.0.0.1",
                "status": {"errorCode": 0},
            }
        ]
    )
    outcome = aq.collect_entra_signins(repo, fake)  # type: ignore[arg-type]
    assert outcome.fetched == 1
    assert any("상위 앱: Microsoft 365 Copilot 1건" == detail for detail in outcome.details)
    rows = repo.list_audit_events(source="entra_signin")
    assert rows[0].client_ip == "10.0.0.1"
    assert rows[0].operation == "Microsoft 365 Copilot"


def test_collect_runs_idempotently(repo: Repository) -> None:
    payload = [
        {
            "id": "da-x",
            "activityDateTime": "2025-01-15T09:30:00Z",
            "activityDisplayName": "Op",
            "initiatedBy": {"user": {"id": "u-1", "userPrincipalName": "u@x"}},
        }
    ]
    fake = _FakeGraph(directory_audits=payload)
    aq.collect_entra_audits(repo, fake)  # type: ignore[arg-type]
    aq.collect_entra_audits(repo, fake)  # type: ignore[arg-type]  # again
    rows = repo.list_audit_events(source="entra_audit")
    assert len(rows) == 1  # PK upsert keeps a single row


def test_entra_batch_count_survives_flush(repo: Repository) -> None:
    payload = [
        {
            "id": f"da-{i}",
            "activityDateTime": "2025-01-15T09:30:00Z",
            "activityDisplayName": "Update user",
            "initiatedBy": {"user": {"id": f"u-{i % 3}", "userPrincipalName": f"u{i % 3}@x"}},
        }
        for i in range(501)
    ]
    fake = _FakeGraph(directory_audits=payload)

    outcome = aq.collect_entra_audits(repo, fake)  # type: ignore[arg-type]

    assert outcome.fetched == 501
    state = repo.get_audit_collection_state("entra_audit")
    assert state is not None
    assert state.last_record_count == 501
    assert any("영향 사용자: 3명" == detail for detail in outcome.details)
    assert any("Update user 501건" in detail for detail in outcome.details)


# ---- Purview -----------------------------------------------------------


def test_purview_submit_then_drain(repo: Repository) -> None:
    fake = _FakeGraph(
        purview_records=[
            {
                "id": "pv-1",
                "createdDateTime": "2025-01-15T11:00:00Z",
                "operation": "CopilotInteraction",
                "userId": "u-1",
                "userPrincipalName": "alice@x",
                "workload": "OfficeNative",
                "auditData": {"AppName": "Word", "ResultStatus": "Success"},
            }
        ]
    )
    outcome = aq.collect_purview(repo, fake)  # type: ignore[arg-type]
    assert outcome.fetched == 1
    assert any("쿼리 ID: qid-1" == detail for detail in outcome.details)
    assert any("상위 작업: CopilotInteraction 1건" == detail for detail in outcome.details)
    rows = repo.list_audit_events(source="purview")
    assert len(rows) == 1
    assert rows[0].operation == "CopilotInteraction"
    state = repo.get_audit_collection_state("purview")
    assert state is not None
    assert state.pending_query_id is None  # cleared on success
    assert state.last_record_count == 1


def test_purview_copilot_payload_is_extracted(repo: Repository) -> None:
    fake = _FakeGraph(
        purview_records=[
            {
                "id": "pv-copilot",
                "createdDateTime": "2026-05-22T07:53:59Z",
                "operation": "CopilotInteraction",
                "userId": "u-1",
                "userPrincipalName": "alice@x",
                "workload": "Copilot",
                "auditData": {
                    "Operation": "CopilotInteraction",
                    "Workload": "Copilot",
                    "AppIdentity": "Copilot.Studio.agent-1",
                    "ClientIP": "10.0.0.5",
                    "CopilotEventData": {
                        "AppHost": "Copilot Studio",
                        "ThreadId": "thread-1",
                        "AccessedResources": [{"name": "doc-1"}],
                    },
                },
            }
        ]
    )

    aq.collect_purview(repo, fake)  # type: ignore[arg-type]

    row = repo.list_audit_events(source="purview")[0]
    assert row.app == "Copilot Studio"
    payload = json.loads(row.target_resources or "[]")
    assert {item["key"] for item in payload} >= {
        "AppIdentity",
        "AppHost",
        "ThreadId",
        "AccessedResources",
    }


def test_purview_model_transparency_payload_is_extracted(repo: Repository) -> None:
    fake = _FakeGraph(
        purview_records=[
            {
                "id": "pv-model",
                "createdDateTime": "2026-05-20T04:26:41Z",
                "operation": "CopilotInteraction",
                "userId": "u-1",
                "userPrincipalName": "alice@x",
                "workload": "Copilot",
                "auditData": {
                    "Operation": "CopilotInteraction",
                    "Workload": "Copilot",
                    "CopilotEventData": {
                        "AppHost": "Office",
                        "ThreadId": "thread-1",
                        "ModelTransparencyDetails": [
                            {"ModelProviderName": "OpenAI"}
                        ],
                    },
                },
            }
        ]
    )

    aq.collect_purview(repo, fake)  # type: ignore[arg-type]

    payload = json.loads(repo.list_audit_events(source="purview")[0].target_resources or "[]")
    model_item = next(item for item in payload if item["key"] == "ModelTransparencyDetails")
    assert model_item["value"][0]["ModelProviderName"] == "OpenAI"


def test_purview_teams_app_installed_payload_is_extracted(repo: Repository) -> None:
    fake = _FakeGraph(
        purview_records=[
            {
                "id": "pv-teams-app",
                "createdDateTime": "2026-05-18T02:28:41Z",
                "operation": "AppInstalled",
                "userId": "u-1",
                "userPrincipalName": "alice@x",
                "workload": "MicrosoftTeams",
                "auditData": {
                    "Operation": "AppInstalled",
                    "Workload": "MicrosoftTeams",
                    "AddOnGuid": "addon-guid-1",
                    "AddOnType": 4,
                    "AppDistributionMode": "Organization",
                    "AppExternalId": "app-external-1",
                    "ChatThreadId": "thread-1",
                    "OperationScope": 2,
                    "AppAccessContext": {"AADSessionId": "session-1"},
                },
            }
        ]
    )

    aq.collect_purview(repo, fake)  # type: ignore[arg-type]

    row = repo.list_audit_events(source="purview")[0]
    assert row.app == "app-external-1"
    payload = json.loads(row.target_resources or "[]")
    assert {item["key"] for item in payload} >= {
        "AddOnGuid",
        "AddOnType",
        "AppDistributionMode",
        "AppExternalId",
        "ChatThreadId",
        "OperationScope",
        "AppAccessContext",
    }


def test_purview_payload_includes_unknown_audit_data_fields(repo: Repository) -> None:
    fake = _FakeGraph(
        purview_records=[
            {
                "id": "pv-new-shape",
                "createdDateTime": "2026-05-18T02:28:41Z",
                "operation": "FutureOperation",
                "userId": "u-1",
                "userPrincipalName": "alice@x",
                "workload": "FutureWorkload",
                "auditData": {
                    "Operation": "FutureOperation",
                    "Workload": "FutureWorkload",
                    "FuturePayloadId": "payload-1",
                    "NestedPayload": {"InnerId": "inner-1"},
                    "EmptyPayload": "",
                },
            }
        ]
    )

    aq.collect_purview(repo, fake)  # type: ignore[arg-type]

    row = repo.list_audit_events(source="purview")[0]
    payload = json.loads(row.target_resources or "[]")
    assert {item["key"] for item in payload} >= {
        "FuturePayloadId",
        "NestedPayload",
    }
    assert "EmptyPayload" not in {item["key"] for item in payload}


def test_purview_404_disables_collector(repo: Repository) -> None:
    fake = _FakeGraph(raise_404_on_submit=True)
    outcome = aq.collect_purview(repo, fake)  # type: ignore[arg-type]
    assert outcome.error is not None
    state = repo.get_audit_collection_state("purview")
    assert state is not None
    assert state.enabled is False


def test_purview_substrate_403_records_error_without_disabling(repo: Repository) -> None:
    """403 'App ... dont have any permissions' remains recoverable."""
    fake = _FakeGraph(raise_403_substrate_on_submit=True)
    outcome = aq.collect_purview(repo, fake)  # type: ignore[arg-type]
    assert outcome.error is not None
    state = repo.get_audit_collection_state("purview")
    assert state is not None
    assert state.enabled is True
    assert state.last_error is not None
    assert "Purview" in state.last_error
    assert "403" in state.last_error
    assert "PowerShell" not in state.last_error
    assert "Audit Reader" not in state.last_error


def test_mark_purview_permissions_ready_reenables_disabled_state(repo: Repository) -> None:
    state = AuditCollectionState(
        source="purview",
        last_collected_at="2025-01-01T00:00:00Z",
        pending_query_id="stale-query",
        pending_submitted_at="2025-01-01T00:01:00Z",
        pending_window_start="2025-01-01T00:00:00Z",
        pending_window_end="2025-01-01T01:00:00Z",
        last_error="403 — 서비스 주체가 Purview 감사 로그 권한을 아직 갖고 있지 않음.",
        last_error_at="2025-01-01T00:02:00Z",
        last_success_at=None,
        last_record_count=0,
        enabled=False,
    )
    repo.update_audit_collection_state(state)

    aq.mark_purview_permissions_ready(repo)

    repaired = repo.get_audit_collection_state("purview")
    assert repaired is not None
    assert repaired.enabled is True
    assert repaired.pending_query_id is None
    assert repaired.pending_submitted_at is None
    assert repaired.last_error is None
    assert repaired.last_collected_at == "2025-01-01T00:00:00Z"


def test_purview_disabled_permission_state_retries_after_rbac_flag(repo: Repository) -> None:
    repo.update_audit_collection_state(
        AuditCollectionState(
            source="purview",
            last_collected_at=None,
            pending_query_id=None,
            pending_submitted_at=None,
            pending_window_start=None,
            pending_window_end=None,
            last_error="403 — 서비스 주체가 Purview 감사 로그 권한을 아직 갖고 있지 않음.",
            last_error_at="2025-01-01T00:02:00Z",
            last_success_at=None,
            last_record_count=0,
            enabled=False,
        )
    )
    repo.set_text_setting("purview_rbac_granted", "1")
    fake = _FakeGraph(
        purview_records=[
            {
                "id": "pv-after-repair",
                "createdDateTime": "2025-01-15T11:00:00Z",
                "operation": "CopilotInteraction",
                "userId": "u-1",
            }
        ]
    )

    outcome = aq.collect_purview(repo, fake)  # type: ignore[arg-type]

    assert outcome.fetched == 1
    state = repo.get_audit_collection_state("purview")
    assert state is not None
    assert state.enabled is True
    assert state.last_error is None


def test_purview_pending_query_resumes_next_cycle(repo: Repository) -> None:
    fake = _FakeGraph(purview_status="running")
    outcome = aq.collect_purview(repo, fake)  # type: ignore[arg-type]
    assert outcome.pending is True
    assert any("쿼리 상태: running" == detail for detail in outcome.details)
    state = repo.get_audit_collection_state("purview")
    assert state is not None
    assert state.pending_query_id == "qid-1"
    # Next cycle: complete it.
    fake._purview_status = "succeeded"
    fake._purview_records = [
        {
            "id": "pv-late",
            "createdDateTime": "2025-01-15T11:00:00Z",
            "operation": "CopilotInteraction",
            "userId": "u-1",
        }
    ]
    out2 = aq.collect_purview(repo, fake)  # type: ignore[arg-type]
    assert out2.fetched == 1
    state2 = repo.get_audit_collection_state("purview")
    assert state2 is not None
    assert state2.pending_query_id is None


# ---- Usage reports -----------------------------------------------------


_USAGE_CSV = (
    b"Display Name,User Principal Name,Last activity date,"
    b"Last activity of Microsoft Teams Copilot,"
    b"Last activity of Word Copilot,"
    b"Last activity of Excel Copilot,"
    b"Last activity of PowerPoint Copilot,"
    b"Last activity of Outlook Copilot,"
    b"Last activity of OneNote Copilot,"
    b"Last activity of Loop Copilot,"
    b"Last activity of Copilot Chat\n"
    b"Alice Anderson,alice@contoso.com,2025-01-14,2025-01-14,2025-01-10,,,2025-01-14,,,2025-01-14\n"
    b"Bob Brown,bob@contoso.com,2025-01-12,,,,,,,,2025-01-12\n"
)

_USAGE_CSV_CURRENT_COLUMNS = (
    b"Report Refresh Date,User Principal Name,Display Name,Last Activity Date,"
    b"Copilot Chat Last Activity Date,Microsoft Teams Copilot Last Activity Date,"
    b"Word Copilot Last Activity Date,Excel Copilot Last Activity Date,"
    b"PowerPoint Copilot Last Activity Date,Outlook Copilot Last Activity Date,"
    b"OneNote Copilot Last Activity Date,Loop Copilot Last Activity Date,Report Period\n"
    b"2026-05-19,A25BD01A4B5F6482758A0C00162A1298,F55C24F4D1ED3FB6A2C51CEABA786000,"
    b"2026-05-16,2026-05-16,,2026-02-12,2026-05-12,2026-05-13,,,,30\n"
)

_USAGE_COUNT_SUMMARY_CSV = (
    b"Report Refresh Date,Report Period,Any App Enabled Users,Any App Active Users,"
    b"Microsoft Teams Enabled Users,Microsoft Teams Active Users,Word Enabled Users,Word Active Users,"
    b"PowerPoint Enabled Users,PowerPoint Active Users,Outlook Enabled Users,Outlook Active Users,"
    b"Excel Enabled Users,Excel Active Users,OneNote Enabled Users,OneNote Active Users,"
    b"Loop Enabled Users,Loop Active Users,Copilot Chat Enabled Users,Copilot Chat Active Users\n"
    b"2026-05-19,30,100,40,100,30,100,10,100,5,100,8,100,7,100,2,100,1,100,25\n"
)

_USAGE_COUNT_TREND_CSV = (
    b"Report Refresh Date,Report Period,Report Date,Any App Enabled Users,Any App Active Users,"
    b"Microsoft Teams Enabled Users,Microsoft Teams Active Users,Word Enabled Users,Word Active Users,"
    b"PowerPoint Enabled Users,PowerPoint Active Users,Outlook Enabled Users,Outlook Active Users,"
    b"Excel Enabled Users,Excel Active Users,OneNote Enabled Users,OneNote Active Users,"
    b"Loop Enabled Users,Loop Active Users,Copilot Chat Enabled Users,Copilot Chat Active Users\n"
    b"2026-05-19,30,2026-05-18,100,35,100,25,100,7,100,4,100,6,100,5,100,1,100,1,100,22\n"
    b"2026-05-19,30,2026-05-19,100,40,100,30,100,10,100,5,100,8,100,7,100,2,100,1,100,25\n"
)


def test_usage_csv_parsed_and_stored(repo: Repository) -> None:
    fake = _FakeGraph(usage_csv=_USAGE_CSV)
    n = ur.collect_copilot_usage(repo, fake)  # type: ignore[arg-type]
    assert n == 2
    today = repo.latest_usage_snapshot_date("D30")
    assert today is not None


def test_usage_count_summary_and_trend_parsed_and_stored(repo: Repository) -> None:
    fake = _FakeGraph(
        usage_csv=_USAGE_CSV,
        summary_csv=_USAGE_COUNT_SUMMARY_CSV,
        trend_csv=_USAGE_COUNT_TREND_CSV,
    )

    result = ur.collect_copilot_usage_reports(repo, fake)  # type: ignore[arg-type]

    assert result.detail_rows == 2
    assert result.summary_rows == 1
    assert result.trend_rows == 2
    summary_rows = repo.list_usage_count_rows(report_type="summary", period="D30")
    trend_rows = repo.list_usage_count_rows(report_type="trend", period="D30")
    assert len(summary_rows) == 1
    assert summary_rows[0].any_app_active_users == 40
    assert summary_rows[0].copilot_chat_active_users == 25
    assert len(trend_rows) == 2
    assert trend_rows[0].report_date == "2026-05-19"
    assert trend_rows[0].teams_active_users == 30


def test_usage_upsert_updates_same_snapshot_period_without_deleting_other_periods(
    repo: Repository,
) -> None:
    rows = ur.parse_for_tests(_USAGE_CSV, period="D30")
    assert repo.upsert_usage_snapshots(rows) == 2
    changed = [*rows]
    changed[0].display_name = "Alice Updated"
    assert repo.upsert_usage_snapshots(changed) == 2

    d30_rows = repo.list_usage_snapshots(period="D30")
    assert len(d30_rows) == 2
    assert d30_rows[0].display_name == "Alice Updated"

    d90_rows = ur.parse_for_tests(_USAGE_CSV, period="D90")
    assert repo.upsert_usage_snapshots(d90_rows) == 2
    assert len(repo.list_usage_snapshots(period="D30")) == 2
    assert len(repo.list_usage_snapshots(period="D90")) == 2


def test_audit_worker_collects_all_usage_report_periods(repo: Repository) -> None:
    from copilot_watchtower.workers.collector import AuditCollectorWorker

    fake = _FakeGraph(
        usage_csv=_USAGE_CSV,
        summary_csv=_USAGE_COUNT_SUMMARY_CSV,
        trend_csv=_USAGE_COUNT_TREND_CSV,
    )
    worker = AuditCollectorWorker(repo, fake)  # type: ignore[arg-type]

    assert worker._snapshot_usage_report() == (20, 0)
    assert fake.usage_periods_requested == ["D7", "D30", "D90", "D180"]
    assert fake.summary_periods_requested == ["D7", "D30", "D90", "D180"]
    assert fake.trend_periods_requested == ["D7", "D30", "D90", "D180"]
    for period in ("D7", "D30", "D90", "D180"):
        assert len(repo.list_usage_snapshots(period=period)) == 2
        assert len(repo.list_usage_count_rows(report_type="summary", period=period)) == 1
        assert len(repo.list_usage_count_rows(report_type="trend", period=period)) == 2


@pytest.mark.parametrize(
    ("data_kind", "expected"),
    [
        ("audit", ["audit"]),
        ("usage", ["usage"]),
        ("diagnostics", ["diagnostics"]),
    ],
)
def test_audit_worker_collects_only_selected_management_data(
    repo: Repository,
    data_kind: str,
    expected: list[str],
) -> None:
    from copilot_watchtower.workers.collector import AuditCollectorWorker

    calls: list[str] = []
    worker = AuditCollectorWorker(repo, _FakeGraph(), data_kind=data_kind)  # type: ignore[arg-type]

    def collect_audit() -> tuple[int, int]:
        calls.append("audit")
        return 1, 0

    def collect_usage() -> tuple[int, int]:
        calls.append("usage")
        return 2, 0

    def collect_diagnostics() -> tuple[int, int]:
        calls.append("diagnostics")
        return 3, 0

    worker._collect_audit_events = collect_audit  # type: ignore[method-assign]
    worker._snapshot_usage_report = collect_usage  # type: ignore[method-assign]
    worker._collect_admin_diagnostics = collect_diagnostics  # type: ignore[method-assign]

    worker.run()

    assert calls == expected


def test_admin_diagnostics_logs_catalog_success_without_optional_error_count(repo: Repository) -> None:
    from copilot_watchtower.workers.collector import AuditCollectorWorker

    worker = AuditCollectorWorker(repo, _FakeGraph(), data_kind="diagnostics")  # type: ignore[arg-type]
    worker._build_delegated_catalog_graph = lambda: _FakeGraph()  # type: ignore[method-assign]
    logs: list[str] = []
    worker.log_line.connect(logs.append)

    rows, errors = worker._collect_admin_diagnostics()

    assert rows == 4
    assert errors == 0
    assert any("Copilot 패키지/Agent 카탈로그: 패키지 1건 조회 (200)" in line for line in logs)
    assert any("Copilot 제한 모드: 권한 또는 관리자 정책으로 접근 거부 (동의 대기 가능) (403)" in line for line in logs)
    assert any("에이전트 목록: 1개 저장" in line for line in logs)


def test_usage_404_swallows_error(repo: Repository) -> None:
    fake = _FakeGraph(usage_csv=None)
    n = ur.collect_copilot_usage(repo, fake)  # type: ignore[arg-type]
    assert n == 0


def test_usage_parser_column_mapping() -> None:
    rows = ur.parse_for_tests(_USAGE_CSV, period="D30")
    assert len(rows) == 2
    alice = rows[0]
    assert alice.upn == "alice@contoso.com"
    assert alice.display_name == "Alice Anderson"
    assert alice.last_activity_teams == "2025-01-14"
    assert alice.last_activity_word == "2025-01-10"
    assert alice.last_activity_excel is None
    assert alice.last_activity_bizchat == "2025-01-14"


def test_usage_parser_current_graph_column_names() -> None:
    rows = ur.parse_for_tests(_USAGE_CSV_CURRENT_COLUMNS, period="D30")
    assert len(rows) == 1
    row = rows[0]
    assert row.snapshot_date == "2026-05-19"
    assert row.period == "D30"
    assert row.last_activity_overall == "2026-05-16"
    assert row.last_activity_bizchat == "2026-05-16"
    assert row.last_activity_word == "2026-02-12"
    assert row.last_activity_excel == "2026-05-12"
    assert row.last_activity_powerpoint == "2026-05-13"
