"""Entrypoint smoke tests for the web-only shell."""
from __future__ import annotations

from copilot_watchtower import app as app_module


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
