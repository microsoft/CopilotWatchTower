"""Spike: discover the real Power Platform Licensing API contract.

The unofficial licensing endpoints are undocumented, so instead of guessing
REST paths we drive a real PPAC sign-in (the same headless Chromium flow the
collector uses), capture the bearer token the admin-center SPA mints, and then
hit the endpoints PPAC actually calls. The raw JSON for each is printed and
saved so the parser/collector can be written against the *real* shapes.

Run:

    .\\.venv\\Scripts\\python.exe scripts\\spike_licensing.py

Credentials + tenant are read from the active profile's store.db (the same
``ediscovery_browser_user`` / ``ediscovery_browser_password`` the collector
uses). Output is written to
``%LOCALAPPDATA%\\CopilotWatchTower\\licensing_spike.json``.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

# Allow running from the repo root without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import httpx  # noqa: E402

from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.services.consumption_browser_download import (  # noqa: E402
    capture_licensing_token,
)
from copilot_watchtower.db import Repository  # noqa: E402


LICENSING_BASE = "https://licensing.powerplatform.microsoft.com"


def _find_profile_db() -> Path | None:
    """Locate a profile store.db that has browser creds + tenant configured."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    root = Path(base) / "CopilotWatchTower"
    candidates = list((root / "profiles").glob("*/store.db"))
    legacy = root / "store.db"
    if legacy.exists():
        candidates.append(legacy)
    for db in candidates:
        try:
            repo = Repository(db)
            tenant = repo.get_text_setting("tenant_id")
            user = repo.get_text_setting("ediscovery_browser_user") or repo.get_text_setting(
                "exo_delegated_user"
            )
            if tenant and user:
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


def _probe(client: httpx.Client, method: str, path: str, *, json_body=None) -> dict:
    url = f"{LICENSING_BASE}{path}"
    try:
        resp = client.request(method, url, json=json_body)
    except Exception as exc:  # noqa: BLE001
        return {"method": method, "url": url, "error": repr(exc)}
    body_text = resp.text
    try:
        body = resp.json()
    except ValueError:
        body = body_text[:2000]
    return {
        "method": method,
        "url": url,
        "status": resp.status_code,
        "body": body,
    }


def main() -> int:
    db = _find_profile_db()
    if db is None:
        print(
            "활성 프로필에서 tenant_id + 브라우저 로그인 계정을 찾지 못했습니다. "
            "앱에서 설정을 먼저 완료하세요."
        )
        return 2
    print(f"• 프로필 DB: {db}")
    tenant, user, password = _load_creds(db)
    if not (tenant and user and password):
        print("tenant_id / 사용자 / 비밀번호 중 일부가 비어 있습니다.")
        return 2
    print(f"• 테넌트: {tenant}  계정: {user}")

    print("• PPAC 자동 로그인으로 라이선싱 토큰을 캡처합니다 (headless Chromium)…")
    token = capture_licensing_token(
        username=user, password=password, on_log=lambda m: print("  " + m)
    )
    print("• 토큰 확보 완료. 발견된 엔드포인트를 직접 호출합니다.\n")

    end = date.today()
    start = end - timedelta(days=30)
    body_range = {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
    }

    client = httpx.Client(
        timeout=60.0,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )

    # Endpoints observed from the PPAC network capture. We try a couple of
    # plausible bodies for the POST "getmany" endpoints.
    probes = [
        ("GET", f"/v0.1/tenants/{tenant}/allocationsV2/sum"),
        ("POST", f"/v0.1/tenants/{tenant}/allocationsV2/getmany", {}),
        ("POST", f"/v0.1/tenants/{tenant}/allocationsV2/getmany", body_range),
        ("POST", f"/v0.1/tenants/{tenant}/allocationsV2/overage/getmany", {}),
        (
            "GET",
            f"/v0.1/tenants/{tenant}/ManagedEnvironment/PowerApps/GetLicenseSummary",
        ),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/entitlements/extension"),
        ("GET", f"/v0.1-alpha/tenants/{tenant}/TenantCapacity"),
        ("GET", f"/v1.0/tenants/{tenant}/CurrencyReports"),
    ]

    results = []
    with client:
        for probe in probes:
            method, path = probe[0], probe[1]
            json_body = probe[2] if len(probe) > 2 else None
            r = _probe(client, method, path, json_body=json_body)
            results.append(r)
            status = r.get("status", r.get("error"))
            print(f"  [{status}] {method} {path}")

    out = Path(os.environ.get("LOCALAPPDATA") or str(Path.home())) / "CopilotWatchTower"
    out.mkdir(parents=True, exist_ok=True)
    out_file = out / "licensing_spike.json"
    out_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n• 전체 응답을 저장했습니다: {out_file}")
    print("  이 파일의 JSON 구조를 보고 수집기/파서를 실제 계약에 맞춰 구현합니다.")

    # End-to-end check of the production LicensingClient against the live API.
    from copilot_watchtower.services.consumption_browser_download import (
        CapturedTokenProvider,
    )
    from copilot_watchtower.services.licensing import LicensingClient

    print("\n• 운영 LicensingClient로 실제 수집을 검증합니다…")
    client = LicensingClient(CapturedTokenProvider(token), tenant, timeout=60.0)
    try:
        cur = client.fetch_currency_rows()
        cap = client.fetch_capacity_rows()
        print(f"  통화 리포트 {len(cur)}행, 스토리지 용량 {len(cap)}행 파싱 완료.")
        for r in cur[:6]:
            print(f"    ↳ {r.report_type}/{r.product} = {r.quantity} {r.unit}")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
