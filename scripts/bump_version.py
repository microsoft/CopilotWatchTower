"""Bump the application version across all files that pin it.

Single source of truth is ``src/copilot_watchtower/__init__.py``
(``__version__``). This script keeps the following in sync:

* ``src/copilot_watchtower/__init__.py``  → ``__version__ = "X.Y.Z"``
* ``pyproject.toml``                       → ``version = "X.Y.Z"`` ([project])
* ``packaging/AppxManifest.xml``           → ``Version="X.Y.Z.0"`` (4-part)

Usage::

    python scripts/bump_version.py 0.2.0
    python scripts/bump_version.py --part patch
    python scripts/bump_version.py --part minor --dry-run

The MSIX manifest requires a four-part ``MAJOR.MINOR.PATCH.REVISION``
version; the revision is always ``0`` for tagged releases.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INIT_PATH = REPO_ROOT / "src" / "copilot_watchtower" / "__init__.py"
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"
APPX_PATH = REPO_ROOT / "packaging" / "AppxManifest.xml"

_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_INIT_RE = re.compile(r'(__version__\s*=\s*")(\d+\.\d+\.\d+)(")')
_PYPROJECT_RE = re.compile(r'(?m)^(version\s*=\s*")(\d+\.\d+\.\d+)(")')
_APPX_RE = re.compile(r'(?<![A-Za-z])(Version=")(\d+\.\d+\.\d+\.\d+)(")')


class BumpError(Exception):
    """Raised for invalid input or unexpected file content."""


def parse_semver(value: str) -> tuple[int, int, int]:
    match = _SEMVER_RE.match(value.strip())
    if not match:
        raise BumpError(f"올바른 SemVer(X.Y.Z)가 아닙니다: {value!r}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def bump_semver(current: str, part: str) -> str:
    """Increment ``current`` (``X.Y.Z``) by the named ``part``."""
    major, minor, patch = parse_semver(current)
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    if part == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise BumpError(f"알 수 없는 part: {part!r} (major|minor|patch)")


def format_appx_version(semver: str) -> str:
    """Convert ``X.Y.Z`` into the 4-part MSIX form ``X.Y.Z.0``."""
    major, minor, patch = parse_semver(semver)
    return f"{major}.{minor}.{patch}.0"


def read_current_version() -> str:
    text = INIT_PATH.read_text(encoding="utf-8")
    match = _INIT_RE.search(text)
    if not match:
        raise BumpError(f"__version__ 를 찾지 못했습니다: {INIT_PATH}")
    return match.group(2)


def _replace_once(text: str, pattern: re.Pattern[str], replacement: str, where: str) -> str:
    new_text, count = pattern.subn(replacement, text)
    if count != 1:
        raise BumpError(f"{where}에서 버전 패턴을 정확히 1회 찾지 못했습니다 (찾음: {count}).")
    return new_text


def apply_version(new_version: str, *, dry_run: bool = False) -> list[str]:
    """Write ``new_version`` to all tracked files. Returns a change log."""
    parse_semver(new_version)  # validate
    appx_version = format_appx_version(new_version)
    changes: list[str] = []

    files = [
        (INIT_PATH, _INIT_RE, rf"\g<1>{new_version}\g<3>"),
        (PYPROJECT_PATH, _PYPROJECT_RE, rf"\g<1>{new_version}\g<3>"),
        (APPX_PATH, _APPX_RE, rf"\g<1>{appx_version}\g<3>"),
    ]
    for path, pattern, replacement in files:
        text = path.read_text(encoding="utf-8")
        updated = _replace_once(text, pattern, replacement, path.name)
        rel = path.relative_to(REPO_ROOT)
        if updated != text and not dry_run:
            path.write_text(updated, encoding="utf-8")
        changes.append(str(rel))
    return changes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bump the CopilotWatchTower version.")
    parser.add_argument(
        "version",
        nargs="?",
        help="명시적 새 버전 (예: 0.2.0). 생략 시 --part 사용.",
    )
    parser.add_argument(
        "--part",
        choices=["major", "minor", "patch"],
        help="현재 버전에서 증가시킬 부분.",
    )
    parser.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않고 미리보기.")
    args = parser.parse_args(argv)

    if not args.version and not args.part:
        parser.error("새 버전 또는 --part 중 하나가 필요합니다.")
    if args.version and args.part:
        parser.error("새 버전과 --part 는 함께 쓸 수 없습니다.")

    current = read_current_version()
    new_version = args.version if args.version else bump_semver(current, args.part)
    parse_semver(new_version)

    try:
        changes = apply_version(new_version, dry_run=args.dry_run)
    except BumpError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1

    verb = "미리보기" if args.dry_run else "업데이트"
    print(f"{current} → {new_version} ({verb})")
    print(f"  MSIX: {format_appx_version(new_version)}")
    for change in changes:
        print(f"  - {change}")
    if not args.dry_run:
        print("\n다음 단계: git commit, git tag v"
              f"{new_version}, git push --tags 로 릴리스를 트리거하세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
