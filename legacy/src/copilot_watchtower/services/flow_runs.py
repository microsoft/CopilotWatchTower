"""Pure parser for Dataverse ``flowrun`` records → :class:`FlowRunRow`.

HTTP-free so it can be unit-tested against synthetic fixtures regardless of the
(unofficial) Web API shape. The Dataverse Web API returns logical column names
lowercased; lookup display names arrive as ``@OData.Community.Display.V1.
FormattedValue`` annotations when the request asks for formatted values.
"""
from __future__ import annotations

import json
from typing import Any

from ..db.repository import FlowRunRow

_FORMATTED = "@OData.Community.Display.V1.FormattedValue"


def _str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def _date_part(value: Any) -> str | None:
    """Return the ``YYYY-MM-DD`` day part of an ISO timestamp, else None."""
    text = _str(value)
    if not text:
        return None
    # Handles "2026-06-12T01:00:00Z" and "2026-06-12T01:00:00+00:00".
    return text.split("T", 1)[0]


def parse_flow_run_record(
    record: dict[str, Any],
    *,
    environment_id: str | None,
    environment_name: str | None,
) -> FlowRunRow | None:
    """Map one ``flowrun`` Web API record to a :class:`FlowRunRow`.

    Returns ``None`` when the record carries no usable id.
    """
    run_id = _str(record.get("flowrunid")) or _str(record.get("name"))
    if not run_id:
        return None

    workflow_id = _str(record.get("_workflow_value")) or _str(record.get("workflowid"))
    workflow_name = _str(record.get(f"_workflow_value{_FORMATTED}"))
    owner_id = _str(record.get("_ownerid_value"))
    owner_name = _str(record.get(f"_ownerid_value{_FORMATTED}"))
    start_time = _str(record.get("starttime"))
    created_on = _str(record.get("createdon"))

    return FlowRunRow(
        id=run_id,
        environment_id=environment_id,
        environment_name=environment_name,
        workflow_id=workflow_id,
        workflow_name=workflow_name,
        modern_flow_type=_int(record.get("modernflowtype")),
        conversation_id=_str(record.get("conversationid")),
        bot_id=None,  # not directly on flowrun; reconciled with agents later
        owner_id=owner_id,
        owner_name=owner_name,
        status=_str(record.get("status")),
        trigger_type=_str(record.get("triggertype")),
        start_time=start_time,
        end_time=_str(record.get("endtime")),
        duration_ms=_int(record.get("duration")),
        error_code=_str(record.get("errorcode")),
        error_message=_str(record.get("errormessage")),
        run_date=_date_part(start_time or created_on),
        created_on=created_on,
        raw_json=json.dumps(record, ensure_ascii=False),
    )


def parse_flow_run_rows(
    records: list[dict[str, Any]],
    *,
    environment_id: str | None = None,
    environment_name: str | None = None,
) -> list[FlowRunRow]:
    """Parse a page of ``flowrun`` records, dropping any without an id."""
    rows: list[FlowRunRow] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        row = parse_flow_run_record(
            record,
            environment_id=environment_id,
            environment_name=environment_name,
        )
        if row is not None:
            rows.append(row)
    return rows


# Columns requested from the flowrun entity set. Conservative: every one is a
# documented flowrun attribute, and lookups (_workflow_value/_ownerid_value)
# come back automatically with their FormattedValue annotation.
FLOW_RUN_SELECT = (
    "flowrunid,name,status,starttime,endtime,duration,errorcode,errormessage,"
    "modernflowtype,conversationid,triggertype,createdon,_workflow_value,_ownerid_value"
)
