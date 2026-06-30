"""Entrypoint smoke tests for the web-only shell."""
from __future__ import annotations

from pathlib import Path

from copilot_watchtower import app as app_module
from copilot_watchtower.config import AppPaths


def test_web_shell_is_only_option(monkeypatch) -> None:
    # Whatever flags the launcher passes, the shell is always the web one.
    for argv in (
        ["copilot-watchtower"],
        ["copilot-watchtower", "--web"],
        ["copilot-watchtower", "--web-shell"],
        ["copilot-watchtower", "--legacy-ui"],
    ):
        monkeypatch.setattr(app_module, "sys", _StubSys(argv))
        assert app_module._wants_web_shell() is True


class _StubSys:
    """Drop-in replacement for the ``sys`` module's argv attribute."""

    def __init__(self, argv: list[str]) -> None:
        self.argv = argv


def test_app_paths_resolve_uses_localappdata_when_not_packaged(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr("copilot_watchtower.config._current_package_family_name", lambda: None)

    paths = AppPaths.resolve()

    assert paths.root == tmp_path / "CopilotWatchTower"
    assert paths.root.exists()


def test_app_paths_resolve_uses_msix_localcache_when_packaged(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(
        "copilot_watchtower.config._current_package_family_name",
        lambda: "CopilotWatchTower.Dev_123abc",
    )

    paths = AppPaths.resolve()

    assert paths.root == (
        tmp_path / "Packages" / "CopilotWatchTower.Dev_123abc" / "LocalCache" / "Local" / "CopilotWatchTower"
    )
    assert paths.root.exists()
