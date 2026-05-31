"""Helpers for surfacing collected audit payloads without event-specific blind spots."""
from __future__ import annotations

import json
from typing import Any

PRIORITY_AUDIT_DATA_KEYS = (
    "ObjectId",
    "TargetUrl",
    "TargetUrls",
    "FileName",
    "Site",
    "AppIdentity",
    "AppName",
    "AppDisplayName",
    "AddOnName",
    "AddOnGuid",
    "AddOnType",
    "AppDistributionMode",
    "AppExternalId",
    "ChatThreadId",
    "OperationScope",
    "AppAccessContext",
)

PRIORITY_COPILOT_EVENT_KEYS = (
    "AppHost",
    "ThreadId",
    "ModelTransparencyDetails",
    "AccessedResources",
    "Contexts",
    "MessageIds",
)

RAW_TOP_LEVEL_KEYS = (
    "objectId",
    "service",
    "auditLogRecordType",
)


def audit_data_from_raw(raw: dict[str, Any]) -> dict[str, Any]:
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


def copilot_event_data(audit_data: dict[str, Any]) -> dict[str, Any]:
    value = audit_data.get("CopilotEventData")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def audit_model(raw: dict[str, Any]) -> str:
    audit_data = audit_data_from_raw(raw)
    event_data = copilot_event_data(audit_data)
    details = event_data.get("ModelTransparencyDetails")
    if isinstance(details, list):
        labels = [_model_detail_label(item) for item in details if isinstance(item, dict)]
        labels = [label for label in labels if label]
        if labels:
            return ", ".join(dict.fromkeys(labels))
    if isinstance(details, dict):
        label = _model_detail_label(details)
        if label:
            return label
    for key in (
        "ModelProviderName",
        "ModelName",
        "ModelId",
        "ModelDeploymentName",
        "DeploymentName",
        "ModelVersion",
    ):
        value = event_data.get(key) or audit_data.get(key)
        if value:
            return str(value)
    return ""


def audit_grounding_items(raw: dict[str, Any]) -> list[dict[str, Any]]:
    audit_data = audit_data_from_raw(raw)
    event_data = copilot_event_data(audit_data)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source, value in (
        ("AccessedResources", event_data.get("AccessedResources")),
        ("Contexts", event_data.get("Contexts")),
    ):
        if isinstance(value, list):
            for item in value:
                _append_grounding_item(items, seen, source, item)
        elif isinstance(value, dict):
            _append_grounding_item(items, seen, source, value)
    return items


def audit_grounding_json(raw: dict[str, Any]) -> str | None:
    items = audit_grounding_items(raw)
    return json.dumps(items, ensure_ascii=False) if items else None


def audit_grounding_summary(raw: dict[str, Any], *, limit: int = 3) -> str:
    items = audit_grounding_items(raw)
    if not items:
        return ""
    labels = [_grounding_label(item) for item in items[:limit]]
    labels = [label for label in labels if label]
    if len(items) > limit:
        labels.append(f"+{len(items) - limit}")
    return ", ".join(labels)


def audit_payload_items(
    raw: dict[str, Any],
    audit_data: dict[str, Any] | None = None,
    *,
    existing_json: str | None = None,
) -> list[dict[str, Any]]:
    audit_data = audit_data if audit_data is not None else audit_data_from_raw(raw)
    event_data = copilot_event_data(audit_data)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in _existing_items(existing_json):
        _append_payload_item(items, seen, item.get("key") or "payload", item.get("value"))

    for key in PRIORITY_AUDIT_DATA_KEYS:
        _append_payload_item(items, seen, key, audit_data.get(key))
    for key in PRIORITY_COPILOT_EVENT_KEYS:
        _append_payload_item(items, seen, key, event_data.get(key))

    for key, value in audit_data.items():
        if key == "CopilotEventData" or _is_metadata_key(key):
            continue
        _append_payload_item(items, seen, key, value)
    for key, value in event_data.items():
        if _is_metadata_key(key):
            continue
        _append_payload_item(items, seen, key, value)
    for key in RAW_TOP_LEVEL_KEYS:
        _append_payload_item(items, seen, key, raw.get(key))
    return items


def payload_json(items: list[dict[str, Any]]) -> str | None:
    return json.dumps(items, ensure_ascii=False) if items else None


def _model_detail_label(item: dict[str, Any]) -> str:
    parts: list[str] = []
    provider = item.get("ModelProviderName")
    model = item.get("ModelName") or item.get("ModelId")
    deployment = item.get("ModelDeploymentName") or item.get("DeploymentName")
    version = item.get("ModelVersion")
    for value in (provider, model, deployment, version):
        if value:
            parts.append(str(value))
    return " / ".join(parts)


def _append_grounding_item(
    items: list[dict[str, Any]], seen: set[str], source: str, value: Any
) -> None:
    if not isinstance(value, dict):
        if value:
            key = str(value)
            if key not in seen:
                seen.add(key)
                items.append({"source": source, "value": value})
        return
    if not value:
        return
    normalized = {k: v for k, v in value.items() if not _is_metadata_key(k)}
    if not normalized:
        return
    identity = _first_value(
        normalized,
        "SiteUrl",
        "Url",
        "URL",
        "Name",
        "DisplayName",
        "Title",
        "FileName",
        "Id",
    )
    dedupe_key = f"{source}:{identity or json.dumps(normalized, sort_keys=True, ensure_ascii=False)}"
    if dedupe_key in seen:
        return
    seen.add(dedupe_key)
    item = {"source": source, **normalized}
    items.append(item)


def _grounding_label(item: dict[str, Any]) -> str:
    name = _first_value(item, "Name", "DisplayName", "Title", "FileName")
    url = _first_value(item, "SiteUrl", "Url", "URL")
    identifier = _first_value(item, "Id", "ResourceId")
    base = str(name or url or identifier or item.get("value") or item.get("source") or "resource")
    meta = [str(v) for v in (_first_value(item, "Type"), _first_value(item, "Action")) if v]
    if meta:
        return f"{base} ({', '.join(meta)})"
    return base


def _first_value(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "" and value != [] and value != {}:
            return value
    return None


def _existing_items(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _append_payload_item(
    items: list[dict[str, Any]], seen: set[str], key: str, value: Any
) -> None:
    if value is None or value == "" or value == [] or value == {}:
        return
    if key in seen:
        return
    seen.add(key)
    items.append({"key": key, "value": value})


def _is_metadata_key(key: str) -> bool:
    return key.startswith("@") or key.endswith("@odata.type")