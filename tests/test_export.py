from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from copilot_watchtower.db import InteractionRow, Repository, UserRow, initialize
from copilot_watchtower.export import export_csv, export_json, export_xlsx


def _make_repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    repo = Repository(db)
    repo.upsert_users([UserRow("u1", "a@x.com", "Alice", True, True, True)])
    iso = datetime(2026, 5, 21, 9, 0, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    repo.upsert_interactions(
        [
            InteractionRow(
                id="i1", user_id="u1", session_id="s1", request_id="r1",
                created_at=iso, interaction_type="userPrompt", app="BizChat",
                body_text="요약 부탁", body_content_type="text",
                attachments_json=None, raw_json='{"foo":1}', fetched_at=iso,
            ),
            InteractionRow(
                id="i2", user_id="u1", session_id="s1", request_id="r2",
                created_at=iso, interaction_type="aiResponse", app="BizChat",
                body_text="네 알겠습니다", body_content_type="text",
                attachments_json=None, raw_json='{"bar":2}', fetched_at=iso,
            ),
        ]
    )
    return repo


def test_export_csv(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path)
    out = tmp_path / "out.csv"
    n = export_csv(repo.list_interactions(), out)
    assert n == 2
    content = out.read_text(encoding="utf-8-sig")
    assert "요약 부탁" in content
    assert "id,user_id" in content


def test_export_json(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path)
    out = tmp_path / "out.json"
    n = export_json(repo.list_interactions(), out)
    assert n == 2
    import json

    data = json.loads(out.read_text(encoding="utf-8"))
    assert len(data) == 2
    # raw_json was re-parsed into a dict.
    assert isinstance(data[0]["raw_json"], dict)


def test_export_xlsx(tmp_path: Path) -> None:
    repo = _make_repo(tmp_path)
    out = tmp_path / "out.xlsx"
    n = export_xlsx(repo.list_interactions(), out)
    assert n == 2
    assert out.exists()
    assert out.stat().st_size > 1000
