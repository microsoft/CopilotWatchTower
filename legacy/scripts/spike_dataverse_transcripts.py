"""Spike: probe Dataverse Copilot Studio conversation transcripts.

Custom-engine Copilot Studio agents persist *every* channel's conversation
(Microsoft Teams, web chat, Direct Line, …) into the Dataverse
``conversationtranscript`` table — turns the Graph ``getAllEnterpriseInteractions``
substrate (the rest of this app) never sees. This probe verifies, against a
real tenant, the unofficial path the collector relies on:

1. Drive a headless maker-portal sign-in and capture the ``*.crm.dynamics.com``
   bearer tokens the SPA acquires.
2. Enumerate the admin's environments via the Global Discovery Service.
3. For each environment, query ``conversationtranscripts`` and dump the raw
   ``content`` (Bot Framework activity array), the channel ids, and the parser
   output so we can confirm the real column/JSON shape.

Run:

    $env:PYTHONUTF8="1"; $env:PYTHONIOENCODING="utf-8"
    .\\.venv\\Scripts\\python.exe scripts\\spike_dataverse_transcripts.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from copilot_watchtower.db import Repository  # noqa: E402
from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.services.dataverse import DataverseClient  # noqa: E402
from copilot_watchtower.services.dataverse_browser_download import (  # noqa: E402
    capture_dataverse_tokens,
)


def _out_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    folder = Path(base) / "CopilotWatchTower"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _find_profile_db() -> Path | None:
    root = _out_dir()
    candidates = list((root / "profiles").glob("*/store.db"))
    legacy = root / "store.db"
    if legacy.exists():
        candidates.append(legacy)
    for db in candidates:
        try:
            repo = Repository(db)
            if repo.get_text_setting("ediscovery_browser_user") or repo.get_text_setting(
                "exo_delegated_user"
            ):
                return db
        except Exception:
            continue
    return None


def main() -> int:
    db = _find_profile_db()
    if db is None:
        print("프로필 데이터베이스를 찾지 못했습니다. 앱을 먼저 실행/설정하세요.")
        return 2
    repo = Repository(db)
    user = (
        repo.get_text_setting("ediscovery_browser_user")
        or repo.get_text_setting("exo_delegated_user")
        or ""
    )
    blob = repo.get_secret("ediscovery_browser_password") or repo.get_secret(
        "exo_delegated_password"
    )
    if not user or blob is None:
        print("브라우저 로그인 계정이 저장되어 있지 않습니다. 앱 설정에서 등록하세요.")
        return 2
    password = str(unprotect(blob))

    print(f"○ {user} 계정으로 Dataverse 토큰을 캡처합니다…")
    tokens = capture_dataverse_tokens(
        username=user, password=password, on_log=lambda line: print("  ", line)
    )
    print("• 캡처된 호스트:", ", ".join(tokens.hosts))

    client = DataverseClient(tokens.token_for)
    try:
        envs = client.discover_environments()
        print(f"○ 환경 {len(envs)}개 발견:")
        for env in envs:
            print(f"   - {env.friendly_name or '?'} | {env.url} | id={env.id}")

        since = (datetime.now(timezone.utc) - timedelta(days=28)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        dump_path = _out_dir() / "dataverse_transcripts_spike.jsonl"
        dump_path.write_text("", encoding="utf-8")
        total = 0
        for env in envs:
            print(f"\n=== {env.url} (since {since}) ===")
            try:
                parsed = client.fetch_transcript_rows(env, since=since, max_pages=5)
            except Exception as exc:  # noqa: BLE001 - probe surfaces all
                print(f"   ⚠ 실패: {exc}")
                continue
            channels = sorted({(r.app or "?") for r in parsed.rows})
            print(
                f"   상호작용 {len(parsed.rows)}건 | 참가자 {len(parsed.participants)}명 "
                f"| 채널: {channels}"
            )
            teams = [r for r in parsed.rows if (r.app or "").lower() == "msteams"]
            print(f"   → 그 중 Teams(msteams): {len(teams)}건")
            with dump_path.open("a", encoding="utf-8") as fh:
                for r in parsed.rows[:50]:
                    fh.write(
                        json.dumps(
                            {
                                "env": env.url,
                                "id": r.id,
                                "app": r.app,
                                "type": r.interaction_type,
                                "user": r.user_id,
                                "text": (r.body_text or "")[:200],
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            total += len(parsed.rows)
        print(f"\n총 {total}건을 {dump_path}에 덤프했습니다.")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
