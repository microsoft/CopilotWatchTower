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

import logging
from datetime import datetime, timedelta, timezone

from PySide6.QtCore import QObject, Signal

from ..db import Repository
from ..security import unprotect
from ..services.consumption_browser_download import (
    CapturedTokenProvider,
    ConsumptionBrowserError,
    capture_licensing_token,
)
from ..services.licensing import LicensingClient, LicensingError

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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

            end = datetime.now(timezone.utc).date()
            start = end - timedelta(days=self.window_days)
            start_s = start.isoformat()
            end_s = end.isoformat()

            # Each source is fetched independently so one failure (e.g. a
            # permission gap on capacity) does not hide the others' data.
            sources = (
                ("통화 리포트", client.fetch_currency_rows),
                ("스토리지 용량", client.fetch_capacity_rows),
                ("에이전트(리소스)별 메시지", client.fetch_mcs_resource_rows),
                ("환경별 메시지", client.fetch_mcs_environment_rows),
            )
            for label, fetch in sources:
                if self._should_stop:
                    self.log_line.emit("○ 사용자 요청으로 중단되었습니다.")
                    break
                self.progress.emit("running", f"{label} 수집 중…")
                try:
                    rows = fetch(start_s, end_s)
                    written = self.repo.upsert_consumption_rows(rows)
                    rows_added += written
                    self.log_line.emit(f"⛁ {label}: {written}건 저장")
                except LicensingError as exc:
                    errors += 1
                    log.warning("consumption %s failed: %s", label, exc)
                    detail = str(exc.detail).strip() if exc.detail else ""
                    status = f"HTTP {exc.status}" if exc.status else "오류"
                    suffix = f": {detail}" if detail else ""
                    self.log_line.emit(f"⚠ {label} 수집 실패 ({status}){suffix}")

            if errors and rows_added == 0:
                self.progress.emit("error", "소비량 데이터를 가져오지 못했습니다.")
            else:
                self.progress.emit("done", f"완료: {rows_added}건 저장")
        except ConsumptionBrowserError as exc:
            errors = 1
            log.warning("consumption browser sign-in failed: %s", exc)
            self.error.emit(f"소비량 수집 브라우저 로그인 실패: {exc}")
            self.progress.emit("error", "PPAC 브라우저 로그인이 필요합니다.")
        except Exception as exc:  # noqa: BLE001 - surface any failure to UI
            errors = 1
            log.exception("Consumption collection aborted: %r", exc)
            self.error.emit(f"소비량 수집 중 오류가 발생했습니다: {exc}")
            self.progress.emit("error", "소비량 수집 실패")
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            self.cycle_finished.emit(rows_added, errors)

    # ----------------------------------------------------------------

    def _build_client(self) -> LicensingClient | None:
        tenant_id = self.repo.get_text_setting("tenant_id")
        if not tenant_id:
            self.error.emit("소비량 수집: 테넌트 ID가 없어 라이선싱 API에 연결할 수 없습니다.")
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
            self.error.emit(
                "소비량 수집: PPAC 자동 로그인 계정이 저장되어 있지 않습니다. "
                "설정에서 브라우저 로그인 계정을 등록하세요."
            )
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
