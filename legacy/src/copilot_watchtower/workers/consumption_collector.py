"""Background worker that collects Power Platform consumption snapshots.

Mirrors :class:`EdiscoveryCollectorWorker`: a :class:`QObject` moved onto a
:class:`QThread`. Instead of minting a standalone delegated token for the
unofficial Power Platform Licensing audience (which expired independently and
forced a re-login), it drives a real Power Platform Admin Center sign-in with
headless Chromium and reuses the licensing bearer token the admin-center SPA
already acquires (see :mod:`..services.consumption_browser_download`). That
token authorises the real PPAC licensing endpoints (``CurrencyReports`` and
``TenantCapacity``), whose JSON snapshots are parsed and upserted into
``power_platform_consumption``.

The licensing API is unofficial and may break without notice — failures are
surfaced through the ``error``/``log_line`` signals rather than swallowed.
"""
from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime, timedelta

from PySide6.QtCore import QObject, Signal

from ..db import Repository
from ..i18n import translate
from ..security import unprotect
from ..services.consumption_browser_download import (
    CapturedTokenProvider,
    ConsumptionBrowserError,
    capture_licensing_token,
)
from ..services.licensing import LicensingClient, LicensingError

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class ConsumptionCollectorWorker(QObject):
    """Downloads Power Platform consumption reports for the tenant."""

    cycle_started = Signal(str)            # trigger
    cycle_finished = Signal(int, int)      # rows_added, errors
    progress = Signal(str, str)            # status, message
    log_line = Signal(str)
    error = Signal(str)

    def __init__(
        self,
        repo: Repository,
        *,
        window_days: int = 180,
        trigger: str = "manual",
    ) -> None:
        super().__init__()
        self.repo = repo
        self.window_days = max(int(window_days), 1)
        self.trigger = trigger
        self._should_stop = False

    def request_stop(self) -> None:
        self._should_stop = True

    # ----------------------------------------------------------------

    def run(self) -> None:
        self.cycle_started.emit(self.trigger)
        rows_added = 0
        errors = 0
        client: LicensingClient | None = None
        try:
            client = self._build_client()
            if client is None:
                errors = 1
                return

            end = datetime.now(UTC).date()
            start = end - timedelta(days=self.window_days)
            start_s = start.isoformat()
            end_s = end.isoformat()

            # Each source is fetched independently so one failure (e.g. a
            # permission gap on capacity) does not hide the others' data.
            sources = (
                (translate("worker.consumption.sourceCurrency"), client.fetch_currency_rows),
                (translate("worker.consumption.sourceStorage"), client.fetch_capacity_rows),
                (translate("worker.consumption.sourceMcsResource"), client.fetch_mcs_resource_rows),
                (translate("worker.consumption.sourceMcsEnvironment"), client.fetch_mcs_environment_rows),
                (translate("worker.consumption.sourceMcsUser"), client.fetch_mcs_user_rows),
            )
            for label, fetch in sources:
                if self._should_stop:
                    self.log_line.emit(translate("worker.stoppedByUserRequest"))
                    break
                self.progress.emit("running", translate("worker.consumption.sourceCollecting", label=label))
                try:
                    rows = fetch(start_s, end_s)
                    written = self.repo.upsert_consumption_rows(rows)
                    rows_added += written
                    self.log_line.emit(translate("worker.consumption.sourceSaved", label=label, count=written))
                except LicensingError as exc:
                    errors += 1
                    log.warning("consumption %s failed: %s", label, exc)
                    detail = str(exc.detail).strip() if exc.detail else ""
                    status = f"HTTP {exc.status}" if exc.status else translate("worker.errorLabel")
                    suffix = f": {detail}" if detail else ""
                    self.log_line.emit(translate("worker.consumption.sourceFailed", label=label, status=status, suffix=suffix))

            if errors and rows_added == 0:
                self.progress.emit("error", translate("worker.consumption.fetchFailed"))
            else:
                self.progress.emit("done", translate("worker.doneSaved", count=rows_added))
        except ConsumptionBrowserError as exc:
            errors = 1
            log.warning("consumption browser sign-in failed: %s", exc)
            self.error.emit(translate("worker.consumption.browserLoginFailed", error=exc))
            self.progress.emit("error", translate("worker.consumption.browserLoginRequired"))
        except Exception as exc:  # noqa: BLE001 - surface any failure to UI
            errors = 1
            log.exception("Consumption collection aborted: %r", exc)
            self.error.emit(translate("worker.consumption.aborted", error=exc))
            self.progress.emit("error", translate("worker.consumption.failed"))
        finally:
            if client is not None:
                with contextlib.suppress(Exception):
                    client.close()
            self.cycle_finished.emit(rows_added, errors)

    # ----------------------------------------------------------------

    def _build_client(self) -> LicensingClient | None:
        tenant_id = self.repo.get_text_setting("tenant_id")
        if not tenant_id:
            self.error.emit(translate("worker.consumption.noTenant"))
            return None

        user = (
            self.repo.get_text_setting("ediscovery_browser_user")
            or self.repo.get_text_setting("exo_delegated_user")
            or ""
        )
        password_blob = self.repo.get_secret(
            "ediscovery_browser_password"
        ) or self.repo.get_secret("exo_delegated_password")
        if not user or password_blob is None:
            self.error.emit(translate("worker.consumption.noBrowserAccount"))
            return None
        password = str(unprotect(password_blob))

        # Drive a real PPAC sign-in and reuse the licensing token the admin
        # center SPA mints — no standalone delegated token to expire.
        token = capture_licensing_token(
            username=user,
            password=password,
            on_log=self.log_line.emit,
        )
        provider = CapturedTokenProvider(token)
        return LicensingClient(provider, tenant_id, timeout=120.0)
