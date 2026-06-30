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

import contextlib
import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from PySide6.QtCore import QObject, Signal

from ..config import DATAVERSE_DEFAULT_WINDOW_DAYS
from ..db import Repository, UserRow
from ..i18n import translate
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
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


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

            self.progress.emit("running", translate("worker.dataverse.envListQuerying"))
            # Prefer the environments enumerated via BAP during token capture:
            # that list covers every environment the signed-in user can reach
            # (each already had its org token minted), so it is authoritative.
            environments = list(self._bap_environments)
            if environments:
                self.log_line.emit(
                    translate("worker.dataverse.envConfirmedBap", count=len(environments))
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
                            translate("worker.dataverse.envListFailed", error=self._fmt(exc))
                        )
                        self.progress.emit("error", translate("worker.dataverse.envListFetchFailed"))
                        return
                    self.log_line.emit(
                        translate("worker.dataverse.discoveryFallback")
                    )
                if not environments:
                    # Discovery succeeded but returned nothing; still try orgs.
                    environments = self._environments_from_tokens()
                    from_discovery = False
                if not environments:
                    self.log_line.emit(translate("worker.dataverse.noEnvironments"))
                    self.progress.emit("done", translate("worker.dataverse.noEnvToCollect"))
                    return
                if from_discovery:
                    # Global Discovery enumerates every environment the admin
                    # can reach, so this count is authoritative.
                    self.log_line.emit(
                        translate("worker.dataverse.envConfirmedDiscovery", count=len(environments))
                    )
                else:
                    # Fallback: we only see the environment(s) the maker portal
                    # minted a token for — typically just the signed-in user's
                    # default environment, NOT every environment they can access.
                    self.log_line.emit(
                        translate("worker.dataverse.envConfirmedCaptured", count=len(environments))
                    )
                    self.log_line.emit(
                        translate("worker.dataverse.captureLimitedHint")
                    )

            since = self._window_start()
            touched_users: set[str] = set()
            for env in environments:
                if self._should_stop:
                    self.log_line.emit(translate("worker.stoppedByUserRequest"))
                    break
                label = env.friendly_name or env.url
                self.progress.emit("running", translate("worker.dataverse.envCollecting", label=label))
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
                        translate("worker.dataverse.envTokenSkip", label=label)
                    )
                    if env.id:
                        self.log_line.emit(
                            translate("worker.dataverse.permissionCheck", env_id=env.id)
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
                        translate("worker.dataverse.envFailed", label=label, error=self._fmt(exc))
                    )
                    continue

                if not parsed.rows:
                    # Distinguish "the table is genuinely empty for this window"
                    # from "records existed but every turn was filtered out", so
                    # the operator knows whether to widen the window or relax the
                    # Teams-only filter.
                    if parsed.records_seen == 0:
                        self.log_line.emit(
                            translate("worker.dataverse.noTranscripts", label=label, days=self.window_days)
                        )
                    else:
                        detail = translate(
                            "worker.dataverse.detailCounts",
                            records=parsed.records_seen,
                            activities=parsed.activities_seen,
                        )
                        if parsed.skipped_non_teams:
                            detail += translate("worker.dataverse.detailSkippedNonTeams", count=parsed.skipped_non_teams)
                        if parsed.skipped_empty:
                            detail += translate("worker.dataverse.detailSkippedEmpty", count=parsed.skipped_empty)
                        self.log_line.emit(
                            translate("worker.dataverse.noConvToSave", label=label, detail=detail)
                        )
                        if parsed.activities_seen == 0 and parsed.content_shape:
                            # Records existed but their content JSON had no
                            # activity array — show the actual shape so we can
                            # adjust the parser to the real transcript format.
                            self.log_line.emit(
                                translate("worker.dataverse.contentShapeUnexpected", shape=parsed.content_shape)
                            )
                        if parsed.skipped_non_teams and self.teams_only:
                            self.log_line.emit(
                                translate("worker.dataverse.teamsOnlyHint")
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
                    translate("worker.dataverse.envSaved", label=label, written=written, parsed=len(parsed.rows))
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
                self.progress.emit("error", translate("worker.dataverse.convFetchFailed"))
            else:
                self.progress.emit("done", translate("worker.doneSaved", count=rows_added))
        except DataverseBrowserError as exc:
            errors = 1
            log.warning("dataverse browser sign-in failed: %s", exc)
            self.error.emit(translate("worker.dataverse.browserLoginFailed", error=exc))
            self.progress.emit("error", translate("worker.dataverse.makerLoginRequired"))
        except Exception as exc:  # noqa: BLE001 - surface any failure to UI
            errors = 1
            log.exception("Dataverse collection aborted: %r", exc)
            self.error.emit(translate("worker.dataverse.aborted", error=exc))
            self.progress.emit("error", translate("worker.dataverse.failed"))
        finally:
            if client is not None:
                with contextlib.suppress(Exception):
                    client.close()
            self.cycle_finished.emit(rows_added, errors)

    # ----------------------------------------------------------------

    @staticmethod
    def _fmt(exc: DataverseError) -> str:
        detail = str(exc.detail).strip() if exc.detail else ""
        status = f"HTTP {exc.status}" if exc.status else translate("worker.errorLabel")
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
        start = datetime.now(UTC) - timedelta(days=self.window_days)
        return start.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _ensure_users(self, participants: dict[str, str]) -> None:
        """Upsert minimal user rows so transcripts stay attributable.

        Transcript participants are Teams/web end users that may not exist in
        the license-based ``users`` table; we add a lightweight row (out of
        scope, no license) keyed on the parser-assigned ``dataverse:`` id.
        """
        bare_ids = [
            user_id.split("dataverse:", 1)[1]
            for user_id, name in participants.items()
            if user_id.startswith("dataverse:") and (not name or name == user_id)
        ]
        resolved = self.repo.display_names_for_ids(bare_ids)
        rows = [
            UserRow(
                id=user_id,
                upn=None,
                display_name=(resolved.get(user_id.split("dataverse:", 1)[1]) if user_id.startswith("dataverse:") else None) or name or None,
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
            self.error.emit(translate("worker.dataverse.noBrowserAccount"))
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
                    translate("worker.dataverse.devEnvExcluded", count=len(dev_envs))
                )
            if envs:
                self.log_line.emit(
                    translate("worker.dataverse.bapEnvConfirmed", count=len(envs))
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
