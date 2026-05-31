"""Unattended browser download for eDiscovery direct-download proxy URLs."""
from __future__ import annotations

import logging
import re
from pathlib import Path

import httpx

log = logging.getLogger(__name__)


class BrowserDownloadError(RuntimeError):
    """Raised when the headless browser cannot capture the export download."""


def download_with_playwright(
    download_url: str,
    *,
    download_dir: Path | str,
    username: str,
    password: str,
    timeout_ms: int = 300_000,
) -> Path:
    """Download an eDiscovery proxy URL using headless Chromium.

    This mirrors the working MCP implementation in ``docs/ediscovery.py``:
    wrap the entire navigation/login flow in ``expect_download`` so the final
    proxy redirect can trigger Chromium's download manager, then persist the
    captured file. If the download event times out, retry a direct HTTP stream
    with browser cookies from the authenticated context.
    """
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise BrowserDownloadError(
            "playwright가 설치되어 있지 않습니다. `pip install playwright` 및 "
            "`python -m playwright install chromium`을 실행하세요."
        ) from exc

    if not username or not password:
        raise BrowserDownloadError("headless 브라우저 로그인 계정/비밀번호가 없습니다.")

    target_dir = Path(download_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            try:
                with page.expect_download(timeout=timeout_ms) as download_info:
                    try:
                        page.goto(download_url, timeout=60_000, wait_until="domcontentloaded")
                    except Exception:
                        # Some proxy responses switch directly into download.
                        pass
                    _complete_microsoft_login(page, username=username, password=password)
                download = download_info.value
                suggested = _safe_filename(download.suggested_filename or "ediscovery-export.zip")
                local_path = target_dir / suggested
                download.save_as(str(local_path))
                _assert_not_html(local_path)
                return local_path
            except Exception as exc:
                log.info("Playwright download event failed; trying cookie stream", exc_info=True)
                fallback = _download_with_browser_cookies(
                    download_url,
                    target_dir=target_dir,
                    cookies=context.cookies(),
                )
                if fallback is not None:
                    return fallback
                if isinstance(exc, BrowserDownloadError):
                    raise
                if isinstance(exc, PlaywrightTimeoutError):
                    raise BrowserDownloadError("headless 브라우저 다운로드 이벤트가 시간 초과되었습니다.") from exc
                raise BrowserDownloadError(f"headless 브라우저 다운로드 실패: {exc}") from exc
        finally:
            browser.close()


def _complete_microsoft_login(page, *, username: str, password: str) -> None:
    # Email step.
    try:
        email_input = page.locator('input[name="loginfmt"], input#i0116').first
        email_input.wait_for(state="visible", timeout=15_000)
        if not email_input.input_value(timeout=1_000):
            email_input.fill(username)
        _click_submit(page)
        page.wait_for_timeout(1_500)
    except Exception:
        pass

    # Some tenants present a passkey-first screen. Move to password flow.
    for pattern in (r"password", r"암호", r"비밀번호", r"다른.*방법", r"sign in another way"):
        try:
            page.get_by_text(re.compile(pattern, re.IGNORECASE)).first.click(timeout=2_000)
            page.wait_for_timeout(1_000)
            break
        except Exception:
            pass

    # Password step.
    try:
        password_input = page.locator('input[name="passwd"], input#i0118, input[type="password"]').first
        password_input.wait_for(state="visible", timeout=20_000)
        if not password_input.input_value(timeout=1_000):
            password_input.fill(password)
        _click_submit(page)
        page.wait_for_timeout(2_500)
    except Exception:
        pass

    # Stay signed in / keep session prompt. Prefer Yes like the source project,
    # but fall back to No/Back if that is what the tenant shows.
    for selector in ("#idSIButton9", "input[type=submit]", "#idBtn_Back"):
        try:
            page.locator(selector).first.click(timeout=5_000)
            page.wait_for_timeout(1_500)
            break
        except Exception:
            pass


def _click_submit(page) -> None:
    for selector in ('input[type="submit"]', "#idSIButton9", 'button[type="submit"]'):
        try:
            page.locator(selector).first.click(timeout=5_000)
            return
        except Exception:
            pass


def _download_with_browser_cookies(
    download_url: str,
    *,
    target_dir: Path,
    cookies: list[dict],
) -> Path | None:
    cookie_dict: dict[str, str] = {}
    for cookie in cookies:
        domain = str(cookie.get("domain") or "")
        if "ediscovery" in domain or "office365" in domain or "proxyservice" in domain:
            name = cookie.get("name")
            value = cookie.get("value")
            if name and value:
                cookie_dict[str(name)] = str(value)
    if not cookie_dict:
        return None
    local_path = target_dir / "ediscovery-export.zip"
    with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0), follow_redirects=True, cookies=cookie_dict) as client:
        with client.stream("GET", download_url) as response:
            if not response.is_success:
                return None
            with local_path.open("wb") as handle:
                first = True
                for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    if first:
                        first = False
                        if _looks_like_html(chunk[:256]):
                            return None
                    handle.write(chunk)
    if local_path.exists() and local_path.stat().st_size > 0:
        return local_path
    return None


def _assert_not_html(path: Path) -> None:
    with path.open("rb") as handle:
        header = handle.read(256)
    if _looks_like_html(header):
        try:
            path.unlink()
        except OSError:
            pass
        raise BrowserDownloadError("브라우저 인증 후에도 HTML 로그인 응답이 저장되었습니다.")


def _looks_like_html(data: bytes) -> bool:
    low = data.lower().lstrip()
    return low.startswith(b"<!doctype") or low.startswith(b"<html") or b"<form" in low[:200]


def _safe_filename(name: str) -> str:
    cleaned = "".join(ch if ch not in '<>:"/\\|?*' else "_" for ch in name).strip()
    return cleaned or "ediscovery-export.zip"