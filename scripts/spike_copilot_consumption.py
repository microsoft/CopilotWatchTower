"""Spike: capture the per-environment Copilot Studio message-consumption contract.

Method A (already implemented) gives tenant-wide snapshots. The data the user
actually wants — per-agent / per-resource Copilot Studio message consumption —
lives behind the PPAC "리소스별 메시지 소비 > 다운로드" button on the
Licensing > Copilot Studio > 환경(Environments) page, and it is loaded /
exported **per environment**.

This spike drives a real PPAC sign-in with headless Chromium, then:

1. enumerates the tenant's environments (the same list PPAC iterates), and
2. records EVERY JSON/fetch/XHR response and any file download triggered while
   the Copilot Studio licensing page loads, so we can learn the real request
   shape (URL, query params, 180-day window encoding, CSV columns).

Nothing here is wired into the app yet — it only discovers the contract. All
captured traffic is written to
``%LOCALAPPDATA%\\CopilotWatchTower\\copilot_consumption_capture.jsonl`` and any
downloaded files to ``…\\copilot_consumption_downloads\\``.

Run:

    .\\.venv\\Scripts\\python.exe scripts\\spike_copilot_consumption.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.db import Repository  # noqa: E402
from copilot_watchtower.services.ediscovery_browser_download import (  # noqa: E402
    _complete_microsoft_login,
)

# Hosts whose JSON traffic is interesting for consumption discovery.
INTERESTING_HOST_HINTS = (
    "licensing.powerplatform",
    "api.powerplatform",
    "api.bap.microsoft",
    "powerapps.com",
    "admin.powerplatform",
    "api.admin.powerplatform",
)

# Candidate licensing pages to visit. PPAC has shuffled these routes over time,
# so we try several and keep whichever renders the consumption table.
CANDIDATE_LICENSING_URLS = (
    "https://admin.powerplatform.microsoft.com/licensing",
    "https://admin.powerplatform.microsoft.com/billing/licenses",
    "https://admin.powerplatform.microsoft.com/resources/capacity",
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


def _interesting(url: str) -> bool:
    return any(hint in url for hint in INTERESTING_HOST_HINTS)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright 미설치: pip install playwright && python -m playwright install chromium")
        return 2

    db = _find_profile_db()
    if db is None:
        print("활성 프로필에서 tenant_id + 브라우저 로그인 계정을 찾지 못했습니다.")
        return 2
    tenant, user, password = _load_creds(db)
    if not (tenant and user and password):
        print("tenant_id / 사용자 / 비밀번호 중 일부가 비어 있습니다.")
        return 2
    print(f"• 프로필 DB: {db}")
    print(f"• 테넌트: {tenant}  계정: {user}")

    end = date.today()
    start = end - timedelta(days=180)
    print(f"• 대상 기간(180일): {start.isoformat()} → {end.isoformat()}")

    out = _out_dir()
    dump_path = out / "copilot_consumption_capture.jsonl"
    dump_path.write_text("", encoding="utf-8")
    dl_dir = out / "copilot_consumption_downloads"
    dl_dir.mkdir(parents=True, exist_ok=True)

    seen: list[str] = []
    dumped = {"count": 0}

    def record(kind: str, **fields) -> None:
        with dump_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"kind": kind, **fields}, ensure_ascii=False) + "\n")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        def on_response(response):
            try:
                url = response.url
                if not _interesting(url):
                    return
                path = url.split("?", 1)[0]
                marker = f"{response.request.method} {path}"
                if marker not in seen:
                    seen.append(marker)
                ctype = (response.headers or {}).get("content-type", "")
                if "json" not in ctype and "csv" not in ctype and "text" not in ctype:
                    return
                if dumped["count"] >= 120:
                    return
                try:
                    body = response.text()
                except Exception:
                    body = ""
                try:
                    req_body = response.request.post_data or ""
                except Exception:
                    req_body = ""
                record(
                    "response",
                    method=response.request.method,
                    url=url,
                    status=response.status,
                    content_type=ctype,
                    request_body=req_body[:8_000],
                    body=body[:40_000],
                )
                dumped["count"] += 1
            except Exception:
                pass

        def on_download(download):
            try:
                name = download.suggested_filename or "download.bin"
                target = dl_dir / name
                download.save_as(str(target))
                record("download", suggested=name, url=download.url, saved=str(target))
                print(f"  ⬇ 다운로드 캡처: {name} → {target}")
            except Exception as exc:
                record("download_error", error=repr(exc))

        page.on("response", on_response)
        page.on("download", on_download)

        # --- sign in ------------------------------------------------------
        print("• PPAC 자동 로그인 (headless Chromium)…")
        try:
            page.goto(
                "https://admin.powerplatform.microsoft.com/",
                timeout=60_000,
                wait_until="domcontentloaded",
            )
        except Exception:
            pass
        _complete_microsoft_login(page, username=user, password=password)
        page.wait_for_timeout(6_000)

        # --- enumerate environments via the BAP API ----------------------
        print("• 환경 목록을 조회합니다…")
        envs: list[dict] = []
        env_probe_urls = [
            "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2023-06-01",
            "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2023-06-01",
        ]
        for probe in env_probe_urls:
            try:
                resp = page.request.get(probe, timeout=60_000)
                if resp.ok:
                    data = resp.json()
                    items = data.get("value", data) if isinstance(data, dict) else data
                    for it in items or []:
                        name = it.get("name") or it.get("id")
                        props = it.get("properties", {}) if isinstance(it, dict) else {}
                        display = props.get("displayName") or props.get("linkedEnvironmentMetadata", {}).get("friendlyName")
                        if name:
                            envs.append({"name": name, "display": display})
                    record("environments", probe=probe, count=len(envs), items=envs)
                    if envs:
                        break
            except Exception as exc:
                record("env_probe_error", probe=probe, error=repr(exc))
        print(f"  → 환경 {len(envs)}개 발견")
        for e in envs[:10]:
            print(f"    ↳ {e['display'] or '(이름없음)'}  [{e['name']}]")

        # --- visit candidate licensing pages, let the SPA call its APIs --
        for url in CANDIDATE_LICENSING_URLS:
            print(f"• 라이선싱 페이지 방문: {url}")
            try:
                page.goto(url, timeout=60_000, wait_until="domcontentloaded")
            except Exception:
                pass
            page.wait_for_timeout(8_000)

        # --- try to reach the Copilot Studio product licensing view ------
        # The consumption table is under Licensing → Copilot Studio. Click any
        # nav entry whose text mentions Copilot Studio, then wait for XHRs.
        try:
            for label in ("Copilot Studio", "환경", "Environments"):
                loc = page.get_by_text(label, exact=False)
                if loc.count() > 0:
                    loc.first.click(timeout=4_000)
                    page.wait_for_timeout(5_000)
                    print(f"  · '{label}' 클릭 후 XHR 대기")
        except Exception as exc:
            record("nav_click_error", error=repr(exc))

        page.wait_for_timeout(4_000)

        print(f"\n• 관찰된 관심 엔드포인트 {len(seen)}개:")
        for marker in seen:
            print(f"    ↳ {marker}")

        context.close()
        browser.close()

    print(f"\n• 전체 캡처 저장: {dump_path}  (응답 {dumped['count']}건)")
    print(f"• 다운로드 폴더: {dl_dir}")
    print("  이 파일에서 환경별 메시지 소비 엔드포인트/CSV 컬럼을 확인해 수집기를 구현합니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
