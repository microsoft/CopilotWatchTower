"""Drive a Microsoft Purview eDiscovery collection for a single user.

This orchestrator runs the end-to-end pipeline against the *new*
eDiscovery experience using Graph delegated auth (which works on
non-premium tenants):

    create/reuse case -> add search (scoped to the target mailbox)
    -> estimate statistics -> export results -> download package
    -> parse into interaction turns

It is deliberately Qt-free so it can be unit-tested in isolation and
re-used by the :class:`EdiscoveryCollectorWorker`. Progress is surfaced
through an optional ``on_progress`` callback and cooperative cancellation
through ``should_stop``. The supplied :class:`EdiscoveryJob` is mutated
and persisted as the pipeline advances so an interrupted run can be
inspected (and, later, resumed).
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from ..db import EdiscoveryJob, InteractionRow, Repository
from ..i18n import translate
from ..services.graph import GraphClient, GraphError
from . import ediscovery_export

log = logging.getLogger(__name__)

DEFAULT_CASE_NAME = "CopilotWatchTower"

# Terminal long-running-operation states reported by Graph.
_TERMINAL = {"succeeded", "failed", "partiallysucceeded"}

ProgressCb = Callable[[str, str], None]
StopCb = Callable[[], bool]
BrowserDownloadCb = Callable[[str], bytes | None]


class EdiscoveryError(Exception):
    """Raised when the eDiscovery pipeline cannot proceed."""


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_copilot_content_query(
    window_start: str | None, window_end: str | None
) -> str:
    """Build a KeyQL content query for Copilot items in a date range.

    Copilot prompts/responses for both licensed and unlicensed users are
    journaled into the user's mailbox, so a mailbox search constrained by
    date returns the conversation bodies. The item-class clause narrows
    to Copilot-generated conversation items; it is intentionally broad
    because the exact stored class varies across Copilot surfaces.
    """
    clauses: list[str] = []
    date_clause = _date_clause(window_start, window_end)
    if date_clause:
        clauses.append(date_clause)
    # Copilot interaction items. These ItemClass values cover the Copilot
    # surfaces whose prompts/responses are journaled into the mailbox
    # (Copilot chat, connected/cloud AI apps, and Teams Copilot).
    clauses.append(
        "(ItemClass:IPM.SkypeTeams.Message.Copilot.*) "
        "OR (ItemClass:IPM.SkypeTeams.Message.ConnectedAIApp*) "
        "OR (ItemClass:IPM.SkypeTeams.Message.CloudAIApp*) "
        "OR (ItemClass:IPM.SkypeTeams.Message.TeamCopilot*) "
        "OR (ItemClass:IPM.SkypeTeams.TeamCopilot*)"
    )
    return " AND ".join(f"({c})" for c in clauses)


def _date_clause(window_start: str | None, window_end: str | None) -> str:
    start = _date_only(window_start)
    end = _date_only(window_end)
    if start and end:
        return f"(received>={start} AND received<={end})"
    if start:
        return f"received>={start}"
    if end:
        return f"received<={end}"
    return ""


def _date_only(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip()
    return text.split("T", 1)[0] if "T" in text else text


def _human_size(num_bytes: int) -> str:
    """Format a byte count as a short human-readable string (e.g. ``1.2 MB``)."""
    size = float(max(0, num_bytes))
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _is_direct_download_proxy(url: str) -> bool:
    """True for the browser-interactive eDiscovery direct-download proxy URL.

    These URLs (``*.proxyservice.ediscovery.svc.cloud.microsoft/.../
    exportaedblobFileResult(...)``) redirect to an interactive ``id_token``
    sign-in and reject bearer tokens with ``401``; they cannot be downloaded
    programmatically.
    """
    low = (url or "").lower()
    return "proxyservice.ediscovery" in low or "exportaedblobfileresult" in low


def _direct_download_proxy_payload(url: str) -> dict[str, Any]:
    match = re.search(r"exportaedblobFileResult\(([^)]+)\)", url or "", flags=re.IGNORECASE)
    if not match:
        return {}
    raw = match.group(1)
    try:
        padded = raw + "=" * (-len(raw) % 4)
        return json.loads(base64.b64decode(padded).decode("utf-8", errors="replace"))
    except Exception:  # noqa: BLE001
        return {}


def _is_reports_download_url(url: str) -> bool:
    payload = _direct_download_proxy_payload(url)
    file_name = str(payload.get("FileName") or payload.get("fileName") or "").lower()
    return file_name.startswith("reports-")


def _human_duration(seconds: float) -> str:
    """Format a short ETA like ``5초`` / ``2분 3초`` / ``1시간 4분``."""
    secs = int(max(0, seconds))
    if secs < 60:
        return translate("duration.seconds", secs=secs)
    minutes, secs = divmod(secs, 60)
    if minutes < 60:
        return translate("duration.minutesSeconds", minutes=minutes, secs=secs)
    hours, minutes = divmod(minutes, 60)
    return translate("duration.hoursMinutes", hours=hours, minutes=minutes)


def _download_progress_text(
    done: int,
    total: int,
    *,
    rate_bps: float = 0.0,
    eta_seconds: float | None = None,
) -> str:
    """Build a download progress line with percentage, speed, and ETA.

    ``done``/``total`` are byte counts (``total`` may be ``0`` when the server
    does not advertise a size). ``rate_bps`` is the current throughput in
    bytes/second; ``eta_seconds`` is the estimated remaining time.
    """
    parts: list[str]
    if total > 0:
        pct = min(100, int(done * 100 / total))
        parts = [
            translate(
                "ediscovery.downloadProgress",
                done=_human_size(done),
                total=_human_size(total),
                pct=pct,
            )
        ]
    else:
        parts = [translate("ediscovery.downloadProgressNoTotal", done=_human_size(done))]
    if rate_bps > 0:
        parts.append(f"{_human_size(int(rate_bps))}/s")
    if eta_seconds is not None and eta_seconds > 0:
        parts.append(translate("ediscovery.eta", duration=_human_duration(eta_seconds)))
    return " · ".join(parts)


class EdiscoveryOrchestrator:
    """Runs the eDiscovery pipeline for one target user."""

    def __init__(
        self,
        graph: GraphClient,
        repo: Repository,
        *,
        case_name: str = DEFAULT_CASE_NAME,
        on_progress: ProgressCb | None = None,
        should_stop: StopCb | None = None,
        browser_downloader: BrowserDownloadCb | None = None,
        poll_seconds: float = 15.0,
        max_poll_seconds: float = 21600.0,
    ) -> None:
        self._graph = graph
        self._repo = repo
        self._case_name = case_name
        self._on_progress = on_progress
        self._should_stop = should_stop or (lambda: False)
        self._browser_downloader = browser_downloader
        self._poll_seconds = poll_seconds
        self._max_poll_seconds = max_poll_seconds
        self._reexported = False

    # -- helpers ------------------------------------------------------

    def _progress(self, status: str, message: str) -> None:
        if self._on_progress is not None:
            try:
                self._on_progress(status, message)
            except Exception:  # noqa: BLE001
                log.debug("eDiscovery progress callback failed", exc_info=True)

    def _stop_requested(self) -> bool:
        try:
            return bool(self._should_stop())
        except Exception:  # noqa: BLE001
            return False

    def _save(self, job: EdiscoveryJob, status: str | None = None) -> None:
        if status is not None:
            job.status = status
        job.updated_at = _now_iso()
        self._repo.upsert_ediscovery_job(job)

    def _fail(self, job: EdiscoveryJob, message: str) -> None:
        job.last_error = message
        job.last_error_at = _now_iso()
        self._save(job, "error")

    def _poll_operation(self, job: EdiscoveryJob, operation_url: str, label: str) -> dict[str, Any]:
        # eDiscovery estimate/export run server-side and report no percentage,
        # so without an elapsed-time/attempt counter the UI looks frozen on a
        # repeated "running" line. Surface both so the user can see progress.
        labels = {
            "Estimate": translate("ediscovery.phaseEstimate"),
            "Export": translate("ediscovery.phaseExport"),
        }
        ko_label = labels.get(label, label)
        started = time.monotonic()
        attempt = 0
        deadline = started + self._max_poll_seconds
        while True:
            if self._stop_requested():
                raise EdiscoveryError(f"{label} cancelled by user")
            attempt += 1
            payload = self._graph.get_ediscovery_operation(operation_url)
            status = (payload.get("status") or "").lower()
            elapsed = time.monotonic() - started
            self._progress(
                job.status,
                translate(
                    "ediscovery.pollRunning",
                    label=ko_label,
                    elapsed=_human_duration(elapsed),
                    status=status or "running",
                    attempt=attempt,
                ),
            )
            if status in _TERMINAL:
                if status == "failed":
                    raise EdiscoveryError(
                        f"{label} failed: {payload.get('statusDetail') or payload}"
                    )
                self._progress(
                    job.status,
                    translate(
                        "ediscovery.pollDone",
                        label=ko_label,
                        elapsed=_human_duration(elapsed),
                    ),
                )
                return payload
            if time.monotonic() >= deadline:
                raise EdiscoveryError(f"{label} timed out after {self._max_poll_seconds:.0f}s")
            time.sleep(self._poll_seconds)

    # -- pipeline -----------------------------------------------------

    def run(self, job: EdiscoveryJob) -> list[InteractionRow]:
        """Execute the full pipeline, returning parsed interaction rows.

        The job is persisted at each stage. Raises :class:`EdiscoveryError`
        on failure (after recording the error on the job).
        """
        try:
            return self._run(job)
        except EdiscoveryError as exc:
            self._fail(job, str(exc))
            raise
        except GraphError as exc:
            self._fail(job, f"Graph error: {exc}")
            raise EdiscoveryError(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            self._fail(job, f"Unexpected error: {exc}")
            raise EdiscoveryError(str(exc)) from exc

    def _run(self, job: EdiscoveryJob) -> list[InteractionRow]:
        """Resumable pipeline driven by the job's persisted artifacts.

        eDiscovery estimate/export are long-running (minutes to hours) and a
        run may be interrupted (app closed, cancelled, timed out) or end in an
        ``error`` status after a transient failure. Because the job persists
        ``case_id``/``search_id``/``operation_url``/``export_url`` at every
        stage, a re-invocation reconnects to the most advanced stage that has
        a persisted artifact — regardless of the recorded ``status`` — instead
        of restarting the expensive export from scratch:

        * ``export_url`` present        -> download & parse
        * ``operation_url`` present     -> resume in-flight export poll
        * ``search_id`` present         -> estimate + export
        * ``case_id`` present           -> ensure search, then continue
        * nothing persisted             -> full (re)build from preflight
        """
        if not job.target_upn:
            raise EdiscoveryError("target_upn is required")

        # Guard against re-export loops: a stale Azure Blob SAS link may 401 and
        # justify exactly one re-export, but the interactive proxy link 401s
        # every time, so we only ever re-export once per run.
        self._reexported = False

        # Resume points (most advanced first), keyed off persisted artifacts
        # so a job left in "error" still continues rather than restarting.
        if job.export_url:
            if _is_reports_download_url(job.export_url) and job.operation_url:
                self._progress(
                    "downloading",
                    translate("ediscovery.reselectItemsPackage"),
                )
                final = self._graph.get_ediscovery_operation(job.operation_url)
                return self._finish_export(job, final)
            self._progress(job.status or "downloading", "Resuming from download stage")
            return self._download_and_parse(job)
        if job.operation_url:
            self._progress("exporting", "Resuming in-flight export")
            final = self._poll_operation(job, job.operation_url, "Export")
            return self._finish_export(job, final)

        # Earlier stages: build/reuse case + search, then estimate + export.
        # _ensure_case / _ensure_search no-op when their ids are already set.
        if not job.case_id:
            self._progress("preflight", "Checking eDiscovery permissions")
            self._graph.preflight_ediscovery()
        self._ensure_case(job)
        self._ensure_search(job)
        self._estimate(job)
        return self._start_export(job)

    # -- pipeline stages ---------------------------------------------

    def _case_display_name(self, job: EdiscoveryJob) -> str:
        """Per-target, per-window, per-run case name.

        Each distinct collection gets its own eDiscovery case instead of
        piling every search/data source into one shared per-user case. The
        name embeds:

        * the target UPN and collection window, and
        * a timestamp derived from ``job.created_at``

        The ``created_at`` timestamp is what guarantees a *fresh* case per
        collection: re-collecting the same window after the local job row was
        cleared produces a new job (new ``created_at``) → new case name →
        :meth:`GraphClient.find_ediscovery_case` no longer matches the old
        cloud case. ``created_at`` is fixed for the lifetime of a single job,
        so a re-run/resume of the *same* job reuses the same name (and, via
        the persisted ``job.case_id``, the same case).
        """
        target = (job.target_upn or "").strip() or "all"
        alias = target.split("@", 1)[0] or "all"
        window = self._window_label(job)
        stamp = self._run_stamp(job)
        return f"{self._case_name} - {alias} {window} @{stamp}"

    @staticmethod
    def _window_label(job: EdiscoveryJob) -> str:
        start = _date_only(job.window_start) or "open"
        end = _date_only(job.window_end) or "open"
        return f"[{start}~{end}]"

    @staticmethod
    def _run_stamp(job: EdiscoveryJob) -> str:
        """Readable, stable-per-job timestamp used to keep case names unique.

        Derived from ``job.created_at`` (e.g. ``2026-05-30T06:16:34Z`` →
        ``20260530-061634``). Falls back to the job id when the timestamp is
        missing or unparseable so the name is still unique.
        """
        raw = (job.created_at or "").strip()
        if raw:
            digits = re.sub(r"[^0-9]", "", raw.split("+", 1)[0])
            if len(digits) >= 14:
                return f"{digits[:8]}-{digits[8:14]}"
            if digits:
                return digits
        return (job.id or "job")[:12]

    def _ensure_case(self, job: EdiscoveryJob) -> None:
        # A job that already bound a case (e.g. interrupted after the case
        # stage) keeps using it — even if the case-naming convention changed
        # between runs — so we never orphan an in-flight case.
        if job.case_id:
            self._progress("case", f"Reusing eDiscovery case '{job.case_id}'")
            return
        case_name = self._case_display_name(job)
        self._progress("case", f"Creating eDiscovery case '{case_name}'")
        case = self._graph.create_ediscovery_case(
            case_name,
            description="Auto-created by CopilotWatchTower for Copilot interaction collection.",
        )
        job.case_id = str(case.get("id") or "")
        if not job.case_id:
            raise EdiscoveryError("Failed to obtain eDiscovery case id")
        self._save(job, "case")
        if self._stop_requested():
            raise EdiscoveryError("Cancelled before search creation")

    def _ensure_search(self, job: EdiscoveryJob) -> None:
        # Reuse a search bound on a prior (interrupted) run so we never
        # re-create the search — and its non-custodial data sources — for a
        # case that already has them (which fails with 409 Conflict).
        if job.search_id:
            self._progress("searching", f"Reusing eDiscovery search '{job.search_id}'")
            return
        self._progress("searching", f"Adding search for {job.target_upn}")
        content_query = build_copilot_content_query(job.window_start, job.window_end)
        search = self._graph.add_ediscovery_search(
            job.case_id,
            display_name=f"Copilot-{job.target_upn}-{job.id[:8]}",
            content_query=content_query,
            mailbox_emails=[job.target_upn],
        )
        job.search_id = str(search.get("id") or "")
        if not job.search_id:
            raise EdiscoveryError("Failed to obtain eDiscovery search id")
        self._save(job, "searching")

    def _estimate(self, job: EdiscoveryJob) -> None:
        self._progress("searching", "Estimating search statistics")
        est = self._graph.estimate_ediscovery_search(job.case_id, job.search_id)
        est_op = est.get("operation_location")
        if est_op:
            self._poll_operation(job, est_op, "Estimate")
        if self._stop_requested():
            raise EdiscoveryError("Cancelled before export")

    def _start_export(self, job: EdiscoveryJob) -> list[InteractionRow]:
        self._progress("exporting", "Starting export")
        export = self._graph.export_ediscovery_search(
            job.case_id,
            job.search_id,
            display_name=f"Export-{job.target_upn}-{job.id[:8]}",
        )
        export_op = export.get("operation_location")
        if not export_op:
            raise EdiscoveryError("Export did not return an operation location")
        job.operation_url = export_op
        self._save(job, "exporting")
        final = self._poll_operation(job, export_op, "Export")
        return self._finish_export(job, final)

    def _finish_export(self, job: EdiscoveryJob, final: dict[str, Any]) -> list[InteractionRow]:
        # Diagnostic: the eDiscovery export operation returns several possible
        # download shapes. The "IsDirectDownloadProxy" proxy URL requires an
        # interactive browser sign-in and rejects our bearer (401), so we must
        # prefer an Azure Blob SAS path when Graph offers one. Log which keys
        # are present so we can see exactly what this tenant returned.
        try:
            top_keys = sorted(k for k in final if not k.startswith("@"))
            meta = final.get("exportFileMetadata")
            meta_keys: list[str] = []
            if isinstance(meta, list) and meta and isinstance(meta[0], dict):
                meta_keys = sorted(meta[0].keys())
            log.info(
                "Export operation payload keys=%s exportFileMetadata[0] keys=%s",
                top_keys,
                meta_keys,
            )
        except Exception:  # noqa: BLE001 - diagnostics must never break the run
            pass
        download_url, is_proxy = self._extract_download_url(final)
        if not download_url:
            raise EdiscoveryError("Export completed but no download URL was returned")
        if is_proxy:
            # The only URL Graph gave us is the browser-interactive proxy link.
            # Our token-based download cannot use it, and re-exporting just
            # produces another identical proxy link, so surface a clear,
            # actionable error instead of looping.
            log.warning("Export only returned an interactive proxy URL: %s", download_url)
        job.export_url = download_url
        self._save(job, "downloading")
        return self._download_and_parse(job)

    def _download_and_parse(self, job: EdiscoveryJob) -> list[InteractionRow]:
        if not job.export_url:
            raise EdiscoveryError("No export download URL available to resume from")
        self._save(job, "downloading")
        self._progress("downloading", translate("ediscovery.downloadStart"))

        # Direct-download proxy URLs are browser/OIDC oriented. In this tenant
        # they consistently reject access-token download attempts, so do not
        # waste time on backend token candidates; go straight to the unattended
        # Playwright download capture path. Blob/SAS and other programmatic
        # URLs still use the HTTP downloader below.
        if _is_direct_download_proxy(job.export_url):
            rows = self._browser_download_fallback(job, reason="direct_proxy")
            if rows is not None:
                return rows
            raise EdiscoveryError(translate("ediscovery.directProxyFailed"))

        # Export packages can be hundreds of MB, so surface a live progress
        # line (percentage + speed + ETA). graph.py throttles to ~1 MiB, but
        # we additionally collapse to whole-percent steps so the UI log/bar
        # updates smoothly without flooding the panel on large downloads.
        dl_state = {"start": time.monotonic(), "last_pct": -1, "last_emit": 0.0}

        def _on_download(done: int, total: int) -> None:
            now = time.monotonic()
            elapsed = now - dl_state["start"]
            rate = done / elapsed if elapsed > 0 else 0.0
            eta = (total - done) / rate if (total > 0 and rate > 0) else None
            if total > 0:
                pct = min(100, int(done * 100 / total))
                # Emit on each new whole-percent step (always emit the final).
                if pct == dl_state["last_pct"] and done < total:
                    return
                dl_state["last_pct"] = pct
            else:
                # Unknown size: time-throttle to at most ~2/sec.
                if now - dl_state["last_emit"] < 0.5:
                    return
                dl_state["last_emit"] = now
            self._progress(
                "downloading",
                _download_progress_text(done, total, rate_bps=rate, eta_seconds=eta),
            )

        try:
            data = self._graph.download_ediscovery_export(
                job.export_url,
                on_progress=_on_download,
            )
        except GraphError as exc:
            if getattr(exc, "auth_redirect", False):
                rows = self._browser_download_fallback(job, reason="auth_redirect")
                if rows is not None:
                    return rows
                raise EdiscoveryError(
                    translate("ediscovery.proxyInteractiveOnly")
                ) from exc
            # Export download URLs are short-lived Azure Blob SAS links. When a
            # resume happens after the link has expired the storage front door
            # returns 401/403/404. Re-downloading the same dead URL would loop
            # forever, so drop the stale export pointers and re-run the export
            # (the case/search are still bound, so this is cheap to retry).
            #
            # BUT the eDiscovery *direct-download proxy* URL
            # (IsDirectDownloadProxy) rejects our bearer with 401 on every
            # attempt because it requires an interactive browser sign-in.
            # Re-exporting just mints another identical proxy link, so we must
            # NOT loop — stop with a clear, actionable error instead.
            if _is_direct_download_proxy(job.export_url):
                rows = self._browser_download_fallback(job, reason="auth_redirect")
                if rows is not None:
                    return rows
                raise EdiscoveryError(
                    translate("ediscovery.proxyBackendRejected")
                ) from exc
            if (
                exc.status in (401, 403, 404)
                and job.case_id
                and job.search_id
                and not self._reexported
            ):
                self._reexported = True
                log.info(
                    "Export download URL expired (status=%s); re-running export.",
                    exc.status,
                )
                self._progress("exporting", translate("ediscovery.linkExpiredReexport"))
                job.export_url = None
                job.operation_url = None
                self._save(job, "exporting")
                return self._start_export(job)
            raise

        self._progress(
            "parsing",
            translate("ediscovery.downloadDoneParsing", size=_human_size(len(data))),
        )
        return self._parse_package(job, data)

    def _browser_download_fallback(
        self,
        job: EdiscoveryJob,
        *,
        reason: str,
    ) -> list[InteractionRow] | None:
        if self._browser_downloader is None or not job.export_url:
            return None
        if reason == "direct_proxy":
            message = translate("ediscovery.proxyAutoLoginDirect")
        else:
            message = translate("ediscovery.proxyAutoLoginRetry")
        self._progress(
            "downloading",
            message,
        )
        data = self._browser_downloader(job.export_url)
        if not data:
            raise EdiscoveryError(translate("ediscovery.browserAutoDownloadFailed"))
        self._progress(
            "parsing",
            translate(
                "ediscovery.browserDownloadDoneParsing", size=_human_size(len(data))
            ),
        )
        return self._parse_package(job, data)

    def _parse_package(self, job: EdiscoveryJob, data: bytes) -> list[InteractionRow]:
        self._save(job, "parsing")
        items = ediscovery_export.parse_export_bytes(
            data,
            on_progress=lambda line: self._progress("parsing", line),
        )
        user_id = job.target_user_id or job.target_upn
        rows = ediscovery_export.items_to_interaction_rows(items, user_id=user_id)
        self._progress(
            "parsing",
            translate("ediscovery.parseDone", items=len(items), rows=len(rows)),
        )
        return rows

    @staticmethod
    def _extract_download_url(payload: dict[str, Any]) -> tuple[str | None, bool]:
        """Pull a download URL out of a completed export operation payload.

        Returns ``(url, is_proxy)`` where ``is_proxy`` is ``True`` when the
        only available URL is the browser-interactive *direct download proxy*
        (``nam.proxyservice.ediscovery.svc.cloud.microsoft/...exportaedblobFileResult``).
        That proxy redirects to an interactive ``id_token`` sign-in and
        rejects bearer tokens with ``401``, so it cannot be used by our
        token-based downloader — callers must handle it specially.

        We therefore *prefer* a programmatic Azure Blob SAS link
        (``azureBlobUrl``/``azureBlobToken`` or ``azureBlobContainer``) over
        the proxy URL, and only fall back to the proxy when nothing else is
        offered.
        """
        # 1) Programmatic Azure Blob SAS (preferred — works with no bearer).
        blob = payload.get("azureBlobUrl") or payload.get("azureBlobContainer")
        if blob:
            token = payload.get("azureBlobToken") or payload.get("azureBlobSasToken")
            if token:
                sep = "&" if "?" in str(blob) else "?"
                return f"{blob}{sep}{str(token).lstrip('?&')}", False
            return str(blob), False
        # 2) A bare programmatic downloadUrl at the top level.
        if payload.get("downloadUrl"):
            url = str(payload["downloadUrl"])
            return url, _is_direct_download_proxy(url)
        # 3) Per-file metadata. These downloadUrls are usually the interactive
        #    proxy links, so flag them as such.
        meta = payload.get("exportFileMetadata")
        if isinstance(meta, list):
            entries = [entry for entry in meta if isinstance(entry, dict) and entry.get("downloadUrl")]

            def _rank(entry: dict[str, Any]) -> tuple[int, int]:
                name = str(entry.get("fileName") or entry.get("filename") or "").lower()
                size = int(entry.get("size") or 0)
                # Reports-* ZIPs contain only export reports/manifest CSVs. The
                # actual evidence payload is normally Items*.zip and is much
                # larger. Pick that first so the parser receives MSG/EML/JSON
                # content instead of only Items_*.csv metadata.
                if name.startswith("items"):
                    return (0, -size)
                if name.startswith("reports"):
                    return (2, -size)
                return (1, -size)

            for entry in sorted(entries, key=_rank):
                if isinstance(entry, dict) and entry.get("downloadUrl"):
                    url = str(entry["downloadUrl"])
                    return url, _is_direct_download_proxy(url)
        return None, False
