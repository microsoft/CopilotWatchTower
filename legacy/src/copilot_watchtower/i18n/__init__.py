"""i18n package.

All runtime translation goes through the **backend message catalog** in
:mod:`copilot_watchtower.i18n.messages`, which provides :func:`translate`
plus the process-wide active-language state. Services, workers, the web
bridge, and the PySide6 bootstrap dialogs all render their user-facing
strings through it. The React web UI has its own react-i18next resources
under ``web/src/i18n``.
"""
from __future__ import annotations

from .messages import (
    MESSAGES,
    get_active_language,
    set_active_language,
    translate,
)

__all__ = [
    "MESSAGES",
    "get_active_language",
    "set_active_language",
    "translate",
]
