"""Tests for scripts/bump_version.py pure helpers and file edits."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "bump_version.py"
_spec = importlib.util.spec_from_file_location("bump_version", _SCRIPT)
assert _spec and _spec.loader
bump_version = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bump_version)


def test_bump_semver_major() -> None:
    assert bump_version.bump_semver("1.2.3", "major") == "2.0.0"


def test_bump_semver_minor() -> None:
    assert bump_version.bump_semver("1.2.3", "minor") == "1.3.0"


def test_bump_semver_patch() -> None:
    assert bump_version.bump_semver("1.2.3", "patch") == "1.2.4"


def test_bump_semver_rejects_bad_part() -> None:
    with pytest.raises(bump_version.BumpError):
        bump_version.bump_semver("1.2.3", "nope")


def test_parse_semver_rejects_invalid() -> None:
    with pytest.raises(bump_version.BumpError):
        bump_version.parse_semver("1.2")


def test_format_appx_version_adds_revision() -> None:
    assert bump_version.format_appx_version("0.2.0") == "0.2.0.0"


def test_apply_version_dry_run_does_not_write(tmp_path, monkeypatch) -> None:
    init = tmp_path / "__init__.py"
    init.write_text('__version__ = "0.1.0"\n', encoding="utf-8")
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text('[project]\nversion = "0.1.0"\n', encoding="utf-8")
    appx = tmp_path / "AppxManifest.xml"
    appx.write_text(
        '<Identity Version="0.1.0.0" />\n'
        '<TargetDeviceFamily MaxVersionTested="10.0.22631.0" />\n',
        encoding="utf-8",
    )

    monkeypatch.setattr(bump_version, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(bump_version, "INIT_PATH", init)
    monkeypatch.setattr(bump_version, "PYPROJECT_PATH", pyproject)
    monkeypatch.setattr(bump_version, "APPX_PATH", appx)

    bump_version.apply_version("0.2.0", dry_run=True)
    assert '0.1.0' in init.read_text(encoding="utf-8")  # unchanged


def test_apply_version_writes_all_files(tmp_path, monkeypatch) -> None:
    init = tmp_path / "__init__.py"
    init.write_text('__version__ = "0.1.0"\n', encoding="utf-8")
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text('[project]\nversion = "0.1.0"\n', encoding="utf-8")
    appx = tmp_path / "AppxManifest.xml"
    appx.write_text(
        '<Identity Version="0.1.0.0" />\n'
        '<TargetDeviceFamily MaxVersionTested="10.0.22631.0" />\n',
        encoding="utf-8",
    )

    monkeypatch.setattr(bump_version, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(bump_version, "INIT_PATH", init)
    monkeypatch.setattr(bump_version, "PYPROJECT_PATH", pyproject)
    monkeypatch.setattr(bump_version, "APPX_PATH", appx)

    bump_version.apply_version("0.2.0")
    assert '__version__ = "0.2.0"' in init.read_text(encoding="utf-8")
    assert 'version = "0.2.0"' in pyproject.read_text(encoding="utf-8")
    appx_text = appx.read_text(encoding="utf-8")
    assert 'Version="0.2.0.0"' in appx_text
    # The MaxVersionTested attribute must be left untouched.
    assert 'MaxVersionTested="10.0.22631.0"' in appx_text
