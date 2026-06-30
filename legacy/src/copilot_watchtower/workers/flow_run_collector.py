"""Background worker that collects Power Automate / Copilot Studio flow runs.

Mirrors :class:`DataverseCollectorWorker`: a :class:`QObject` moved onto a
:class:`QThread`. Reads the Dataverse ``flowrun`` table — the freshest signal
for *autonomous / scheduled* agents that run with no human in the loop (and so
leave no useful conversation transcript and only show up in the lagged billing
snapshot hours later). Run **counts** are a leading indicator of spend, not the
billed credits themselves; the UI labels them accordingly.

The ``flowrun`` table is *elastic* with a short TTL, so this collection should
run frequently inside that window. Collection is incremental on ``createdon``.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from PySide6.QtCore import QObject, Signal

from ..config import FLOW_RUN_DEFAULT_WINDOW_DAYS
from ..db import Repository
from ..i18n import translate
from ..services.dataverse import DataverseError
from ..services.dataverse_browser_download import DataverseBrowserError
from ..services.flow_runs import FLOW_RUN_SELECT, parse_flow_run_rows
from .dataverse_session import (
    DataverseSession,
    DataverseSessionError,
    build_dataverse_session,
)

log = logging.getLogger(__name__)


class FlowRunCollectorWorker(QObject):
    """Collects flow-run execution history from Dataverse."""

    cycle_started = Signal(str)            # trigger
    cycle_finished = Signal(int, int)      # rows_added, errors
    progress = Signal(str, str)            # status, message
    log_line = Signal(str)
    error = Signal(str)

    def __init__(
        self,
        repo: Repository,
        *,
        window_days: int = FLOW_RUN_DEFAULT_WINDOW_DAYS,
        add_self_as_admin: bool = False,
        trigger: str = "manual",
    ) -> None:
        super().__init__()
        self.repo = repo
        self.window_days = max(int(window_days), 1)
        self.add_self_as_admin = bool(add_self_as_admin)
        self.trigger = trigger
        self._should_stop = False

    def request_stop(self) -> None:
        self._should_stop = True

    def run(self) -> None:
        self.cycle_started.emit(self.trigger)
        rows_added = 0
        errors = 0
        session: DataverseSession | None = None
        try:
            session = build_dataverse_session(
                self.repo,
                on_log=self.log_line.emit,
                add_self_as_admin=self.add_self_as_admin,
            )
            self.progress.emit("running", translate("worker.flowRun.querying"))
            since = self._window_start()
            environments = session.queryable_environments()
            for env in environments:
                if self._should_stop:
                    self.log_line.emit(translate("worker.stoppedByUserRequest"))
                    break
                label = env.friendly_name or env.url
                self.progress.emit(
                    "running", translate("worker.flowRun.envCollecting", label=label)
                )
                try:
                    records = session.client.fetch_entity_rows(
                        env,
                        "flowruns",
                        select=FLOW_RUN_SELECT,
                        filter=f"createdon gt {since}",
                        orderby="createdon desc",
                        include_formatted=True,
                        max_pages=50,
                    )
                except DataverseError as exc:
                    errors += 1
                    log.warning("flowrun env %s failed: %s", env.url, exc)
                    self.log_line.emit(
                        translate(
                            "worker.flowRun.envFailed", label=label, error=self._fmt(exc)
                        )
                    )
                    continue
                rows = parse_flow_run_rows(
                    records, environment_id=env.id, environment_name=env.friendly_name
                )
                if not rows:
                    self.log_line.emit(translate("worker.flowRun.noRuns", label=label))
                    continue
                existing = self.repo.existing_flow_run_ids(r.id for r in rows)
                self.repo.upsert_flow_runs(rows)
                written = len({r.id for r in rows if r.id not in existing})
                rows_added += written
                self.log_line.emit(
                    translate(
                        "worker.flowRun.envSaved",
                        label=label,
                        written=written,
                        total=len(rows),
                    )
                )
            self.progress.emit("done", translate("worker.doneSaved", count=rows_added))
        except DataverseSessionError as exc:
            errors = 1
            self.error.emit(str(exc))
            self.progress.emit("error", translate("worker.dataverse.makerLoginRequired"))
        except DataverseBrowserError as exc:
            errors = 1
            log.warning("flowrun browser sign-in failed: %s", exc)
            self.error.emit(translate("worker.flowRun.browserLoginFailed", error=exc))
            self.progress.emit("error", translate("worker.dataverse.makerLoginRequired"))
        except Exception as exc:  # noqa: BLE001 - surface any failure to UI
            errors = 1
            log.exception("Flow-run collection aborted: %r", exc)
            self.error.emit(translate("worker.flowRun.aborted", error=exc))
            self.progress.emit("error", translate("worker.dataverse.failed"))
        finally:
            if session is not None:
                session.close()
            self.cycle_finished.emit(rows_added, errors)

    # ----------------------------------------------------------------

    @staticmethod
    def _fmt(exc: DataverseError) -> str:
        detail = str(exc.detail).strip() if exc.detail else ""
        status = f"HTTP {exc.status}" if exc.status else translate("worker.errorLabel")
        return f"{status}: {detail}" if detail else status

    def _window_start(self) -> str:
        start = datetime.now(UTC) - timedelta(days=self.window_days)
        return start.strftime("%Y-%m-%dT%H:%M:%SZ")
