"""Spike: directly probe the MCSMessages (Copilot Studio message) endpoints.

The page capture revealed the real endpoints that back the Copilot Studio
"리소스별 메시지 소비" table. The download button just exports these. So instead
of clicking download per environment we can call the JSON endpoints directly
with the captured PPAC token. This probe fetches each, with and without a
180-day window, and prints the full JSON so we can model the parser.

Run:

    .\\.venv\\Scripts\\python.exe scripts\\spike_mcs_messages.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import httpx  # noqa: E402

from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.db import Repository  # noqa: E402
from copilot_watchtower.services.consumption_browser_download import (  # noqa: E402
    capture_licensing_token,
)

HOST = "https://licensing.powerplatform.microsoft.com"


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
            if repo.get_text_setting("tenant_id") and (
                repo.get_text_setting("ediscovery_browser_user")
                or repo.get_text_setting("exo_delegated_user")
            ):
                return db
        except Exception:
            continue
    return None


def _load_creds(db: Path) -> tuple[str, str, str]:
    repo = Repository(db)
    tenant = repo.get_text_setting("tenant_id") or ""
    user = (
        repo.get_text_setting("ediscovery_browser_user")
        or repo.get_text_setting("exo_delegated_user")
        or ""
    )
    blob = repo.get_secret("ediscovery_browser_password") or repo.get_secret(
        "exo_delegated_password"
    )
    password = str(unprotect(blob)) if blob is not None else ""
    return tenant, user, password


def main() -> int:
    db = _find_profile_db()
    if db is None:
        print("활성 프로필을 찾지 못했습니다.")
        return 2
    tenant, user, password = _load_creds(db)
    if not (tenant and user and password):
        print("자격 증명이 비어 있습니다.")
        return 2
    print(f"테넌트: {tenant}  계정: {user}")

    print("PPAC 토큰 캡처 중...")
    token = capture_licensing_token(
        username=user, password=password, on_log=lambda m: print("  " + m)
    )
    print("토큰 확보. MCSMessages 엔드포인트를 직접 호출합니다.\n")

    end = date.today()
    start = end - timedelta(days=180)
    win = {"startDate": start.isoformat(), "endDate": end.isoformat()}
    win2 = {"from": start.isoformat(), "to": end.isoformat()}

    paths = [
        ("GET", f"/v2.0/tenants/{tenant}/entitlements/MCSMessages", None),
        ("GET", f"/v2.0/tenants/{tenant}/entitlements/MCSMessages/resources", None),
        ("GET", f"/v2.0/tenants/{tenant}/entitlements/MCSMessages/resources", win),
        ("GET", f"/v2.0/tenants/{tenant}/entitlements/MCSMessages/users", None),
        ("GET", f"/v2.0/tenants/{tenant}/entitlements/MCSMessages/users", win),
        ("GET", f"/v2.0/tenants/{tenant}/environments/entitlementConsumptions/MCSMessages", None),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/entitlements/MCSMessages/snapshot/resources", None),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/entitlements/MCSMessages/snapshot/resources", win),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/entitlements/MCSMessages/snapshot/product", None),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/entitlements/MCSMessages/trends", None),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/entitlements/MCSMessages/trends", win2),
        ("GET", f"/v1.0/tenants/{tenant}/capacityTypes/MCSMessages/trends", None),
    ]

    client = httpx.Client(
        timeout=60.0,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    results = []
    with client:
        for method, path, params in paths:
            url = HOST + path
            try:
                resp = client.request(method, url, params=params)
                try:
                    body = resp.json()
                except ValueError:
                    body = resp.text[:2000]
                status = resp.status_code
            except Exception as exc:  # noqa: BLE001
                body = repr(exc)
                status = "ERR"
            qs = f"?{json.dumps(params, ensure_ascii=False)}" if params else ""
            print(f"[{status}] {method} {path} {qs}")
            blob = json.dumps(body, ensure_ascii=False)
            print("   " + blob[:1200])
            print()
            results.append({"method": method, "path": path, "params": params, "status": status, "body": body})

    out_file = _out_dir() / "mcs_messages_probe.json"
    out_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"전체 응답 저장: {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
