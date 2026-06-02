"""Python ↔ JS bridge exposed to the embedded web shell via QWebChannel.

Every slot returns a JSON string so the JS side gets a predictable
serialised payload regardless of Qt's metatype coverage. Filters are
also accepted as JSON strings to keep the surface small and stable.

The bridge intentionally has no HTTP listener — all communication runs
inside the host process through QWebChannel.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from PySide6.QtCore import QObject, Signal, Slot

from .. import __app_name__, __version__
from ..app_labels import display_app_name
from ..config import RuntimeOptions
from ..db import Repository
from ..export.backup import BUNDLE_SUFFIX
from ..profiles import ProfileRegistry
from .actions import OperationsController

log = logging.getLogger(__name__)

_THREAD_TURN_BODY_LIMIT = 2000
_GUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
_NON_HUMAN_LABELS = {"microsoft365 copilot", "microsoft 365 copilot"}


@dataclass(frozen=True)
class BridgeContext:
    """Read-only context the shell hands to the bridge.

    Keeping it explicit avoids the bridge reaching into shell internals
    and makes test setup obvious.
    """

    repo: Repository
    registry: ProfileRegistry | None = None
    profile_id: str | None = None
    options: RuntimeOptions | None = None


class Bridge(QObject):
    """QWebChannel-exposed facade over Repository analytics helpers."""

    log_message = Signal(str)
    bridge_event = Signal(str)  # JSON push channel for live updates

    def __init__(
        self,
        context: BridgeContext,
        controller: OperationsController | None = None,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._context = context
        self._controller = controller
        if controller is not None:
            # Chain signal-to-signal so PySide6 marshals correctly even though
            # both objects already live in the main thread.
            controller.event.connect(self.bridge_event)

    # ---- system / context ------------------------------------------

    @Slot(result=str)
    def system_info(self) -> str:
        profile_name = None
        if self._context.registry is not None and self._context.profile_id:
            profile = self._context.registry.get(self._context.profile_id)
            if profile is not None:
                profile_name = profile.name
        return _dumps(
            {
                "app": __app_name__,
                "version": __version__,
                "profile": profile_name,
                "profile_id": self._context.profile_id,
            }
        )

    @Slot(result=str)
    def app_version(self) -> str:
        """Return the installed application version."""
        return _dumps(
            {
                "ok": True,
                "version": __version__,
                "app_name": __app_name__,
            }
        )

    @Slot(result=str)
    def check_for_updates(self) -> str:
        """Compare the installed version with the latest GitHub release."""
        from ..services.version_check import check_for_update

        try:
            result = check_for_update(__version__)
        except Exception as exc:  # defensive: never crash the shell
            log.exception("Version check failed")
            return _dumps(
                {
                    "ok": False,
                    "current_version": __version__,
                    "error": f"업데이트 확인 중 오류가 발생했습니다: {exc}",
                }
            )
        return _dumps(result)

    @Slot(str, result=str)
    def open_external_url(self, url: str) -> str:
        """Open an http(s) URL in the system browser."""
        from PySide6.QtCore import QUrl
        from PySide6.QtGui import QDesktopServices

        target = (url or "").strip()
        scheme = QUrl(target).scheme().lower()
        if scheme not in ("http", "https"):
            return _dumps({"ok": False, "error": "허용되지 않은 URL입니다."})
        opened = QDesktopServices.openUrl(QUrl(target))
        return _dumps({"ok": bool(opened)})


    # ---- analytics: user-focused -----------------------------------

    @Slot(str, result=str)
    def analytics_user_activity_overview(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.user_activity_overview(
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            user_id=filters.get("user_id"),
            app=filters.get("app"),
            search=filters.get("search"),
            source_type=filters.get("source_type") or "api",
            limit=int(filters.get("limit") or 500),
        )
        return _dumps([_label_app(row) for row in rows])

    @Slot(str, result=str)
    def analytics_user_daily_activity(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.user_daily_activity(
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            user_id=filters.get("user_id"),
            app=filters.get("app"),
            search=filters.get("search"),
            source_type=filters.get("source_type") or "api",
            limit=int(filters.get("limit") or 2000),
        )
        return _dumps([_label_app(row) for row in rows])

    @Slot(str, result=str)
    def analytics_user_daily_app_usage(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.user_daily_app_usage(
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            user_id=filters.get("user_id"),
            app=filters.get("app"),
            search=filters.get("search"),
            source_type=filters.get("source_type") or "api",
            limit=int(filters.get("limit") or 2000),
        )
        out: list[dict[str, Any]] = []
        for row in rows:
            entry = dict(row)
            entry["app_raw"] = row.get("app") or ""
            entry["app"] = display_app_name(row.get("app") or "")
            out.append(entry)
        return _dumps(out)

    @Slot(str, result=str)
    def analytics_interaction_apps(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        apps = self._context.repo.interaction_apps(
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            user_id=filters.get("user_id"),
            source_type=filters.get("source_type") or "api",
        )
        return _dumps(
            [
                {"value": app, "label": display_app_name(app)}
                for app in apps
            ]
        )

    # ---- users -----------------------------------------------------

    @Slot(result=str)
    def users_in_scope(self) -> str:
        users = self._context.repo.users_in_scope()
        return _dumps(
            [
                {
                    "id": user.id,
                    "upn": user.upn,
                    "display_name": user.display_name,
                    "enabled": user.enabled,
                    "licensed": user.has_copilot_license,
                }
                for user in users
            ]
        )

    @Slot(result=str)
    def ediscovery_users(self) -> str:
        users = self._context.repo.users_with_interactions(source_type="ediscovery")
        return _dumps(
            [
                {
                    "id": user.id,
                    "upn": user.upn,
                    "display_name": user.display_name,
                    "enabled": user.enabled,
                    "licensed": user.has_copilot_license,
                }
                for user in users
            ]
        )

    # ---- conversations --------------------------------------------

    @Slot(str, result=str)
    def conversations_list(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        threads = self._context.repo.list_threads(
            user_id=filters.get("user_id"),
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            app=filters.get("app"),
            search=filters.get("search"),
            search_scope=filters.get("search_scope") or "title",
            source_type=filters.get("source_type") or "api",
            limit=int(filters.get("limit") or 200),
        )
        return _dumps([_thread_summary_with_user_fallback(self._context.repo, thread) for thread in threads])

    @Slot(str, result=str)
    def conversation_apps(self, source_type: str) -> str:
        apps = self._context.repo.thread_apps(source_type=source_type or "api")
        return _dumps(
            [{"value": app, "label": display_app_name(app)} for app in apps]
        )

    @Slot(str, result=str)
    def conversations_detail(self, thread_id: str) -> str:
        thread = self._context.repo.get_thread(thread_id)
        if thread is None:
            return _dumps({"thread": None, "turns": [], "audit": []})
        turns = self._context.repo.thread_turns(thread_id, source_type=thread.source_type)
        audit_events = self._context.repo.audit_events_for_thread(thread)
        return _dumps(
            {
                "thread": _thread_summary_with_user_fallback(self._context.repo, thread, turns=turns),
                "turns": [_thread_turn(turn) for turn in turns],
                "audit": [_audit_event_row(event) for event in audit_events],
            }
        )

    # ---- agents ----------------------------------------------------

    @Slot(str, result=str)
    def agents_list(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.list_copilot_agent_activity(
            threshold_days=int(filters.get("threshold_days") or 30),
            include_all=bool(filters.get("include_all", True)),
            search=filters.get("search"),
        )
        return _dumps([_agent_row(row) for row in rows])

    # ---- security / audit -----------------------------------------

    @Slot(str, result=str)
    def audit_events_list(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.list_audit_events(
            source=filters.get("source"),
            user_id=filters.get("user_id"),
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            search=filters.get("search"),
            limit=int(filters.get("limit") or 300),
        )
        return _dumps([_audit_event_full(event) for event in rows])

    @Slot(result=str)
    def admin_diagnostics_list(self) -> str:
        rows = self._context.repo.list_copilot_admin_diagnostics()
        return _dumps(
            [
                {
                    "key": row.key,
                    "label": row.label,
                    "endpoint": row.endpoint,
                    "status": row.status,
                    "status_code": row.status_code,
                    "summary": row.summary,
                    "error": row.error,
                    "captured_at": row.captured_at,
                }
                for row in rows
            ]
        )

    # ---- official Microsoft reports -------------------------------

    @Slot(str, result=str)
    def usage_snapshots_list(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.list_usage_snapshots(
            period=filters.get("period"),
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            search=filters.get("search"),
            limit=int(filters.get("limit") or 500),
        )
        return _dumps([_usage_snapshot_row(row) for row in rows])

    @Slot(str, result=str)
    def usage_counts_list(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.list_usage_count_rows(
            report_type=filters.get("report_type"),
            period=filters.get("period"),
            limit=int(filters.get("limit") or 200),
        )
        return _dumps([_usage_count_row(row) for row in rows])

    @Slot(result=str)
    def usage_periods_summary(self) -> str:
        repo = self._context.repo
        latest = {period: repo.latest_usage_snapshot_date(period) for period in ("D7", "D30", "D90", "D180")}
        return _dumps({"latest_snapshot_dates": latest})

    # ---- Power Platform consumption (agent cost-credit) ------------

    @Slot(str, result=str)
    def consumption_list(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        rows = self._context.repo.list_consumption_rows(
            report_type=filters.get("report_type"),
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            user_id=filters.get("user_id"),
            search=filters.get("search"),
            limit=int(filters.get("limit") or 500),
        )
        return _dumps([_consumption_row(row) for row in rows])

    @Slot(str, result=str)
    def consumption_overview(self, filters_json: str) -> str:
        """Per-report-type KPIs + daily trend + heaviest users for the window."""
        filters = _parse_filters(filters_json)
        repo = self._context.repo
        report_type = filters.get("report_type") or "MCSMessages"
        days = int(filters.get("days") or 30)
        summary = repo.consumption_summary(report_type=report_type, days=days)
        trend = repo.consumption_daily_totals(report_type=report_type, days=days)
        top_users = repo.consumption_top_users(report_type=report_type, days=days, limit=20)
        return _dumps(
            {
                "summary": summary,
                "trend": [{"date": d, "total": total} for d, total in trend],
                "top_users": top_users,
            }
        )

    @Slot(result=str)
    def consumption_collect_start(self) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.start_consumption_collection())

    @Slot(result=str)
    def consumption_collect_stop(self) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.stop_consumption_collection())

    # ---- operations / system --------------------------------------

    @Slot(str, result=str)
    def operations_recent_runs(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        runs = self._context.repo.recent_runs(limit=int(filters.get("limit") or 50))
        return _dumps(
            [
                {
                    "id": run.id,
                    "started_at": run.started_at,
                    "finished_at": run.finished_at,
                    "users_processed": run.users_processed,
                    "interactions_fetched": run.interactions_fetched,
                    "errors_count": run.errors_count,
                    "trigger": run.trigger,
                }
                for run in runs
            ]
        )

    @Slot(str, result=str)
    def operations_run_logs(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        kind = str(filters.get("kind") or "")
        limit = int(filters.get("limit") or 30)
        return _dumps(self._controller.recent_run_logs(kind, limit))

    @Slot(result=str)
    def operations_audit_state(self) -> str:
        rows = []
        for source in ("purview", "entra_audit", "entra_signin"):
            state = self._context.repo.get_audit_collection_state(source)
            if state is None:
                continue
            rows.append(
                {
                    "source": state.source,
                    "last_collected_at": state.last_collected_at,
                    "last_success_at": state.last_success_at,
                    "last_error": state.last_error,
                    "last_error_at": state.last_error_at,
                    "last_record_count": state.last_record_count,
                    "pending_query_id": state.pending_query_id,
                    "enabled": state.enabled,
                }
            )
        return _dumps(rows)

    @Slot(result=str)
    def operations_summary(self) -> str:
        repo = self._context.repo
        return _dumps(
            {
                "users": {
                    "total": repo.total_users(),
                    "readiness": repo.readiness_rate(),
                },
                "interactions": repo.total_interactions(),
                "threads": repo.thread_count(),
            }
        )

    @Slot(str, result=str)
    def insights_adoption_summary(self, filters_json: str) -> str:
        filters = _parse_filters(filters_json)
        days = int(filters.get("days") or 30)
        repo = self._context.repo
        return _dumps(
            {
                "adoption": repo.adoption_summary(days=days),
                "sessions": repo.meaningful_interaction_count(days=days),
            }
        )

    @Slot(result=str)
    def profiles_list(self) -> str:
        if self._context.registry is None:
            return _dumps([])
        active = self._context.registry.active_profile_id
        out: list[dict[str, Any]] = []
        for profile in self._context.registry.profiles:
            out.append(
                {
                    "id": profile.id,
                    "name": profile.name,
                    "tenant_domain": profile.tenant_domain,
                    "display_name": profile.display_name,
                    "bootstrap_complete": bool(profile.bootstrap_complete),
                    "last_used_at": profile.last_used_at,
                    "created_at": profile.created_at,
                    "active": profile.id == active,
                    "current": profile.id == self._context.profile_id,
                }
            )
        return _dumps(out)

    @Slot(result=str)
    def settings_summary(self) -> str:
        options = self._context.options
        repo = self._context.repo
        tenant_id = repo.get_text_setting("tenant_id")
        client_id = repo.get_text_setting("client_id")
        secret_expires_at = repo.get_text_setting("secret_expires_at")
        language = repo.get_text_setting("language") or (options.language if options else None)
        return _dumps(
            {
                "tenant_id": tenant_id,
                "client_id": client_id,
                "secret_expires_at": secret_expires_at,
                "language": language,
                "poll_interval_minutes": options.poll_interval_minutes if options else None,
                "scope_mode": options.scope_mode if options else None,
                "scope_group_id": options.scope_group_id if options else None,
                "scope_upns": list(options.scope_upns) if options else [],
                "auto_backup_enabled": options.auto_backup_enabled if options else False,
                "auto_backup_mode": options.auto_backup_mode if options else "new",
                "bootstrap_complete": repo.get_text_setting("bootstrap_complete") == "1",
            }
        )

    # ---- actions --------------------------------------------------

    @Slot(str, str, result=str)
    def collection_start(self, kind: str, options_json: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        try:
            options = json.loads(options_json) if options_json else {}
        except (TypeError, ValueError):
            options = {}
        if not isinstance(options, dict):
            options = {}
        return _dumps(self._controller.start_collection(kind, options=options))

    @Slot(str, result=str)
    def collection_stop(self, kind: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.stop_collection(kind))

    @Slot(result=str)
    def collection_status(self) -> str:
        if self._controller is None:
            return _dumps({"running": []})
        return _dumps(self._controller.collection_status())

    @Slot(str, result=str)
    def ediscovery_collect_start(self, payload_json: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        try:
            payload = json.loads(payload_json) if payload_json else {}
        except (TypeError, ValueError):
            return _dumps({"ok": False, "error": "잘못된 요청 형식입니다."})
        if not isinstance(payload, dict):
            return _dumps({"ok": False, "error": "잘못된 요청 형식입니다."})
        target_upn = str(payload.get("target_upn") or "").strip()
        window_start = payload.get("window_start")
        window_end = payload.get("window_end")
        job_id = payload.get("job_id")
        return _dumps(
            self._controller.start_ediscovery_collection(
                target_upn,
                window_start=str(window_start) if window_start else None,
                window_end=str(window_end) if window_end else None,
                job_id=str(job_id) if job_id else None,
            )
        )

    @Slot(str, result=str)
    def ediscovery_collect_stop(self, job_id: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.stop_ediscovery_collection(job_id))

    @Slot(result=str)
    def ediscovery_collect_status(self) -> str:
        if self._controller is None:
            return _dumps({"jobs": []})
        return _dumps(self._controller.ediscovery_status())

    @Slot(str, result=str)
    def ediscovery_open_download(self, job_id: str) -> str:
        """Disabled: the product must not open manual browser download UI."""
        return _dumps(
            {
                "ok": False,
                "error": "수동 브라우저 다운로드는 지원하지 않습니다. 자동 백엔드 다운로드만 시도합니다.",
            }
        )

    @Slot(str, result=str)
    def ediscovery_import_export(self, job_id: str) -> str:
        """Disabled: the product must not ask the operator to import ZIPs."""
        return _dumps(
            {
                "ok": False,
                "error": "수동 ZIP 가져오기는 지원하지 않습니다. 자동 백엔드 다운로드만 시도합니다.",
            }
        )

    @Slot(str, result=str)
    def profile_switch(self, profile_id: str) -> str:

        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.switch_profile(profile_id))

    @Slot(str, result=str)
    def profile_add(self, name: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.add_profile(name))

    @Slot(str, str, result=str)
    def profile_remove(self, profile_id: str, delete_data_json: str = "true") -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        try:
            delete_data = bool(json.loads(delete_data_json))
        except (TypeError, ValueError):
            delete_data = True
        return _dumps(self._controller.remove_profile(profile_id, delete_data=delete_data))

    @Slot(str, result=str)
    def settings_update(self, payload_json: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        try:
            payload = json.loads(payload_json or "{}")
        except (TypeError, ValueError):
            return _dumps({"ok": False, "error": "잘못된 JSON 입력"})
        if not isinstance(payload, dict):
            return _dumps({"ok": False, "error": "payload는 객체여야 합니다."})
        return _dumps(self._controller.update_settings(payload))

    @Slot(str, result=str)
    def open_system_dialog(self, kind: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.open_system_dialog(kind))

    # ---- backup / restore / export --------------------------------

    @Slot(result=str)
    def backup_create(self) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.create_backup())

    @Slot(result=str)
    def backup_pick_file(self) -> str:
        """Open a native file-open dialog (GUI thread) and return the path."""
        from PySide6.QtWidgets import QFileDialog

        start_dir = ""
        if self._controller is not None:
            info = self._controller.exports_dir_path()
            if info.get("ok"):
                start_dir = info.get("path") or ""
        path, _ = QFileDialog.getOpenFileName(
            None,
            "백업 파일 선택",
            start_dir,
            f"CopilotWatchTower 백업 (*{BUNDLE_SUFFIX});;모든 파일 (*.*)",
        )
        return _dumps({"ok": bool(path), "path": path or ""})

    @Slot(str, result=str)
    def backup_inspect(self, file_path: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.inspect_backup(file_path))

    @Slot(str, result=str)
    def backup_restore(self, file_path: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.restore_backup(file_path))

    @Slot(str, result=str)
    def export_interactions(self, fmt: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.export_interactions(fmt))

    @Slot(str, result=str)
    def export_threads_all(self, fmt: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.export_all_threads(fmt))

    @Slot(str, str, result=str)
    def export_thread(self, thread_id: str, fmt: str) -> str:
        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        return _dumps(self._controller.export_thread(thread_id, fmt))

    @Slot(result=str)
    def exports_open_folder(self) -> str:
        from PySide6.QtCore import QUrl
        from PySide6.QtGui import QDesktopServices

        if self._controller is None:
            return _dumps({"ok": False, "error": "controller not wired"})
        info = self._controller.exports_dir_path()
        if not info.get("ok"):
            return _dumps(info)
        QDesktopServices.openUrl(QUrl.fromLocalFile(info["path"]))
        return _dumps({"ok": True, "path": info["path"]})

    @Slot(result=str)
    def diagnostics_ping(self) -> str:
        """Round-trip diagnostic. Pushes a bridge_event so the UI can verify the live channel works."""
        if self._controller is not None:
            self._controller.emit_test_event()
        log.info("diagnostics_ping")
        return _dumps({"ok": True})

def _parse_filters(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        log.debug("Bridge received non-JSON filters payload: %r", raw)
        return {}
    if not isinstance(parsed, dict):
        return {}
    return parsed


def _label_app(row: dict[str, Any]) -> dict[str, Any]:
    entry = dict(row)
    raw = row.get("top_app") or ""
    entry["top_app_raw"] = raw
    entry["top_app"] = display_app_name(raw)
    return entry


def _thread_summary(thread: Any) -> dict[str, Any]:
    return {
        "id": thread.id,
        "user_id": thread.user_id,
        "display_name": thread.display_name,
        "upn": thread.upn,
        "started_at": thread.started_at,
        "ended_at": thread.ended_at,
        "app_raw": thread.app or "",
        "app": display_app_name(thread.app or ""),
        "turn_count": int(thread.turn_count),
        "prompt_count": int(thread.prompt_count),
        "response_count": int(thread.response_count),
        "title": thread.title or "",
        "topic_keywords": list(thread.topic_keywords or []),
        "session_ids": list(thread.session_ids or []),
        "source_type": getattr(thread, "source_type", "api"),
        "match_snippet": getattr(thread, "match_snippet", None),
        "body_match": bool(getattr(thread, "body_match", False)),
    }


def _looks_synthetic_identity(value: str | None) -> bool:
    text = (value or "").strip()
    if not text:
        return True
    lowered = text.lower()
    return (
        lowered.startswith("dataverse:")
        or lowered.startswith("8:orgid:")
        or lowered in _NON_HUMAN_LABELS
    )


def _friendly_raw_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or _looks_synthetic_identity(text):
        return None
    return text


def _resolve_identity_name_from_raw(repo: Repository, raw_json: str | None, *, source_type: str) -> str | None:
    if not raw_json:
        return None
    try:
        raw = json.loads(raw_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None

    if source_type == "api":
        identity = raw.get("user")
        if isinstance(identity, dict):
            name = _friendly_raw_name(identity.get("displayName"))
            if name:
                return name
            identity_id = str(identity.get("id") or "").strip()
            if identity_id and _GUID_RE.match(identity_id):
                return repo.display_names_for_ids([identity_id]).get(identity_id)
        return None

    if source_type == "dataverse":
        activity = raw.get("activity")
        sender = activity.get("from") if isinstance(activity, dict) else None
        if isinstance(sender, dict):
            name = _friendly_raw_name(sender.get("name"))
            if name:
                return name
            candidate = str(
                sender.get("aadObjectId") or sender.get("aadobjectid") or sender.get("id") or ""
            ).strip()
            if candidate and _GUID_RE.match(candidate):
                return repo.display_names_for_ids([candidate]).get(candidate)
        return None

    return None


def _thread_summary_with_user_fallback(
    repo: Repository,
    thread: Any,
    *,
    turns: list[Any] | None = None,
) -> dict[str, Any]:
    summary = _thread_summary(thread)
    current_label = summary.get("display_name") or summary.get("upn") or summary.get("user_id")
    if not _looks_synthetic_identity(str(current_label or "")):
        return summary

    source_type = str(getattr(thread, "source_type", "api") or "api")
    candidate_turns = turns if turns is not None else repo.thread_turns(thread.id, source_type=source_type)
    user_turns = [turn for turn in candidate_turns if (turn.interaction_type or "").lower() == "userprompt"]
    ordered_turns = user_turns + [turn for turn in candidate_turns if turn not in user_turns]
    for turn in ordered_turns:
        resolved = _resolve_identity_name_from_raw(repo, getattr(turn, "raw_json", None), source_type=source_type)
        if resolved:
            summary["display_name"] = resolved
            return summary
    return summary


def _thread_turn(turn: Any) -> dict[str, Any]:
    body = turn.body_text or ""
    if len(body) > _THREAD_TURN_BODY_LIMIT:
        body = body[:_THREAD_TURN_BODY_LIMIT] + "…"
    return {
        "id": turn.id,
        "created_at": turn.created_at,
        "interaction_type": turn.interaction_type or "",
        "app_raw": turn.app or "",
        "app": display_app_name(turn.app or ""),
        "session_id": turn.session_id,
        "body_text": body,
        "body_content_type": turn.body_content_type or "",
        "raw_json": turn.raw_json,
        "source_type": getattr(turn, "source_type", "api"),
    }


def _audit_event_row(event: Any) -> dict[str, Any]:
    return {
        "id": event.id,
        "source": event.source,
        "event_time": event.event_time,
        "upn": event.upn,
        "operation": event.operation,
        "workload": event.workload,
        "app_raw": event.app or "",
        "app": display_app_name(event.app or ""),
        "result": event.result,
        "raw_json": getattr(event, "raw_json", None),
    }


def _audit_event_full(event: Any) -> dict[str, Any]:
    base = _audit_event_row(event)
    base.update(
        {
            "user_id": event.user_id,
            "client_ip": event.client_ip,
            "target_resources": event.target_resources,
            "raw_json": event.raw_json,
            "fetched_at": event.fetched_at,
        }
    )
    return base


def _consumption_row(row: Any) -> dict[str, Any]:
    return {
        "report_type": row.report_type,
        "usage_date": row.usage_date,
        "environment_id": row.environment_id,
        "environment_name": row.environment_name,
        "user_id": row.user_id,
        "display_name": row.display_name,
        "upn": row.upn,
        "product": row.product,
        "quantity": row.quantity,
        "unit": row.unit,
        "raw_json": row.raw_json,
    }


def _usage_snapshot_row(row: Any) -> dict[str, Any]:
    return {
        "snapshot_date": row.snapshot_date,
        "user_id": row.user_id,
        "upn": row.upn,
        "period": row.period,
        "display_name": row.display_name,
        "last_activity_overall": row.last_activity_overall,
        "last_activity_teams": row.last_activity_teams,
        "last_activity_word": row.last_activity_word,
        "last_activity_excel": row.last_activity_excel,
        "last_activity_powerpoint": row.last_activity_powerpoint,
        "last_activity_outlook": row.last_activity_outlook,
        "last_activity_onenote": row.last_activity_onenote,
        "last_activity_loop": row.last_activity_loop,
        "last_activity_bizchat": row.last_activity_bizchat,
    }


def _usage_count_row(row: Any) -> dict[str, Any]:
    return {
        "report_type": row.report_type,
        "report_refresh_date": row.report_refresh_date,
        "period": row.period,
        "report_date": row.report_date,
        "any_app_enabled_users": row.any_app_enabled_users,
        "any_app_active_users": row.any_app_active_users,
        "teams_enabled_users": row.teams_enabled_users,
        "teams_active_users": row.teams_active_users,
        "word_enabled_users": row.word_enabled_users,
        "word_active_users": row.word_active_users,
        "powerpoint_enabled_users": row.powerpoint_enabled_users,
        "powerpoint_active_users": row.powerpoint_active_users,
        "outlook_enabled_users": row.outlook_enabled_users,
        "outlook_active_users": row.outlook_active_users,
        "excel_enabled_users": row.excel_enabled_users,
        "excel_active_users": row.excel_active_users,
        "onenote_enabled_users": row.onenote_enabled_users,
        "onenote_active_users": row.onenote_active_users,
        "loop_enabled_users": row.loop_enabled_users,
        "loop_active_users": row.loop_active_users,
        "copilot_chat_enabled_users": row.copilot_chat_enabled_users,
        "copilot_chat_active_users": row.copilot_chat_active_users,
    }


def _agent_row(row: Any) -> dict[str, Any]:
    agent = row.agent
    return {
        "id": agent.id,
        "display_name": agent.display_name,
        "app_identity": agent.app_identity,
        "app_external_id": agent.app_external_id,
        "add_on_guid": agent.add_on_guid,
        "source": agent.source,
        "status": agent.status,
        "created_at": agent.created_at,
        "updated_at": agent.updated_at,
        "raw_json": agent.raw_json,
        "last_activity_at": agent.last_activity_at,
        "last_activity_source": agent.last_activity_source,
        "usage_event_count": int(agent.usage_event_count or 0),
        "state": row.state,
        "is_stale": bool(row.is_stale),
        "days_inactive": row.days_inactive,
        "confidence": row.confidence,
        "threshold_days": int(row.threshold_days),
        "audit_coverage_start": row.audit_coverage_start,
        "audit_coverage_end": row.audit_coverage_end,
    }


def _dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)
