from __future__ import annotations

from pathlib import Path

import pytest

from copilot_watchtower.db import Repository, initialize
from copilot_watchtower.services.admin_diagnostics import collect_copilot_admin_diagnostics
from copilot_watchtower.services.auth import DelegatedAuthExpiredError
from copilot_watchtower.services.graph import GraphError


class _FakeGraph:
    def get_copilot_admin_limited_mode(self):
        return {"isEnabledForGroup": True, "groupId": "group-1"}

    def list_copilot_admin_policy_settings(self):
        raise GraphError(403, {"error": {"message": "missing permission"}})

    def list_copilot_admin_catalog_packages(self):
        return [
            {"id": "pkg-1", "displayName": "Sales Agent", "elementTypes": ["DeclarativeCopilots"]},
            {"id": "mail-1", "displayName": "Mail Add-in", "elementTypes": ["ExchangeAddIns"]},
        ]

    def list_copilot_agent_registrations(self):
        raise GraphError(404, {"error": {"message": "not deployed"}})


class _FakeGraphWithAgent(_FakeGraph):
    def list_copilot_agent_registrations(self):
        return [
            {
                "id": "agent-1",
                "displayName": "Sales Agent",
                "appIdentity": "Copilot.Studio.agent-1",
                "publishingStatus": "Published",
            }
        ]


class _FakeGraphForbiddenCatalog(_FakeGraph):
    def list_copilot_admin_catalog_packages(self):
        raise GraphError(403, {"error": {"message": "app-only forbidden"}})


class _FakeDelegatedCatalog:
    def list_copilot_admin_catalog_packages(self):
        return [
            {"id": "pkg-agent", "displayName": "Delegated Agent", "elementTypes": ["CustomEngineCopilots"]},
            {"id": "pkg-mail", "displayName": "Delegated Mail Add-in", "elementTypes": ["ExchangeAddIns"]},
        ]


class _FakeDelegatedCatalogExpired:
    def list_copilot_admin_catalog_packages(self):
        raise DelegatedAuthExpiredError("silent delegated token missing")


class _FakeDelegatedCatalogUnexpected:
    def list_copilot_admin_catalog_packages(self):
        raise RuntimeError("catalog probe transport failure")


class _FakeDelegatedCatalogUnlicensed:
    def list_copilot_admin_catalog_packages(self):
        raise GraphError(
            403,
            {
                "error": {
                    "code": "Forbidden",
                    "message": (
                        "Customer must be a licensed for Agent 365 in order to "
                        "use Agent 365 Graph APIs"
                    ),
                }
            },
        )



@pytest.fixture()
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


def test_collect_copilot_admin_diagnostics_persists_status_rows(repo: Repository) -> None:
    assert collect_copilot_admin_diagnostics(repo, _FakeGraph()) == 4  # type: ignore[arg-type]

    rows = {row.key: row for row in repo.list_copilot_admin_diagnostics()}
    assert rows["limited_mode"].status == "ok"
    assert "그룹 제한 모드" in (rows["limited_mode"].summary or "")
    assert rows["policy_settings"].status == "forbidden"
    assert rows["catalog_packages"].status == "ok"
    assert rows["catalog_packages"].payload_json is not None
    assert rows["agent_registrations"].status == "not_found"


def test_collect_copilot_admin_diagnostics_normalizes_agent_rows(repo: Repository) -> None:
    assert collect_copilot_admin_diagnostics(repo, _FakeGraphWithAgent()) == 4  # type: ignore[arg-type]

    agents = {row.id: row for row in repo.list_copilot_agents()}

    assert agents["agent-1"].display_name == "Sales Agent"
    assert agents["agent-1"].app_identity == "Copilot.Studio.agent-1"
    assert agents["agent-1"].status == "Published"


def test_collect_copilot_admin_diagnostics_uses_delegated_catalog_graph(repo: Repository) -> None:
    assert (
        collect_copilot_admin_diagnostics(
            repo,
            _FakeGraphForbiddenCatalog(),  # type: ignore[arg-type]
            catalog_graph=_FakeDelegatedCatalog(),  # type: ignore[arg-type]
        )
        == 4
    )

    rows = {row.key: row for row in repo.list_copilot_admin_diagnostics()}
    assert rows["catalog_packages"].status == "ok"
    agents = {row.id: row for row in repo.list_copilot_agents()}
    assert agents["pkg-agent"].display_name == "Delegated Agent"
    assert agents["pkg-agent"].source == "catalog_packages"
    assert "pkg-mail" not in agents


def test_collect_copilot_admin_diagnostics_surfaces_agent365_license_missing(repo: Repository) -> None:
    assert (
        collect_copilot_admin_diagnostics(
            repo,
            _FakeGraphForbiddenCatalog(),  # type: ignore[arg-type]
            catalog_graph=_FakeDelegatedCatalogUnlicensed(),  # type: ignore[arg-type]
        )
        == 4
    )

    rows = {row.key: row for row in repo.list_copilot_admin_diagnostics()}
    catalog = rows["catalog_packages"]
    assert catalog.status == "forbidden"
    assert catalog.status_code == 403
    assert "Agent 365 라이선스 미보유" in (catalog.summary or "")


def test_collect_copilot_admin_diagnostics_surfaces_delegated_token_expired(repo: Repository) -> None:
    assert (
        collect_copilot_admin_diagnostics(
            repo,
            _FakeGraph(),  # type: ignore[arg-type]
            catalog_graph=_FakeDelegatedCatalogExpired(),  # type: ignore[arg-type]
        )
        == 4
    )

    rows = {row.key: row for row in repo.list_copilot_admin_diagnostics()}
    assert rows["catalog_packages"].status == "error"
    assert rows["catalog_packages"].status_code == 401
    assert "권한 재등록" in (rows["catalog_packages"].summary or "")


def test_collect_copilot_admin_diagnostics_includes_unexpected_error_message(repo: Repository) -> None:
    assert (
        collect_copilot_admin_diagnostics(
            repo,
            _FakeGraph(),  # type: ignore[arg-type]
            catalog_graph=_FakeDelegatedCatalogUnexpected(),  # type: ignore[arg-type]
        )
        == 4
    )

    rows = {row.key: row for row in repo.list_copilot_admin_diagnostics()}
    assert rows["catalog_packages"].status == "error"
    assert rows["catalog_packages"].status_code is None
    assert "catalog probe transport failure" in (rows["catalog_packages"].summary or "")