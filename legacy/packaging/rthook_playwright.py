"""PyInstaller runtime hook: point Playwright at the bundled browsers.

A frozen build ships Chromium under ``<bundle>/ms-playwright``. Without
this hook Playwright would look in ``%LOCALAPPDATA%\\ms-playwright`` on the
target machine, which does not exist on a clean PC. We set
``PLAYWRIGHT_BROWSERS_PATH`` to the bundled copy unless the user has
explicitly overridden it.
"""
from __future__ import annotations

import os
import sys

_meipass = getattr(sys, "_MEIPASS", None)
if _meipass:
    bundled = os.path.join(_meipass, "ms-playwright")
    if os.path.isdir(bundled) and not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = bundled
