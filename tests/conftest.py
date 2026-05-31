"""pytest configuration shared by all test modules."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Make the `src/` layout importable without installation for fast CI runs.
SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# Force a per-test scratch directory so AppPaths.resolve() does not touch
# the developer's real %LOCALAPPDATA% directory.
os.environ.setdefault("LOCALAPPDATA", str(Path(__file__).resolve().parent / "_tmp_localappdata"))
