"""Background worker for one-shot maintenance tasks.

Backup creation, restore, and data export can each touch the whole
database, so they run off the UI thread. This generic worker wraps a
single callable that receives a ``progress(label, current, total)``
callback and returns a JSON-serialisable result dict.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from PySide6.QtCore import QObject, Signal

log = logging.getLogger(__name__)

TaskFn = Callable[[Callable[[str, int, int], None]], dict]


class MaintenanceWorker(QObject):
    """Runs a single maintenance callable and reports progress/result."""

    progress = Signal(str, int, int)  # label, current, total
    done = Signal(dict)               # result payload
    failed = Signal(str)              # error message

    def __init__(self, task: TaskFn, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._task = task

    def run(self) -> None:
        try:
            result = self._task(self._emit_progress)
        except Exception as exc:  # noqa: BLE001 — surface to UI, never crash
            log.exception("Maintenance task failed")
            self.failed.emit(str(exc))
            return
        self.done.emit(result)

    def _emit_progress(self, label: str, current: int, total: int) -> None:
        self.progress.emit(label, current, total)
