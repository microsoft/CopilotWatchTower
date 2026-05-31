"""Audit log collection orchestration.

Wraps the Graph ``security.auditLog.queries`` async pattern and the
Entra ``directoryAudits`` / ``signIns`` synchronous endpoints. Each
collector picks up where the previous cycle left off using
:class:`AuditCollectionState` (persisted by the repository).

Three concrete sources:
  * ``purview``       — Microsoft 365 Unified Audit Log via Graph.
  * ``entra_audit``   — Entra ID directory audits.
  * ``entra_signin``  — Entra ID sign-in events.

Failures are recorded on the state row and surfaced through the
caller's logger; they never abort an outer collection cycle.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..audit_payload import audit_data_from_raw, audit_payload_items, copilot_event_data, payload_json
from ..db import AuditCollectionState, AuditEventRow, Repository
from .graph import GraphClient, GraphError

log = logging.getLogger(__name__)


# Substrate message used by the M365 audit/Purview backend when the
# *Graph* token is fine but the calling service principal hasn't been
# granted access *inside* the compliance portal. We use it to give the
# operator a clearer next step than "Graph error 403".
_PURVIEW_NO_PERMS_RE = re.compile(
    r"App:[^ ]+\s+(?:don[' ]?t|does(?:n)?[' ]?t)\s+have\s+any\s+permissions",
    re.IGNORECASE,
)

PURVIEW_PERMISSION_HINT = (
    "Purview Unified Audit Log API에 액세스하려면 Microsoft Graph 애플리케이션 권한 "
    "AuditLogsQuery.Read.All과 Exchange/Purview roleManagement의 "
    "'View-Only Audit Logs' 역할 부여가 모두 필요합니다.\n"
    "권한 업데이트에서 관리자 동의를 다시 받은 뒤, 온보딩의 Purview 감사 역할 자동 부여를 "
    "다시 실행하세요. 이 역할 부여는 Microsoft Graph roleManagement/exchange API만 사용합니다."
)


def _is_purview_permission_error(detail: object) -> bool:
    """Return True if a 403 detail looks like the substrate \"no perms\" error."""
    try:
        text = json.dumps(detail) if not isinstance(detail, str) else detail
    except (TypeError, ValueError):
        text = str(detail)
    return bool(_PURVIEW_NO_PERMS_RE.search(text))


def _new_audit_collection_state(source: str) -> AuditCollectionState:
    return AuditCollectionState(
        source=source,
        last_collected_at=None,
        pending_query_id=None,
        pending_submitted_at=None,
        pending_window_start=None,
        pending_window_end=None,
        last_error=None,
        last_error_at=None,
        last_success_at=None,
        last_record_count=0,
        enabled=True,
    )


def _clear_purview_permission_block(state: AuditCollectionState) -> None:
    state.enabled = True
    state.pending_query_id = None
    state.pending_submitted_at = None
    state.pending_window_start = None
    state.pending_window_end = None
    state.last_error = None
    state.last_error_at = None


def _is_disabled_purview_permission_block(state: AuditCollectionState) -> bool:
    if state.enabled or state.source != "purview":
        return False
    detail = state.last_error or ""
    return "403" in detail and (
        "Purview" in detail
        or "서비스 주체" in detail
        or _is_purview_permission_error(detail)
    )


def mark_purview_permissions_ready(repo: Repository) -> None:
    """Re-enable Purview collection after Graph consent/RBAC was repaired."""
    state = repo.get_audit_collection_state("purview") or _new_audit_collection_state("purview")
    _clear_purview_permission_block(state)
    repo.update_audit_collection_state(state)



# Default window when nothing has been collected yet. 7 days keeps the
# initial Purview query bounded — operators can rerun to backfill more.
DEFAULT_BACKFILL_DAYS = 7

# Operations of interest for the Purview query. Keeping the list narrow
# avoids exceeding the Graph query record cap and surfaces Copilot- /
# DLP-related activity prominently in the dashboard.
PURVIEW_DEFAULT_OPERATIONS: list[str] = [
    "CopilotInteraction",
    "AppInstalled",
    "AppUpgraded",
    "AppRemoved",
    "DLPRuleMatch",
    "InformationProtectionLabelApplied",
]


@dataclass
class CollectionOutcome:
    source: str
    fetched: int
    error: Optional[str] = None
    pending: bool = False  # query submitted but not yet complete
    details: list[str] = field(default_factory=list)


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _window_detail(start: str | None, end: str | None) -> str:
    return f"범위: {start or '(unknown)'} ~ {end or '(unknown)'}"


def _counter_detail(label: str, counts: Counter[str], *, limit: int = 5) -> str | None:
    if not counts:
        return None
    summary = ", ".join(f"{name} {count}건" for name, count in counts.most_common(limit))
    return f"{label}: {summary}"


def _purview_details(
    state: AuditCollectionState,
    *,
    query_id: str | None = None,
    status: str | None = None,
) -> list[str]:
    details = [_window_detail(state.pending_window_start, state.pending_window_end)]
    if query_id:
        details.append(f"쿼리 ID: {query_id}")
    if status:
        details.append(f"쿼리 상태: {status}")
    details.append(f"작업 필터: {', '.join(PURVIEW_DEFAULT_OPERATIONS)}")
    return details


# ---- Purview ----------------------------------------------------------


def collect_purview(
    repo: Repository,
    graph: GraphClient,
    *,
    backfill_days: int = DEFAULT_BACKFILL_DAYS,
    poll_seconds: float = 10.0,
    max_wait_seconds: float = 60.0,
) -> CollectionOutcome:
    """Drive one cycle of Purview audit collection.

    The Graph ``auditLog.queries`` API is asynchronous: this helper
    submits a new query if none is pending, otherwise it tries to drain
    the previously-submitted one. Either way the state row is updated.
    """
    state = repo.get_audit_collection_state("purview") or _new_audit_collection_state("purview")
    if not state.enabled:
        if (
            repo.get_text_setting("purview_rbac_granted") == "1"
            and _is_disabled_purview_permission_block(state)
        ):
            log.info("Re-enabling Purview collection after stored RBAC grant flag")
            _clear_purview_permission_block(state)
            repo.update_audit_collection_state(state)
        else:
            return CollectionOutcome(source="purview", fetched=0)

    try:
        # Resume a pending query if we have one stored.
        if state.pending_query_id:
            return _drain_purview_query(repo, graph, state, poll_seconds, max_wait_seconds)
        # Otherwise submit a fresh query for the next window.
        return _submit_and_drain_purview(
            repo, graph, state, backfill_days, poll_seconds, max_wait_seconds
        )
    except GraphError as ge:
        # 404 == endpoint not provisioned in this tenant. Disable the
        # collector so we don't spam Graph; users can re-enable from the
        # settings dialog once they've turned on Purview.
        if ge.status == 404:
            log.warning(
                "Purview auditLog query endpoint returned 404. Disabling Purview collection."
            )
            state.enabled = False
            state.last_error = "404 — Purview Audit Log Query API not available"
            state.last_error_at = _iso_now()
            repo.update_audit_collection_state(state)
            return CollectionOutcome(source="purview", fetched=0, error=str(ge))
        # 403 with the substrate "App ... dont have any permissions"
        # message means the Graph token reached the Purview backend, but
        # the application permission consent and/or Exchange role grant
        # is not effective yet. Record a clear error, but keep the source
        # enabled so it can recover after the Graph-only repair flow.
        if ge.status == 403 and _is_purview_permission_error(ge.detail):
            log.warning(
                "Purview substrate returned 403 (service principal not "
                "authorised in Purview/Exchange yet). Keeping collection "
                "enabled so it can recover after the Graph repair flow."
            )
            state.enabled = True
            state.pending_query_id = None
            state.pending_submitted_at = None
            state.pending_window_start = None
            state.pending_window_end = None
            state.last_error = (
                "403 — 서비스 주체가 Purview 감사 로그 권한을 아직 갖고 있지 않음.\n"
                + PURVIEW_PERMISSION_HINT
            )
            state.last_error_at = _iso_now()
            repo.update_audit_collection_state(state)
            return CollectionOutcome(source="purview", fetched=0, error=str(ge))
        return _record_error(repo, state, ge)

    except Exception as e:  # noqa: BLE001
        return _record_error(repo, state, e)


def _submit_and_drain_purview(
    repo: Repository,
    graph: GraphClient,
    state: AuditCollectionState,
    backfill_days: int,
    poll_seconds: float,
    max_wait_seconds: float,
) -> CollectionOutcome:
    window_end = _iso_now()
    window_start = state.last_collected_at or _iso_days_ago(backfill_days)
    qid = graph.submit_audit_log_query(
        display_name=f"CopilotWatchTower-{window_end}",
        start=window_start,
        end=window_end,
        operation_filters=PURVIEW_DEFAULT_OPERATIONS,
    )
    state.pending_query_id = qid
    state.pending_submitted_at = _iso_now()
    state.pending_window_start = window_start
    state.pending_window_end = window_end
    state.last_error = None
    state.last_error_at = None
    repo.update_audit_collection_state(state)
    return _drain_purview_query(repo, graph, state, poll_seconds, max_wait_seconds)


def _drain_purview_query(
    repo: Repository,
    graph: GraphClient,
    state: AuditCollectionState,
    poll_seconds: float,
    max_wait_seconds: float,
) -> CollectionOutcome:
    qid = state.pending_query_id
    if qid is None:
        return CollectionOutcome(source="purview", fetched=0)
    payload = graph.wait_for_audit_query(
        qid, poll_seconds=poll_seconds, max_seconds=max_wait_seconds
    )
    status = (payload.get("status") or "").lower()
    if status in {"running", "notstarted", "queued", ""}:
        # Still in flight — keep state pending so the next cycle picks
        # it up. Returning fetched=0 + pending=True signals the worker
        # to log a "still pending" line.
        return CollectionOutcome(
            source="purview",
            fetched=0,
            pending=True,
            details=_purview_details(state, query_id=qid, status=status or "unknown"),
        )
    if status == "failed":
        err = payload.get("error", {})
        msg = err.get("message") or "query failed"
        state.pending_query_id = None
        state.pending_submitted_at = None
        state.last_error = msg
        state.last_error_at = _iso_now()
        repo.update_audit_collection_state(state)
        return CollectionOutcome(source="purview", fetched=0, error=msg)
    if status == "cancelled":
        state.pending_query_id = None
        state.pending_submitted_at = None
        state.last_error = "query cancelled"
        state.last_error_at = _iso_now()
        repo.update_audit_collection_state(state)
        return CollectionOutcome(source="purview", fetched=0, error="cancelled")
    # status == 'succeeded'
    rows = list(_iter_purview_events(graph, qid))
    if rows:
        repo.upsert_audit_events(rows)
        repo.refresh_copilot_agent_usage_from_audit_events()
    details = _purview_details(state, query_id=qid, status="succeeded")
    user_keys = {row.user_id or row.upn for row in rows if row.user_id or row.upn}
    if user_keys:
        details.append(f"영향 사용자: {len(user_keys)}명")
    op_detail = _counter_detail(
        "상위 작업", Counter(row.operation or "(unknown)" for row in rows)
    )
    if op_detail:
        details.append(op_detail)
    # Advance the watermark to the end of the requested window even if
    # there were zero records (so we don't re-query the same range).
    state.last_collected_at = state.pending_window_end or _iso_now()
    state.last_success_at = _iso_now()
    state.last_record_count = len(rows)
    state.last_error = None
    state.last_error_at = None
    state.pending_query_id = None
    state.pending_submitted_at = None
    state.pending_window_start = None
    state.pending_window_end = None
    repo.update_audit_collection_state(state)
    return CollectionOutcome(source="purview", fetched=len(rows), details=details)


def _iter_purview_events(graph: GraphClient, query_id: str) -> Iterator[AuditEventRow]:
    fetched_at = _iso_now()
    for raw in graph.list_audit_query_records(query_id):
        # Records can carry both top-level fields and nested
        # ``auditData`` blocks. We try the most specific source first.
        ad = audit_data_from_raw(raw)
        # Graph normalises some core columns onto the record level.
        operation = raw.get("operation") or ad.get("Operation")
        user_id = raw.get("userId") or ad.get("UserId")
        upn = raw.get("userPrincipalName") or ad.get("UserPrincipalName")
        event_time = (
            raw.get("createdDateTime")
            or raw.get("recordDate")
            or ad.get("CreationTime")
            or fetched_at
        )
        workload = raw.get("workload") or ad.get("Workload")
        app = (
            raw.get("appId")
            or ad.get("AppName")
            or ad.get("AppDisplayName")
            or copilot_event_data(ad).get("AppHost")
            or ad.get("AppIdentity")
            or ad.get("AddOnName")
            or ad.get("AppExternalId")
            or ad.get("AddOnGuid")
        )
        client_ip = raw.get("clientIp") or ad.get("ClientIP")
        target_resources = payload_json(audit_payload_items(raw, ad))
        event_id = str(raw.get("id") or raw.get("recordId") or f"purview:{event_time}:{user_id}")
        yield AuditEventRow(
            id=f"purview:{event_id}",
            source="purview",
            event_time=str(event_time),
            user_id=str(user_id) if user_id else None,
            upn=str(upn) if upn else None,
            operation=str(operation) if operation else None,
            workload=str(workload) if workload else None,
            app=str(app) if app else None,
            target_resources=target_resources,
            client_ip=str(client_ip) if client_ip else None,
            result=str(ad.get("ResultStatus")) if ad.get("ResultStatus") else None,
            raw_json=json.dumps(raw, ensure_ascii=False),
            fetched_at=fetched_at,
        )


# ---- Entra audits + sign-ins -----------------------------------------


def collect_entra_audits(
    repo: Repository, graph: GraphClient, *, backfill_days: int = DEFAULT_BACKFILL_DAYS
) -> CollectionOutcome:
    return _collect_entra(
        repo, graph, source="entra_audit", backfill_days=backfill_days
    )


def collect_entra_signins(
    repo: Repository, graph: GraphClient, *, backfill_days: int = DEFAULT_BACKFILL_DAYS
) -> CollectionOutcome:
    return _collect_entra(
        repo, graph, source="entra_signin", backfill_days=backfill_days
    )


def _collect_entra(
    repo: Repository,
    graph: GraphClient,
    *,
    source: str,
    backfill_days: int,
) -> CollectionOutcome:
    state = repo.get_audit_collection_state(source) or _new_audit_collection_state(source)
    if not state.enabled:
        return CollectionOutcome(source=source, fetched=0)

    since = state.last_collected_at or _iso_days_ago(backfill_days)
    until = _iso_now()
    try:
        rows: list[AuditEventRow] = []
        total = 0
        operation_counts: Counter[str] = Counter()
        user_keys: set[str] = set()
        fetched_at = _iso_now()
        if source == "entra_audit":
            stream = graph.list_directory_audits(since=since, until=until)
            parser = _parse_directory_audit
        else:
            stream = graph.list_sign_ins(since=since, until=until)
            parser = _parse_sign_in
        for raw in stream:
            row = parser(raw, fetched_at)
            if row is not None:
                rows.append(row)
                total += 1
                operation_counts[row.operation or "(unknown)"] += 1
                user_key = row.user_id or row.upn
                if user_key:
                    user_keys.add(user_key)
            if len(rows) >= 500:
                repo.upsert_audit_events(rows)
                rows.clear()
        if rows:
            repo.upsert_audit_events(rows)
        state.last_collected_at = until
        state.last_success_at = _iso_now()
        state.last_record_count = total
        state.last_error = None
        state.last_error_at = None
        repo.update_audit_collection_state(state)
        details = [_window_detail(since, until)]
        if user_keys:
            details.append(f"영향 사용자: {len(user_keys)}명")
        counter_label = "상위 작업" if source == "entra_audit" else "상위 앱"
        op_detail = _counter_detail(counter_label, operation_counts)
        if op_detail:
            details.append(op_detail)
        return CollectionOutcome(source=source, fetched=total, details=details)
    except GraphError as ge:
        if ge.status == 404:
            log.warning(
                "Entra audit endpoint %s returned 404. Disabling collector.", source
            )
            state.enabled = False
        return _record_error(repo, state, ge)
    except Exception as e:  # noqa: BLE001
        return _record_error(repo, state, e)


def _parse_directory_audit(raw: dict[str, Any], fetched_at: str) -> AuditEventRow | None:
    initiated_by = raw.get("initiatedBy", {}) or {}
    user = (initiated_by.get("user") or {})
    targets = raw.get("targetResources") or []
    return AuditEventRow(
        id=f"entra_audit:{raw.get('id')}",
        source="entra_audit",
        event_time=str(raw.get("activityDateTime") or fetched_at),
        user_id=str(user.get("id")) if user.get("id") else None,
        upn=str(user.get("userPrincipalName")) if user.get("userPrincipalName") else None,
        operation=str(raw.get("activityDisplayName")) if raw.get("activityDisplayName") else None,
        workload=str(raw.get("category")) if raw.get("category") else None,
        app=str(raw.get("loggedByService")) if raw.get("loggedByService") else None,
        target_resources=json.dumps(targets, ensure_ascii=False) if targets else None,
        client_ip=None,
        result=str(raw.get("result")) if raw.get("result") else None,
        raw_json=json.dumps(raw, ensure_ascii=False),
        fetched_at=fetched_at,
    )


def _parse_sign_in(raw: dict[str, Any], fetched_at: str) -> AuditEventRow | None:
    return AuditEventRow(
        id=f"entra_signin:{raw.get('id')}",
        source="entra_signin",
        event_time=str(raw.get("createdDateTime") or fetched_at),
        user_id=str(raw.get("userId")) if raw.get("userId") else None,
        upn=str(raw.get("userPrincipalName")) if raw.get("userPrincipalName") else None,
        operation=str(raw.get("appDisplayName")) if raw.get("appDisplayName") else None,
        workload="signIns",
        app=str(raw.get("clientAppUsed")) if raw.get("clientAppUsed") else None,
        target_resources=None,
        client_ip=str(raw.get("ipAddress")) if raw.get("ipAddress") else None,
        result=(
            str((raw.get("status") or {}).get("errorCode"))
            if isinstance(raw.get("status"), dict)
            else None
        ),
        raw_json=json.dumps(raw, ensure_ascii=False),
        fetched_at=fetched_at,
    )


def _record_error(
    repo: Repository, state: AuditCollectionState, exc: Exception
) -> CollectionOutcome:
    msg = repr(exc)
    log.warning("Audit collection error (%s): %s", state.source, msg)
    state.last_error = msg
    state.last_error_at = _iso_now()
    repo.update_audit_collection_state(state)
    return CollectionOutcome(source=state.source, fetched=0, error=msg)
