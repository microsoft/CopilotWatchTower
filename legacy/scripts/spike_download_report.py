"""Spike: reverse-engineer the PPAC "Download report" CSV lifecycle.

The PPAC Licensing → Copilot Studio → **Download report** panel lets an admin
export consumption CSVs along three axes:

* **Usage type**     – e.g. ``Copilot Credits`` (the dropdown may carry more).
* **Look back window** – e.g. 7 / 30 / 90 days (we want the *longest* offered).
* **Download type**  – ``Environment Consumption Summary`` /
  ``Agent-Level Credit Consumption`` / ``User-Level Credit Consumption``.

Unlike the JSON snapshot endpoints the collector already calls, this export is
an **async request → poll → download** lifecycle that is only triggered when
the admin clicks the button. This spike drives the real UI with headless
Chromium, then:

1. opens the Download report panel and **enumerates every dropdown option**
   (Usage type, Look back window, Download type) so we learn the full matrix;
2. selects the *longest* look back window and, for every Usage type ×
   Download type combination, clicks Download and records:
   * the POST that *requests* the report (URL + body — the report-type / window
     / scope encoding we need),
   * any *poll* requests, and
   * the resulting CSV download (saved to disk, headers sniffed).

Nothing here is wired into the app — it only discovers the contract. Output:

* ``%LOCALAPPDATA%\\CopilotWatchTower\\download_report_capture.jsonl`` — traffic
* ``%LOCALAPPDATA%\\CopilotWatchTower\\download_report_options.json`` — dropdowns
* ``…\\download_report_downloads\\`` — every CSV that was generated

Run:

    .\\.venv\\Scripts\\python.exe scripts\\spike_download_report.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.db import Repository  # noqa: E402
from copilot_watchtower.services.ediscovery_browser_download import (  # noqa: E402
    _complete_microsoft_login,
)

# Hosts whose traffic is interesting while the report export runs.
INTERESTING_HOST_HINTS = (
    "licensing.powerplatform",
    "api.powerplatform",
    "admin.powerplatform",
    "api.admin.powerplatform",
)

# Entry points for the Copilot Studio licensing surface. PPAC has shuffled
# these over time, so we try several and keep whichever renders the page with
# the "Download report" button.
CANDIDATE_LICENSING_URLS = (
    "https://admin.powerplatform.microsoft.com/licensing/products/copilotStudio",
    "https://admin.powerplatform.microsoft.com/licensing/products/CopilotStudio",
    "https://admin.powerplatform.microsoft.com/licensing",
    "https://admin.powerplatform.microsoft.com/billing/licenses",
)

# Text used to locate UI affordances (English + Korean PPAC locales).
DOWNLOAD_BUTTON_TEXTS = ("Download report", "리포트 다운로드", "보고서 다운로드")
COPILOT_STUDIO_NAV_TEXTS = ("Copilot Studio",)


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

    out = _out_dir()
    dump_path = out / "download_report_capture.jsonl"
    dump_path.write_text("", encoding="utf-8")
    options_path = out / "download_report_options.json"
    dl_dir = out / "download_report_downloads"
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

        def on_request(request):
            try:
                url = request.url
                if not _interesting(url):
                    return
                # Capture mutating calls (report generation) with their bodies.
                if request.method in ("POST", "PUT", "PATCH"):
                    try:
                        body = request.post_data or ""
                    except Exception:
                        body = ""
                    record(
                        "request",
                        method=request.method,
                        url=url,
                        body=body[:8_000],
                    )
            except Exception:
                pass

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
                if dumped["count"] >= 200:
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
                head = ""
                try:
                    head = target.read_text(encoding="utf-8-sig", errors="replace")[:600]
                except Exception:
                    pass
                record(
                    "download",
                    suggested=name,
                    url=download.url,
                    saved=str(target),
                    head=head,
                )
                print(f"  ⬇ CSV 캡처: {name}")
            except Exception as exc:
                record("download_error", error=repr(exc))

        page.on("request", on_request)
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

        # --- reach Licensing → Copilot Studio ----------------------------
        reached = False
        for url in CANDIDATE_LICENSING_URLS:
            print(f"• 라이선싱 페이지 방문: {url}")
            try:
                page.goto(url, timeout=60_000, wait_until="domcontentloaded")
            except Exception:
                pass
            page.wait_for_timeout(7_000)
            # A direct product URL may already render the Download report
            # button; otherwise click the Copilot Studio nav entry.
            for text in DOWNLOAD_BUTTON_TEXTS:
                if page.get_by_role("button", name=text, exact=False).count() > 0:
                    reached = True
                    break
                if page.get_by_text(text, exact=False).count() > 0:
                    reached = True
                    break
            if not reached:
                for label in COPILOT_STUDIO_NAV_TEXTS:
                    loc = page.get_by_text(label, exact=False)
                    if loc.count() > 0:
                        try:
                            loc.first.click(timeout=4_000)
                            page.wait_for_timeout(6_000)
                            print(f"  · '{label}' 클릭")
                            reached = True
                        except Exception:
                            pass
            if reached:
                break
        if not reached:
            print("  ! Copilot Studio 라이선싱 화면을 찾지 못했습니다. 캡처는 계속합니다.")

        # --- open the Download report panel ------------------------------
        opened = False
        for finder in (
            lambda t: page.get_by_role("button", name=t, exact=False),
            lambda t: page.get_by_role("menuitem", name=t, exact=False),
            lambda t: page.get_by_text(t, exact=False),
        ):
            for text in DOWNLOAD_BUTTON_TEXTS:
                loc = finder(text)
                try:
                    if loc.count() == 0:
                        continue
                    loc.first.click(timeout=5_000)
                    page.wait_for_timeout(4_000)
                    print(f"• 'Download report' 패널 열기: '{text}'")
                    opened = True
                    break
                except Exception as exc:
                    record("open_panel_error", text=text, error=repr(exc))
            if opened:
                break
        if not opened:
            print("  ! 'Download report' 버튼을 찾지 못했습니다.")
            # Dump what IS on the page to learn the real affordance text.
            try:
                btn_texts = page.eval_on_selector_all(
                    "button,[role=button],[role=menuitem],a",
                    "els => els.map(e => (e.innerText||e.textContent||'').trim())"
                    ".filter(Boolean).slice(0, 80)",
                )
                record("page_buttons", texts=btn_texts)
                print("  · 페이지 버튼/링크 텍스트(앞 40개):")
                for t in btn_texts[:40]:
                    print(f"      · {t}")
            except Exception as exc:
                record("page_buttons_error", error=repr(exc))
            try:
                shot = out / "download_report_page.png"
                page.screenshot(path=str(shot), full_page=True)
                print(f"  · 스크린샷 저장: {shot}")
            except Exception:
                pass

        # --- enumerate every dropdown's options --------------------------
        def dump_dropdowns() -> dict:
            try:
                return page.evaluate(
                    """
                    () => {
                      const out = {};
                      // Native <select> options.
                      const selects = Array.from(document.querySelectorAll('select'));
                      out.selects = selects.map(s => ({
                        name: s.name || s.id || s.getAttribute('aria-label') || '',
                        options: Array.from(s.options).map(o => ({
                          value: o.value, text: (o.textContent || '').trim()
                        }))
                      }));
                      // Fluent UI comboboxes / dropdowns render as buttons +
                      // listbox. Capture any role=option text on the page.
                      out.roleOptions = Array.from(
                        document.querySelectorAll('[role="option"]')
                      ).map(o => (o.textContent || '').trim()).filter(Boolean);
                      // Combobox triggers (current value) for labelling.
                      out.comboboxes = Array.from(
                        document.querySelectorAll('[role="combobox"],[role="listbox"]')
                      ).map(c => ({
                        label: c.getAttribute('aria-label') || '',
                        text: (c.textContent || '').trim().slice(0, 120)
                      }));
                      return out;
                    }
                    """
                )
            except Exception as exc:
                return {"error": repr(exc)}

        options_snapshot = {"initial": dump_dropdowns()}

        # Open each combobox to force its options into the DOM, then snapshot.
        try:
            combos = page.locator('[role="combobox"]')
            count = combos.count()
            print(f"• 드롭다운 {count}개 탐색")
            captured_lists = []
            for i in range(count):
                try:
                    combos.nth(i).click(timeout=3_000)
                    page.wait_for_timeout(800)
                    opts = page.eval_on_selector_all(
                        '[role="option"]',
                        "els => els.map(e => (e.textContent||'').trim()).filter(Boolean)",
                    )
                    label = combos.nth(i).get_attribute("aria-label") or f"combo_{i}"
                    captured_lists.append({"label": label, "options": opts})
                    print(f"    ↳ [{label}] → {opts}")
                    # Close the listbox before opening the next one.
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(300)
                except Exception as exc:
                    captured_lists.append({"index": i, "error": repr(exc)})
            options_snapshot["comboboxes"] = captured_lists
        except Exception as exc:
            options_snapshot["combobox_error"] = repr(exc)

        options_path.write_text(
            json.dumps(options_snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"• 드롭다운 옵션 저장: {options_path}")

        # --- drive each Download type at the longest look-back window -----
        # Strategy: open the "Download type" combobox, iterate each option,
        # then click the Download/Generate button and wait for the export to
        # kick off so the request→poll traffic is captured.
        def select_combo_option(combo_label_hint: str, option_text: str) -> bool:
            combos = page.locator('[role="combobox"]')
            for i in range(combos.count()):
                lbl = (combos.nth(i).get_attribute("aria-label") or "").lower()
                cur = (combos.nth(i).inner_text() or "").lower()
                if combo_label_hint.lower() in lbl or combo_label_hint.lower() in cur:
                    try:
                        combos.nth(i).click(timeout=3_000)
                        page.wait_for_timeout(600)
                        opt = page.get_by_role("option", name=option_text, exact=False)
                        if opt.count() > 0:
                            opt.first.click(timeout=3_000)
                            page.wait_for_timeout(600)
                            return True
                    except Exception:
                        pass
            return False

        def click_generate() -> None:
            for text in ("Download", "Generate", "다운로드", "생성"):
                loc = page.get_by_role("button", name=text, exact=False)
                if loc.count() > 0:
                    try:
                        loc.first.click(timeout=4_000)
                        page.wait_for_timeout(5_000)
                        return
                    except Exception:
                        pass

        # Try to pick the longest look-back window (usually the last option).
        try:
            combos = page.locator('[role="combobox"]')
            for i in range(combos.count()):
                lbl = (combos.nth(i).get_attribute("aria-label") or "").lower()
                if "look" in lbl or "window" in lbl or "기간" in lbl:
                    combos.nth(i).click(timeout=3_000)
                    page.wait_for_timeout(600)
                    opts = page.locator('[role="option"]')
                    if opts.count() > 0:
                        opts.nth(opts.count() - 1).click(timeout=3_000)
                        page.wait_for_timeout(600)
                        print("• Look back window: 가장 긴 옵션 선택")
                    break
        except Exception as exc:
            record("lookback_select_error", error=repr(exc))

        # Iterate Download type options and generate each.
        download_types = []
        try:
            combos = page.locator('[role="combobox"]')
            for i in range(combos.count()):
                lbl = (combos.nth(i).get_attribute("aria-label") or "").lower()
                cur = (combos.nth(i).inner_text() or "").lower()
                if "download type" in lbl or "consumption" in cur or "summary" in cur:
                    combos.nth(i).click(timeout=3_000)
                    page.wait_for_timeout(600)
                    download_types = page.eval_on_selector_all(
                        '[role="option"]',
                        "els => els.map(e => (e.textContent||'').trim()).filter(Boolean)",
                    )
                    page.keyboard.press("Escape")
                    break
        except Exception as exc:
            record("download_type_enum_error", error=repr(exc))

        print(f"• Download type 옵션: {download_types}")
        for dt in download_types or []:
            print(f"• Download type '{dt}' 생성 시도")
            if select_combo_option("download type", dt) or select_combo_option(
                "consumption", dt
            ):
                click_generate()
                # Let the async export request→poll→download settle.
                page.wait_for_timeout(8_000)
            record("attempted_download_type", value=dt)

        # Final settle so trailing poll/download traffic is captured.
        page.wait_for_timeout(6_000)

        print(f"\n• 관찰된 관심 엔드포인트 {len(seen)}개:")
        for marker in seen:
            print(f"    ↳ {marker}")

        try:
            browser.close()
        except Exception:
            pass

    print(f"\n• 트래픽 캡처: {dump_path}")
    print(f"• 드롭다운 옵션: {options_path}")
    print(f"• 다운로드된 CSV: {dl_dir}")
    print("  이 파일들로 Usage type/look-back/download type 매트릭스와")
    print("  request→poll→download 계약을 수집기에 반영합니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
