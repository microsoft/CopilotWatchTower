"""Fixtures for Playwright end-to-end tests.

These boot the real web shell (``harness.py``) in a subprocess and drive it
with a headless Chromium. Tests are skipped automatically if Playwright or
its browser are unavailable.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest

_HARNESS = Path(__file__).resolve().parent / "harness.py"


@pytest.fixture(scope="session")
def _playwright():
    pytest.importorskip("playwright.sync_api")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(headless=True)
        except Exception as exc:  # noqa: BLE001 - environment without browser
            pytest.skip(f"Chromium not available for Playwright: {exc}")
        try:
            yield browser
        finally:
            browser.close()


@pytest.fixture
def page(_playwright):
    context = _playwright.new_context()
    pg = context.new_page()
    try:
        yield pg
    finally:
        context.close()


def _seed(db: Path) -> None:
    """Create (and optionally seed) the SQLite store the harness will serve."""
    from copilot_watchtower.db import initialize

    initialize(db)


@pytest.fixture
def harness_url(tmp_path: Path):
    db = tmp_path / "e2e.db"
    _seed(db)
    url_file = tmp_path / "url.txt"
    proc = subprocess.Popen(
        [sys.executable, str(_HARNESS), "--db", str(db), "--url-file", str(url_file)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        url = ""
        deadline = time.monotonic() + 40.0
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise RuntimeError(
                    f"harness exited early (code {proc.returncode}):\n{out}"
                )
            if url_file.exists():
                url = url_file.read_text(encoding="utf-8").strip()
                if url:
                    break
            time.sleep(0.1)
        if not url:
            raise RuntimeError("harness did not report a URL within the timeout")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
