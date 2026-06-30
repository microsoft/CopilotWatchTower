"""Static risk scoring for Copilot Studio agents (predictive tier).

The licensing/billing snapshot tells you an agent ran away *after* it spent the
credits; the flow-run table tells you it is running away *now*. This module
answers the third question — **which agents are likely to run away before they
ever do** — by statically analysing the agent's definition (the Dataverse
``botcomponent`` rows, whose ``data`` column holds the component "in OBI
format").

The scoring is a deliberately transparent, best-effort heuristic across the
five factor groups the product owner selected:

1. **autonomy / trigger** — a Trigger / External Trigger component means the
   agent can run with no human in the loop (the defining trait of the runaway
   agents this feature targets). Weighted heaviest.
2. **external calls** — connector + HTTP actions: each outbound call is spend
   and a blast-radius multiplier.
3. **tools** — plugin / skill / action invocations the orchestrator can chain.
4. **loops** — loop / iteration constructs that can amplify spend without bound.
5. **generative orchestration** — generative actions / Custom GPT let the model
   decide what to call, which is powerful but the hardest to bound.

Plus light **meta signals** (knowledge-source count). The result is a 0–100
score and a band; it is a *prediction*, never a certainty, and the UI labels it
as such. Pure and HTTP-free so it is exhaustively unit-testable with synthetic
component fixtures regardless of the (unofficial) OBI shape.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

# botcomponent.componenttype picklist (Microsoft Learn entity reference).
CT_TOPIC = 0
CT_SKILL = 1
CT_DIALOG = 4
CT_TRIGGER = 5
CT_TOPIC_V2 = 9
CT_SKILL_V2 = 13
CT_CUSTOM_GPT = 15
CT_KNOWLEDGE_SOURCE = 16
CT_EXTERNAL_TRIGGER = 17
CT_COPILOT_SETTINGS = 18

# Component types that signal the agent can act without a human turn.
_TRIGGER_TYPES = {CT_TRIGGER, CT_EXTERNAL_TRIGGER}
# Component types that represent callable tools/skills.
_TOOL_TYPES = {CT_SKILL, CT_SKILL_V2}

# Heuristic keyword sets scanned in the OBI ``data``/``content`` payloads. These
# are intentionally broad; the spike (scripts/spike_botcomponents.py) confirms
# the real serialisation so these can be tightened against observed tenants.
_TRIGGER_KEYWORDS = (
    "trigger",
    "recurrence",
    "scheduled",
    "autostart",
    "onschedule",
    "externaltrigger",
)
_EXTERNAL_CALL_KEYWORDS = (
    "connectionreference",
    "connectorid",
    "apiid",
    "httprequest",
    "http.request",
    "microsoft.http",
    "invokeconnector",
    "sendhttprequest",
    "openapi",
    "restapi",
)
_TOOL_KEYWORDS = (
    "invoketool",
    "aiplugin",
    "pluginaction",
    "skillinvocation",
    "executeaction",
    "powerautomate",
    "flowaction",
)
_LOOP_KEYWORDS = (
    "foreach",
    "while",
    "loop",
    "repeat",
    "iterate",
    "until",
)
_GENERATIVE_KEYWORDS = (
    "generativeactions",
    "generativeorchestration",
    "generative_mode",
    "\"orchestration\":\"generative\"",
    "customgpt",
    "gptcomponent",
    "deepreasoning",
)

# Per-factor maximum contributions to the 0..100 score. Autonomy dominates
# because a triggered/autonomous agent is the runaway archetype.
_W_AUTONOMY = 30.0
_W_EXTERNAL = 30.0
_W_TOOLS = 20.0
_W_LOOPS = 30.0
_W_GENERATIVE = 15.0
_W_KNOWLEDGE = 10.0

BAND_LOW = "low"
BAND_MEDIUM = "medium"
BAND_HIGH = "high"
BAND_CRITICAL = "critical"


@dataclass
class RiskFactor:
    """One contributing signal in the score (data-only; UI localises ``key``)."""

    key: str
    score: float
    count: int = 0
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "score": round(self.score, 2),
            "count": self.count,
            "detail": self.detail,
        }


@dataclass
class RiskProfile:
    """The computed static risk profile for a single agent."""

    component_count: int = 0
    has_trigger: bool = False
    external_call_count: int = 0
    tool_count: int = 0
    loop_count: int = 0
    knowledge_count: int = 0
    generative_orchestration: bool = False
    score: float = 0.0
    band: str = BAND_LOW
    factors: list[RiskFactor] = field(default_factory=list)

    def factors_json(self) -> str:
        return json.dumps([f.as_dict() for f in self.factors], ensure_ascii=False)


def _component_text(component: dict[str, Any]) -> str:
    """Lowercased concatenation of a component's OBI payload for keyword scans."""
    parts: list[str] = []
    for key in ("data", "content", "dependencies"):
        value = component.get(key)
        if value is None:
            continue
        parts.append(value if isinstance(value, str) else json.dumps(value))
    return "\n".join(parts).lower()


def _count_keywords(text: str, keywords: tuple[str, ...]) -> int:
    total = 0
    for kw in keywords:
        total += text.count(kw)
    return total


def _component_type(component: dict[str, Any]) -> int | None:
    raw = component.get("componenttype")
    if raw is None:
        raw = component.get("componentType")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _band_for(score: float) -> str:
    if score >= 75:
        return BAND_CRITICAL
    if score >= 50:
        return BAND_HIGH
    if score >= 25:
        return BAND_MEDIUM
    return BAND_LOW


def analyze_agent(components: list[dict[str, Any]]) -> RiskProfile:
    """Compute a :class:`RiskProfile` from one agent's botcomponent rows.

    ``components`` is the list of ``botcomponent`` records (each a dict with at
    least ``componenttype`` and, ideally, the OBI ``data`` text) belonging to a
    single ``bot``. Robust to missing/odd payloads — every signal degrades to a
    keyword scan when the structured fields are absent.
    """
    profile = RiskProfile(component_count=len(components))
    types: list[int | None] = []
    trigger_kw = external_kw = tool_kw = loop_kw = generative_kw = 0

    for component in components:
        ctype = _component_type(component)
        types.append(ctype)
        text = _component_text(component)
        trigger_kw += _count_keywords(text, _TRIGGER_KEYWORDS)
        external_kw += _count_keywords(text, _EXTERNAL_CALL_KEYWORDS)
        tool_kw += _count_keywords(text, _TOOL_KEYWORDS)
        loop_kw += _count_keywords(text, _LOOP_KEYWORDS)
        generative_kw += _count_keywords(text, _GENERATIVE_KEYWORDS)

    type_set = {t for t in types if t is not None}

    # --- autonomy / trigger -------------------------------------------------
    has_trigger = bool(_TRIGGER_TYPES & type_set) or trigger_kw > 0
    profile.has_trigger = has_trigger
    autonomy_score = _W_AUTONOMY if has_trigger else 0.0
    profile.factors.append(
        RiskFactor(
            key="autonomy",
            score=autonomy_score,
            count=sum(1 for t in types if t in _TRIGGER_TYPES) or (1 if trigger_kw else 0),
            detail="trigger" if has_trigger else None,
        )
    )

    # --- external calls (connectors / HTTP) ---------------------------------
    external_count = external_kw
    profile.external_call_count = external_count
    external_score = min(external_count, 10) * (_W_EXTERNAL / 10.0)
    profile.factors.append(
        RiskFactor(key="external_calls", score=external_score, count=external_count)
    )

    # --- tools / skills -----------------------------------------------------
    tool_count = tool_kw + sum(1 for t in types if t in _TOOL_TYPES)
    profile.tool_count = tool_count
    tool_score = min(tool_count, 8) * (_W_TOOLS / 8.0)
    profile.factors.append(RiskFactor(key="tools", score=tool_score, count=tool_count))

    # --- loops / iteration --------------------------------------------------
    loop_count = loop_kw
    profile.loop_count = loop_count
    loop_score = min(loop_count, 5) * (_W_LOOPS / 5.0)
    profile.factors.append(RiskFactor(key="loops", score=loop_score, count=loop_count))

    # --- generative orchestration ------------------------------------------
    generative = bool({CT_CUSTOM_GPT} & type_set) or generative_kw > 0
    profile.generative_orchestration = generative
    generative_score = _W_GENERATIVE if generative else 0.0
    profile.factors.append(
        RiskFactor(
            key="generative_orchestration",
            score=generative_score,
            count=1 if generative else 0,
        )
    )

    # --- knowledge sources (meta signal) ------------------------------------
    knowledge_count = sum(1 for t in types if t == CT_KNOWLEDGE_SOURCE)
    profile.knowledge_count = knowledge_count
    knowledge_score = min(knowledge_count, 5) * (_W_KNOWLEDGE / 5.0)
    profile.factors.append(
        RiskFactor(key="knowledge", score=knowledge_score, count=knowledge_count)
    )

    raw_total = (
        autonomy_score
        + external_score
        + tool_score
        + loop_score
        + generative_score
        + knowledge_score
    )
    profile.score = round(min(raw_total, 100.0), 2)
    profile.band = _band_for(profile.score)
    return profile


_GUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def parent_bot_id(component: dict[str, Any]) -> str | None:
    """Extract the owning bot GUID from a botcomponent record.

    Prefers the ``_parentbotid_value`` lookup the Dataverse Web API returns;
    falls back to any GUID embedded in a ``parentbotid`` field.
    """
    for key in ("_parentbotid_value", "parentbotid", "_ParentBotId_value"):
        value = component.get(key)
        if value:
            match = _GUID_RE.search(str(value))
            if match:
                return match.group(0)
            return str(value)
    return None
