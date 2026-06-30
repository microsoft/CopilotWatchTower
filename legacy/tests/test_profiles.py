"""Tests for the multi-profile registry."""
from __future__ import annotations

import json
from pathlib import Path

from copilot_watchtower.app import _refresh_all_profile_metadata
from copilot_watchtower.db import Repository, initialize
from copilot_watchtower.profiles import (
    LEGACY_DB_FILENAME,
    PROFILE_DB_FILENAME,
    PROFILES_DIRNAME,
    Profile,
    ProfileRegistry,
)
from copilot_watchtower.ui.profile_picker_dialog import ProfilePickerDialog


def test_empty_load(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    assert reg.profiles == []
    assert reg.active_profile_id is None
    assert reg.active() is None


def test_add_and_save_roundtrip(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    p1 = reg.add("Contoso")
    p2 = reg.add("Fabrikam")
    assert reg.active_profile_id == p1.id  # first add wins until changed
    assert len(reg) == 2

    # Re-load from disk to ensure save() persisted everything.
    reg2 = ProfileRegistry.load(tmp_path)
    assert {p.name for p in reg2.profiles} == {"Contoso", "Fabrikam"}
    assert reg2.active_profile_id == p1.id
    # IDs survived the round-trip.
    assert {p.id for p in reg2.profiles} == {p1.id, p2.id}


def test_set_active_and_touch(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    reg.add("A")
    p2 = reg.add("B")
    reg.set_active(p2.id)
    assert reg.active().id == p2.id

    before = reg.get(p2.id).last_used_at
    reg.touch(p2.id)
    after = reg.get(p2.id).last_used_at
    assert after >= before


def test_remove_drops_active_to_other(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    p1 = reg.add("A")
    p2 = reg.add("B")
    reg.set_active(p1.id)
    reg.remove(p1.id, delete_data=False)
    # Active should fall back to the remaining profile, not stay
    # pointing at the deleted id.
    assert reg.active_profile_id == p2.id
    assert reg.get(p1.id) is None


def test_remove_last_clears_active(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    p = reg.add("Only")
    reg.remove(p.id, delete_data=False)
    assert reg.active_profile_id is None
    assert reg.profiles == []


def test_update_metadata_persists(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    p = reg.add("Initial")
    reg.update_metadata(
        p.id,
        name="Renamed",
        tenant_id="tenant-123",
        tenant_domain="contoso.onmicrosoft.com",
        display_name="My App",
        bootstrap_complete=True,
    )
    reg2 = ProfileRegistry.load(tmp_path)
    got = reg2.get(p.id)
    assert got is not None
    assert got.name == "Renamed"
    assert got.tenant_id == "tenant-123"
    assert got.tenant_domain == "contoso.onmicrosoft.com"
    assert got.display_name == "My App"
    assert got.bootstrap_complete is True


def test_profile_picker_label_prefers_tenant_domain() -> None:
    profile = Profile(
        id="p1",
        name="CDX",
        tenant_id="e8db0a12-0000-0000-0000-000000000000",
        tenant_domain="contoso.onmicrosoft.com",
        display_name="CopilotWatchTower-host-abc123",
        bootstrap_complete=True,
    )

    assert ProfilePickerDialog._format_label(profile) == "CDX — 테넌트 contoso.onmicrosoft.com"


def test_profile_picker_label_uses_guid_only_as_fallback() -> None:
    profile = Profile(
        id="p1",
        name="CDX",
        tenant_id="e8db0a12-0000-0000-0000-000000000000",
        display_name="CopilotWatchTower-host-abc123",
        bootstrap_complete=True,
    )

    assert ProfilePickerDialog._format_label(profile) == "CDX — 테넌트 e8db0a12…"


def test_refresh_all_profile_metadata_populates_tenant_domain(
    monkeypatch,
    tmp_path: Path,
) -> None:
    reg = ProfileRegistry.load(tmp_path)
    profile = reg.add("CDX")
    db_path = reg.profile_db_path(profile.id)
    initialize(db_path)
    repo = Repository(db_path)
    repo.set_text_setting("tenant_id", "tenant-123")
    repo.set_text_setting("display_name", "CopilotWatchTower-host-abc123")
    repo.set_text_setting("bootstrap_complete", "1")

    def refresh_tenant_metadata(profile_repo: Repository) -> None:
        profile_repo.set_text_setting("tenant_domain", "contoso.onmicrosoft.com")

    monkeypatch.setattr("copilot_watchtower.app._refresh_tenant_metadata", refresh_tenant_metadata)

    _refresh_all_profile_metadata(reg)

    got = ProfileRegistry.load(tmp_path).get(profile.id)
    assert got is not None
    assert got.tenant_domain == "contoso.onmicrosoft.com"
    assert ProfilePickerDialog._format_label(got) == "CDX — 테넌트 contoso.onmicrosoft.com"


def test_legacy_db_migration(tmp_path: Path) -> None:
    # Simulate the pre-multi-profile layout: a single store.db at the
    # root and no registry.
    legacy = tmp_path / LEGACY_DB_FILENAME
    legacy.write_bytes(b"sqlite-like-content")
    # Sidecar files that often accompany SQLite WAL mode.
    (tmp_path / (LEGACY_DB_FILENAME + "-wal")).write_bytes(b"wal")
    (tmp_path / (LEGACY_DB_FILENAME + "-shm")).write_bytes(b"shm")

    reg = ProfileRegistry.load(tmp_path)
    assert reg.migrate_legacy_db() is True

    # Legacy file is moved away, registry has one default profile.
    assert not legacy.exists()
    assert len(reg) == 1
    assert reg.active_profile_id == reg.profiles[0].id

    profile_dir = tmp_path / PROFILES_DIRNAME / reg.profiles[0].id
    target = profile_dir / PROFILE_DB_FILENAME
    assert target.exists()
    assert target.read_bytes() == b"sqlite-like-content"
    # Sidecars followed the main file.
    assert (profile_dir / (PROFILE_DB_FILENAME + "-wal")).exists()
    assert (profile_dir / (PROFILE_DB_FILENAME + "-shm")).exists()


def test_legacy_migration_skipped_when_profiles_exist(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    reg.add("Pre-existing")
    legacy = tmp_path / LEGACY_DB_FILENAME
    legacy.write_bytes(b"data")
    assert reg.migrate_legacy_db() is False
    # The legacy file is untouched so the user can decide what to do.
    assert legacy.exists()


def test_purge_profile_directory_idempotent(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    p = reg.add("X")
    d = reg.profile_dir(p.id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "store.db").write_bytes(b"x")
    reg.purge_profile_directory(p.id)
    assert not d.exists()
    # Calling again on a missing directory must not raise.
    reg.purge_profile_directory(p.id)


def test_corrupt_registry_recovers_to_empty(tmp_path: Path) -> None:
    (tmp_path / "profiles.json").write_text("{ not json", encoding="utf-8")
    reg = ProfileRegistry.load(tmp_path)
    assert reg.profiles == []
    assert reg.active_profile_id is None


def test_get_returns_none_for_unknown_id(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    assert reg.get("does-not-exist") is None


def test_save_writes_valid_json(tmp_path: Path) -> None:
    reg = ProfileRegistry.load(tmp_path)
    p = reg.add("A")
    data = json.loads((tmp_path / "profiles.json").read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["active_profile_id"] == p.id
    assert len(data["profiles"]) == 1
    assert data["profiles"][0]["id"] == p.id


def test_pick_or_create_enters_active_profile_without_picker(tmp_path: Path) -> None:
    """With multiple profiles, startup now enters the active one directly.

    The native picker dialog was removed; switching/adding/removing happens in
    the web Settings page, so this no longer pops a modal at launch.
    """
    from copilot_watchtower.app import _pick_or_create_profile

    reg = ProfileRegistry.load(tmp_path)
    reg.add("A")
    second = reg.add("B")
    reg.set_active(second.id)

    profile, _is_new = _pick_or_create_profile(reg, None)
    assert profile is not None
    assert profile.id == second.id


def test_pick_or_create_seeds_first_profile_when_empty(tmp_path: Path) -> None:
    from copilot_watchtower.app import _pick_or_create_profile

    reg = ProfileRegistry.load(tmp_path)
    profile, is_new = _pick_or_create_profile(reg, None)
    assert profile is not None
    assert is_new is True
    assert len(reg) == 1
