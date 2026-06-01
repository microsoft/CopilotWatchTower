"""Background worker that collects Dataverse Copilot Studio transcripts.

Mirrors :class:`ConsumptionCollectorWorker`: a :class:`QObject` moved onto a
:class:`QThread`. Custom-engine Copilot Studio agents persist *every* channel's
conversation (Microsoft Teams, web chat, Direct Line, …) into the Dataverse
``conversationtranscript`` table — turns the Graph ``getAllEnterpriseInteractions``
substrate never sees. This worker drives a real maker-portal sign-in with
headless Chromium, reuses the ``*.crm.dynamics.com`` bearer tokens the SPA
acquires (see :mod:`..services.dataverse_browser_download`), enumerates the
admin's environments via the Global Discovery Service, reads each environment's
transcripts, and ingests them as ``source_type='dataverse'`` interactions so
they render alongside the license-based Copilot conversations.

Copilot Studio transcripts default to a 30-day retention, so this collection
must run periodically inside that window to avoid permanent data loss. The
Dataverse Web API is unofficial for this purpose and may change — failures are
surfaced through the ``error``/``log_line`` signals rather than swallowed.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from PySide6.QtCore import QObject, Signal

from ..config import DATAVERSE_DEFAULT_WINDOW_DAYS
from ..db import Repository, UserRow
from ..security import unprotect
from ..services.dataverse import (
    DataverseClient,
    DataverseEnvironment,
    DataverseError,
    fetch_bap_environments,
)
from ..services.dataverse_browser_download import (
    DataverseBrowserError,
    EnvCaptureTarget,
    capture_dataverse_tokens,
)
from ..services.threading_service import recompute_threads_for_user

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class DataverseCollectorWorker(QObject):
    """Collects Copilot Studio conversation transcripts from Dataverse."""

    cycle_started = Signal(str)            # trigger
    cycle_finished = Signal(int, int)      # rows_added, errors
    progress = Signal(str, str)            # status, message
    log_line = Signal(str)
    error = Signal(str)

    def __init__(
        self,
        repo: Repository,
        *,
        window_days: int = DATAVERSE_DEFAULT_WINDOW_DAYS,
        teams_only: bool = False,
        add_self_as_admin: bool = False,
        trigger: str = "manual",
    ) -> None:
        super().__init__()
        self.repo = repo
        self.window_days = max(int(window_days), 1)
        self.teams_only = bool(teams_only)
        # Opt-in: when set, environments the signed-in user can not mint a token
        # for are recovered by adding the user as system administrator via the
        # Power Platform admin center before retrying. Default off — this writes
        # admin access to shared/production environments.
        self.add_self_as_admin = bool(add_self_as_admin)
        self.trigger = trigger
        self._should_stop = False
        self._captured = None
        # Environments enumerated via BAP during token capture (preferred over
        # Global Discovery, which is usually unreachable).
        self._bap_environments: list[DataverseEnvironment] = []

    def request_stop(self) -> None:
        self._should_stop = True

    # ----------------------------------------------------------------

    def run(self) -> None:
        self.cycle_started.emit(self.trigger)
        rows_added = 0
        errors = 0
        client: DataverseClient | None = None
        try:
            client = self._build_client()
            if client is None:
                errors = 1
                return

            self.progress.emit("running", "Dataverse 환경 목록 조회 중…")
            # Prefer the environments enumerated via BAP during token capture:
            # that list covers every environment the signed-in user can reach
            # (each already had its org token minted), so it is authoritative.
            environments = list(self._bap_environments)
            if environments:
                self.log_line.emit(
                    f"○ Dataverse 환경 {len(environments)}개를 확인했습니다 "
                    f"(BAP 환경 목록)."
                )
            else:
                from_discovery = True
                try:
                    environments = client.discover_environments()
                except DataverseError as exc:
                    # The maker portal often only mints an org-audience token
                    # (never a Global Discovery one), so discovery returns 401.
                    # Fall back to the org hosts we already captured tokens for.
                    environments = self._environments_from_tokens()
                    from_discovery = False
                    if not environments:
                        errors = 1
                        self.error.emit(
                            f"Dataverse 환경 목록 조회 실패: {self._fmt(exc)}"
                        )
                        self.progress.emit("error", "환경 목록을 가져오지 못했습니다.")
                        return
                    self.log_line.emit(
                        "○ 글로벌 디스커버리에 접근하지 못해 캡처한 환경 토큰으로 "
                        "직접 수집합니다."
                    )
                if not environments:
                    # Discovery succeeded but returned nothing; still try orgs.
                    environments = self._environments_from_tokens()
                    from_discovery = False
                if not environments:
                    self.log_line.emit("• 접근 가능한 Dataverse 환경이 없습니다.")
                    self.progress.emit("done", "수집할 환경이 없습니다.")
                    return
                if from_discovery:
                    # Global Discovery enumerates every environment the admin
                    # can reach, so this count is authoritative.
                    self.log_line.emit(
                        f"○ Dataverse 환경 {len(environments)}개를 확인했습니다 "
                        f"(글로벌 디스커버리)."
                    )
                else:
                    # Fallback: we only see the environment(s) the maker portal
                    # minted a token for — typically just the signed-in user's
                    # default environment, NOT every environment they can access.
                    self.log_line.emit(
                        f"○ Dataverse 환경 {len(environments)}개를 확인했습니다 "
                        f"(캡처된 토큰 기준)."
                    )
                    self.log_line.emit(
                        "  ↳ 글로벌 디스커버리와 BAP에 접근하지 못해 로그인 계정의 "
                        "기본 환경만 보일 수 있습니다. 다른 환경의 대화까지 "
                        "수집하려면 글로벌 디스커버리 접근 권한 또는 환경별 수집이 "
                        "필요합니다."
                    )

            since = self._window_start()
            touched_users: set[str] = set()
            for env in environments:
                if self._should_stop:
                    self.log_line.emit("○ 사용자 요청으로 중단되었습니다.")
                    break
                label = env.friendly_name or env.url
                self.progress.emit("running", f"{label} 대화 기록 수집 중…")
                # When a per-environment token was never minted, the client would
                # fall back to an unrelated org's token and hit a 401. Skip with a
                # clear message instead so the operator knows which environments
                # were inaccessible (vs. a genuine collection error).
                env_host = (urlsplit(env.url).hostname or "").lower()
                captured_hosts = (
                    set(self._captured.org_hosts) if self._captured else set()
                )
                if captured_hosts and env_host and env_host not in captured_hosts:
                    self.log_line.emit(
                        f"• {label}: 환경 토큰을 발급받지 못해 건너뜁니다 "
                        "(이 계정이 해당 환경의 메이커 권한이 없을 수 있습니다)."
                    )
                    if env.id:
                        self.log_line.emit(
                            f"  ↳ 권한 확인: "
                            f"https://make.powerapps.com/environments/{env.id}/home"
                        )
                    continue
                try:
                    parsed = client.fetch_transcript_rows(
                        env,
                        since=since,
                        teams_only=self.teams_only,
                    )
                except DataverseError as exc:
                    errors += 1
                    log.warning("dataverse env %s failed: %s", env.url, exc)
                    self.log_line.emit(
                        f"⚠ {label} 수집 실패 ({self._fmt(exc)})"
                    )
                    continue

                if not parsed.rows:
                    # Distinguish "the table is genuinely empty for this window"
                    # from "records existed but every turn was filtered out", so
                    # the operator knows whether to widen the window or relax the
                    # Teams-only filter.
                    if parsed.records_seen == 0:
                        self.log_line.emit(
                            f"• {label}: 최근 {self.window_days}일 안에 대화 기록"
                            f"(conversationtranscript)이 없습니다."
                        )
                    else:
                        detail = (
                            f"트랜스크립트 {parsed.records_seen}건, "
                            f"메시지 {parsed.activities_seen}건"
                        )
                        if parsed.skipped_non_teams:
                            detail += f", Teams 외 채널 제외 {parsed.skipped_non_teams}건"
                        if parsed.skipped_empty:
                            detail += f", 본문 없는 메시지 {parsed.skipped_empty}건"
                        self.log_line.emit(
                            f"• {label}: 저장할 대화가 없습니다 ({detail})."
                        )
                        if parsed.activities_seen == 0 and parsed.content_shape:
                            # Records existed but their content JSON had no
                            # activity array — show the actual shape so we can
                            # adjust the parser to the real transcript format.
                            self.log_line.emit(
                                f"  ↳ 트랜스크립트 content 구조가 예상과 다릅니다: "
                                f"{parsed.content_shape}"
                            )
                        if parsed.skipped_non_teams and self.teams_only:
                            self.log_line.emit(
                                "  ↳ Teams 전용 필터가 켜져 있습니다. 다른 채널"
                                " 대화까지 보려면 'Teams 전용' 옵션을 끄세요."
                            )
                    continue

                # Ensure a users row exists for every user_id the interactions
                # reference (defensive: covers ids the parser did not surface as
                # named participants) so the interactions→users FK is satisfied.
                row_users = {
                    user_id: parsed.participants.get(user_id)
                    for user_id in {r.user_id for r in parsed.rows}
                }
                self._ensure_users(row_users)
                existing = self.repo.existing_interaction_ids(r.id for r in parsed.rows)
                self.repo.upsert_interactions(parsed.rows)
                written = len({r.id for r in parsed.rows if r.id not in existing})
                rows_added += written
                touched_users.update(r.user_id for r in parsed.rows)
                self.log_line.emit(
                    f"⛁ {label}: 상호작용 {written}건 신규 저장 "
                    f"(총 파싱 {len(parsed.rows)}건)"
                )

            # Rebuild conversation threads for every user we ingested turns for
            # so the Dataverse-sourced data renders identically to Copilot.
            for user_id in touched_users:
                if self._should_stop:
                    break
                user = UserRow(
                    id=user_id,
                    upn=None,
                    display_name=None,
                    enabled=True,
                    has_copilot_license=False,
                    in_scope=False,
                )
                recompute_threads_for_user(self.repo, user, source_type="dataverse")

            if errors and rows_added == 0:
                self.progress.emit("error", "대화 기록을 가져오지 못했습니다.")
            else:
                self.progress.emit("done", f"완료: {rows_added}건 저장")
        except DataverseBrowserError as exc:
            errors = 1
            log.warning("dataverse browser sign-in failed: %s", exc)
            self.error.emit(f"대화 기록 수집 브라우저 로그인 실패: {exc}")
            self.progress.emit("error", "메이커 포털 브라우저 로그인이 필요합니다.")
        except Exception as exc:  # noqa: BLE001 - surface any failure to UI
            errors = 1
            log.exception("Dataverse collection aborted: %r", exc)
            self.error.emit(f"대화 기록 수집 중 오류가 발생했습니다: {exc}")
            self.progress.emit("error", "대화 기록 수집 실패")
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            self.cycle_finished.emit(rows_added, errors)

    # ----------------------------------------------------------------

    @staticmethod
    def _fmt(exc: DataverseError) -> str:
        detail = str(exc.detail).strip() if exc.detail else ""
        status = f"HTTP {exc.status}" if exc.status else "오류"
        return f"{status}: {detail}" if detail else status

    def _environments_from_tokens(self) -> list[DataverseEnvironment]:
        """Synthesize environments from captured org-host tokens.

        Used when Global Discovery is unreachable (401) because the maker portal
        only minted org-audience tokens. Each captured ``*.crm.dynamics.com``
        host (excluding the discovery host) becomes a directly-queryable org.
        """
        if self._captured is None:
            return []
        return [
            DataverseEnvironment(id=host, url=f"https://{host}", friendly_name=host)
            for host in self._captured.org_hosts
        ]

    def _window_start(self) -> str:
        start = datetime.now(timezone.utc) - timedelta(days=self.window_days)
        return start.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _ensure_users(self, participants: dict[str, str]) -> None:
        """Upsert minimal user rows so transcripts stay attributable.

        Transcript participants are Teams/web end users that may not exist in
        the license-based ``users`` table; we add a lightweight row (out of
        scope, no license) keyed on the parser-assigned ``dataverse:`` id.
        """
        rows = [
            UserRow(
                id=user_id,
                upn=None,
                display_name=name or None,
                enabled=True,
                has_copilot_license=False,
                in_scope=False,
            )
            for user_id, name in participants.items()
        ]
        if rows:
            self.repo.upsert_users(rows)

    def _build_client(self) -> DataverseClient | None:
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
                "대화 기록 수집: 자동 로그인 계정이 저장되어 있지 않습니다. "
                "설정에서 브라우저 로그인 계정을 등록하세요."
            )
            return None
        password = str(unprotect(password_blob))

        # Enumerate environments via BAP mid-session so the browser can mint a
        # token per environment. Populates ``self._bap_environments`` for run().
        def _enumerate(bap_token: str) -> list[EnvCaptureTarget]:
            all_envs = fetch_bap_environments(bap_token)
            # 개발자(Developer) 환경에는 Copilot 대화 기록(conversationtranscript)이
            # 전혀 쌓이지 않으므로, 수집은 물론 관리자 추가 시도 대상에서도 완전히
            # 제외한다.
            dev_envs = [
                env
                for env in all_envs
                if (env.sku or "").strip().lower() == "developer"
            ]
            envs = [
                env
                for env in all_envs
                if (env.sku or "").strip().lower() != "developer"
            ]
            self._bap_environments = envs
            if dev_envs:
                self.log_line.emit(
                    f"○ 개발자 환경 {len(dev_envs)}개는 기록 데이터가 없어 "
                    "수집 대상에서 제외했습니다."
                )
            if envs:
                self.log_line.emit(
                    f"○ BAP에서 환경 {len(envs)}개를 확인했습니다."
                )
            targets: list[EnvCaptureTarget] = []
            for env in envs:
                host = urlsplit(env.url).hostname or ""
                targets.append(
                    EnvCaptureTarget(
                        env_id=env.id,
                        org_host=host.lower(),
                        label=env.friendly_name or env.url,
                    )
                )
            return targets

        tokens = capture_dataverse_tokens(
            username=user,
            password=password,
            on_log=self.log_line.emit,
            enumerate_environments=_enumerate,
            add_self_as_admin=self.add_self_as_admin,
        )
        self._captured = tokens
        return DataverseClient(tokens.token_for, timeout=120.0)
