"""Tests for deriving Copilot agent-identity lifecycle events from audits."""
from __future__ import annotations

import json
from pathlib import Path

from copilot_watchtower.db import AuditEventRow, Repository, initialize
from copilot_watchtower.services.agent_identity import (
    build_agent_identity_events,
    parse_agent_identity_event,
)

_BLUEPRINT_DELETE = {
    "activityDisplayName": "Hard delete service principal",
    "category": "ApplicationManagement",
    "activityDateTime": "2026-06-20T07:25:37Z",
    "result": "success",
    "initiatedBy": {"app": {"displayName": "Microsoft Copilot Studio agent identity blueprint"}},
    "targetResources": [
        {"type": "ServicePrincipal", "displayName": "에이전트 (Microsoft Copilot Studio)", "id": "sp-1"}
    ],
}
_PVA_DELETE_APP = {
    "activityDisplayName": "Delete application",
    "category": "ApplicationManagement",
    "activityDateTime": "2026-06-20T07:25:37Z",
    "result": "success",
    "initiatedBy": {"app": {"displayName": "Power Virtual Agents Service"}},
    "targetResources": [
        {"type": "Application", "displayName": "Copilot FAQ Assistant (Microsoft Copilot Studio)", "id": "app-1"}
    ],
}
_NON_AGENT_SP_ADD = {
    "activityDisplayName": "Add service principal",
    "category": "ApplicationManagement",
    "activityDateTime": "2026-06-24T00:52:50Z",
    "result": "success",
    "initiatedBy": {"app": {"displayName": "Managed Service Identity"}},
    "targetResources": [
        {"type": "ServicePrincipal", "displayName": "MCAPSGovDeployPolicies", "id": "sp-2"}
    ],
}


def _audit_row(iid: str, raw: dict) -> AuditEventRow:
    return AuditEventRow(
        id=f"entra_audit:{iid}",
        source="entra_audit",
        event_time=str(raw.get("activityDateTime") or ""),
        user_id=None,
        upn=None,
        operation=str(raw.get("activityDisplayName") or ""),
        workload=str(raw.get("category") or ""),
        app=str(raw.get("loggedByService") or "Core Directory"),
        target_resources=json.dumps(raw.get("targetResources") or [], ensure_ascii=False),
        client_ip=None,
        result=raw.get("result"),
        raw_json=json.dumps(raw, ensure_ascii=False),
        fetched_at="2026-06-20T00:00:00Z",
    )


def test_parse_identifies_copilot_agent_events_only() -> None:
    blueprint = parse_agent_identity_event(_BLUEPRINT_DELETE)
    assert blueprint is not None
    assert blueprint["action"] == "deleted"
    assert blueprint["target_name"] == "에이전트"  # "(Microsoft Copilot Studio)" suffix stripped
    assert blueprint["target_type"] == "ServicePrincipal"
    assert blueprint["actor"] == "Microsoft Copilot Studio agent identity blueprint"

    pva = parse_agent_identity_event(_PVA_DELETE_APP)
    assert pva is not None
    assert pva["target_name"] == "Copilot FAQ Assistant"
    assert pva["action"] == "deleted"

    # A generic (non-Copilot) service-principal add must be ignored.
    assert parse_agent_identity_event(_NON_AGENT_SP_ADD) is None


def test_build_events_links_to_known_agents() -> None:
    rows = [
        _audit_row("b", _BLUEPRINT_DELETE),
        _audit_row("p", _PVA_DELETE_APP),
        _audit_row("n", _NON_AGENT_SP_ADD),
    ]
    name_index = {"copilot faq assistant": "agent-123"}
    events = build_agent_identity_events(rows, name_index)
    assert len(events) == 2  # the non-agent service principal is excluded
    by_name = {e.target_name: e for e in events}
    assert by_name["Copilot FAQ Assistant"].agent_known is True
    assert by_name["Copilot FAQ Assistant"].agent_id == "agent-123"
    assert by_name["에이전트"].agent_known is False
    assert by_name["에이전트"].agent_id is None


def test_bridge_agent_identity_events(qtbot, tmp_path: Path) -> None:
    del qtbot  # ensures a QApplication exists
    db = tmp_path / "ai.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_audit_events([_audit_row("b", _BLUEPRINT_DELETE), _audit_row("n", _NON_AGENT_SP_ADD)])

    from copilot_watchtower.webshell.bridge import Bridge, BridgeContext

    bridge = Bridge(BridgeContext(repo=repo))
    events = json.loads(bridge.agent_identity_events("{}"))
    assert len(events) == 1  # only the Copilot agent event, not the generic SP add
    assert events[0]["action"] == "deleted"
    assert events[0]["target_name"] == "에이전트"
    assert events[0]["agent_known"] is False
