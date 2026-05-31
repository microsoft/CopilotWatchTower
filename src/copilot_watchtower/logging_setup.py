"""Logging setup with a rotating file handler.

Logs go to `%LOCALAPPDATA%\\CopilotWatchTower\\logs\\app.log` with a
weekly rotation. INFO+ on disk, DEBUG+ on stderr when developing.
"""
from __future__ import annotations

import logging
import logging.handlers
import sys

from .config import AppPaths


def configure_logging(paths: AppPaths, verbose: bool = False) -> None:
    root = logging.getLogger()
    if root.handlers:  # idempotent for tests
        return
    root.setLevel(logging.DEBUG if verbose else logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s :: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )

    file_handler = logging.handlers.TimedRotatingFileHandler(
        paths.log_dir / "app.log",
        when="W0",
        backupCount=8,
        encoding="utf-8",
        utc=True,
    )
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    audit_handler = logging.handlers.TimedRotatingFileHandler(
        paths.log_dir / "audit.log",
        when="W0",
        backupCount=26,
        encoding="utf-8",
        utc=True,
    )
    audit_handler.setLevel(logging.INFO)
    audit_handler.setFormatter(fmt)
    logging.getLogger("audit").addHandler(audit_handler)
    logging.getLogger("audit").propagate = False

    stream = logging.StreamHandler(sys.stderr)
    stream.setLevel(logging.DEBUG if verbose else logging.WARNING)
    stream.setFormatter(fmt)
    root.addHandler(stream)


def audit(message: str, **fields: object) -> None:
    """Emit a structured audit event (admin-relevant actions only)."""
    extras = " ".join(f"{k}={v!r}" for k, v in fields.items())
    logging.getLogger("audit").info("%s %s", message, extras)
