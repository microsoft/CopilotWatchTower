"""Multi-tenant profile management.

Each *profile* maps to a single Entra tenant and owns its own SQLite
database, settings, credentials, and collected data. The on-disk
layout under :data:`AppPaths.root` is::

    profiles.json                # this registry
    profiles/
      <profile-id>/
        store.db                 # per-profile SQLite (Repository target)
    logs/                        # shared
    store.db                     # legacy single-tenant DB (migrated)

The active profile id is tracked here so the rest of the app can simply
ask :meth:`ProfileRegistry.active` for the current target.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

REGISTRY_FILENAME = "profiles.json"
PROFILES_DIRNAME = "profiles"
LEGACY_DB_FILENAME = "store.db"
PROFILE_DB_FILENAME = "store.db"
REGISTRY_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Profile:
    """A single multi-tenant slot.

    ``tenant_id`` / ``tenant_domain`` / ``display_name`` are mirrored from the per-profile
    SQLite settings purely so the picker UI can show them without
    opening every database. They are refreshed on every save.
    """

    id: str
    name: str
    tenant_id: str | None = None
    tenant_domain: str | None = None
    display_name: str | None = None
    created_at: str = field(default_factory=_now_iso)
    last_used_at: str = field(default_factory=_now_iso)
    bootstrap_complete: bool = False

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Profile":
        return cls(
            id=str(d["id"]),
            name=str(d.get("name") or "Untitled"),
            tenant_id=d.get("tenant_id"),
            tenant_domain=d.get("tenant_domain"),
            display_name=d.get("display_name"),
            created_at=str(d.get("created_at") or _now_iso()),
            last_used_at=str(d.get("last_used_at") or _now_iso()),
            bootstrap_complete=bool(d.get("bootstrap_complete", False)),
        )


class ProfileRegistry:
    """Persistent list of profiles plus the active selection.

    Reads/writes a small JSON file. The format is intentionally simple
    and forward-compatible: unknown keys are preserved on round-trips
    via the dataclass conversion only carrying known fields.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / REGISTRY_FILENAME
        self.profiles: list[Profile] = []
        self.active_profile_id: str | None = None

    # ---- persistence -------------------------------------------------

    @classmethod
    def load(cls, root: Path) -> "ProfileRegistry":
        reg = cls(root)
        if not reg.path.exists():
            return reg
        try:
            data = json.loads(reg.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            log.exception("profiles.json corrupt — starting empty")
            return reg
        reg.active_profile_id = data.get("active_profile_id")
        for entry in data.get("profiles") or []:
            try:
                reg.profiles.append(Profile.from_dict(entry))
            except (KeyError, TypeError):
                log.warning("Skipping malformed profile entry: %r", entry)
        return reg

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": REGISTRY_VERSION,
            "active_profile_id": self.active_profile_id,
            "profiles": [p.to_dict() for p in self.profiles],
        }
        # Write atomically so a crash mid-write doesn't corrupt the
        # registry — losing the registry means losing access to every
        # profile, including credentials.
        fd, tmp = tempfile.mkstemp(prefix="profiles-", suffix=".json", dir=str(self.root))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, ensure_ascii=False)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ---- queries -----------------------------------------------------

    def __len__(self) -> int:
        return len(self.profiles)

    def get(self, profile_id: str) -> Profile | None:
        for p in self.profiles:
            if p.id == profile_id:
                return p
        return None

    def active(self) -> Profile | None:
        if not self.active_profile_id:
            return None
        return self.get(self.active_profile_id)

    # ---- mutation ----------------------------------------------------

    def add(self, name: str) -> Profile:
        profile = Profile(id=uuid.uuid4().hex, name=name.strip() or "Untitled")
        self.profiles.append(profile)
        if self.active_profile_id is None:
            self.active_profile_id = profile.id
        self.save()
        log.info("Added profile id=%s name=%r", profile.id, profile.name)
        return profile

    def remove(self, profile_id: str, *, delete_data: bool = True) -> None:
        """Remove a profile entry. Optionally erase its SQLite files too."""
        profile = self.get(profile_id)
        if profile is None:
            return
        self.profiles = [p for p in self.profiles if p.id != profile_id]
        if self.active_profile_id == profile_id:
            self.active_profile_id = self.profiles[0].id if self.profiles else None
        self.save()
        if delete_data:
            self.purge_profile_directory(profile_id)
        log.info("Removed profile id=%s (delete_data=%s)", profile_id, delete_data)

    def set_active(self, profile_id: str) -> None:
        if not self.get(profile_id):
            raise KeyError(profile_id)
        self.active_profile_id = profile_id
        self.touch(profile_id)

    def touch(self, profile_id: str) -> None:
        profile = self.get(profile_id)
        if profile is None:
            return
        profile.last_used_at = _now_iso()
        self.save()

    def update_metadata(
        self,
        profile_id: str,
        *,
        name: str | None = None,
        tenant_id: str | None = None,
        tenant_domain: str | None = None,
        display_name: str | None = None,
        bootstrap_complete: bool | None = None,
    ) -> None:
        profile = self.get(profile_id)
        if profile is None:
            return
        if name is not None:
            profile.name = name.strip() or profile.name
        if tenant_id is not None:
            profile.tenant_id = tenant_id
        if tenant_domain is not None:
            profile.tenant_domain = tenant_domain
        if display_name is not None:
            profile.display_name = display_name
        if bootstrap_complete is not None:
            profile.bootstrap_complete = bootstrap_complete
        profile.last_used_at = _now_iso()
        self.save()

    # ---- paths -------------------------------------------------------

    def profile_dir(self, profile_id: str) -> Path:
        return self.root / PROFILES_DIRNAME / profile_id

    def profile_db_path(self, profile_id: str) -> Path:
        return self.profile_dir(profile_id) / PROFILE_DB_FILENAME

    def purge_profile_directory(self, profile_id: str) -> None:
        """Delete the per-profile data directory (DB + WAL, etc.).

        Safe to call even when the directory does not exist.
        """
        d = self.profile_dir(profile_id)
        if not d.exists():
            return
        try:
            shutil.rmtree(d)
            log.info("Purged profile directory %s", d)
        except OSError:
            log.exception("Failed to purge profile directory %s", d)

    # ---- one-time migration -----------------------------------------

    def migrate_legacy_db(self) -> bool:
        """Migrate a pre-multi-profile ``store.db`` into a new profile.

        Returns ``True`` if a migration was performed.
        """
        legacy = self.root / LEGACY_DB_FILENAME
        if not legacy.exists():
            return False
        # Don't migrate if profiles already exist — that means the user
        # has both an old root DB *and* new profiles, so we leave the
        # legacy file alone to avoid surprising data movement.
        if self.profiles:
            log.info(
                "Legacy %s found but registry already has profiles; leaving it.",
                legacy,
            )
            return False

        profile = Profile(id=uuid.uuid4().hex, name="기본 프로필")
        target_dir = self.profile_dir(profile.id)
        target_dir.mkdir(parents=True, exist_ok=True)
        target_db = target_dir / PROFILE_DB_FILENAME
        try:
            shutil.move(str(legacy), str(target_db))
        except OSError:
            log.exception("Failed to migrate legacy DB; aborting migration")
            try:
                shutil.rmtree(target_dir)
            except OSError:
                pass
            return False
        # Move SQLite sidecar files too (WAL/SHM) — they may not exist.
        for suffix in ("-wal", "-shm", "-journal"):
            side = legacy.with_name(legacy.name + suffix)
            if side.exists():
                try:
                    shutil.move(str(side), str(target_db) + suffix)
                except OSError:
                    log.warning("Could not move sidecar %s", side)
        self.profiles.append(profile)
        self.active_profile_id = profile.id
        self.save()
        log.info(
            "Migrated legacy DB to profile id=%s at %s", profile.id, target_db
        )
        return True
