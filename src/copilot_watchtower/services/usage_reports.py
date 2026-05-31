"""Microsoft 365 Copilot usage report ingestion.

Pulls the per-tenant CSV reports exposed by Graph and writes one row
per (user, period) into ``copilot_usage_snapshots``. The reports cover
the last activity timestamps per workload (Teams, Word, Excel, ...)
and provide the data needed by the Viva-style dashboard.

The Graph endpoints return CSV with the columns documented at
``learn.microsoft.com``. We map a stable subset onto the
:class:`UsageSnapshotRow` dataclass; the original CSV row is preserved
under ``raw_json`` so anything unmapped is still recoverable.

Failures (404 = report not provisioned, 403 = permission missing) are
logged but never raised to the caller — the collector worker treats
usage ingestion as opportunistic data.
"""
from __future__ import annotations

import csv
import io
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ..db import Repository, UsageCountRow, UsageSnapshotRow
from ..usage_mapping import normalize_usage_row, period_from_report
from .graph import GraphClient, GraphError

log = logging.getLogger(__name__)

USAGE_REPORT_PERIODS: tuple[str, ...] = ("D7", "D30", "D90", "D180")

_COUNT_COLUMN_MAP: dict[str, str] = {
    "any app enabled users": "any_app_enabled_users",
    "any app active users": "any_app_active_users",
    "microsoft teams enabled users": "teams_enabled_users",
    "microsoft teams active users": "teams_active_users",
    "word enabled users": "word_enabled_users",
    "word active users": "word_active_users",
    "powerpoint enabled users": "powerpoint_enabled_users",
    "powerpoint active users": "powerpoint_active_users",
    "outlook enabled users": "outlook_enabled_users",
    "outlook active users": "outlook_active_users",
    "excel enabled users": "excel_enabled_users",
    "excel active users": "excel_active_users",
    "onenote enabled users": "onenote_enabled_users",
    "onenote active users": "onenote_active_users",
    "loop enabled users": "loop_enabled_users",
    "loop active users": "loop_active_users",
    "copilot chat enabled users": "copilot_chat_enabled_users",
    "copilot chat active users": "copilot_chat_active_users",
}


@dataclass(frozen=True)
class UsageCollectionResult:
    detail_rows: int = 0
    summary_rows: int = 0
    trend_rows: int = 0

    @property
    def total_rows(self) -> int:
        return self.detail_rows + self.summary_rows + self.trend_rows


def _iso_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def collect_copilot_usage(
    repo: Repository,
    graph: GraphClient,
    *,
    period: str = "D30",
) -> int:
    """Fetch and persist the Copilot user detail report.

    Returns the number of snapshot rows written.
    """
    try:
        csv_bytes = graph.fetch_copilot_usage_user_detail(period=period)
    except GraphError as ge:
        if ge.status in (403, 404):
            log.warning(
                "Copilot usage report unavailable (status=%s). Skipping.", ge.status
            )
            return 0
        raise
    except Exception:  # noqa: BLE001
        log.exception("Failed to fetch Copilot usage report")
        return 0
    rows = _parse_csv(csv_bytes, period=period)
    if not rows:
        return 0
    return repo.upsert_usage_snapshots(rows)


def collect_copilot_usage_reports(
    repo: Repository,
    graph: GraphClient,
    *,
    period: str = "D30",
) -> UsageCollectionResult:
    """Fetch and persist all official Copilot usage report shapes for a period."""
    detail_rows = collect_copilot_usage(repo, graph, period=period)
    summary_rows = _collect_count_report(
        repo,
        lambda: graph.fetch_copilot_user_count_summary(period=period),
        period=period,
        report_type="summary",
    )
    trend_rows = _collect_count_report(
        repo,
        lambda: graph.fetch_copilot_user_count_trend(period=period),
        period=period,
        report_type="trend",
    )
    return UsageCollectionResult(
        detail_rows=detail_rows,
        summary_rows=summary_rows,
        trend_rows=trend_rows,
    )


def _collect_count_report(
    repo: Repository,
    fetcher,
    *,
    period: str,
    report_type: str,
) -> int:
    try:
        csv_bytes = fetcher()
    except GraphError as ge:
        if ge.status in (403, 404):
            log.warning(
                "Copilot usage %s report unavailable (status=%s). Skipping.",
                report_type,
                ge.status,
            )
            return 0
        raise
    except Exception:  # noqa: BLE001
        log.exception("Failed to fetch Copilot usage %s report", report_type)
        return 0
    rows = _parse_count_csv(csv_bytes, period=period, report_type=report_type)
    if not rows:
        return 0
    return repo.upsert_usage_count_rows(rows)


def _parse_csv(data: bytes, *, period: str) -> list[UsageSnapshotRow]:
    """Parse the Graph CSV into :class:`UsageSnapshotRow` instances."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    today = _iso_today()
    out: list[UsageSnapshotRow] = []
    for raw in reader:
        projected = normalize_usage_row(raw)
        upn = projected.get("upn")
        snapshot_date = projected.get("report_refresh_date") or today
        effective_period = period_from_report(projected.get("report_period"), period)
        # We can't always match Graph users by UPN before this is run
        # (the user sync might not have completed yet), so user_id is
        # left empty and the dashboard joins by UPN later.
        out.append(
            UsageSnapshotRow(
                snapshot_date=snapshot_date,
                user_id=None,
                upn=upn,
                period=effective_period,
                display_name=projected.get("display_name"),
                last_activity_overall=projected.get("last_activity_overall"),
                last_activity_teams=projected.get("last_activity_teams"),
                last_activity_word=projected.get("last_activity_word"),
                last_activity_excel=projected.get("last_activity_excel"),
                last_activity_powerpoint=projected.get("last_activity_powerpoint"),
                last_activity_outlook=projected.get("last_activity_outlook"),
                last_activity_onenote=projected.get("last_activity_onenote"),
                last_activity_loop=projected.get("last_activity_loop"),
                last_activity_bizchat=projected.get("last_activity_bizchat"),
                raw_json=json.dumps(raw, ensure_ascii=False),
            )
        )
    return out


def parse_for_tests(data: bytes, *, period: str = "D30") -> list[UsageSnapshotRow]:
    """Public re-export of :func:`_parse_csv` so unit tests can call it."""
    return _parse_csv(data, period=period)


def parse_counts_for_tests(
    data: bytes,
    *,
    period: str = "D30",
    report_type: str = "summary",
) -> list[UsageCountRow]:
    return _parse_count_csv(data, period=period, report_type=report_type)


def _parse_count_csv(data: bytes, *, period: str, report_type: str) -> list[UsageCountRow]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    today = _iso_today()
    out: list[UsageCountRow] = []
    for raw in reader:
        normalized = {_normalise_column(str(key)): value for key, value in raw.items() if key is not None}
        report_refresh_date = _clean(normalized.get("report refresh date")) or today
        effective_period = period_from_report(_clean(normalized.get("report period")), period)
        report_date = _clean(normalized.get("report date"))
        counts = {
            field: _clean_int(normalized.get(column))
            for column, field in _COUNT_COLUMN_MAP.items()
        }
        out.append(
            UsageCountRow(
                report_type=report_type,
                report_refresh_date=report_refresh_date,
                period=effective_period,
                report_date=report_date,
                any_app_enabled_users=counts["any_app_enabled_users"],
                any_app_active_users=counts["any_app_active_users"],
                teams_enabled_users=counts["teams_enabled_users"],
                teams_active_users=counts["teams_active_users"],
                word_enabled_users=counts["word_enabled_users"],
                word_active_users=counts["word_active_users"],
                powerpoint_enabled_users=counts["powerpoint_enabled_users"],
                powerpoint_active_users=counts["powerpoint_active_users"],
                outlook_enabled_users=counts["outlook_enabled_users"],
                outlook_active_users=counts["outlook_active_users"],
                excel_enabled_users=counts["excel_enabled_users"],
                excel_active_users=counts["excel_active_users"],
                onenote_enabled_users=counts["onenote_enabled_users"],
                onenote_active_users=counts["onenote_active_users"],
                loop_enabled_users=counts["loop_enabled_users"],
                loop_active_users=counts["loop_active_users"],
                copilot_chat_enabled_users=counts["copilot_chat_enabled_users"],
                copilot_chat_active_users=counts["copilot_chat_active_users"],
                raw_json=json.dumps(raw, ensure_ascii=False),
            )
        )
    return out


def _normalise_column(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _clean(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _clean_int(value: Any) -> int | None:
    text = _clean(value)
    if text is None:
        return None
    try:
        return int(text.replace(",", ""))
    except ValueError:
        return None
