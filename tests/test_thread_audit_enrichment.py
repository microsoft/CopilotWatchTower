from __future__ import annotations

import json

from copilot_watchtower.db import AuditEventRow, InteractionRow
from copilot_watchtower.services.thread_audit_enrichment import build_grounding_text_map


def _interaction(iid: str, *, session: str = "s1", created_at: str = "2026-05-22T07:55:45Z") -> InteractionRow:
    return InteractionRow(
        id=iid,
        user_id="u1",
        session_id=session,
        request_id=None,
        created_at=created_at,
        interaction_type="userPrompt",
        app="BizChat",
        body_text="question",
        body_content_type="text",
        attachments_json=None,
        raw_json="{}",
        fetched_at=created_at,
    )


def _audit(raw: dict, *, event_time: str = "2026-05-22T07:55:45Z") -> AuditEventRow:
    return AuditEventRow(
        id="purview:1",
        source="purview",
        event_time=event_time,
        user_id="u1",
        upn="u1@example.com",
        operation="CopilotInteraction",
        workload="Copilot",
        app=None,
        target_resources=None,
        client_ip=None,
        result=None,
        raw_json=json.dumps(raw, ensure_ascii=False),
        fetched_at=event_time,
    )


def test_grounding_map_uses_message_id_match() -> None:
    interactions = [_interaction("m1")]
    audit_events = [
        _audit(
            {
                "auditData": {
                    "CopilotEventData": {
                        "Messages": [{"Id": "m1"}],
                        "AccessedResources": [
                            {"Name": "휴가_근태_가이드.docx", "Type": "Unknown", "Action": "Read"}
                        ],
                    }
                }
            }
        )
    ]

    result = build_grounding_text_map(interactions, audit_events)

    assert "m1" in result
    assert "휴가_근태_가이드.docx" in result["m1"]


def test_grounding_map_uses_session_thread_id_match() -> None:
    interactions = [_interaction("m1", session="thread-1")]
    audit_events = [
        _audit(
            {
                "auditData": {
                    "CopilotEventData": {
                        "ThreadId": "thread-1",
                        "AccessedResources": [
                            {"Name": "법령 URL", "Type": "Text", "Action": "Read"}
                        ],
                    }
                }
            }
        )
    ]

    result = build_grounding_text_map(interactions, audit_events)

    assert result["m1"].startswith("법령 URL")


def test_grounding_map_uses_near_time_when_ids_are_missing() -> None:
    interactions = [_interaction("m1", created_at="2026-05-22T07:55:45.393Z")]
    audit_events = [
        _audit(
            {
                "auditData": {
                    "CopilotEventData": {
                        "AccessedResources": [
                            {"Name": "참조 문서", "Type": "Text", "Action": "Read"}
                        ],
                    }
                }
            },
            event_time="2026-05-22T07:55:45Z",
        )
    ]

    result = build_grounding_text_map(interactions, audit_events)

    assert "참조 문서" in result["m1"]


def test_grounding_map_uses_near_time_with_audit_clock_skew() -> None:
    interactions = [_interaction("m1", created_at="2026-05-22T07:54:20Z")]
    audit_events = [
        _audit(
            {
                "auditData": {
                    "CopilotEventData": {
                        "AccessedResources": [
                            {"Name": "휴가_근태_가이드.docx", "Type": "Unknown", "Action": "Read"}
                        ],
                    }
                }
            },
            event_time="2026-05-22T07:55:45Z",
        )
    ]

    result = build_grounding_text_map(interactions, audit_events)

    assert "휴가_근태_가이드.docx" in result["m1"]


def test_grounding_map_does_not_use_distant_time_only_match() -> None:
    interactions = [_interaction("m1", created_at="2026-05-22T07:40:00Z")]
    audit_events = [
        _audit(
            {
                "auditData": {
                    "CopilotEventData": {
                        "AccessedResources": [
                            {"Name": "너무 먼 문서", "Type": "Text", "Action": "Read"}
                        ],
                    }
                }
            },
            event_time="2026-05-22T07:55:45Z",
        )
    ]

    result = build_grounding_text_map(interactions, audit_events)

    assert result == {}