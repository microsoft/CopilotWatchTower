from __future__ import annotations

from copilot_watchtower.time_format import format_kst, kst_date_bounds_utc


def test_format_kst_converts_graph_utc_timestamp() -> None:
    assert format_kst("2026-05-21T09:00:00Z") == "2026-05-21 18:00:00 KST"


def test_format_kst_treats_sqlite_naive_datetime_as_utc() -> None:
    assert format_kst("2026-05-21 09:00:00") == "2026-05-21 18:00:00 KST"


def test_kst_date_bounds_convert_to_utc_query_range() -> None:
    assert kst_date_bounds_utc("2026-05-23", "2026-05-23") == (
        "2026-05-22T15:00:00Z",
        "2026-05-23T14:59:59Z",
    )