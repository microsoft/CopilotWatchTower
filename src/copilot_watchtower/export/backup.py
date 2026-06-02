"""Portable, data-only backup bundles for a single profile.

A bundle is a ZIP archive containing:

* ``manifest.json`` — app/schema version, source profile metadata, and
  per-table row counts captured at backup time.
* ``data.db`` — a fresh SQLite database (current schema) holding only the
  *data* tables. Secrets (``settings``) and operational state
  (collection watermarks, eDiscovery jobs) are deliberately excluded so a
  bundle can be safely restored into a different tenant's profile.

Derived ``conversation_threads`` rows are **not** stored; they are
recomputed deterministically on restore from the imported interactions.
"""

from __future__ import annotations

import json
import logging
import shutil
import sqlite3
import tempfile
import zipfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from .. import __version__
from ..db import Repository, initialize
from ..db.repository import _connect, _load_schema_sql, _migrate
from ..services.threading_service import recompute_threads_for_all_users

if TYPE_CHECKING:
    from ..profiles import Profile

log = logging.getLogger(__name__)

#: Schema version embedded in bundle manifests. Bump alongside schema.sql.
CURRENT_SCHEMA_VERSION = 3

#: Data tables copied into a bundle, in FK-safe insert order (``users``
#: first because ``interactions`` references it). ``conversation_threads``
#: is intentionally absent — it is recomputed on restore.
INCLUDED_TABLES: tuple[str, ...] = (
    "users",
    "interactions",
    "audit_events",
    "copilot_usage_snapshots",
    "copilot_usage_user_counts",
    "copilot_admin_diagnostics",
    "copilot_agents",
)

BUNDLE_DB_NAME = "data.db"
MANIFEST_NAME = "manifest.json"
BUNDLE_SUFFIX = ".cwtbackup"

ProgressFn = Callable[[str, int, int], None]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _table_columns(conn: sqlite3.Connection, table: str, schema: str = "main") -> list[str]:
    rows = conn.execute(f"PRAGMA {schema}.table_info({table})").fetchall()
    return [r[1] for r in rows]


def _safe_stem(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in ("-", "_") else "-" for c in (name or "").strip())
    cleaned = cleaned.strip("-") or "profile"
    return cleaned[:48]


def build_backup_bundle(
    source_db_path: Path,
    dest_dir: Path,
    profile: "Profile | None" = None,
    *,
    progress: ProgressFn | None = None,
    bundle_path: Path | None = None,
) -> Path:
    """Create a ``*.cwtbackup`` archive from ``source_db_path``.

    Returns the path to the written bundle inside ``dest_dir``.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    if bundle_path is None:
        stem = _safe_stem(profile.name if profile else "profile")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        bundle_path = dest_dir / f"cwt-backup-{stem}-{stamp}{BUNDLE_SUFFIX}"
    else:
        bundle_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="cwt-backup-") as tmp:
        tmp_dir = Path(tmp)
        bundle_db = tmp_dir / BUNDLE_DB_NAME
        # Fresh DB with the current schema (tables, indexes, FTS, triggers).
        initialize(bundle_db)

        counts: dict[str, int] = {}
        total = len(INCLUDED_TABLES)
        with _connect(source_db_path) as conn:
            conn.execute("ATTACH DATABASE ? AS bundle", (str(bundle_db),))
            try:
                for idx, table in enumerate(INCLUDED_TABLES, start=1):
                    if progress:
                        progress(f"백업 중: {table}", idx, total)
                    src_cols = _table_columns(conn, table, "main")
                    dst_cols = _table_columns(conn, table, "bundle")
                    cols = [c for c in src_cols if c in dst_cols]
                    if not cols:
                        counts[table] = 0
                        continue
                    col_sql = ", ".join(f'"{c}"' for c in cols)
                    conn.execute(
                        f"INSERT INTO bundle.{table} ({col_sql}) "
                        f"SELECT {col_sql} FROM main.{table}"
                    )
                    counts[table] = conn.execute(
                        f"SELECT COUNT(*) FROM bundle.{table}"
                    ).fetchone()[0]
            finally:
                conn.execute("DETACH DATABASE bundle")

        manifest = {
            "app_version": __version__,
            "schema_version": CURRENT_SCHEMA_VERSION,
            "created_at": _now_iso(),
            "profile": {
                "id": profile.id if profile else None,
                "name": profile.name if profile else None,
                "tenant_id": profile.tenant_id if profile else None,
                "tenant_domain": profile.tenant_domain if profile else None,
            },
            "tables": counts,
            "row_total": sum(counts.values()),
        }
        manifest_path = tmp_dir / MANIFEST_NAME
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        with zipfile.ZipFile(bundle_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(manifest_path, MANIFEST_NAME)
            zf.write(bundle_db, BUNDLE_DB_NAME)

    log.info("Wrote backup bundle %s (%d rows)", bundle_path, manifest["row_total"])
    return bundle_path


def read_backup_manifest(bundle_path: Path) -> dict:
    """Read and return the manifest from a bundle without extracting data."""
    with zipfile.ZipFile(bundle_path, "r") as zf:
        with zf.open(MANIFEST_NAME) as fh:
            return json.loads(fh.read().decode("utf-8"))


class BackupError(Exception):
    """Raised when a bundle is malformed or incompatible."""


def restore_backup_bundle(
    target: Repository,
    bundle_path: Path,
    *,
    progress: ProgressFn | None = None,
) -> dict:
    """Import a bundle into ``target`` (the current profile's repository).

    Existing rows are kept; only new rows (by primary key) are inserted —
    ``INSERT OR IGNORE`` skips duplicates. After importing interactions,
    conversation threads are recomputed for every affected user/source.

    Returns a result dict with per-table ``{added, skipped}`` counts.
    """
    with zipfile.ZipFile(bundle_path, "r") as zf:
        names = set(zf.namelist())
        if MANIFEST_NAME not in names or BUNDLE_DB_NAME not in names:
            raise BackupError("백업 파일 형식이 올바르지 않습니다.")
        manifest = json.loads(zf.read(MANIFEST_NAME).decode("utf-8"))
        bundle_schema = int(manifest.get("schema_version", 0) or 0)
        if bundle_schema > CURRENT_SCHEMA_VERSION:
            raise BackupError(
                "이 백업은 더 최신 버전에서 생성되어 복원할 수 없습니다. "
                "최신 버전으로 업데이트하세요."
            )

        with tempfile.TemporaryDirectory(prefix="cwt-restore-") as tmp:
            tmp_dir = Path(tmp)
            extracted_db = tmp_dir / BUNDLE_DB_NAME
            with zf.open(BUNDLE_DB_NAME) as src, open(extracted_db, "wb") as dst:
                shutil.copyfileobj(src, dst)

            # Forward-migrate an older bundle to the current schema so the
            # column intersection below picks up newly added columns.
            with _connect(extracted_db) as conn:
                _migrate(conn)
                conn.executescript(_load_schema_sql())

            results: dict[str, dict[str, int]] = {}
            total = len(INCLUDED_TABLES)
            with _connect(target.db_path) as conn:
                conn.execute("ATTACH DATABASE ? AS bundle", (str(extracted_db),))
                try:
                    for idx, table in enumerate(INCLUDED_TABLES, start=1):
                        if progress:
                            progress(f"복원 중: {table}", idx, total)
                        bundle_total = conn.execute(
                            f"SELECT COUNT(*) FROM bundle.{table}"
                        ).fetchone()[0]
                        if bundle_total == 0:
                            results[table] = {"added": 0, "skipped": 0}
                            continue
                        main_cols = _table_columns(conn, table, "main")
                        bundle_cols = _table_columns(conn, table, "bundle")
                        cols = [c for c in bundle_cols if c in main_cols]
                        col_sql = ", ".join(f'"{c}"' for c in cols)
                        before = conn.execute(
                            f"SELECT COUNT(*) FROM main.{table}"
                        ).fetchone()[0]
                        conn.execute(
                            f"INSERT OR IGNORE INTO main.{table} ({col_sql}) "
                            f"SELECT {col_sql} FROM bundle.{table}"
                        )
                        after = conn.execute(
                            f"SELECT COUNT(*) FROM main.{table}"
                        ).fetchone()[0]
                        added = after - before
                        results[table] = {
                            "added": added,
                            "skipped": bundle_total - added,
                        }
                finally:
                    conn.execute("DETACH DATABASE bundle")

    # Recompute derived threads for both data sources now that new
    # interactions have landed. Runs against the target repository.
    if progress:
        progress("스레드 재계산 중", total, total)
    threads_api = recompute_threads_for_all_users(target, source_type="api")
    threads_ediscovery = recompute_threads_for_all_users(
        target, source_type="ediscovery"
    )

    added_total = sum(t["added"] for t in results.values())
    skipped_total = sum(t["skipped"] for t in results.values())
    log.info(
        "Restored bundle %s: +%d rows, %d skipped, %d threads",
        bundle_path,
        added_total,
        skipped_total,
        threads_api + threads_ediscovery,
    )
    return {
        "tables": results,
        "added": added_total,
        "skipped": skipped_total,
        "threads_recomputed": threads_api + threads_ediscovery,
        "source_profile": manifest.get("profile", {}),
    }
