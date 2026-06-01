from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from copilot_watchtower.db import InteractionRow, Repository, UserRow, initialize
from copilot_watchtower.export.backup import (
    BackupError,
    build_backup_bundle,
    read_backup_manifest,
    restore_backup_bundle,
)


def _iso(day: int = 21) -> str:
    return datetime(2026, 5, day, 9, 0, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _make_repo(path: Path, *, seed: bool = True) -> Repository:
    initialize(path)
    repo = Repository(path)
    if seed:
        repo.upsert_users([UserRow("u1", "a@x.com", "Alice", True, True, True)])
        iso = _iso()
        repo.upsert_interactions(
            [
                InteractionRow(
                    id="i1", user_id="u1", session_id="s1", request_id="r1",
                    created_at=iso, interaction_type="userPrompt", app="BizChat",
                    body_text="요약 부탁합니다", body_content_type="text",
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


def test_backup_roundtrip_into_fresh_profile(tmp_path: Path) -> None:
    source = _make_repo(tmp_path / "src" / "store.db")
    bundle = build_backup_bundle(source.db_path, tmp_path / "exports")
    assert bundle.exists()

    target = _make_repo(tmp_path / "dst" / "store.db", seed=False)
    result = restore_backup_bundle(target, bundle)

    # 1 user + 2 interactions imported.
    assert result["added"] == 3
    assert result["tables"]["interactions"]["added"] == 2
    assert result["tables"]["users"]["added"] == 1
    assert result["skipped"] == 0
    assert len(target.list_interactions(source_type=None, limit=1000)) == 2
    # Users were imported too (FK-safe order).
    assert len(target.users_with_interactions(source_type=None)) == 1


def test_restore_skips_duplicates(tmp_path: Path) -> None:
    source = _make_repo(tmp_path / "src" / "store.db")
    bundle = build_backup_bundle(source.db_path, tmp_path / "exports")

    target = _make_repo(tmp_path / "dst" / "store.db", seed=False)
    restore_backup_bundle(target, bundle)
    # Re-importing the same bundle adds nothing and skips everything.
    second = restore_backup_bundle(target, bundle)

    assert second["added"] == 0
    assert second["skipped"] > 0
    assert len(target.list_interactions(source_type=None, limit=1000)) == 2


def test_restore_merges_new_rows(tmp_path: Path) -> None:
    source = _make_repo(tmp_path / "src" / "store.db")
    bundle = build_backup_bundle(source.db_path, tmp_path / "exports")

    target = _make_repo(tmp_path / "dst" / "store.db")
    # target already has i1/i2; add a unique row before import.
    target.upsert_interactions(
        [
            InteractionRow(
                id="i3", user_id="u1", session_id="s2", request_id="r3",
                created_at=_iso(22), interaction_type="userPrompt", app="BizChat",
                body_text="다른 질문", body_content_type="text",
                attachments_json=None, raw_json="{}", fetched_at=_iso(22),
            )
        ]
    )
    result = restore_backup_bundle(target, bundle)
    # i1/i2 already present -> skipped; nothing new from bundle.
    assert result["added"] == 0
    assert len(target.list_interactions(source_type=None, limit=1000)) == 3


def test_backup_excludes_settings(tmp_path: Path) -> None:
    source = _make_repo(tmp_path / "src" / "store.db")
    source.set_text_setting("tenant_id", "secret-tenant")
    bundle = build_backup_bundle(source.db_path, tmp_path / "exports")

    target = _make_repo(tmp_path / "dst" / "store.db", seed=False)
    restore_backup_bundle(target, bundle)
    # settings table is not part of the bundle.
    assert target.get_text_setting("tenant_id") is None


def test_manifest_counts(tmp_path: Path) -> None:
    source = _make_repo(tmp_path / "src" / "store.db")
    bundle = build_backup_bundle(source.db_path, tmp_path / "exports")
    manifest = read_backup_manifest(bundle)
    assert manifest["schema_version"] == 3
    assert manifest["tables"]["interactions"] == 2
    assert manifest["tables"]["users"] == 1
    assert manifest["row_total"] >= 3


def test_restore_rejects_newer_bundle(tmp_path: Path) -> None:
    import json
    import zipfile

    source = _make_repo(tmp_path / "src" / "store.db")
    bundle = build_backup_bundle(source.db_path, tmp_path / "exports")

    # Rewrite the manifest to claim a future schema version.
    data = {}
    with zipfile.ZipFile(bundle, "r") as zf:
        for name in zf.namelist():
            data[name] = zf.read(name)
    manifest = json.loads(data["manifest.json"].decode("utf-8"))
    manifest["schema_version"] = 999
    data["manifest.json"] = json.dumps(manifest).encode("utf-8")
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, blob in data.items():
            zf.writestr(name, blob)

    target = _make_repo(tmp_path / "dst" / "store.db", seed=False)
    try:
        restore_backup_bundle(target, bundle)
    except BackupError:
        return
    raise AssertionError("expected BackupError for newer-schema bundle")
