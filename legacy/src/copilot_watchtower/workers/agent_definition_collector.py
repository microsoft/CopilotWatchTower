"""Background worker that builds per-agent static risk profiles.

Mirrors :class:`DataverseCollectorWorker`. Reads each environment's Copilot
Studio agent definitions from Dataverse — the ``bot`` master records and their
``botcomponent`` rows (whose ``data`` column holds the OBI definition) — and
runs the pure :func:`services.agent_risk.analyze_agent` scorer to predict which
agents are likely to run away **before** they do. The score is a transparent
heuristic, never a certainty; the UI labels it as a static prediction.

There is no time window: it always reads the *current* definition of every
agent. Components per environment are capped so a pathological tenant cannot
stall a cycle.
"""
from __future__ import annotations

import logging

from PySide6.QtCore import QObject, Signal

from ..config import AGENT_DEFINITION_MAX_COMPONENTS
from ..db import AgentDefinitionRow, Repository
from ..i18n import translate
from ..services.agent_risk import analyze_agent, parent_bot_id
from ..services.dataverse import DataverseError
from ..services.dataverse_browser_download import DataverseBrowserError
from .dataverse_session import (
    DataverseSession,
    DataverseSessionError,
    build_dataverse_session,
)

log = logging.getLogger(__name__)

_FORMATTED = "@OData.Community.Display.V1.FormattedValue"

_BOT_SELECT = "botid,name,schemaname,statecode,createdon,modifiedon,_modifiedby_value,_createdby_value"
_BOTCOMPONENT_SELECT = (
    "botcomponentid,name,componenttype,schemaname,statecode,componentstate,"
    "modifiedon,_parentbotid_value,content,data"
)


def _state_label(record: dict) -> str | None:
    formatted = record.get(f"statecode{_FORMATTED}")
    if formatted:
        return str(formatted)
    code = record.get("statecode")
    if code == 0:
        return "Active"
    if code == 1:
        return "Inactive"
    return None


class AgentDefinitionCollectorWorker(QObject):
    """Collects + risk-scores Copilot Studio agent definitions from Dataverse."""

    cycle_started = Signal(str)            # trigger
    cycle_finished = Signal(int, int)      # agents_scored, errors
    progress = Signal(str, str)            # status, message
    log_line = Signal(str)
    error = Signal(str)

    def __init__(
        self,
        repo: Repository,
        *,
        add_self_as_admin: bool = False,
        trigger: str = "manual",
    ) -> None:
        super().__init__()
        self.repo = repo
        self.add_self_as_admin = bool(add_self_as_admin)
        self.trigger = trigger
        self._should_stop = False

    def request_stop(self) -> None:
        self._should_stop = True

    def run(self) -> None:
        self.cycle_started.emit(self.trigger)
        scored = 0
        errors = 0
        session: DataverseSession | None = None
        try:
            session = build_dataverse_session(
                self.repo,
                on_log=self.log_line.emit,
                add_self_as_admin=self.add_self_as_admin,
            )
            self.progress.emit("running", translate("worker.agentDef.querying"))
            for env in session.queryable_environments():
                if self._should_stop:
                    self.log_line.emit(translate("worker.stoppedByUserRequest"))
                    break
                label = env.friendly_name or env.url
                self.progress.emit(
                    "running", translate("worker.agentDef.envCollecting", label=label)
                )
                try:
                    bots = session.client.fetch_entity_rows(
                        env, "bots", select=_BOT_SELECT, include_formatted=True, max_pages=20
                    )
                    components = session.client.fetch_entity_rows(
                        env,
                        "botcomponents",
                        select=_BOTCOMPONENT_SELECT,
                        top=AGENT_DEFINITION_MAX_COMPONENTS,
                        max_pages=50,
                    )
                except DataverseError as exc:
                    errors += 1
                    log.warning("agent-def env %s failed: %s", env.url, exc)
                    self.log_line.emit(
                        translate(
                            "worker.agentDef.envFailed", label=label, error=self._fmt(exc)
                        )
                    )
                    continue

                if not bots:
                    self.log_line.emit(translate("worker.agentDef.noAgents", label=label))
                    continue

                # Group components by their owning bot.
                by_bot: dict[str, list[dict]] = {}
                for comp in components:
                    parent = parent_bot_id(comp)
                    if parent:
                        by_bot.setdefault(parent, []).append(comp)

                rows: list[AgentDefinitionRow] = []
                for bot in bots:
                    bot_id = str(bot.get("botid") or "").strip()
                    if not bot_id:
                        continue
                    bot_components = by_bot.get(bot_id, [])
                    profile = analyze_agent(bot_components)
                    rows.append(
                        AgentDefinitionRow(
                            id=bot_id,
                            environment_id=env.id,
                            environment_name=env.friendly_name,
                            bot_name=bot.get("name"),
                            schema_name=bot.get("schemaname"),
                            state=_state_label(bot),
                            component_count=profile.component_count,
                            has_trigger=profile.has_trigger,
                            external_call_count=profile.external_call_count,
                            tool_count=profile.tool_count,
                            loop_count=profile.loop_count,
                            knowledge_count=profile.knowledge_count,
                            generative_orchestration=profile.generative_orchestration,
                            risk_score=profile.score,
                            risk_band=profile.band,
                            risk_factors_json=profile.factors_json(),
                            created_by=bot.get(f"_createdby_value{_FORMATTED}"),
                            modified_by=bot.get(f"_modifiedby_value{_FORMATTED}"),
                            modified_on=bot.get("modifiedon"),
                        )
                    )
                if rows:
                    self.repo.upsert_agent_definitions(rows)
                    scored += len(rows)
                    self.log_line.emit(
                        translate(
                            "worker.agentDef.envSaved",
                            label=label,
                            written=len(rows),
                            components=len(components),
                        )
                    )
            self.progress.emit("done", translate("worker.doneSaved", count=scored))
        except DataverseSessionError as exc:
            errors = 1
            self.error.emit(str(exc))
            self.progress.emit("error", translate("worker.dataverse.makerLoginRequired"))
        except DataverseBrowserError as exc:
            errors = 1
            log.warning("agent-def browser sign-in failed: %s", exc)
            self.error.emit(translate("worker.flowRun.browserLoginFailed", error=exc))
            self.progress.emit("error", translate("worker.dataverse.makerLoginRequired"))
        except Exception as exc:  # noqa: BLE001 - surface any failure to UI
            errors = 1
            log.exception("Agent-definition collection aborted: %r", exc)
            self.error.emit(translate("worker.agentDef.aborted", error=exc))
            self.progress.emit("error", translate("worker.dataverse.failed"))
        finally:
            if session is not None:
                session.close()
            self.cycle_finished.emit(scored, errors)

    # ----------------------------------------------------------------

    @staticmethod
    def _fmt(exc: DataverseError) -> str:
        detail = str(exc.detail).strip() if exc.detail else ""
        status = f"HTTP {exc.status}" if exc.status else translate("worker.errorLabel")
        return f"{status}: {detail}" if detail else status
