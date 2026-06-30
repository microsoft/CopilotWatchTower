"""PyInstaller entry point.

Frozen builds invoke this script as a top-level module, which means it
cannot use relative imports. We dispatch into the real package via an
absolute import so that ``copilot_watchtower.__main__`` (and its own
relative imports) resolve correctly inside the bundle.
"""
from __future__ import annotations

import sys

from copilot_watchtower.app import run


if __name__ == "__main__":
    sys.exit(run())
