"""Check the latest published GitHub Release and compare it to the
installed version.

The desktop app surfaces this in Settings: it shows the current version
and lets the admin check whether a newer release is available. We only
read public release metadata (no auth) and never download or install
anything automatically — the UI opens the release page in the browser.

SemVer comparison is intentionally self-contained (no ``packaging``
dependency) since the version scheme is the simple ``MAJOR.MINOR.PATCH``
form used by this project.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx

from ..config import GITHUB_RELEASES_LATEST_URL, GITHUB_RELEASES_PAGE_URL

log = logging.getLogger(__name__)

_USER_AGENT = "CopilotWatchTower-UpdateChecker"
_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


class VersionCheckError(Exception):
    """Raised when the latest release cannot be retrieved or parsed."""


@dataclass(frozen=True)
class LatestRelease:
    """Subset of the GitHub release payload the UI needs."""

    version: str
    tag: str
    name: str
    html_url: str
    download_url: str | None
    notes: str
    published_at: str | None
    prerelease: bool


def parse_semver(value: str | None) -> tuple[int, int, int]:
    """Parse ``MAJOR.MINOR.PATCH`` (ignoring any leading ``v`` and
    trailing pre-release/build metadata) into a comparable tuple.

    Raises :class:`ValueError` if the core numeric triple is missing.
    """
    if not value:
        raise ValueError("empty version string")
    text = value.strip()
    if text[:1].lower() == "v":
        text = text[1:]
    match = _SEMVER_RE.match(text)
    if not match:
        raise ValueError(f"not a semver string: {value!r}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def compare_versions(current: str, latest: str) -> int:
    """Return -1 if ``current`` < ``latest``, 0 if equal, 1 if greater."""
    cur = parse_semver(current)
    lat = parse_semver(latest)
    if cur < lat:
        return -1
    if cur > lat:
        return 1
    return 0


def _pick_download_url(assets: list[dict[str, Any]]) -> str | None:
    """Prefer the ``.msix`` asset; fall back to the first downloadable asset."""
    download_urls = [
        a.get("browser_download_url")
        for a in assets
        if a.get("browser_download_url")
    ]
    for asset in assets:
        name = (asset.get("name") or "").lower()
        url = asset.get("browser_download_url")
        if url and name.endswith(".msix"):
            return url
    return download_urls[0] if download_urls else None


def parse_release_payload(payload: dict[str, Any]) -> LatestRelease:
    """Convert a GitHub ``releases/latest`` JSON body into a
    :class:`LatestRelease`."""
    if not isinstance(payload, dict):
        raise VersionCheckError("unexpected release payload shape")
    tag = (payload.get("tag_name") or "").strip()
    if not tag:
        raise VersionCheckError("release payload has no tag_name")
    # Strip a leading "v" for the display/compare version.
    version = tag[1:] if tag[:1].lower() == "v" else tag
    assets = payload.get("assets")
    assets = assets if isinstance(assets, list) else []
    return LatestRelease(
        version=version,
        tag=tag,
        name=(payload.get("name") or tag),
        html_url=(payload.get("html_url") or GITHUB_RELEASES_PAGE_URL),
        download_url=_pick_download_url(assets),
        notes=(payload.get("body") or ""),
        published_at=payload.get("published_at"),
        prerelease=bool(payload.get("prerelease", False)),
    )


def fetch_latest_release(
    *,
    client: httpx.Client | None = None,
    timeout: float = 10.0,
) -> LatestRelease:
    """Fetch and parse the latest GitHub Release.

    Raises :class:`VersionCheckError` on network failure, a non-success
    status (including 404 when no release exists yet), or a malformed
    payload.
    """
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": _USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    owns_client = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        resp = http.get(GITHUB_RELEASES_LATEST_URL, headers=headers)
    except httpx.HTTPError as exc:
        raise VersionCheckError(f"네트워크 오류로 최신 버전을 확인하지 못했습니다: {exc}") from exc
    finally:
        if owns_client:
            http.close()

    if resp.status_code == 404:
        raise VersionCheckError("아직 등록된 릴리스가 없습니다.")
    if not resp.is_success:
        raise VersionCheckError(
            f"최신 버전 정보를 가져오지 못했습니다 (HTTP {resp.status_code})."
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise VersionCheckError("릴리스 응답을 해석하지 못했습니다.") from exc
    return parse_release_payload(payload)


def check_for_update(
    current_version: str,
    *,
    client: httpx.Client | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Compare the installed version against the latest release.

    Returns a JSON-serialisable dict. Network/parse failures are turned
    into ``{"ok": False, "error": ...}`` so callers (the bridge) can keep
    the app stable and just surface a message.
    """
    try:
        latest = fetch_latest_release(client=client, timeout=timeout)
    except VersionCheckError as exc:
        return {
            "ok": False,
            "current_version": current_version,
            "error": str(exc),
        }

    try:
        update_available = compare_versions(current_version, latest.version) < 0
    except ValueError:
        # If either version is unparsable, fall back to a string inequality.
        update_available = current_version.lstrip("vV") != latest.version

    return {
        "ok": True,
        "current_version": current_version,
        "latest_version": latest.version,
        "update_available": update_available,
        "prerelease": latest.prerelease,
        "release_name": latest.name,
        "release_url": latest.html_url,
        "download_url": latest.download_url,
        "notes": latest.notes,
        "published_at": latest.published_at,
    }
