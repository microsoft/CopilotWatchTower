"""Action controller for the web shell.

The PySide WebShellWindow owns this object. The Bridge calls into it to
start/stop collectors and to mutate profile/settings state, while the
Bridge listens to its signals and re-emits them as JSON events for the
embedded React app.

Splitting it out of ``Bridge`` keeps QWebChannel-facing surface narrow
(only ``@Slot`` methods and signals) and makes the controller testable
without QWebEngine.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from PySide6.QtCore import QObject, Qt, Signal, Slot

from ..config import DELEGATED_BOOTSTRAP_SCOPES, RuntimeOptions
from ..db import Repository
from ..profiles import ProfileRegistry
from ..security import unprotect
from ..services import (
    AppOnlyTokenProvider,
    AppRegistrar,
    DelegatedAuthExpiredError,
    DelegatedDeviceCodeTokenProvider,
    GraphClient,
    delegated_token_cache_path,
)
from ..services.ediscovery import _is_direct_download_proxy
from ..workers import (
    AuditCollectorWorker,
    CollectorThread,
    CollectorWorker,
    EdiscoveryCollectorWorker,
    new_job_id,
)

log = logging.getLogger(__name__)

CONVERSATION_KIND = "conversation"
EDISCOVERY_KIND = "ediscovery"
_AUDIT_KINDS = ("audit", "usage", "diagnostics")
_ALL_KINDS = (CONVERSATION_KIND, *_AUDIT_KINDS)


@dataclass
class _RunningJob:
    kind: str
    thread: CollectorThread
    graph: GraphClient | None
    started_at: str


class OperationsController(QObject):
    """Owns collector threads and exposes high-level operations."""

    event = Signal(str)  # JSON string {"type": ..., "payload": ...}
    state_changed = Signal()
    profile_switch_requested = Signal(str)
    profile_add_requested = Signal(str)
    system_dialog_requested = Signal(str)  # "settings" | "permissions_upgrade" | "factory_reset"
    _event_proxy = Signal(str)  # private cross-thread marshal

    def __init__(
        self,
        repo: Repository,
        options: RuntimeOptions,
        registry: ProfileRegistry | None,
        profile_id: str | None,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self.repo = repo
        self.options = options
        self.registry = registry
        self.profile_id = profile_id
        self._jobs: dict[str, _RunningJob] = {}
        # Worker-thread callbacks (Python lambdas) can not target a QObject
        # slot, so PySide6 ignores QueuedConnection and runs them in the
        # worker thread. We route every event through a QueuedConnection
        # proxy slot so the public ``event`` signal is always emitted from
        # this controller's (main) thread — which is what QWebChannel
        # needs to forward it to the embedded JS.
        self._event_proxy.connect(self._on_event_proxy, Qt.QueuedConnection)

    @Slot(str)
    def _on_event_proxy(self, payload: str) -> None:
        log.debug("bridge.event -> %s", payload[:200])
        self.event.emit(payload)

    def emit_test_event(self) -> None:
        self._emit_event(
            "diagnostics",
            {"kind": "system", "line": "⛯ test event 수신 확인"},
        )

    # ---- collection -------------------------------------------------

    def start_collection(self, kind: str, *, trigger: str = "manual") -> dict:
        if kind not in _ALL_KINDS:
            raise ValueError(f"Unknown collection kind: {kind}")
        if kind in self._jobs:
            return {"ok": False, "error": f"이미 진행 중입니다: {kind}"}

        token_provider = self._build_token_provider()
        if token_provider is None:
            return {"ok": False, "error": "앱 등록이 완료되지 않아 토큰을 만들 수 없습니다."}
        graph = GraphClient(token_provider)

        if kind == CONVERSATION_KIND:
            worker = CollectorWorker(self.repo, graph, self.options, trigger=trigger)
            self._connect_conversation_worker(worker)
        else:
            worker = AuditCollectorWorker(self.repo, graph, trigger=trigger, data_kind=kind)
            self._connect_audit_worker(worker, kind=kind)

        thread = CollectorThread(worker, parent=self)
        thread.finished.connect(graph.close)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(lambda k=kind: self._on_job_finished(k))

        self._jobs[kind] = _RunningJob(kind=kind, thread=thread, graph=graph, started_at=_now_iso())
        self.state_changed.emit()
        self._emit_event("collection.started", {"kind": kind, "trigger": trigger})
        thread.start()
        return {"ok": True, "kind": kind}

    def stop_collection(self, kind: str) -> dict:
        job = self._jobs.get(kind)
        if job is None:
            return {"ok": False, "error": f"실행 중인 작업이 없습니다: {kind}"}
        try:
            job.thread.worker.request_stop()
        except Exception:
            log.exception("Failed to request stop for %s", kind)
            return {"ok": False, "error": "중단 요청 중 오류가 발생했습니다."}
        self._emit_event("collection.stop_requested", {"kind": kind})
        return {"ok": True, "kind": kind}

    def collection_status(self) -> dict:
        return {
            "running": [
                {"kind": kind, "started_at": job.started_at}
                for kind, job in self._jobs.items()
            ]
        }

    # ---- eDiscovery collection (single user, delegated) -------------

    def start_ediscovery_collection(
        self,
        target_upn: str,
        *,
        window_start: str | None = None,
        window_end: str | None = None,
        trigger: str = "manual",
        job_id: str | None = None,
    ) -> dict:
        target_upn = (target_upn or "").strip()
        if not target_upn:
            return {"ok": False, "error": "대상 사용자(UPN)를 입력하세요."}

        # Each collection is its own row. A new run mints a fresh id; a resume
        # reuses the supplied job_id so it continues that exact row instead of
        # forking a duplicate. Running jobs are tracked per job_id, so the same
        # UPN can have several independent (and independently resumable) runs.
        resume = bool((job_id or "").strip())
        job_id = (job_id or "").strip() or new_job_id(target_upn, window_start, window_end)
        job_key = f"{EDISCOVERY_KIND}:{job_id}"
        if job_key in self._jobs:
            return {"ok": False, "error": f"이미 진행 중입니다: {target_upn}"}

        worker = EdiscoveryCollectorWorker(
            self.repo,
            target_upn,
            window_start=window_start,
            window_end=window_end,
            trigger=trigger,
            job_id=job_id,
        )
        self._connect_ediscovery_worker(worker, target_upn=target_upn)

        thread = CollectorThread(worker, parent=self)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(lambda k=job_key: self._on_job_finished(k))

        self._jobs[job_key] = _RunningJob(
            kind=job_key, thread=thread, graph=None, started_at=_now_iso()
        )
        self.state_changed.emit()
        self._emit_event(
            "collection.started",
            {
                "kind": EDISCOVERY_KIND,
                "job_id": job_id,
                "target_upn": target_upn,
                "window_start": window_start,
                "window_end": window_end,
                "trigger": trigger,
                "resume": resume,
            },
        )
        thread.start()
        return {"ok": True, "kind": EDISCOVERY_KIND, "job_id": job_id, "target_upn": target_upn}

    def stop_ediscovery_collection(self, job_id: str) -> dict:
        job_key = f"{EDISCOVERY_KIND}:{(job_id or '').strip()}"
        return self.stop_collection(job_key)

    def ediscovery_status(self) -> dict:
        jobs = self.repo.list_ediscovery_jobs(limit=50)
        running_ids = {
            kind.split(":", 1)[1]
            for kind in self._jobs
            if kind.startswith(f"{EDISCOVERY_KIND}:")
        }
        return {
            "jobs": [
                {
                    "id": j.id,
                    "target_upn": j.target_upn,
                    "status": j.status,
                    "window_start": j.window_start,
                    "window_end": j.window_end,
                    "interactions_added": j.interactions_added,
                    "last_error": j.last_error,
                    "updated_at": j.updated_at,
                    "running": j.id in running_ids,
                    "export_url": j.export_url,
                    "needs_manual_download": (
                        j.id not in running_ids
                        and bool(j.export_url)
                        and _is_direct_download_proxy(j.export_url)
                    ),
                }
                for j in jobs
            ]
        }

    def ediscovery_download_url(self, job_id: str) -> dict:
        """Return the (browser-only) download URL for a completed export.

        The eDiscovery *direct download proxy* URL requires an interactive
        browser session, so the UI opens it in the system browser where the
        operator is already signed in. The bridge performs the actual open.
        """
        job_id = (job_id or "").strip()
        job = self.repo.get_ediscovery_job(job_id) if job_id else None
        if job is None:
            return {"ok": False, "error": "작업을 찾을 수 없습니다."}
        if not job.export_url:
            return {"ok": False, "error": "다운로드 링크가 아직 없습니다."}
        return {"ok": True, "url": job.export_url, "target_upn": job.target_upn}

    def import_ediscovery_export(self, job_id: str, file_path: str) -> dict:
        """Ingest a manually-downloaded export ZIP into an existing job.

        Runs the same parse/store/threading path as a normal collection but
        from a local file instead of the Graph download.
        """
        job_id = (job_id or "").strip()
        file_path = (file_path or "").strip()
        if not file_path:
            return {"ok": False, "error": "가져올 파일을 선택하세요."}
        job = self.repo.get_ediscovery_job(job_id) if job_id else None
        if job is None:
            return {"ok": False, "error": "작업을 찾을 수 없습니다."}

        job_key = f"{EDISCOVERY_KIND}:{job_id}"
        if job_key in self._jobs:
            return {"ok": False, "error": f"이미 진행 중입니다: {job.target_upn}"}

        worker = EdiscoveryCollectorWorker(
            self.repo,
            job.target_upn,
            window_start=job.window_start,
            window_end=job.window_end,
            trigger="import",
            job_id=job_id,
            import_path=file_path,
        )
        self._connect_ediscovery_worker(worker, target_upn=job.target_upn)

        thread = CollectorThread(worker, parent=self)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(lambda k=job_key: self._on_job_finished(k))

        self._jobs[job_key] = _RunningJob(
            kind=job_key, thread=thread, graph=None, started_at=_now_iso()
        )
        self.state_changed.emit()
        self._emit_event(
            "collection.started",
            {
                "kind": EDISCOVERY_KIND,
                "job_id": job_id,
                "target_upn": job.target_upn,
                "trigger": "import",
                "import_path": file_path,
            },
        )
        thread.start()
        return {"ok": True, "kind": EDISCOVERY_KIND, "job_id": job_id, "target_upn": job.target_upn}

    def stop_all(self, *, wait_ms: int = 0) -> None:
        for kind, job in list(self._jobs.items()):
            try:
                if job.thread.isRunning():
                    job.thread.worker.request_stop()
                    if wait_ms:
                        job.thread.wait(wait_ms)
            except RuntimeError:
                self._jobs.pop(kind, None)

    # ---- profiles ---------------------------------------------------

    def switch_profile(self, profile_id: str) -> dict:
        if self.registry is None:
            return {"ok": False, "error": "프로필 레지스트리가 연결되지 않았습니다."}
        if self.registry.get(profile_id) is None:
            return {"ok": False, "error": "알 수 없는 프로필 ID 입니다."}
        if profile_id == self.profile_id:
            return {"ok": True, "noop": True}
        self.profile_switch_requested.emit(profile_id)
        return {"ok": True, "switching_to": profile_id}

    def add_profile(self, name: str) -> dict:
        if self.registry is None:
            return {"ok": False, "error": "프로필 레지스트리가 연결되지 않았습니다."}
        name = (name or "").strip() or "새 테넌트"
        self.profile_add_requested.emit(name)
        return {"ok": True, "requested_name": name}

    def remove_profile(self, profile_id: str, *, delete_data: bool = True) -> dict:
        if self.registry is None:
            return {"ok": False, "error": "프로필 레지스트리가 연결되지 않았습니다."}
        if profile_id == self.profile_id:
            return {"ok": False, "error": "현재 사용 중인 프로필은 삭제할 수 없습니다."}
        if self.registry.get(profile_id) is None:
            return {"ok": False, "error": "알 수 없는 프로필 ID 입니다."}
        app_cleanup = self._delete_profile_app_registration(profile_id) if delete_data else {
            "ok": True,
            "app_deleted": None,
            "app_delete_skipped": "delete_data_false",
        }
        if not app_cleanup.get("ok"):
            return app_cleanup
        self.registry.remove(profile_id, delete_data=delete_data)
        payload = {"profile_id": profile_id, **app_cleanup}
        payload.pop("ok", None)
        self._emit_event("profile.removed", payload)
        return {"ok": True, **payload}

    def _delete_profile_app_registration(self, profile_id: str) -> dict:
        assert self.registry is not None
        db_path = self.registry.profile_db_path(profile_id)
        if not db_path.exists():
            return {"ok": True, "app_deleted": None, "app_delete_skipped": "profile_db_missing"}

        profile_repo = Repository(db_path)
        try:
            tenant_id = profile_repo.get_text_setting("tenant_id")
            client_id = profile_repo.get_text_setting("client_id")
            app_object_id = profile_repo.get_text_setting("app_object_id")
        except Exception as exc:  # noqa: BLE001
            log.exception("Failed to read profile settings before delete: %s", profile_id)
            return {"ok": False, "error": f"프로필 설정을 읽을 수 없습니다: {exc}"}

        if not tenant_id or not client_id:
            return {"ok": True, "app_deleted": None, "app_delete_skipped": "app_not_configured"}

        cache_path = delegated_token_cache_path(db_path.parent, tenant_id)
        try:
            provider = DelegatedDeviceCodeTokenProvider(
                tenant_id,
                DELEGATED_BOOTSTRAP_SCOPES,
                cache_path=cache_path,
                allow_device_code=False,
            )
            token = provider.acquire()
        except DelegatedAuthExpiredError as exc:
            return {
                "ok": False,
                "error": (
                    "Entra 앱을 삭제할 관리자 로그인 캐시가 만료되었습니다. "
                    "해당 프로필로 전환한 뒤 권한 재등록 또는 완전 초기화를 먼저 실행하세요."
                ),
                "detail": str(exc),
            }
        except Exception as exc:  # noqa: BLE001
            log.exception("Failed to acquire delegated token for profile app delete: %s", profile_id)
            return {"ok": False, "error": f"Entra 앱 삭제 인증 실패: {exc}"}

        try:
            with AppRegistrar(token, tenant_id) as registrar:
                object_id = app_object_id
                if not object_id:
                    try:
                        object_id = registrar.find_application_object_id(client_id)
                    except LookupError:
                        return {"ok": True, "app_deleted": False, "app_was_present": False}
                deleted = registrar.delete_application(object_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("Failed to delete app registration for profile: %s", profile_id)
            return {"ok": False, "error": f"Entra 앱 삭제 실패: {exc}"}

        return {
            "ok": True,
            "app_deleted": bool(deleted),
            "app_was_present": bool(deleted),
            "app_id": client_id,
        }

    # ---- settings ---------------------------------------------------

    def update_settings(self, payload: dict) -> dict:
        try:
            poll = int(payload.get("poll_interval_minutes", self.options.poll_interval_minutes))
        except (TypeError, ValueError):
            return {"ok": False, "error": "poll_interval_minutes는 정수여야 합니다."}
        if poll < 1:
            return {"ok": False, "error": "poll_interval_minutes는 1 이상이어야 합니다."}

        scope_mode = str(payload.get("scope_mode") or self.options.scope_mode).upper()
        scope_group_id = payload.get("scope_group_id")
        if scope_group_id is not None:
            scope_group_id = str(scope_group_id).strip() or None
        scope_upns_raw = payload.get("scope_upns")
        if scope_upns_raw is None:
            scope_upns = list(self.options.scope_upns)
        elif isinstance(scope_upns_raw, list):
            scope_upns = [str(x).strip() for x in scope_upns_raw if str(x).strip()]
        else:
            return {"ok": False, "error": "scope_upns는 문자열 리스트여야 합니다."}
        language = str(payload.get("language") or self.options.language)

        self.options = RuntimeOptions(
            poll_interval_minutes=poll,
            scope_mode=scope_mode,
            scope_group_id=scope_group_id,
            scope_upns=scope_upns,
            language=language,
        )
        self.repo.set_text_setting("poll_interval_minutes", str(poll))
        self.repo.set_text_setting("scope_mode", scope_mode)
        if scope_group_id:
            self.repo.set_text_setting("scope_group_id", scope_group_id)
        self.repo.set_text_setting("scope_upns", json.dumps(scope_upns))
        self.repo.set_text_setting("language", language)
        self._emit_event("settings.updated", {"poll_interval_minutes": poll, "scope_mode": scope_mode})
        return {"ok": True}

    # ---- system dialogs --------------------------------------------

    _ALLOWED_DIALOGS = ("settings", "permissions_upgrade", "factory_reset")

    def open_system_dialog(self, kind: str) -> dict:
        if kind not in self._ALLOWED_DIALOGS:
            return {"ok": False, "error": f"알 수 없는 다이얼로그: {kind}"}
        self.system_dialog_requested.emit(kind)
        return {"ok": True, "kind": kind}

    # ---- internals --------------------------------------------------

    def _connect_conversation_worker(self, worker: CollectorWorker) -> None:
        # Connect to *real* @Slot methods. Lambdas do not give Qt a QObject
        # receiver, so cross-thread QueuedConnection is unreliable in PySide6.
        worker.log_line.connect(self._on_conv_log, Qt.QueuedConnection)
        worker.error.connect(self._on_conv_error, Qt.QueuedConnection)
        worker.progress.connect(self._on_conv_progress, Qt.QueuedConnection)
        worker.user_progress.connect(self._on_conv_user_progress, Qt.QueuedConnection)
        worker.cycle_started.connect(self._on_conv_cycle_started, Qt.QueuedConnection)
        worker.cycle_finished.connect(self._on_conv_cycle_finished, Qt.QueuedConnection)

    def _connect_audit_worker(self, worker: AuditCollectorWorker, *, kind: str) -> None:
        worker.log_line.connect(
            lambda line, k=kind: self._emit_event("log", {"kind": k, "line": line})
        )
        worker.error.connect(
            lambda line, k=kind: self._emit_event("error", {"kind": k, "line": line})
        )
        worker.audit_progress.connect(
            lambda source, fetched, k=kind: self._emit_event(
                "audit_progress", {"kind": k, "source": source, "fetched": int(fetched)}
            )
        )
        worker.cycle_started.connect(
            lambda label, k=kind: self._emit_event("cycle_started", {"kind": k, "label": label})
        )
        worker.cycle_finished.connect(
            lambda label, audit_events, usage_rows, diagnostics, errors, k=kind: self._emit_event(
                "cycle_finished",
                {
                    "kind": k,
                    "label": label,
                    "audit_events": int(audit_events),
                    "usage_rows": int(usage_rows),
                    "diagnostics": int(diagnostics),
                    "errors": int(errors),
                },
            )
        )

    def _connect_ediscovery_worker(
        self, worker: EdiscoveryCollectorWorker, *, target_upn: str
    ) -> None:
        worker.log_line.connect(
            lambda line, u=target_upn: self._emit_event(
                "log", {"kind": EDISCOVERY_KIND, "target_upn": u, "line": line}
            )
        )
        worker.error.connect(
            lambda line, u=target_upn: self._emit_event(
                "error", {"kind": EDISCOVERY_KIND, "target_upn": u, "line": line}
            )
        )
        worker.progress.connect(
            lambda status, message, u=target_upn: self._emit_event(
                "ediscovery_progress",
                {"kind": EDISCOVERY_KIND, "target_upn": u, "status": status, "message": message},
            )
        )
        worker.cycle_started.connect(
            lambda u: self._emit_event(
                "cycle_started", {"kind": EDISCOVERY_KIND, "target_upn": u}
            )
        )
        worker.cycle_finished.connect(
            lambda u, added, errors: self._emit_event(
                "cycle_finished",
                {
                    "kind": EDISCOVERY_KIND,
                    "target_upn": u,
                    "interactions": int(added),
                    "errors": int(errors),
                },
            )
        )

    # Conversation worker slots --------------------------------------
    @Slot(str)
    def _on_conv_log(self, line: str) -> None:
        self._emit_event("log", {"kind": CONVERSATION_KIND, "line": line})

    @Slot(str)
    def _on_conv_error(self, line: str) -> None:
        self._emit_event("error", {"kind": CONVERSATION_KIND, "line": line})

    @Slot(str, int)
    def _on_conv_progress(self, message: str, percent: int) -> None:
        self._emit_event(
            "progress",
            {"kind": CONVERSATION_KIND, "message": message, "percent": int(percent)},
        )

    @Slot(str, str, int)
    def _on_conv_user_progress(self, user_id: str, display: str, fetched: int) -> None:
        self._emit_event(
            "user_progress",
            {
                "kind": CONVERSATION_KIND,
                "user_id": user_id,
                "display": display,
                "fetched": int(fetched),
            },
        )

    @Slot(int, str)
    def _on_conv_cycle_started(self, run_id: int, trigger: str) -> None:
        self._emit_event(
            "cycle_started",
            {"kind": CONVERSATION_KIND, "run_id": int(run_id), "trigger": trigger},
        )

    @Slot(int, int, int, int)
    def _on_conv_cycle_finished(self, run_id: int, users: int, interactions: int, errors: int) -> None:
        self._emit_event(
            "cycle_finished",
            {
                "kind": CONVERSATION_KIND,
                "run_id": int(run_id),
                "users": int(users),
                "interactions": int(interactions),
                "errors": int(errors),
            },
        )

    def _on_job_finished(self, kind: str) -> None:
        self._jobs.pop(kind, None)
        self.state_changed.emit()
        self._emit_event("collection.finished", {"kind": kind})

    def _build_token_provider(self) -> AppOnlyTokenProvider | None:
        tenant_id = self.repo.get_text_setting("tenant_id")
        client_id = self.repo.get_text_setting("client_id")
        secret_blob = self.repo.get_secret("client_secret")
        if not tenant_id or not client_id or secret_blob is None:
            return None
        try:
            secret = unprotect(secret_blob)
        except Exception:
            log.exception("client secret 복호화 실패")
            return None
        return AppOnlyTokenProvider(tenant_id, client_id, secret)

    def _emit_event(self, kind: str, payload: dict) -> None:
        self._event_proxy.emit(
            json.dumps({"type": kind, "payload": payload, "at": _now_iso()}, ensure_ascii=False)
        )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
