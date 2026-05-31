"""Report and optionally reset eDiscovery-collected data across profile DBs.

Usage:
    python scripts/reset_ediscovery.py            # report counts only
    python scripts/reset_ediscovery.py --apply    # delete jobs + ediscovery interactions
"""
from __future__ import annotations

import glob
import os
import sqlite3
import sys

EDISCOVERY_LIKE = "ediscovery:%"


def db_paths() -> list[str]:
    base = os.path.join(os.environ["LOCALAPPDATA"], "CopilotWatchTower", "profiles")
    return sorted(glob.glob(os.path.join(base, "*", "*.db")))


def _has_table(con: sqlite3.Connection, name: str) -> bool:
    return (
        con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        is not None
    )


def counts(con: sqlite3.Connection) -> tuple[int, int]:
    jobs = 0
    if _has_table(con, "ediscovery_jobs"):
        jobs = con.execute("SELECT COUNT(*) FROM ediscovery_jobs").fetchone()[0]
    inter = 0
    if _has_table(con, "interactions"):
        inter = con.execute(
            "SELECT COUNT(*) FROM interactions WHERE id LIKE ?", (EDISCOVERY_LIKE,)
        ).fetchone()[0]
    return jobs, inter


def main() -> int:
    apply = "--apply" in sys.argv
    paths = db_paths()
    if not paths:
        print("No profile DBs found.")
        return 0
    total_jobs = total_inter = 0
    for p in paths:
        profile = os.path.basename(os.path.dirname(p))
        con = sqlite3.connect(p)
        try:
            jobs, inter = counts(con)
            total_jobs += jobs
            total_inter += inter
            if apply and (jobs or inter):
                if _has_table(con, "interactions"):
                    con.execute("DELETE FROM interactions WHERE id LIKE ?", (EDISCOVERY_LIKE,))
                if _has_table(con, "ediscovery_jobs"):
                    con.execute("DELETE FROM ediscovery_jobs")
                con.commit()
                jafter, iafter = counts(con)
                print(f"{profile} | jobs {jobs}->{jafter}, ediscovery interactions {inter}->{iafter}  [deleted]")
            else:
                print(f"{profile} | jobs {jobs}, ediscovery interactions {inter}")
        finally:
            con.close()
    print(f"\nTOTAL: jobs {total_jobs}, ediscovery interactions {total_inter}")
    if not apply and (total_jobs or total_inter):
        print("Re-run with --apply to delete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
