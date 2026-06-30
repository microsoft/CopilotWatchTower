"""Spike: probe the Dataverse ``flowrun`` table for autonomous-agent signal.

Autonomous / scheduled / trigger Copilot Studio agents run **without a human**,
so they never produce a useful per-user ``conversationtranscript`` and the
license/billing ``MCSMessages`` snapshot only reveals their spend hours-to-a-day
later. Microsoft documents that every Power Automate / Copilot Studio flow
execution lands in the Dataverse ``flowrun`` table (an *elastic* table) as it
happens — making it the freshest available signal for "is an agent running away
right now?".

This probe verifies, against a real tenant, the assumptions the planned
near-real-time tier depends on:

1. Drive a headless maker-portal sign-in, enumerate environments via BAP, and
   capture each environment's ``*.crm.dynamics.com`` bearer token.
2. For each environment, query ``GET {org}/api/data/v9.2/flowruns`` (newest
   first) and observe the **real column shape** (no ``$select`` so nothing is
   hidden).
3. Measure **freshness**: ``now - max(createdon)`` / ``now - max(modifiedon)``
   — how stale is the freshest run?
4. Measure **retention (TTL)**: ``now - min(createdon)`` — how far back does the
   elastic table keep rows?
5. Tally **ModernFlowType** (0=PowerAutomate, 1=CopilotStudioFlow,
   2=M365CopilotAgentFlow) and how many runs carry a ``conversationid``
   (human-linked) vs none (candidate autonomous/scheduled runs).

Run:

    $env:PYTHONUTF8="1"; $env:PYTHONIOENCODING="utf-8"
    .\\.venv\\Scripts\\python.exe scripts\\spike_flowruns.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from copilot_watchtower.config import DATAVERSE_API_VERSION  # noqa: E402
from copilot_watchtower.db import Repository  # noqa: E402
from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.services.dataverse import (  # noqa: E402
    DataverseClient,
    DataverseError,
    fetch_bap_environments,
)
from copilot_watchtower.services.dataverse_browser_download import (  # noqa: E402
    EnvCaptureTarget,
    capture_dataverse_tokens,
)

# Power Automate Cloud Flow type (flowrun.modernflowtype picklist).
MODERN_FLOW_TYPE_LABELS = {
    0: "PowerAutomateFlow",
    1: "CopilotStudioFlow",
    2: "M365CopilotAgentFlow",
}


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


def _parse_dt(value: object) -> datetime | None:
    """Parse a Dataverse ISO timestamp (``...Z`` or offset) to aware UTC."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _age(now: datetime, dt: datetime | None) -> str:
    if dt is None:
        return "?"
    delta = now - dt
    secs = int(delta.total_seconds())
    if secs < 0:
        return "future"
    if secs < 90:
        return f"{secs}s"
    mins = secs // 60
    if mins < 90:
        return f"{mins}m"
    hours = mins // 60
    if hours < 48:
        return f"{hours}h"
    return f"{hours // 24}d"


def _fetch_flowruns(client: DataverseClient, env_url: str) -> list[dict]:
    """Fetch newest flowruns for one environment, defensively.

    No ``$select`` — a spike wants the *real* column shape. Falls back to no
    ``$orderby`` if the elastic table rejects ordering on ``createdon``.
    """
    base = env_url.rstrip("/")
    url = f"{base}/api/data/{DATAVERSE_API_VERSION}/flowruns"
    for params in (
        {"$orderby": "createdon desc", "$top": "200"},
        {"$top": "200"},
    ):
        try:
            data = client._get_json(url, params=params, page_size=200)
        except DataverseError as exc:
            if params.get("$orderby"):
                print(f"   ⚠ $orderby 거부({exc.status}); 정렬 없이 재시도")
                continue
            raise
        rows = data.get("value", []) if isinstance(data, dict) else []
        return [r for r in rows if isinstance(r, dict)]
    return []


def _enumerate_targets(repo: Repository):
    """Build the BAP enumeration callback (mirrors the production worker)."""
    captured_envs: list = []

    def _enumerate(bap_token: str) -> list[EnvCaptureTarget]:
        all_envs = fetch_bap_environments(bap_token)
        # Developer 환경도 flow run은 존재할 수 있으므로 제외하지 않는다.
        captured_envs.extend(all_envs)
        targets: list[EnvCaptureTarget] = []
        for env in all_envs:
            host = (urlsplit(env.url).hostname or "").lower()
            targets.append(
                EnvCaptureTarget(
                    env_id=env.id, org_host=host, label=env.friendly_name or env.url
                )
            )
        return targets

    return _enumerate, captured_envs


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
    enumerate_cb, captured_envs = _enumerate_targets(repo)
    tokens = capture_dataverse_tokens(
        username=user,
        password=password,
        on_log=lambda line: print("  ", line),
        enumerate_environments=enumerate_cb,
    )
    print("• 캡처된 호스트:", ", ".join(tokens.hosts))
    print(f"• BAP 환경 {len(captured_envs)}개")

    client = DataverseClient(tokens.token_for)
    now = datetime.now(timezone.utc)
    dump_path = _out_dir() / "flowruns_spike.jsonl"
    dump_path.write_text("", encoding="utf-8")
    captured_hosts = set(tokens.org_hosts)
    grand_total = 0
    try:
        for env in captured_envs:
            host = (urlsplit(env.url).hostname or "").lower()
            label = env.friendly_name or env.url
            if captured_hosts and host and host not in captured_hosts:
                print(f"\n=== {label} — 토큰 없음, 건너뜀 ===")
                continue
            print(f"\n=== {label} | {env.url} (sku={env.sku}) ===")
            try:
                rows = _fetch_flowruns(client, env.url)
            except DataverseError as exc:
                print(f"   ⚠ 실패: HTTP {exc.status}: {str(exc.detail)[:200]}")
                continue
            if not rows:
                print("   flow run 0건 (빈 테이블이거나 권한 없음)")
                continue

            # Column shape (first row keys) — the whole point of a spike.
            print(f"   flow run {len(rows)}건 | 컬럼: {sorted(rows[0].keys())}")

            created = [d for d in (_parse_dt(r.get("createdon")) for r in rows) if d]
            modified = [d for d in (_parse_dt(r.get("modifiedon")) for r in rows) if d]
            if created:
                newest, oldest = max(created), min(created)
                print(
                    f"   신선도: 최신 createdon {newest.isoformat()} (≈{_age(now, newest)} 전) | "
                    f"보존(TTL): 최古 {oldest.isoformat()} (≈{_age(now, oldest)} 전)"
                )
            if modified:
                print(
                    f"   최신 modifiedon ≈{_age(now, max(modified))} 전 "
                    "(실행 진행/완료 갱신 신선도)"
                )

            # ModernFlowType distribution.
            mft: dict[str, int] = {}
            for r in rows:
                raw = r.get("modernflowtype")
                key = MODERN_FLOW_TYPE_LABELS.get(raw, f"({raw})")
                mft[key] = mft.get(key, 0) + 1
            print(f"   ModernFlowType: {mft}")

            # Human-linked (conversationid present) vs autonomous candidates.
            with_conv = sum(1 for r in rows if str(r.get("conversationid") or "").strip())
            print(
                f"   conversationid 보유: {with_conv}건 (사람 연계) | "
                f"미보유: {len(rows) - with_conv}건 (자율/스케줄 후보)"
            )

            # Status + error distribution (fail-loop detection signal).
            status: dict[str, int] = {}
            errors = 0
            for r in rows:
                s = str(r.get("status") or "?")
                status[s] = status.get(s, 0) + 1
                if str(r.get("errorcode") or "").strip():
                    errors += 1
            print(f"   status: {status} | errorcode 보유: {errors}건")

            with dump_path.open("a", encoding="utf-8") as fh:
                for r in rows[:50]:
                    fh.write(
                        json.dumps(
                            {
                                "env": env.url,
                                "flowrunid": r.get("flowrunid"),
                                "name": r.get("name"),
                                "status": r.get("status"),
                                "modernflowtype": r.get("modernflowtype"),
                                "conversationid": r.get("conversationid"),
                                "triggertype": r.get("triggertype"),
                                "duration": r.get("duration"),
                                "starttime": r.get("starttime"),
                                "createdon": r.get("createdon"),
                                "_workflow_value": r.get("_workflow_value"),
                                "_ownerid_value": r.get("_ownerid_value"),
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            grand_total += len(rows)
        print(f"\n총 {grand_total}건을 {dump_path}에 덤프했습니다.")
        print(
            "\n판정 가이드: (1) 최신 createdon이 분 단위면 near-real-time OK. "
            "(2) conversationid 미보유 run이 존재하면 자율 실행이 flowrun에 잡힘. "
            "(3) ModernFlowType 1/2가 있으면 에이전트 플로우 식별 가능. "
            "(4) 최古 createdon으로 TTL 보존창 확인."
        )
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
