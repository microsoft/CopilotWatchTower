"""Best-effort Microsoft 365 Copilot admin API diagnostics."""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from ..db import CopilotAdminDiagnosticRow, CopilotAgentRow, Repository
from .auth import DelegatedAuthExpiredError
from .graph import GraphClient, GraphError

ProbeFn = Callable[[], Any]
StepCallback = Callable[[str, str, str | None], None]
AGENT_ELEMENT_TYPES = {"DeclarativeCopilots", "CustomEngineCopilots"}


def collect_copilot_admin_diagnostics(
    repo: Repository,
    graph: GraphClient,
    *,
    catalog_graph: GraphClient | None = None,
    on_step: StepCallback | None = None,
) -> int:
    """Probe read-only Copilot admin APIs and persist their latest status.

    These APIs can be absent or require permissions not yet consented in a
    tenant. That is still useful diagnostic information, so 403/404 are stored
    as status rows instead of aborting the audit/usage collection cycle.

    ``on_step`` is called as ``on_step(phase, label, detail)`` where phase is
    one of ``"started"``, ``"finished"``, ``"persist"``. It lets the worker
    surface per-endpoint progress in the UI.
    """
    probes = [
        ("limited_mode", "Copilot 제한 모드", "/copilot/admin/settings/limitedMode", graph.get_copilot_admin_limited_mode, _summarize_limited_mode),
        ("policy_settings", "Copilot 정책 설정", "/copilot/admin/policySettings", graph.list_copilot_admin_policy_settings, lambda p: _summarize_collection(p, "정책")),
        (
            "catalog_packages",
            "Copilot 패키지/Agent 카탈로그",
            "/copilot/admin/catalog/packages",
            (catalog_graph or graph).list_copilot_admin_catalog_packages,
            lambda p: _summarize_collection(p, "패키지"),
        ),
        ("agent_registrations", "Copilot Agent 등록", "/copilot/agentRegistrations", graph.list_copilot_agent_registrations, lambda p: _summarize_collection(p, "등록")),
    ]
    rows: list[CopilotAdminDiagnosticRow] = []
    for key, label, endpoint, fn, summarize in probes:
        if on_step is not None:
            try:
                on_step("started", label, None)
            except Exception:
                pass
        row = _probe(key=key, label=label, endpoint=endpoint, fn=fn, summarize=summarize)
        rows.append(row)
        if on_step is not None:
            try:
                on_step("finished", label, row.summary or row.status)
            except Exception:
                pass
    if on_step is not None:
        try:
            on_step("persist", "진단 결과 저장", None)
        except Exception:
            pass
    count = repo.upsert_copilot_admin_diagnostics(rows)
    agent_rows: list[CopilotAgentRow] = []
    for source, source_rows in _agent_rows_by_source_from_diagnostics(rows).items():
        repo.replace_copilot_agents_for_source(source, source_rows)
        agent_rows.extend(source_rows)
    observed_rows = repo.upsert_observed_copilot_agents_from_audit_events()
    if agent_rows or observed_rows:
        repo.refresh_copilot_agent_usage_from_audit_events()
    return count


def _probe(
    *,
    key: str,
    label: str,
    endpoint: str,
    fn: ProbeFn,
    summarize: Callable[[Any], str],
) -> CopilotAdminDiagnosticRow:
    captured_at = _now_iso()
    try:
        payload = fn()
    except DelegatedAuthExpiredError as exc:
        return CopilotAdminDiagnosticRow(
            key=key,
            label=label,
            endpoint=endpoint,
            status="error",
            status_code=401,
            summary="위임 로그인 만료 (설정 > 권한 재등록 필요)",
            payload_json=None,
            error=str(exc),
            captured_at=captured_at,
        )
    except GraphError as ge:
        status = _status_from_graph_error(ge)
        detail_text = _error_text(ge.detail)
        return CopilotAdminDiagnosticRow(
            key=key,
            label=label,
            endpoint=endpoint,
            status=status,
            status_code=ge.status,
            summary=_error_summary(status, detail_text),
            payload_json=None,
            error=detail_text,
            captured_at=captured_at,
        )
    except Exception as exc:  # noqa: BLE001
        return CopilotAdminDiagnosticRow(
            key=key,
            label=label,
            endpoint=endpoint,
            status="error",
            status_code=None,
            summary=_unexpected_error_summary(exc),
            payload_json=None,
            error=str(exc),
            captured_at=captured_at,
        )
    return CopilotAdminDiagnosticRow(
        key=key,
        label=label,
        endpoint=endpoint,
        status="ok",
        status_code=200,
        summary=summarize(payload),
        payload_json=json.dumps(payload, ensure_ascii=False),
        error=None,
        captured_at=captured_at,
    )


def _summarize_limited_mode(payload: Any) -> str:
    if not isinstance(payload, dict):
        return "응답 수신"
    enabled = payload.get("isEnabledForGroup")
    group_id = payload.get("groupId")
    if enabled is True:
        return f"그룹 제한 모드 사용 중 ({group_id or 'group 미상'})"
    if enabled is False:
        return "그룹 제한 모드 꺼짐"
    return "제한 모드 설정 응답 수신"


def _summarize_collection(payload: Any, label: str) -> str:
    if isinstance(payload, list):
        return f"{label} {len(payload):,}건 조회"
    return f"{label} 응답 수신"


def _status_from_graph_error(error: GraphError) -> str:
    if error.status == 403:
        return "forbidden"
    if error.status == 404:
        return "not_found"
    return "error"


def _error_summary(status: str, detail: str | None = None) -> str:
    if status == "forbidden" and detail and _is_agent365_license_error(detail):
        return "Agent 365 라이선스 미보유 테넌트 (에이전트 카탈로그 사용 불가)"
    return {
        "forbidden": "권한 또는 관리자 정책으로 접근 거부 (동의 대기 가능)",
        "not_found": "API 미배포 또는 리소스 없음 (테넌트 미지원)",
    }.get(status, "진단 호출 실패")


def _is_agent365_license_error(detail: str) -> bool:
    lowered = detail.lower()
    return "agent 365" in lowered or "agent365" in lowered



def _error_text(detail: object) -> str:
    if isinstance(detail, str):
        return detail
    try:
        return json.dumps(detail, ensure_ascii=False)
    except TypeError:
        return str(detail)


def _unexpected_error_summary(exc: Exception) -> str:
    message = str(exc).strip()
    if not message:
        return "진단 호출 중 오류"
    return f"진단 호출 중 오류: {message}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _agent_rows_from_diagnostics(
    rows: list[CopilotAdminDiagnosticRow],
) -> list[CopilotAgentRow]:
    by_source = _agent_rows_by_source_from_diagnostics(rows)
    return [agent for source_rows in by_source.values() for agent in source_rows]


def _agent_rows_by_source_from_diagnostics(
    rows: list[CopilotAdminDiagnosticRow],
) -> dict[str, list[CopilotAgentRow]]:
    agent_rows: list[CopilotAgentRow] = []
    for row in rows:
        if row.status != "ok" or row.key not in {"agent_registrations", "catalog_packages"}:
            continue
        if not row.payload_json:
            continue
        agent_rows.extend(
            _agent_rows_from_payload_json(
                row.payload_json,
                captured_at=row.captured_at,
                source=row.key,
            )
        )
    by_source: dict[str, list[CopilotAgentRow]] = {}
    for agent in agent_rows:
        by_source.setdefault(agent.source, []).append(agent)
    return by_source


def _agent_rows_from_payload_json(
    payload_json: str,
    *,
    captured_at: str,
    source: str,
) -> list[CopilotAgentRow]:
    try:
        payload = json.loads(payload_json)
    except json.JSONDecodeError:
        return []
    items = _payload_items(payload)
    rows: list[CopilotAgentRow] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if source == "catalog_packages" and not _is_agent_package(item):
            continue
        agent_id = _agent_identifier(item, source=source)
        raw_json = json.dumps(item, ensure_ascii=False, sort_keys=True)
        rows.append(
            CopilotAgentRow(
                id=agent_id,
                display_name=_first_deep_value(
                    item,
                    "displayName",
                    "name",
                    "title",
                    "appDisplayName",
                    "AddOnName",
                ),
                app_identity=_first_deep_value(item, "appIdentity", "AppIdentity"),
                app_external_id=_first_deep_value(
                    item,
                    "appExternalId",
                    "externalId",
                    "AppExternalId",
                    "teamsAppId",
                ),
                add_on_guid=_first_deep_value(
                    item,
                    "addOnGuid",
                    "AddOnGuid",
                    "addOnId",
                    "teamsAppDefinitionId",
                ),
                source=source,
                status=_first_deep_value(
                    item,
                    "status",
                    "state",
                    "publishingStatus",
                    "availabilityStatus",
                ),
                created_at=_first_deep_value(
                    item,
                    "createdDateTime",
                    "createdAt",
                    "createdOn",
                    "creationTime",
                ),
                updated_at=_first_deep_value(
                    item,
                    "lastModifiedDateTime",
                    "updatedDateTime",
                    "updatedAt",
                    "modifiedDateTime",
                ),
                raw_json=raw_json,
                captured_at=captured_at,
            )
        )
    return rows


def _is_agent_package(payload: dict[str, Any]) -> bool:
    return bool(set(_element_types(payload)) & AGENT_ELEMENT_TYPES)


def _element_types(payload: dict[str, Any]) -> list[str]:
    value = payload.get("elementTypes") or payload.get("ElementTypes")
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return []


def _payload_items(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("value", "items", "results", "agents", "packages"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
        return [payload]
    return []


def _agent_identifier(payload: dict[str, Any], *, source: str) -> str:
    for key in (
        "id",
        "agentId",
        "appId",
        "appIdentity",
        "appExternalId",
        "externalId",
        "addOnGuid",
        "teamsAppId",
    ):
        value = _first_deep_value(payload, key, key[:1].upper() + key[1:])
        if value:
            return value
    raw_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha1(raw_json.encode("utf-8")).hexdigest()[:24]
    return f"{source}:{digest}"


def _first_deep_value(payload: Any, *names: str) -> str | None:
    wanted = {name.lower() for name in names}
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key.lower() in wanted and _is_scalar(value):
                text = str(value).strip()
                if text:
                    return text
        for value in payload.values():
            nested = _first_deep_value(value, *names)
            if nested:
                return nested
    elif isinstance(payload, list):
        for item in payload:
            nested = _first_deep_value(item, *names)
            if nested:
                return nested
    return None


def _is_scalar(value: Any) -> bool:
    return isinstance(value, str | int | float | bool)