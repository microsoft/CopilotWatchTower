"""Attach Purview grounding metadata to conversation turns for threading."""
from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import datetime

from ..audit_payload import audit_grounding_summary
from ..db import AuditEventRow, InteractionRow

# Used only after explicit MessageId/session ThreadId matching fails.
# Purview audit timestamps and interactionHistory timestamps can differ
# slightly for the same user action, especially when the audit record is
# emitted from the response/resource-access side of the flow.
TIME_MATCH_SECONDS = 180.0


def build_grounding_text_map(
    interactions: Sequence[InteractionRow], audit_events: Sequence[AuditEventRow]
) -> dict[str, str]:
    by_id = {row.id: row for row in interactions}
    by_session: dict[str, list[InteractionRow]] = {}
    for row in interactions:
        if row.session_id:
            by_session.setdefault(row.session_id, []).append(row)

    parsed_times = [(row, _parse_iso(row.created_at)) for row in interactions]
    text_parts: dict[str, list[str]] = {}
    for event in audit_events:
        raw = _loads_raw(event.raw_json)
        grounding = audit_grounding_summary(raw, limit=10)
        if not grounding:
            continue
        targets: set[str] = set()
        for message_id in _message_ids(raw):
            if message_id in by_id:
                targets.add(message_id)
        for thread_id in _thread_like_ids(raw):
            for interaction in by_session.get(thread_id, []):
                targets.add(interaction.id)
        if not targets:
            nearest = _nearest_interaction_id(event.event_time, parsed_times)
            if nearest:
                targets.add(nearest)
        for interaction_id in targets:
            parts = text_parts.setdefault(interaction_id, [])
            if grounding not in parts:
                parts.append(grounding)
    return {key: " ".join(parts) for key, parts in text_parts.items()}


def _loads_raw(raw_json: str | None) -> dict:
    if not raw_json:
        return {}
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _audit_data(raw: dict) -> dict:
    value = raw.get("auditData")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _event_data(raw: dict) -> dict:
    value = _audit_data(raw).get("CopilotEventData")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _message_ids(raw: dict) -> set[str]:
    event = _event_data(raw)
    ids: set[str] = set()
    for key in ("Messages", "MessageIds"):
        value = event.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict) and item.get("Id"):
                    ids.add(str(item["Id"]))
                elif item:
                    ids.add(str(item))
    return ids


def _thread_like_ids(raw: dict) -> set[str]:
    audit_data = _audit_data(raw)
    event = _event_data(raw)
    return {
        str(value)
        for value in (event.get("ThreadId"), audit_data.get("ChatThreadId"))
        if value
    }


def _nearest_interaction_id(
    event_time: str | None, interactions: Sequence[tuple[InteractionRow, datetime | None]]
) -> str | None:
    event_dt = _parse_iso(event_time)
    if event_dt is None:
        return None
    best_id: str | None = None
    best_delta: float | None = None
    for row, created in interactions:
        if created is None:
            continue
        delta = abs((created - event_dt).total_seconds())
        if delta <= TIME_MATCH_SECONDS and (best_delta is None or delta < best_delta):
            best_id = row.id
            best_delta = delta
    return best_id


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None