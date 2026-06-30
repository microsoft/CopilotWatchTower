"""Column mapping helpers for Microsoft 365 Copilot usage reports."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

USAGE_FIELDS = (
    "display_name",
    "upn",
    "last_activity_overall",
    "last_activity_teams",
    "last_activity_word",
    "last_activity_excel",
    "last_activity_powerpoint",
    "last_activity_outlook",
    "last_activity_onenote",
    "last_activity_loop",
    "last_activity_bizchat",
    "report_refresh_date",
    "report_period",
)

_COLUMN_MAP: dict[str, str] = {
    "display name": "display_name",
    "user principal name": "upn",
    "last activity date": "last_activity_overall",
    "last activity of microsoft teams copilot": "last_activity_teams",
    "microsoft teams copilot last activity date": "last_activity_teams",
    "last activity of word copilot": "last_activity_word",
    "word copilot last activity date": "last_activity_word",
    "last activity of excel copilot": "last_activity_excel",
    "excel copilot last activity date": "last_activity_excel",
    "last activity of powerpoint copilot": "last_activity_powerpoint",
    "powerpoint copilot last activity date": "last_activity_powerpoint",
    "last activity of outlook copilot": "last_activity_outlook",
    "outlook copilot last activity date": "last_activity_outlook",
    "last activity of onenote copilot": "last_activity_onenote",
    "onenote copilot last activity date": "last_activity_onenote",
    "last activity of loop copilot": "last_activity_loop",
    "loop copilot last activity date": "last_activity_loop",
    "last activity of copilot chat": "last_activity_bizchat",
    "copilot chat last activity date": "last_activity_bizchat",
    "report refresh date": "report_refresh_date",
    "report period": "report_period",
}


def normalize_usage_row(raw: Mapping[str, Any]) -> dict[str, str | None]:
    projected: dict[str, str | None] = {field: None for field in USAGE_FIELDS}
    for column, value in raw.items():
        if column is None:
            continue
        target = _COLUMN_MAP.get(_normalise_column(str(column)))
        if target is None:
            continue
        projected[target] = _clean(value)
    return projected


def period_from_report(raw_period: str | None, fallback: str) -> str:
    if raw_period:
        value = raw_period.strip()
        if value.isdigit():
            return f"D{value}"
        if value.upper().startswith("D"):
            return value.upper()
    return fallback


def _normalise_column(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _clean(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None