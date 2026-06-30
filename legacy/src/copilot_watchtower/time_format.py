"""Time formatting helpers for user-facing display."""
from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta, timezone

UTC = UTC
KST = timezone(timedelta(hours=9), "KST")


def parse_utcish_datetime(value: str | None) -> datetime | None:
    """Parse UTC-ish timestamps stored by Graph/SQLite and return KST time."""
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(KST)


def format_kst(value: str | None, *, seconds: bool = True, suffix: bool = True) -> str:
    dt = parse_utcish_datetime(value)
    if dt is None:
        return value or ""
    pattern = "%Y-%m-%d %H:%M:%S" if seconds else "%Y-%m-%d %H:%M"
    rendered = dt.strftime(pattern)
    return f"{rendered} KST" if suffix else rendered


def kst_date_bounds_utc(start_date: str, end_date: str) -> tuple[str, str]:
    start = datetime.combine(date.fromisoformat(start_date), time.min, tzinfo=KST)
    end = datetime.combine(date.fromisoformat(end_date), time(23, 59, 59), tzinfo=KST)
    return _utc_iso(start), _utc_iso(end)


def kst_today() -> date:
    return datetime.now(KST).date()


def _utc_iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")