"""Web-based UI shell for CopilotWatchTower.

This package contains the experimental web shell that hosts the new UI
inside a ``QWebEngineView``. Python remains the only process: the
``Bridge`` object exposes Repository data to the embedded web app via
``QWebChannel``. No network listener is opened.
"""
from __future__ import annotations

from .bridge import Bridge
from .window import WebShellWindow

__all__ = ["Bridge", "WebShellWindow"]
