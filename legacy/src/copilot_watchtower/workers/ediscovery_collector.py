"""Background worker that runs an eDiscovery collection for one user.

Mirrors :class:`AuditCollectorWorker`: a :class:`QObject` moved onto a
:class:`QThread` that drives the :class:`EdiscoveryOrchestrator` pipeline,
emits Qt signals for the UI, ingests the resulting interaction turns, and
recomputes conversation threads so eDiscovery-sourced data renders
identically to license-based Copilot interactions.

eDiscovery requires *delegated* Graph auth (app-only is Premium-only), so
the worker always builds a :class:`DelegatedDeviceCodeTokenProvider` with
:data:`DELEGATED_EDISCOVERY_SCOPES` and surfaces the device-code prompt
through the ``error``/``log_line`` signals.
"""
from __future__ import annotations

import contextlib
import hashlib
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

from PySide6.QtCore import QObject, Signal

from ..config import DELEGATED_EDISCOVERY_SCOPES
from ..db import EdiscoveryJob, Repository, UserRow
from ..i18n import translate
from ..security import unprotect
from ..services import (
    DelegatedAuthExpiredError,
    DelegatedDeviceCodeTokenProvider,
    GraphClient,
    delegated_token_cache_path,
    ediscovery_export,
)
from ..services.ediscovery import EdiscoveryError, EdiscoveryOrchestrator, _human_size
from ..services.ediscovery_browser_download import BrowserDownloadError, download_with_playwright
from ..services.threading_service import recompute_threads_for_user

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_job_id(target_upn: str, window_start: str | None, window_end: str | None) -> str:
    """Legacy deterministic id (kept for backward-compatible lookups).

    No longer used to *create* jobs — every new collection now gets its own
    unique row via :func:`new_job_id` so that repeated collections of the same
    UPN/window are tracked (and resumable) independently.
    """
    key = f"{target_upn.strip().lower()}|{window_start or ''}|{window_end or ''}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


def new_job_id(target_upn: str, window_start: str | None, window_end: str | None) -> str:
    """Unique id for a brand-new collection run.

    Includes the UPN/window for readability/debuggability plus a random
    component so each collection start is a distinct row even when the
    UPN and window are identical to a previous run.
    """
    key = (
        f"{target_upn.strip().lower()}|{window_start or ''}|{window_end or ''}"
        f"|{uuid.uuid4().hex}"
    )
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


class EdiscoveryCollectorWorker(QObject):
    """Runs the eDiscovery pipeline for a single target user."""

    cycle_started = Signal(str)                  # target_upn
    cycle_finished = Signal(str, int, int)       # target_upn, interactions_added, errors
    progress = Signal(str, str)                  # status, message
    log_line = Signal(str)
    error = Signal(str)

    def __init__(
        self,
        repo: Repository,
        target_upn: str,
        *,
        window_start: str | None = None,
        window_end: str | None = None,
        trigger: str = "manual",
        job_id: str | None = None,
        import_path: str | None = None,
    ) -> None:
        super().__init__()
        self.repo = repo
        self.target_upn = target_upn.strip()
        self.window_start = window_start
        self.window_end = window_end
        self.trigger = trigger
        # When set, resume this exact job row instead of starting a new run.
        self.job_id = (job_id or "").strip() or None
        # When set, skip the Graph pipeline entirely and ingest this local ZIP
        # file (a manually-downloaded export package) instead.
        self.import_path = (import_path or "").strip() or None
        self._should_stop = False

    def request_stop(self) -> None:
        self._should_stop = True

    def _browser_download(self, url: str) -> bytes | None:
        user = (
            self.repo.get_text_setting("ediscovery_browser_user")
            or self.repo.get_text_setting("exo_delegated_user")
            or ""
        )
        password_blob = self.repo.get_secret("ediscovery_browser_password") or self.repo.get_secret(
            "exo_delegated_password"
        )
        if not user or password_blob is None:
            self.log_line.emit(translate("worker.ediscovery.noBrowserAccount"))
            return None
        password = str(unprotect(password_blob))
        self.log_line.emit(translate("worker.ediscovery.browserDownloadTry"))
        try:
            path = download_with_playwright(
                url,
                download_dir=self.repo.db_path.parent / "ediscovery" / "playwright_downloads",
                username=user,
                password=password,
            )
            self.log_line.emit(translate("worker.ediscovery.browserDownloadDone", name=path.name))
            return Path(path).read_bytes()
        except (BrowserDownloadError, OSError) as exc:
            log.warning("Headless browser eDiscovery download failed: %s", exc)
            self.log_line.emit(translate("worker.ediscovery.browserDownloadFailed", error=exc))
            return None

    # ----------------------------------------------------------------

    def run(self) -> None:
        if self.import_path:
            self._run_import()
            return
        self.cycle_started.emit(self.target_upn)
        added = 0
        errors = 0
        graph: GraphClient | None = None
        try:
            graph = self._build_delegated_graph()
            if graph is None:
                errors = 1
                return
            job = self._load_or_create_job()
            user = self._ensure_target_user(graph, job)
            orchestrator = EdiscoveryOrchestrator(
                graph,
                self.repo,
                on_progress=lambda status, message: self.progress.emit(status, message),
                should_stop=lambda: self._should_stop,
                browser_downloader=self._browser_download,
            )
            self.log_line.emit(translate("worker.ediscovery.collectionStart", target_upn=self.target_upn))
            resume_stages = {"case", "searching", "exporting", "downloading", "parsing"}
            if (job.status or "").lower() in resume_stages:
                self.log_line.emit(translate("worker.ediscovery.resumeStage", stage=job.status))
            rows = orchestrator.run(job)
            if rows:
                existing = self.repo.existing_interaction_ids(r.id for r in rows)
                self.repo.upsert_interactions(rows)
                added = len({r.id for r in rows if r.id not in existing})
                self.log_line.emit(translate("worker.ediscovery.interactionsSaved", added=added, total=len(rows)))
                self._recompute_threads_for_user(user)
            else:
                self.log_line.emit(translate("worker.ediscovery.noParsedInteractions"))
            job.interactions_added = added
            job.status = "done"
            job.updated_at = _now_iso()
            self.repo.upsert_ediscovery_job(job)
            self.progress.emit("done", translate("worker.ediscovery.doneAdded", count=added))
        except DelegatedAuthExpiredError as e:
            log.warning("eDiscovery delegated token expired: %s", e)
            errors = 1
            self._mark_job_auth_expired()
            self.error.emit(translate("worker.ediscovery.delegatedExpired"))
            self.progress.emit("error", translate("worker.ediscovery.delegatedExpiredShort"))
        except EdiscoveryError as e:
            log.warning("eDiscovery collection failed: %s", e)
            errors = 1
            self.error.emit(translate("worker.ediscovery.collectionFailed", error=e))
        except Exception as e:  # noqa: BLE001 — absolute backstop
            log.exception("eDiscovery collector aborted: %r", e)
            errors = 1
            with contextlib.suppress(Exception):
                self.error.emit(translate("worker.ediscovery.collectionAborted", error=e))
        finally:
            if graph is not None:
                with contextlib.suppress(Exception):
                    graph.close()
            self.cycle_finished.emit(self.target_upn, added, errors)

    # ----------------------------------------------------------------

    def _run_import(self) -> None:
        """Ingest a manually-downloaded export ZIP without touching Graph.

        Used as the escape hatch when Graph only hands back the
        browser-interactive *direct download proxy* URL (which our bearer
        cannot use): the user downloads the package in their browser, then
        points us at the local file here.
        """
        self.cycle_started.emit(self.target_upn)
        added = 0
        errors = 0
        try:
            path = Path(self.import_path or "")
            if not path.is_file():
                raise EdiscoveryError(translate("worker.ediscovery.importFileNotFound", path=self.import_path))
            job = self._load_or_create_job()
            user = self._ensure_target_user_offline(job)
            self.log_line.emit(translate("worker.ediscovery.importStart", name=path.name))
            self.progress.emit("parsing", translate("worker.ediscovery.importReading"))
            data = path.read_bytes()
            self.progress.emit(
                "parsing", translate("worker.ediscovery.fileLoaded", size=_human_size(len(data)))
            )
            items = ediscovery_export.parse_export_bytes(
                data,
                on_progress=lambda line: self.progress.emit("parsing", line),
            )
            user_id = job.target_user_id or job.target_upn
            rows = ediscovery_export.items_to_interaction_rows(items, user_id=user_id)
            if rows:
                existing = self.repo.existing_interaction_ids(r.id for r in rows)
                self.repo.upsert_interactions(rows)
                added = len({r.id for r in rows if r.id not in existing})
                self.log_line.emit(translate("worker.ediscovery.interactionsSaved", added=added, total=len(rows)))
                self._recompute_threads_for_user(user)
            else:
                self.log_line.emit(translate("worker.ediscovery.noParsedInteractions"))
            job.interactions_added = added
            job.status = "done"
            # The export package has been consumed; clear the (browser-only)
            # download pointer so the job no longer prompts for a manual import.
            job.export_url = None
            job.last_error = None
            job.last_error_at = None
            job.updated_at = _now_iso()
            self.repo.upsert_ediscovery_job(job)
            self.progress.emit("done", translate("worker.ediscovery.importDoneAdded", count=added))
        except EdiscoveryError as e:
            log.warning("eDiscovery import failed: %s", e)
            errors = 1
            self.error.emit(translate("worker.ediscovery.importFailed", error=e))
            self.progress.emit("error", str(e))
        except Exception as e:  # noqa: BLE001 — absolute backstop
            log.exception("eDiscovery import aborted: %r", e)
            errors = 1
            with contextlib.suppress(Exception):
                self.error.emit(translate("worker.ediscovery.importAborted", error=e))
        finally:
            self.cycle_finished.emit(self.target_upn, added, errors)

    # ----------------------------------------------------------------

    def _build_delegated_graph(self) -> GraphClient | None:
        tenant_id = self.repo.get_text_setting("tenant_id")
        if not tenant_id:
            self.error.emit(translate("worker.ediscovery.noTenant"))
            return None
        cache_path = delegated_token_cache_path(self.repo.db_path.parent, tenant_id)

        # Collection runs in the background, so we never pop an interactive
        # device-code prompt here. If the cached delegated token has expired,
        # acquire() raises DelegatedAuthExpiredError and run() tells the user
        # to re-register permissions (which re-seeds the token cache).
        provider = DelegatedDeviceCodeTokenProvider(
            tenant_id,
            DELEGATED_EDISCOVERY_SCOPES,
            cache_path=cache_path,
            allow_device_code=False,
        )
        return GraphClient(provider, timeout=120.0)

    def _load_or_create_job(self) -> EdiscoveryJob:
        now = _now_iso()
        # Resume path: a specific job id was supplied (e.g. the "재개" button).
        # Continue that exact row instead of forking a new collection.
        if self.job_id:
            existing = self.repo.get_ediscovery_job(self.job_id)
            if existing is not None:
                # Preserve an in-flight stage so the orchestrator resumes the
                # long-running export/download instead of restarting. Only
                # terminal/idle states fall back to a fresh "pending" run.
                resumable = {"case", "searching", "exporting", "downloading", "parsing"}
                if (existing.status or "").lower() not in resumable:
                    existing.status = "pending"
                existing.last_error = None
                existing.last_error_at = None
                existing.updated_at = now
                self.repo.upsert_ediscovery_job(existing)
                return existing
            log.warning(
                "Resume requested for unknown eDiscovery job %s; starting fresh.",
                self.job_id,
            )

        # New collection: always a brand-new row, even for the same UPN/window,
        # so each run is tracked and resumable independently.
        job_id = self.job_id or new_job_id(
            self.target_upn, self.window_start, self.window_end
        )
        job = EdiscoveryJob(
            id=job_id,
            target_upn=self.target_upn,
            target_user_id=None,
            window_start=self.window_start,
            window_end=self.window_end,
            status="pending",
            case_id=None,
            search_id=None,
            operation_url=None,
            export_url=None,
            interactions_added=0,
            last_error=None,
            last_error_at=None,
            created_at=now,
            updated_at=now,
        )
        self.repo.upsert_ediscovery_job(job)
        return job

    def _mark_job_auth_expired(self) -> None:
        """Record the auth-expiry on the job row so it shows in history.

        Best-effort: the auth failure happens before the normal job-create
        path, so we load-or-create the row and stamp an error status.
        """
        try:
            job = self._load_or_create_job()
            job.status = "error"
            job.last_error = translate("worker.ediscovery.authExpiredJobError")
            job.last_error_at = _now_iso()
            job.updated_at = _now_iso()
            self.repo.upsert_ediscovery_job(job)
        except Exception:  # noqa: BLE001 — never mask the original error
            log.exception("Failed to record eDiscovery auth-expiry on job row")

    def _ensure_target_user(self, graph: GraphClient, job: EdiscoveryJob) -> UserRow:
        """Resolve the target user and persist a minimal user record.

        Unlicensed users are not part of the normal collection scope, so
        we create/refresh a row here (out of scope, no license) so the
        threads and UI can attribute the collected interactions.
        """
        resolved = None
        try:
            resolved = graph.resolve_user_by_upn(self.target_upn)
        except Exception:  # noqa: BLE001
            log.debug("resolve_user_by_upn failed for %s", self.target_upn, exc_info=True)
        if resolved is not None:
            user_id = resolved.id
            display = resolved.display_name
            upn = resolved.upn or self.target_upn
            enabled = resolved.enabled
        else:
            user_id = self.target_upn
            display = None
            upn = self.target_upn
            enabled = True
        row = UserRow(
            id=user_id,
            upn=upn,
            display_name=display,
            enabled=enabled,
            has_copilot_license=False,
            in_scope=False,
        )
        self.repo.upsert_users([row])
        job.target_user_id = user_id
        self.repo.upsert_ediscovery_job(job)
        return row

    def _ensure_target_user_offline(self, job: EdiscoveryJob) -> UserRow:
        """Resolve the target user without Graph (for local ZIP imports).

        Reuses the id already bound to the job when present (e.g. resolved by
        an earlier collection attempt), otherwise falls back to the UPN so the
        ingested interactions are still attributable in the UI/threads.
        """
        user_id = job.target_user_id or self.target_upn
        row = UserRow(
            id=user_id,
            upn=self.target_upn,
            display_name=None,
            enabled=True,
            has_copilot_license=False,
            in_scope=False,
        )
        self.repo.upsert_users([row])
        job.target_user_id = user_id
        self.repo.upsert_ediscovery_job(job)
        return row

    def _recompute_threads_for_user(self, user: UserRow) -> None:
        recompute_threads_for_user(self.repo, user, source_type="ediscovery")
