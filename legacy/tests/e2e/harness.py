"""Standalone web-shell harness for Playwright E2E tests.

Boots a ``QApplication`` + :class:`Bridge` + :class:`WebServer` against a
pre-seeded SQLite database in a dedicated process, writes the index URL
(including the session token) to ``--url-file``, then runs the Qt event loop
so RPC calls marshalled onto the main thread are actually serviced.

Running this in its own process is what makes real end-to-end testing
possible: the Playwright-driven browser hits the loopback server while the
Qt event loop here keeps spinning independently. The test fixture terminates
the process when done.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Make ``src/`` importable when launched as a bare script in a subprocess.
_SRC = Path(__file__).resolve().parents[2] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

# Headless Qt: no real display needed for the loopback server.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, help="Path to the seeded SQLite store")
    parser.add_argument("--url-file", required=True, help="Where to write the index URL")
    args = parser.parse_args()

    from PySide6.QtWidgets import QApplication

    from copilot_watchtower.app import _load_options
    from copilot_watchtower.db import Repository
    from copilot_watchtower.webshell.actions import OperationsController
    from copilot_watchtower.webshell.bridge import Bridge, BridgeContext
    from copilot_watchtower.webshell.server import WebServer

    app = QApplication([])
    repo = Repository(Path(args.db))
    options = _load_options(repo)
    controller = OperationsController(repo, options, None, None)
    bridge = Bridge(BridgeContext(repo=repo, options=options), controller)
    server = WebServer(bridge)
    url = server.start()
    Path(args.url_file).write_text(url, encoding="utf-8")
    try:
        return app.exec()
    finally:
        server.stop()


if __name__ == "__main__":
    raise SystemExit(main())
