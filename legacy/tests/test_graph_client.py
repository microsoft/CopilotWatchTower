from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from copilot_watchtower.services.graph import GraphClient


class _FixedTokenProvider:
    def __init__(self, token: str = "fake-token") -> None:
        self.token = token

    def acquire(self) -> str:
        return self.token

    def invalidate(self) -> None:
        self.token = "rotated"


class _ScopedTokenProvider(_FixedTokenProvider):
    def acquire_for_scopes(self, scopes: list[str]) -> str:
        return "scoped-token"


def _build_client(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, timeout=5.0)
    client = GraphClient(_FixedTokenProvider(), http_client=http)
    return client


def test_ediscovery_export_uses_zip_package_options() -> None:
    seen_body: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_body
        seen_body = json.loads(request.content.decode("utf-8"))
        return httpx.Response(202, headers={"Location": "https://graph/op/export"})

    client = _build_client(handler)
    result = client.export_ediscovery_search("case-1", "search-1", display_name="export-1")

    assert result["operation_location"] == "https://graph/op/export"
    assert seen_body["exportFormat"] == "msg"
    assert "includeFolderAndPath" in seen_body["additionalOptions"]
    assert seen_body["exportCriteria"] == "searchHits"


def test_ediscovery_download_preserves_headers_across_manual_redirect() -> None:
    seen: list[tuple[str, str | None, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            (
                str(request.url),
                request.headers.get("authorization"),
                request.headers.get("x-allowwithaadtoken"),
            )
        )
        if str(request.url).startswith("https://nam.proxyservice.ediscovery"):
            return httpx.Response(302, headers={"Location": "https://download.contoso/export.zip"})
        return httpx.Response(200, content=b"zip-bytes", headers={"content-type": "application/zip"})

    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, timeout=5.0)
    client = GraphClient(_ScopedTokenProvider(), http_client=http)

    data = client.download_ediscovery_export(
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/ediscovery/api/proxy/exportaedblobFileResult(abc)"
    )

    assert data == b"zip-bytes"
    assert len(seen) == 2
    assert seen[0][1] == "Bearer scoped-token"
    assert seen[1][1] == "Bearer scoped-token"
    assert seen[1][2] == "true"


def test_paginate_follows_next_link() -> None:
    pages = [
        {"value": [{"id": "u1"}, {"id": "u2"}], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?skiptoken=abc"},
        {"value": [{"id": "u3"}]},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if "skiptoken=abc" in str(request.url):
            return httpx.Response(200, json=pages[1])
        return httpx.Response(200, json=pages[0])

    client = _build_client(handler)
    ids = [u.id for u in client.list_users()]
    assert ids == ["u1", "u2", "u3"]


def test_429_retry_uses_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    state: dict[str, Any] = {"calls": 0, "sleeps": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["calls"] == 1:
            return httpx.Response(429, headers={"Retry-After": "1"}, json={"error": "throttled"})
        return httpx.Response(200, json={"value": []})

    client = _build_client(handler)
    monkeypatch.setattr("time.sleep", lambda s: state["sleeps"].append(s))
    result = list(client.list_users())
    assert result == []
    assert state["calls"] == 2
    assert state["sleeps"] and state["sleeps"][0] >= 1


def test_401_triggers_token_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    state: dict[str, Any] = {"calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["calls"] == 1:
            return httpx.Response(401, json={"error": "unauth"})
        return httpx.Response(200, json={"value": []})

    client = _build_client(handler)
    monkeypatch.setattr("time.sleep", lambda s: None)
    list(client.list_users())
    assert state["calls"] == 2
    # token rotated due to invalidate() being called on 401
    assert client.token_provider.token == "rotated"


def test_granted_app_role_ids_collects_assigned_roles() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "servicePrincipals(appId=" in url:
            return httpx.Response(200, json={"id": "sp-obj-1"})
        if "/servicePrincipals/sp-obj-1/appRoleAssignments" in url:
            return httpx.Response(
                200,
                json={
                    "value": [
                        {"appRoleId": "role-a"},
                        {"appRoleId": "role-b"},
                        {"appRoleId": None},
                    ]
                },
            )
        return httpx.Response(404, json={"error": "not found"})

    client = _build_client(handler)
    roles = client.granted_app_role_ids("client-123")
    assert roles == {"role-a", "role-b"}


def test_granted_app_role_ids_raises_when_forbidden() -> None:
    from copilot_watchtower.services.graph import GraphError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "Insufficient privileges"})

    client = _build_client(handler)
    with pytest.raises(GraphError) as exc:
        client.granted_app_role_ids("client-123")
    assert exc.value.status == 403



def test_organization_summary_prefers_initial_onmicrosoft_domain() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "/v1.0/organization" in str(request.url)
        return httpx.Response(
            200,
            json={
                "value": [
                    {
                        "id": "tenant-1",
                        "displayName": "Contoso",
                        "verifiedDomains": [
                            {"name": "contoso.com", "isDefault": True, "isInitial": False},
                            {"name": "contoso.onmicrosoft.com", "isDefault": False, "isInitial": True},
                        ],
                    }
                ]
            },
        )

    client = _build_client(handler)

    assert client.organization_summary() == {
        "id": "tenant-1",
        "display_name": "Contoso",
        "domain": "contoso.onmicrosoft.com",
    }


def test_copilot_report_methods_use_current_endpoint_names() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, content=b"Report Refresh Date,Report Period\n2026-05-19,30\n")

    client = _build_client(handler)

    client.fetch_copilot_usage_user_detail(period="D30")
    client.fetch_copilot_user_count_summary(period="D30")
    client.fetch_copilot_user_count_trend(period="D30")

    assert any(
        "/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30')" in url
        for url in seen
    )
    assert any(
        "/v1.0/copilot/reports/getMicrosoft365CopilotUserCountSummary(period='D30')" in url
        for url in seen
    )
    assert any(
        "/v1.0/copilot/reports/getMicrosoft365CopilotUserCountTrend(period='D30')" in url
        for url in seen
    )
    assert not any("getMicrosoft365CopilotUsageUserCounts" in url for url in seen)


def test_copilot_report_methods_fall_back_to_beta_when_v1_unavailable() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen.append(url)
        if "/v1.0/copilot/reports/" in url:
            return httpx.Response(404, json={"error": {"message": "not found"}})
        return httpx.Response(200, content=b"Report Refresh Date,Report Period\n2026-05-19,30\n")

    client = _build_client(handler)

    client.fetch_copilot_user_count_summary(period="D30")

    assert any("/v1.0/copilot/reports/getMicrosoft365CopilotUserCountSummary" in url for url in seen)
    assert any("/beta/reports/getMicrosoft365CopilotUserCountSummary" in url for url in seen)


def test_copilot_admin_probe_methods_use_expected_paths() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if str(request.url).endswith("/limitedMode"):
            return httpx.Response(200, json={"isEnabledForGroup": False})
        return httpx.Response(200, json={"value": []})

    client = _build_client(handler)

    client.get_copilot_admin_limited_mode()
    client.list_copilot_admin_policy_settings()
    client.list_copilot_admin_catalog_packages()
    client.list_copilot_agent_registrations()

    assert any("/v1.0/copilot/admin/settings/limitedMode" in url for url in seen)
    assert any("/beta/copilot/admin/policySettings" in url for url in seen)
    assert any("/beta/copilot/admin/catalog/packages" in url for url in seen)
    assert any("/beta/copilot/agentRegistrations" in url for url in seen)


def test_catalog_packages_accepts_top_level_list_payload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "/beta/copilot/admin/catalog/packages" in str(request.url)
        return httpx.Response(
            200,
            json=[
                {"id": "pkg-1", "displayName": "Sales Agent", "elementTypes": ["DeclarativeCopilots"]},
                {"id": "pkg-2", "displayName": "Service Agent", "elementTypes": ["CustomEngineCopilots"]},
            ],
        )

    client = _build_client(handler)

    assert client.list_copilot_admin_catalog_packages() == [
        {"id": "pkg-1", "displayName": "Sales Agent", "elementTypes": ["DeclarativeCopilots"]},
        {"id": "pkg-2", "displayName": "Service Agent", "elementTypes": ["CustomEngineCopilots"]},
    ]
