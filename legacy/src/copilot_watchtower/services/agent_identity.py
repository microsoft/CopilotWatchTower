"""Derive Copilot *agent identity* lifecycle events from Entra directory audits.

The Entra directory audit log records service-principal / application lifecycle
operations. A subset of these concern Copilot agents: when a Copilot Studio /
Power Virtual Agents agent is published or removed, its backing service
principal / application is added or hard-deleted. This module turns those raw
``ApplicationManagement`` audit rows into a compact, agent-centric governance
feed (who created/deleted which agent identity, and when), best-effort linked to
the known ``copilot_agents`` inventory by display name.

Pure and HTTP-free: it reads already-collected ``AuditEventRow`` data, so it is
fully unit-testable and adds no new collection or permissions.
"""
from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from ..db import AuditEventRow

# Apps that act as the directory initiator when a Copilot agent identity is
# provisioned or removed (lower-cased for comparison).
_COPILOT_AGENT_INITIATORS = {
    "microsoft copilot studio agent identity blueprint",
    "power virtual agents service",
}
# Marker found in the target service-principal / application display name of a
# Copilot Studio agent (e.g. "Copilot FAQ Assistant (Microsoft Copilot Studio)").
_AGENT_TARGET_MARKER = "microsoft copilot studio"
_AGENT_NAME_SUFFIX = " (Microsoft Copilot Studio)"

ACTION_CREATED = "created"
ACTION_DELETED = "deleted"
ACTION_UPDATED = "updated"
ACTION_OTHER = "other"


@dataclass
class AgentIdentityEvent:
    """One agent-identity lifecycle event derived from a directory audit row."""

    event_time: str
    action: str  # created | deleted | updated | other
    operation: str  # raw activityDisplayName
    target_name: str  # agent name with the "(Microsoft Copilot Studio)" suffix stripped
    target_id: str | None  # Entra service-principal / application object id
    target_type: str | None  # ServicePrincipal | Application | ...
    actor: str  # initiating user UPN or app display name
    result: str | None
    agent_id: str | None  # linked copilot_agents.id when the name matches a known agent
    agent_known: bool


def _classify_action(operation: str) -> str:
    op = operation.lower()
    if "add" in op or "create" in op:
        return ACTION_CREATED
    if "delete" in op or "remove" in op:
        return ACTION_DELETED
    if "update" in op:
        return ACTION_UPDATED
    return ACTION_OTHER


def _clean_agent_name(name: str) -> str:
    stripped = name.strip()
    if stripped.endswith(_AGENT_NAME_SUFFIX):
        return stripped[: -len(_AGENT_NAME_SUFFIX)].strip()
    return stripped


def _initiator_label(initiated_by: dict[str, Any]) -> str:
    app = initiated_by.get("app") or {}
    user = initiated_by.get("user") or {}
    return str(
        user.get("userPrincipalName")
        or user.get("displayName")
        or app.get("displayName")
        or "(unknown)"
    )


def _is_agent_identity_event(
    initiated_by: dict[str, Any], targets: list[dict[str, Any]]
) -> bool:
    app_name = str((initiated_by.get("app") or {}).get("displayName") or "").lower()
    if app_name in _COPILOT_AGENT_INITIATORS:
        return True
    return any(_AGENT_TARGET_MARKER in str(t.get("displayName") or "").lower() for t in targets)


def parse_agent_identity_event(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Return parsed agent-identity fields if ``raw`` (a directory audit event)
    concerns a Copilot agent's service principal / application, else ``None``.
    """
    initiated_by = raw.get("initiatedBy") or {}
    targets = [t for t in (raw.get("targetResources") or []) if isinstance(t, dict)]
    if not _is_agent_identity_event(initiated_by, targets):
        return None
    # Prefer a ServicePrincipal / Application target; fall back to the first.
    target = next(
        (t for t in targets if str(t.get("type") or "") in ("ServicePrincipal", "Application")),
        targets[0] if targets else {},
    )
    operation = str(raw.get("activityDisplayName") or "")
    return {
        "event_time": str(raw.get("activityDateTime") or ""),
        "action": _classify_action(operation),
        "operation": operation,
        "target_name": _clean_agent_name(str(target.get("displayName") or "")),
        "target_id": target.get("id"),
        "target_type": target.get("type"),
        "actor": _initiator_label(initiated_by),
        "result": raw.get("result"),
    }


def build_agent_identity_events(
    rows: Iterable[AuditEventRow], agent_name_to_id: dict[str, str]
) -> list[AgentIdentityEvent]:
    """Parse + filter directory-audit rows into agent-identity events, linking
    each to a known Copilot agent by (case-insensitive) display name."""
    events: list[AgentIdentityEvent] = []
    for row in rows:
        try:
            raw = json.loads(row.raw_json) if row.raw_json else {}
        except (TypeError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        parsed = parse_agent_identity_event(raw)
        if parsed is None:
            continue
        agent_id = agent_name_to_id.get(parsed["target_name"].lower())
        events.append(
            AgentIdentityEvent(
                event_time=parsed["event_time"],
                action=parsed["action"],
                operation=parsed["operation"],
                target_name=parsed["target_name"],
                target_id=parsed["target_id"],
                target_type=parsed["target_type"],
                actor=parsed["actor"],
                result=parsed["result"],
                agent_id=agent_id,
                agent_known=agent_id is not None,
            )
        )
    return events
