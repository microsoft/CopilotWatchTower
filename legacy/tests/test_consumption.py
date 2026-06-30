"""Unit tests for Power Platform consumption (agent cost-credit) feature.

Covers three layers without touching the live (unofficial) licensing API:

* ``parse_consumption_csv`` — header-alias robustness, dateless-row skip,
  numeric coercion and ``raw_json`` preservation;
* ``Repository`` consumption persistence + aggregation helpers (upsert,
  list, daily totals, top users, summary projection);
* ``Bridge.consumption_list`` / ``consumption_overview`` JSON surfaces.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from copilot_watchtower.config import (
    LICENSING_REPORT_AI_BUILDER,
    LICENSING_REPORT_MCS_MESSAGES,
)
from copilot_watchtower.db import (
    ConsumptionRow,
    Repository,
    UserRow,
    initialize,
)
from copilot_watchtower.services.licensing import parse_consumption_csv
from copilot_watchtower.webshell.bridge import Bridge, BridgeContext


def _date(days_ago: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# CSV parsing
# --------------------------------------------------------------------------

def test_parse_consumption_csv_maps_aliased_headers() -> None:
    csv_text = (
        "Date,UserId,EnvironmentId,EnvironmentName,MessageCount\n"
        "2026-05-01T00:00:00Z,u-1,env-1,Prod,12\n"
        "2026-05-02,u-2,env-1,Prod,3\n"
    )
    rows = parse_consumption_csv(
        csv_text.encode("utf-8"), LICENSING_REPORT_MCS_MESSAGES
    )
    assert len(rows) == 2
    first = rows[0]
    assert first.report_type == LICENSING_REPORT_MCS_MESSAGES
    assert first.usage_date == "2026-05-01"  # T-suffix stripped
    assert first.user_id == "u-1"
    assert first.environment_id == "env-1"
    assert first.environment_name == "Prod"
    assert first.quantity == 12.0
    assert first.unit == "messages"
    # The full original row is preserved for forensics.
    assert json.loads(first.raw_json)["MessageCount"] == "12"


def test_parse_consumption_csv_skips_dateless_rows() -> None:
    csv_text = "Date,UserId,Quantity\n,u-1,5\n2026-05-01,u-2,7\n"
    rows = parse_consumption_csv(csv_text, LICENSING_REPORT_AI_BUILDER)
    assert [r.user_id for r in rows] == ["u-2"]
    assert rows[0].unit == "credits"


def test_parse_consumption_csv_coerces_messy_numbers() -> None:
    csv_text = "Date,Quantity\n2026-05-01,\"1,234\"\n2026-05-02,bogus\n"
    rows = parse_consumption_csv(csv_text, LICENSING_REPORT_MCS_MESSAGES)
    assert rows[0].quantity == 1234.0
    assert rows[1].quantity == 0.0


# --------------------------------------------------------------------------
# JSON parsing (real PPAC licensing endpoints — fixtures from a live capture)
# --------------------------------------------------------------------------

def test_parse_currency_reports_json_splits_fields() -> None:
    from copilot_watchtower.services.licensing import parse_currency_reports_json

    data = [
        {"currencyType": "MCSMessages", "purchased": 25000, "allocated": 5000},
        {"currencyType": "TenantM365Copilot", "purchased": 25, "allocated": 0},
        {"currencyType": "", "purchased": 1},  # no currency -> skipped
        "junk",  # non-dict -> skipped
    ]
    rows = parse_currency_reports_json(data, snapshot_date="2026-06-01")
    # MCSMessages -> purchased + allocated; Copilot -> purchased + allocated.
    by_key = {(r.report_type, r.product): r.quantity for r in rows}
    assert by_key[("MCSMessages", "purchased")] == 25000.0
    assert by_key[("MCSMessages", "allocated")] == 5000.0
    assert by_key[("TenantM365Copilot", "purchased")] == 25.0
    mcs = next(r for r in rows if r.report_type == "MCSMessages")
    assert mcs.usage_date == "2026-06-01"
    assert mcs.unit == "messages"
    assert mcs.user_id is None
    # The empty-currency and non-dict entries produced no rows.
    assert all(r.report_type in {"MCSMessages", "TenantM365Copilot"} for r in rows)


def test_parse_tenant_capacity_json_emits_actual_rated_total() -> None:
    from copilot_watchtower.services.licensing import parse_tenant_capacity_json

    data = {
        "tenantCapacities": [
            {
                "capacityType": "Database",
                "capacityUnits": "MB",
                "totalCapacity": 5120.0,
                "consumption": {"actual": 909.25, "rated": 1024.0},
            },
            "junk",  # non-dict -> skipped
        ]
    }
    rows = parse_tenant_capacity_json(data, snapshot_date="2026-06-01")
    by_product = {r.product: r.quantity for r in rows}
    assert by_product == {"actual": 909.25, "rated": 1024.0, "total": 5120.0}
    assert all(r.report_type == "Capacity:Database" for r in rows)
    assert all(r.unit == "MB" for r in rows)


def test_parse_currency_reports_json_handles_non_list() -> None:
    from copilot_watchtower.services.licensing import parse_currency_reports_json

    assert parse_currency_reports_json({}, snapshot_date="2026-06-01") == []
    assert parse_currency_reports_json(None, snapshot_date="2026-06-01") == []


def test_parse_tenant_capacity_json_handles_missing_key() -> None:
    from copilot_watchtower.services.licensing import parse_tenant_capacity_json

    assert parse_tenant_capacity_json({}, snapshot_date="2026-06-01") == []
    assert parse_tenant_capacity_json(None, snapshot_date="2026-06-01") == []


def test_parse_mcs_resource_rows_breaks_down_per_agent() -> None:
    from copilot_watchtower.services.licensing import parse_mcs_resource_rows

    # Real shape from /v2.0/.../entitlements/MCSMessages/resources
    data = [
        {
            "resources": [
                {
                    "environmentId": "env-a",
                    "resourceId": "res-1",
                    "consumed": 215.15,
                    "unit": "Messages",
                    "metadata": {"ResourceName": "pdfwork", "NonBillableQuantity": 0.0},
                    "asOfDate": "2026-05-31T09:44:48.233",
                },
                {
                    "environmentId": "env-b",
                    "resourceId": "res-2",
                    "consumed": 0.0,
                    "unit": "Messages",
                    "metadata": {"ResourceName": "일일 업무 정리 도우미", "NonBillableQuantity": 98.0},
                    "asOfDate": "2026-05-31T09:44:48.233",
                },
                "junk",  # non-dict -> skipped
            ]
        }
    ]
    rows = parse_mcs_resource_rows(
        data, snapshot_date="2026-06-01", window_start="2025-12-02", window_end="2026-05-31"
    )
    assert len(rows) == 2
    assert all(r.report_type == "MCSMessages:resource" for r in rows)
    assert all(r.unit == "messages" for r in rows)
    # asOfDate is used for the usage_date, normalized to its date part.
    assert all(r.usage_date == "2026-05-31" for r in rows)
    by_product = {r.product: r for r in rows}
    assert by_product["pdfwork"].quantity == 215.15
    assert by_product["pdfwork"].environment_id == "env-a"
    assert by_product["pdfwork"].window_start == "2025-12-02"
    # Non-billable quantity is preserved in raw_json for the UI.
    raw = json.loads(by_product["일일 업무 정리 도우미"].raw_json)
    assert raw["metadata"]["NonBillableQuantity"] == 98.0


def test_parse_mcs_resource_rows_handles_empty() -> None:
    from copilot_watchtower.services.licensing import parse_mcs_resource_rows

    assert parse_mcs_resource_rows(None, snapshot_date="2026-06-01") == []
    assert parse_mcs_resource_rows([], snapshot_date="2026-06-01") == []
    assert parse_mcs_resource_rows([{"resources": "x"}], snapshot_date="2026-06-01") == []


def test_parse_mcs_environment_rows_emits_capacity_fields() -> None:
    from copilot_watchtower.services.licensing import parse_mcs_environment_rows

    # Real shape from /v2.0/.../environments/entitlementConsumptions/MCSMessages
    data = {
        "value": [
            {
                "environmentId": "70e5e429",
                "environmentName": "Microsoft 365 Copilot Chat",
                "entitlement": {
                    "capacity": {
                        "allocated": {"value": 5000.0},
                        "consumed": {"value": 12.0},
                        "availableQuantity": 4988.0,
                    }
                },
            },
            "junk",  # non-dict -> skipped
        ]
    }
    rows = parse_mcs_environment_rows(data, snapshot_date="2026-06-01")
    assert all(r.report_type == "MCSMessages:environment" for r in rows)
    assert all(r.environment_name == "Microsoft 365 Copilot Chat" for r in rows)
    by_product = {r.product: r.quantity for r in rows}
    assert by_product == {"consumed": 12.0, "allocated": 5000.0, "available": 4988.0}


def test_parse_mcs_environment_rows_handles_empty() -> None:
    from copilot_watchtower.services.licensing import parse_mcs_environment_rows

    assert parse_mcs_environment_rows({}, snapshot_date="2026-06-01") == []
    assert parse_mcs_environment_rows(None, snapshot_date="2026-06-01") == []


def test_parse_mcs_user_rows_breaks_down_per_user() -> None:
    from copilot_watchtower.services.licensing import parse_mcs_user_rows

    # Real shape from /v2.0/.../entitlements/MCSMessages/users?fromDate&toDate
    data = {
        "value": [
            {
                "users": [
                    {
                        "tenantId": "tid",
                        "userId": "abf5d800-b694-4ab3-ac82-ec256c020c88",
                        "consumed": 42.0,
                        "unit": "Messages",
                        "metadata": {"Resources": 2, "NonBillableQuantity": 16.0},
                        "asOfDate": "2026-06-01T00:00:00",
                    },
                    "junk",  # non-dict -> skipped
                ]
            },
            "junk",  # non-dict group -> skipped
        ]
    }
    rows = parse_mcs_user_rows(
        data, snapshot_date="2026-06-02", window_start="2025-12-05", window_end="2026-06-02"
    )
    assert len(rows) == 1
    row = rows[0]
    assert row.report_type == "MCSMessages:user"
    assert row.user_id == "abf5d800-b694-4ab3-ac82-ec256c020c88"
    assert row.quantity == 42.0
    assert row.unit == "messages"
    assert row.usage_date == "2026-06-01"  # from asOfDate
    assert row.window_start == "2025-12-05"
    # Non-billable quantity + resource count preserved for the UI.
    raw = json.loads(row.raw_json)
    assert raw["metadata"]["NonBillableQuantity"] == 16.0
    assert raw["metadata"]["Resources"] == 2


def test_parse_mcs_user_rows_handles_empty() -> None:
    from copilot_watchtower.services.licensing import parse_mcs_user_rows

    assert parse_mcs_user_rows({}, snapshot_date="2026-06-01") == []
    assert parse_mcs_user_rows(None, snapshot_date="2026-06-01") == []
    assert parse_mcs_user_rows({"value": [{"users": "x"}]}, snapshot_date="2026-06-01") == []



# --------------------------------------------------------------------------
# Browser-driven licensing token capture (no live browser/network)
# --------------------------------------------------------------------------

def test_extract_bearer_token_reads_authorization_header() -> None:
    from copilot_watchtower.services.consumption_browser_download import (
        extract_bearer_token,
    )

    assert extract_bearer_token({"Authorization": "Bearer abc.def"}) == "abc.def"
    # Header name casing must not matter.
    assert extract_bearer_token({"authorization": "bearer xyz"}) == "xyz"
    # Non-bearer / missing headers yield None.
    assert extract_bearer_token({"Authorization": "Basic zzz"}) is None
    assert extract_bearer_token({"Content-Type": "application/json"}) is None


def test_extract_token_from_storage_matches_audience() -> None:
    from copilot_watchtower.services.consumption_browser_download import (
        extract_token_from_storage,
    )

    storage = {
        "msal.account.keys": "[]",
        "some-key-licensing.powerplatform.microsoft.com-accesstoken": json.dumps(
            {"secret": "tok-123", "target": "https://licensing.powerplatform.microsoft.com/.default"}
        ),
        "graph-token": json.dumps({"secret": "graph-tok", "target": "graph.microsoft.com"}),
    }
    token = extract_token_from_storage(
        storage, audience="licensing.powerplatform.microsoft.com"
    )
    assert token == "tok-123"


def test_extract_token_from_storage_returns_none_when_absent() -> None:
    from copilot_watchtower.services.consumption_browser_download import (
        extract_token_from_storage,
    )

    storage = {"graph-token": json.dumps({"secret": "graph-tok", "target": "graph"})}
    assert (
        extract_token_from_storage(
            storage, audience="licensing.powerplatform.microsoft.com"
        )
        is None
    )


def test_captured_token_provider_returns_static_token() -> None:
    from copilot_watchtower.services.consumption_browser_download import (
        CapturedTokenProvider,
    )

    provider = CapturedTokenProvider("static-tok")
    assert provider.acquire() == "static-tok"
    assert provider.acquire_for_scopes(["any"]) == "static-tok"



# --------------------------------------------------------------------------
# Repository
# --------------------------------------------------------------------------

@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    r = Repository(db)
    r.upsert_users(
        [
            UserRow("u-1", "u1@x", "User One", True, True, True),
            UserRow("u-2", "u2@x", "User Two", True, True, True),
        ]
    )
    return r


def _row(usage_date: str, user_id: str | None, qty: float, *, env: str | None = "env-1") -> ConsumptionRow:
    return ConsumptionRow(
        report_type=LICENSING_REPORT_MCS_MESSAGES,
        usage_date=usage_date,
        environment_id=env,
        environment_name="Prod" if env else None,
        user_id=user_id,
        product="Copilot Studio",
        quantity=qty,
        unit="messages",
    )


def test_upsert_consumption_rows_is_idempotent(repo: Repository) -> None:
    rows = [_row(_date(1), "u-1", 10.0), _row(_date(1), "u-2", 5.0)]
    assert repo.upsert_consumption_rows(rows) == 2
    # Re-upsert with an updated quantity -> same id, value overwritten.
    repo.upsert_consumption_rows([_row(_date(1), "u-1", 99.0)])
    listed = repo.list_consumption_rows(report_type=LICENSING_REPORT_MCS_MESSAGES)
    by_user = {r.user_id: r.quantity for r in listed}
    assert by_user == {"u-1": 99.0, "u-2": 5.0}


def test_list_consumption_rows_joins_user_display(repo: Repository) -> None:
    repo.upsert_consumption_rows([_row(_date(1), "u-1", 10.0)])
    listed = repo.list_consumption_rows(report_type=LICENSING_REPORT_MCS_MESSAGES)
    assert listed[0].display_name == "User One"
    assert listed[0].upn == "u1@x"


def test_consumption_daily_totals_and_top_users(repo: Repository) -> None:
    repo.upsert_consumption_rows(
        [
            _row(_date(2), "u-1", 10.0),
            _row(_date(2), "u-2", 4.0),
            _row(_date(1), "u-1", 6.0),
        ]
    )
    totals = repo.consumption_daily_totals(report_type=LICENSING_REPORT_MCS_MESSAGES, days=30)
    assert dict(totals) == {_date(2): 14.0, _date(1): 6.0}
    # Ascending by date.
    assert [d for d, _ in totals] == sorted(d for d, _ in totals)
    top = repo.consumption_top_users(report_type=LICENSING_REPORT_MCS_MESSAGES, days=30)
    assert top[0]["user_id"] == "u-1"
    assert top[0]["total"] == 16.0
    assert top[0]["display_name"] == "User One"


def test_consumption_summary_projects_month(repo: Repository) -> None:
    # 2 active days, 20 total => 10/day => 300 projected over 30 days.
    repo.upsert_consumption_rows(
        [
            _row(_date(1), "u-1", 10.0),
            _row(_date(0), "u-2", 10.0),
        ]
    )
    summary = repo.consumption_summary(report_type=LICENSING_REPORT_MCS_MESSAGES, days=30)
    assert summary["total"] == 20.0
    assert summary["users"] == 2
    assert summary["environments"] == 1
    assert summary["unit"] == "messages"
    assert summary["projected_month"] == pytest.approx(300.0)


# --------------------------------------------------------------------------
# Bridge
# --------------------------------------------------------------------------

@pytest.fixture
def bridge(qtbot, repo: Repository) -> Bridge:
    del qtbot  # ensures a QApplication exists
    repo.upsert_consumption_rows(
        [
            _row(_date(1), "u-1", 10.0),
            _row(_date(1), "u-2", 5.0),
        ]
    )
    return Bridge(BridgeContext(repo=repo))


def test_bridge_consumption_list_returns_rows(bridge: Bridge) -> None:
    payload = json.loads(
        bridge.consumption_list(json.dumps({"report_type": LICENSING_REPORT_MCS_MESSAGES}))
    )
    assert {r["user_id"] for r in payload} == {"u-1", "u-2"}
    assert payload[0]["unit"] == "messages"
    assert "display_name" in payload[0]


def test_bridge_consumption_overview_shape(bridge: Bridge) -> None:
    payload = json.loads(
        bridge.consumption_overview(
            json.dumps({"report_type": LICENSING_REPORT_MCS_MESSAGES, "days": 30})
        )
    )
    assert payload["summary"]["total"] == 15.0
    assert payload["summary"]["users"] == 2
    assert isinstance(payload["trend"], list)
    assert payload["trend"][0]["total"] == 15.0
    assert payload["top_users"][0]["total"] == 10.0
