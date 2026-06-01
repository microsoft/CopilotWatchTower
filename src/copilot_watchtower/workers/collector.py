"""Background collector worker.

Encapsulates a single run of:
    1. user sync (resolves the configured scope to a set of user IDs);
    2. backfill of new users (since=None);
    3. incremental refresh of existing users (since=last_watermark-Δ);

The worker is intentionally cooperative: it checks ``_should_stop``
between users so the UI can request a clean abort.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from PySide6.QtCore import QObject, QThread, Signal

from ..config import DELEGATED_COPILOT_AGENT_SYNC_SCOPES, WATERMARK_SAFETY_MARGIN_SECONDS, RuntimeOptions
from ..db import InteractionRow, Repository, UserRow, attachments_to_json
from ..services import (
    DelegatedAuthExpiredError,
    DelegatedDeviceCodeTokenProvider,
    GraphClient,
    GraphError,
    delegated_token_cache_path,
)
from ..services.admin_diagnostics import collect_copilot_admin_diagnostics
from ..services.audit_query import (
    collect_entra_audits,
    collect_entra_signins,
    collect_purview,
)
from ..services.threading_service import recompute_threads_for_user
from ..services.usage_reports import USAGE_REPORT_PERIODS, collect_copilot_usage_reports
from ..time_format import format_kst

if TYPE_CHECKING:
    from ..services.graph import CopilotInteraction, GraphUser

log = logging.getLogger(__name__)


# Microsoft 365 Copilot Service Plan IDs. We probe `subscribedSkus` and
# pick SKUs that include any of these plans. Hard-coded list is the most
# stable signal; new Copilot SKUs are added over time.
#
# These are *service plan* IDs (the inner plans of a SKU), not SKU IDs. The
# shared M365 Copilot plans below appear across the commercial, EDU, Sales and
# Service SKUs, so matching any of them flags a Copilot-licensed user. The EDU
# SKU (Microsoft_365_Copilot_EDU, sku ad9c22b3-52d7-4e7e-973c-88121ea96436)
# bundles M365_COPILOT_APPS / TEAMS / SHAREPOINT / INTELLIGENT_SEARCH and is
# therefore covered by the shared plans without a dedicated entry.
COPILOT_SERVICE_PLAN_IDS: set[str] = {
    "3f30311c-6b1e-49a9-ab65-1c52d2bb8e80",  # M365_COPILOT_BUSINESS_CHAT
    "a62f8878-de10-42f3-b68f-6149a25ceb97",  # M365_COPILOT_APPS (commercial/EDU/Sales)
    "b95945de-b3bd-46db-8437-f2beb6ea2347",  # M365_COPILOT_TEAMS (commercial/EDU)
    "931e4a88-a67f-48b5-814f-16a5f1e6028d",  # M365_COPILOT_INTELLIGENT_SEARCH (commercial/EDU)
    "0aedf20c-091d-420b-aadf-30c042609612",  # M365_COPILOT_SHAREPOINT (commercial/EDU)
    "12d3a26a-c0b9-4cdd-9a5d-99ec6f1f5c75",  # M365 Copilot for Service (placeholder)
}


@dataclass
class CollectionResult:
    run_id: int
    users_processed: int = 0
    interactions_fetched: int = 0
    errors: list[str] = field(default_factory=list)


class CollectorWorker(QObject):
    """QObject moved to a QThread; collects users and conversation turns."""

    progress = Signal(str, int)               # message, percent
    user_progress = Signal(str, str, int)     # user_id, display, fetched
    cycle_started = Signal(int, str)          # run_id, trigger
    cycle_finished = Signal(int, int, int, int)  # run_id, users, interactions, errors
    log_line = Signal(str)
    error = Signal(str)

    def __init__(
        self,
        repo: Repository,
        graph: GraphClient,
        options: RuntimeOptions,
        trigger: str = "scheduled",
    ) -> None:
        super().__init__()
        self.repo = repo
        self.graph = graph
        self.options = options
        self.trigger = trigger
        self._should_stop = False

    def request_stop(self) -> None:
        self._should_stop = True

    # ----------------------------------------------------------------

    def run(self) -> None:
        log.info("CollectorWorker.run start (trigger=%s)", self.trigger)
        try:
            self._run_inner()
        except Exception as e:  # noqa: BLE001 — absolute backstop
            log.exception("Collector run aborted: %r", e)
            try:
                self.error.emit(f"수집 장애로 중단되었습니다: {e}")
            except Exception:
                pass
        finally:
            log.info("CollectorWorker.run exit")

    def _run_inner(self) -> None:
        run_id = self.repo.start_run(self.trigger)
        self.cycle_started.emit(run_id, self.trigger)
        self.log_line.emit(f"○ 수집 워커 시작 (run #{run_id}, trigger={self.trigger})")
        self.progress.emit("수집 준비 중...", 1)
        result = CollectionResult(run_id=run_id)
        try:
            in_scope_ids = self._sync_users()
            if in_scope_ids is None:
                return
            users = [u for u in self.repo.users_in_scope() if u.id in in_scope_ids]
            self.log_line.emit(f"• 수집 대상 사용자: {len(users)}명")
            if not users:
                self.log_line.emit("  · 수집 대상 사용자가 없습니다 (scope/license 설정 확인)")
            for index, user in enumerate(users, start=1):
                if self._should_stop:
                    self.log_line.emit("사용자 요청으로 수집을 중단했습니다.")
                    break
                pct = int(100 * index / max(1, len(users)))
                display = user.display_name or user.upn or user.id
                self.progress.emit(display, pct)
                self.log_line.emit(f"  · [{index}/{len(users)}] {display} 조회 중...")
                try:
                    fetched = self._collect_user(user)
                    result.users_processed += 1
                    result.interactions_fetched += fetched
                except GraphError as ge:
                    log.warning("GraphError for user %s: %s", user.id, ge)
                    self.repo.update_collection_state(user.id, last_error=str(ge))
                    result.errors.append(f"{user.upn or user.id}: {ge}")
                    self.error.emit(f"{user.upn or user.id}: {ge}")
                except Exception as e:  # noqa: BLE001 - last-ditch logging
                    log.exception("Unexpected collection error for %s", user.id)
                    self.repo.update_collection_state(user.id, last_error=repr(e))
                    result.errors.append(f"{user.upn or user.id}: {e}")
                    self.error.emit(f"{user.upn or user.id}: {e}")
        finally:
            self.repo.finish_run(
                run_id, result.users_processed, result.interactions_fetched, len(result.errors)
            )
            self.cycle_finished.emit(
                run_id, result.users_processed, result.interactions_fetched, len(result.errors)
            )

    # ----------------------------------------------------------------

    def _sync_users(self) -> set[str] | None:
        """Resolve the configured scope to a set of in-scope user IDs."""
        mode = self.options.scope_mode
        self.log_line.emit(f"• 사용자 동기화 시작 (scope mode={mode})")
        self.progress.emit(f"사용자 동기화 (scope={mode})", 2)
        try:
            in_scope_ids = self._resolve_scope_user_ids()
        except GraphError as ge:
            self.error.emit(f"사용자 목록 조회 실패: {ge}")
            return None
        self.log_line.emit(f"  · in-scope 대상: {len(in_scope_ids):,}명")

        # Fetch full user attributes for everything that ended up in scope.
        self.log_line.emit("  · /users 상세 조회 중...")
        self.progress.emit("/users 조회 중", 4)
        graph_users: dict[str, GraphUser] = {}
        try:
            count = 0
            for gu in self.graph.list_users():
                if gu.id in in_scope_ids:
                    graph_users[gu.id] = gu
                count += 1
                if count % 200 == 0:
                    self.log_line.emit(f"    · /users 수신 {count:,}명 (in-scope {len(graph_users):,})")
        except GraphError as ge:
            self.error.emit(f"사용자 상세 조회 실패: {ge}")
            return None
        self.log_line.emit(f"  · /users 조회 완료: 전체 {count:,} 중 in-scope {len(graph_users):,}")

        if mode in {"ALL_ACTIVE", "GROUP", "CUSTOM"}:
            self.log_line.emit("  · Copilot 라이선스 사용자 조회 중...")
            self.progress.emit("Copilot 라이선스 조회", 6)
            licensed_ids = set(self.graph.copilot_licensed_user_ids(self._copilot_sku_ids()))
            self.log_line.emit(f"  · 라이선스 사용자: {len(licensed_ids):,}명")
        else:
            licensed_ids = set(in_scope_ids)  # already filtered for LICENSED

        rows: list[UserRow] = []
        for uid in in_scope_ids:
            gu = graph_users.get(uid)
            if gu is None:
                continue
            rows.append(
                UserRow(
                    id=gu.id,
                    upn=gu.upn,
                    display_name=gu.display_name,
                    enabled=gu.enabled,
                    has_copilot_license=uid in licensed_ids,
                    in_scope=True,
                )
            )
        self.repo.upsert_users(rows)
        self.repo.mark_out_of_scope({r.id for r in rows})
        self.log_line.emit(f"• 사용자 동기화 완료: in-scope {len(rows)}명 저장")
        self.progress.emit("사용자 동기화 완료", 8)
        return {r.id for r in rows}

    def _resolve_scope_user_ids(self) -> set[str]:
        mode = self.options.scope_mode
        if mode == "ALL_ACTIVE":
            self.log_line.emit("  · 전체 활성 사용자 조회 중 (/users)...")
            return {gu.id for gu in self.graph.list_users() if gu.enabled}
        if mode == "LICENSED":
            self.log_line.emit("  · Copilot 라이선스 사용자 조회 중...")
            ids = set(self.graph.copilot_licensed_user_ids(self._copilot_sku_ids()))
            self.log_line.emit(f"  · 라이선스 사용자 {len(ids):,}명")
            return ids
        if mode == "GROUP":
            if not self.options.scope_group_id:
                raise RuntimeError("Group scope requires a group ID.")
            self.log_line.emit(f"  · 그룹 멤버 조회 중 (groupId={self.options.scope_group_id})...")
            return set(self.graph.group_member_ids(self.options.scope_group_id))
        if mode == "CUSTOM":
            ids: set[str] = set()
            for upn in self.options.scope_upns:
                self.log_line.emit(f"  · UPN 해석: {upn}")
                user = self.graph.resolve_user_by_upn(upn)
                if user is not None:
                    ids.add(user.id)
            return ids
        raise ValueError(f"Unknown scope mode: {mode}")

    def _copilot_sku_ids(self) -> set[str]:
        ids: set[str] = set()
        for sku in self.graph.list_subscribed_skus():
            plans = {p.get("servicePlanId") for p in sku.get("servicePlans", [])}
            if plans & COPILOT_SERVICE_PLAN_IDS:
                ids.add(str(sku["skuId"]))
        return ids

    # ----------------------------------------------------------------

    def _collect_user(self, user: UserRow) -> int:
        watermark, backfill_complete = self.repo.get_collection_state(user.id)
        if backfill_complete and watermark:
            since_dt = datetime.fromisoformat(watermark.replace("Z", "+00:00")) - timedelta(
                seconds=WATERMARK_SAFETY_MARGIN_SECONDS
            )
            since = since_dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        else:
            since = None  # initial backfill

        fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        max_created = watermark
        latest_returned_created: str | None = None
        fetched_count = 0
        new_count = 0
        batch: list[InteractionRow] = []
        BATCH_SIZE = 200

        for interaction in self.graph.list_interactions(user.id, since=since):
            batch.append(_to_row(user.id, interaction, fetched_at))
            fetched_count += 1
            if interaction.created_at and (
                latest_returned_created is None or interaction.created_at > latest_returned_created
            ):
                latest_returned_created = interaction.created_at
            if interaction.created_at and (max_created is None or interaction.created_at > max_created):
                max_created = interaction.created_at
            if len(batch) >= BATCH_SIZE:
                new_count += self._upsert_interactions_counting_new(batch)
                batch.clear()
                self.user_progress.emit(user.id, user.display_name or user.upn or user.id, new_count)

        if batch:
            new_count += self._upsert_interactions_counting_new(batch)

        self.repo.update_collection_state(
            user.id,
            last_collected_at=max_created or fetched_at,
            backfill_complete=True,
            last_error="",
        )
        display = user.display_name or user.upn or user.id
        self.user_progress.emit(user.id, display, new_count)
        rechecked_count = fetched_count - new_count
        if fetched_count > 0:
            self.log_line.emit(
                f"  · {display}: API 반환 {fetched_count}건 "
                f"(신규 {new_count}, 재확인 {rechecked_count}), "
                f"최신 원본 {format_kst(latest_returned_created)}"
            )
        else:
            window = f"{format_kst(since)} 이후" if since else "전체 백필"
            self.log_line.emit(
                f"  · {display}: API 반환 0건 ({window})"
            )

        # Recompute conversation threads for this user. Cheap: bounded
        # by the number of interactions we hold for them locally.
        try:
            self._recompute_threads_for_user(user)
        except Exception as e:  # noqa: BLE001 — threading must never abort a run
            log.exception("Thread re-compute failed for user %s: %s", user.id, e)
            self.error.emit(f"{user.upn or user.id}: 스레드 계산 실패 - {e}")

        return new_count

    def _upsert_interactions_counting_new(self, batch: list[InteractionRow]) -> int:
        existing_ids = self.repo.existing_interaction_ids(row.id for row in batch)
        self.repo.upsert_interactions(batch)
        return len({row.id for row in batch if row.id not in existing_ids})

    def _recompute_threads_for_user(self, user: UserRow) -> None:
        """Rebuild the user's conversation_threads rows from current interactions.

        Always recomputes the full set for the user so cross-batch
        merges (where new interactions extend an older thread) stay
        consistent. The work is local — no Graph calls.
        """
        recompute_threads_for_user(self.repo, user, source_type="api")


class AuditCollectorWorker(QObject):
    """QObject moved to a QThread; collects one management-data category."""

    cycle_started = Signal(str)               # trigger
    cycle_finished = Signal(str, int, int, int, int)  # label, audit_events, usage_rows, diagnostics, errors
    log_line = Signal(str)
    error = Signal(str)
    audit_progress = Signal(str, int)         # source, fetched_in_this_cycle

    def __init__(
        self,
        repo: Repository,
        graph: GraphClient,
        trigger: str = "manual",
        data_kind: str = "audit",
    ) -> None:
        super().__init__()
        self.repo = repo
        self.graph = graph
        self.trigger = trigger
        self.data_kind = data_kind
        self._should_stop = False

    def request_stop(self) -> None:
        self._should_stop = True

    def run(self) -> None:
        audit_fetched = 0
        usage_rows = 0
        diagnostics_rows = 0
        errors = 0
        label = _management_collection_label(self.data_kind)
        self.cycle_started.emit(f"{label} ({self.trigger})")
        try:
            if self.data_kind == "audit":
                audit_fetched, errors = self._collect_audit_events()
            elif self.data_kind == "usage":
                usage_rows, errors = self._snapshot_usage_report()
            elif self.data_kind == "diagnostics":
                diagnostics_rows, errors = self._collect_admin_diagnostics()
            else:
                raise ValueError(f"Unknown management data collection kind: {self.data_kind}")
        except Exception as e:  # noqa: BLE001 — absolute backstop
            log.exception("Management data collector run aborted: %r", e)
            errors += 1
            try:
                self.error.emit(f"{label} 수집 장애로 중단되었습니다: {e}")
            except Exception:
                pass
        finally:
            self.cycle_finished.emit(label, audit_fetched, usage_rows, diagnostics_rows, errors)

    def _collect_audit_events(self) -> tuple[int, int]:
        """Run all three audit collectors in series.

        Each collector handles its own watermark + error state. Failures
        are surfaced via :pyattr:`error` but do not raise out of this
        method — audit collection is supplemental data.
        """
        total = 0
        errors = 0
        for label, fn in (
            ("Purview", lambda: collect_purview(self.repo, self.graph)),
            ("Entra audit", lambda: collect_entra_audits(self.repo, self.graph)),
            ("Entra sign-in", lambda: collect_entra_signins(self.repo, self.graph)),
        ):
            if self._should_stop:
                return total, errors
            try:
                outcome = fn()
            except Exception as e:  # noqa: BLE001 — defensive backstop
                log.exception("%s audit collection crashed", label)
                errors += 1
                self.error.emit(f"{label} 감사 수집 실패: {e}")
                continue
            self.audit_progress.emit(outcome.source, outcome.fetched)
            total += outcome.fetched
            if outcome.error:
                errors += 1
                self.log_line.emit(f"{label}: 오류 — {outcome.error}")
            elif outcome.pending:
                self.log_line.emit(f"{label}: 비동기 쿼리 대기 중 (다음 사이클에서 재시도)")
            else:
                self.log_line.emit(f"{label}: {outcome.fetched}건 수집")
            for detail in outcome.details:
                self.log_line.emit(f"  · {label} {detail}")
        return total, errors

    def _collect_admin_diagnostics(self) -> tuple[int, int]:
        catalog_graph = self._build_delegated_catalog_graph()
        total_steps = 4
        state = {"started": 0, "finished": 0}

        def on_step(phase: str, label: str, detail: str | None) -> None:
            if phase == "started":
                state["started"] += 1
                self.log_line.emit(f"• {label} 조회 중… ({state['started']}/{total_steps})")
                # Approximate percent of the *started* step so the UI moves
                # while the request is in flight.
                percent = int(((state["started"] - 1) / total_steps) * 100)
                self.audit_progress.emit(label, percent)
            elif phase == "finished":
                state["finished"] += 1
                summary = detail or "완료"
                self.log_line.emit(f"  · {label}: {summary}")
                percent = int((state["finished"] / total_steps) * 100)
                self.audit_progress.emit(label, percent)
            elif phase == "persist":
                self.log_line.emit("• 결과 저장 및 에이전트 사용량 재계산 중…")
                self.audit_progress.emit("관리 진단 저장", 99)

        self.log_line.emit("관리 진단 수집 시작 (총 4단계)")
        self.audit_progress.emit("관리 진단", 0)
        try:
            rows = collect_copilot_admin_diagnostics(
                self.repo, self.graph, catalog_graph=catalog_graph, on_step=on_step
            )
        except DelegatedAuthExpiredError as e:
            log.warning("Delegated catalog token expired: %s", e)
            self.error.emit(
                "Copilot 카탈로그 동기화: 위임 로그인이 만료되었습니다.\n"
                "→ 설정 → 권한 재등록을 실행해 다시 로그인하세요."
            )
            return 0, 1
        except Exception as e:  # noqa: BLE001
            log.exception("Copilot admin diagnostics failed")
            self.error.emit(f"Copilot 관리 진단 실패: {e}")
            return 0, 1
        finally:
            if catalog_graph is not None:
                catalog_graph.close()
        self.log_line.emit(f"Copilot 관리 진단: {rows}개 항목 갱신")
        diagnostics = self.repo.list_copilot_admin_diagnostics()
        errors = 0
        for row in diagnostics:
            self.log_line.emit(f"  · {row.label}: {row.summary or row.status} ({row.status_code or '-'})")
            if row.key == "catalog_packages" and row.status in {"forbidden", "error"}:
                errors += 1
        agent_count = len(self.repo.list_copilot_agents(limit=10000))
        self.log_line.emit(f"  · 에이전트 목록: {agent_count:,}개 저장")
        self.audit_progress.emit("관리 진단", 100)
        return rows, errors

    def _build_delegated_catalog_graph(self) -> GraphClient | None:
        tenant_id = self.repo.get_text_setting("tenant_id")
        if not tenant_id:
            self.log_line.emit("Copilot 패키지/Agent 카탈로그: 테넌트 ID가 없어 delegated sync를 건너뜁니다.")
            return None
        cache_path = delegated_token_cache_path(self.repo.db_path.parent, tenant_id)

        # Background collection never prompts for an interactive device-code
        # login (the user isn't necessarily watching the log). If the cached
        # delegated token has expired, acquire() raises
        # DelegatedAuthExpiredError and we tell the user to re-register
        # permissions, which re-seeds the token cache.
        provider = DelegatedDeviceCodeTokenProvider(
            tenant_id,
            DELEGATED_COPILOT_AGENT_SYNC_SCOPES,
            cache_path=cache_path,
            allow_device_code=False,
        )
        return GraphClient(provider, timeout=120.0)

    def _snapshot_usage_report(self) -> tuple[int, int]:
        """Pull the latest Microsoft 365 Copilot usage CSVs from Graph."""
        counts: dict[str, dict[str, int]] = {}
        errors = 0
        for period in USAGE_REPORT_PERIODS:
            if self._should_stop:
                break
            try:
                result = collect_copilot_usage_reports(self.repo, self.graph, period=period)
                counts[period] = {
                    "detail": result.detail_rows,
                    "summary": result.summary_rows,
                    "trend": result.trend_rows,
                }
            except Exception as e:  # noqa: BLE001
                log.exception("Copilot usage report ingest failed for %s", period)
                self.error.emit(f"사용량 리포트 수집 실패 ({period}): {e}")
                errors += 1
                counts[period] = {"detail": 0, "summary": 0, "trend": 0}
        total = sum(sum(report_counts.values()) for report_counts in counts.values())
        detail = ", ".join(
            f"{period}=detail:{report_counts['detail']}/summary:{report_counts['summary']}/trend:{report_counts['trend']}"
            for period, report_counts in counts.items()
        )
        latest = ", ".join(
            f"{period}:{self.repo.latest_usage_snapshot_date(period) or '-'}"
            for period in counts
        )
        if total > 0:
            self.log_line.emit(f"사용량 보고서 갱신: {total}행 ({detail}; snapshot={latest})")
        else:
            self.log_line.emit(f"사용량 보고서: 갱신된 행 없음 ({detail or 'period 없음'})")
        return total, errors


def _management_collection_label(data_kind: str) -> str:
    return {
        "audit": "감사 이벤트",
        "usage": "사용량 보고서",
        "diagnostics": "관리 진단/에이전트",
    }.get(data_kind, data_kind)


def _to_row(user_id: str, interaction: "CopilotInteraction", fetched_at: str) -> InteractionRow:
    attachments_payload = {
        "attachments": interaction.attachments,
        "links": interaction.links,
        "mentions": interaction.mentions,
    }
    return InteractionRow(
        id=interaction.id,
        user_id=user_id,
        session_id=interaction.session_id,
        request_id=interaction.request_id,
        created_at=interaction.created_at,
        interaction_type=interaction.interaction_type,
        app=interaction.app,
        body_text=interaction.body_text,
        body_content_type=interaction.body_content_type,
        attachments_json=attachments_to_json(attachments_payload),
        raw_json=json.dumps(interaction.raw, ensure_ascii=False),
        fetched_at=fetched_at,
    )


class CollectorThread(QThread):
    """QThread wrapper that owns a collector QObject."""

    def __init__(
        self,
        worker: QObject,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self.worker = worker
        self.worker.moveToThread(self)

    def run(self) -> None:  # noqa: D401 — Qt override
        self.worker.run()
