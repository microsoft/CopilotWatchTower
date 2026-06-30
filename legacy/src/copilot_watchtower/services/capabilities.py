"""License-configuration capability model.

Customers run CopilotWatchTower against tenants with different Microsoft 365
license configurations. The set of data sources — and therefore the features
the app can surface — depends on that configuration. Rather than hard-code the
four common tiers, capabilities are modelled as an *additive* set of booleans;
the four tiers are human-friendly presets layered on top so an unusual real
tenant (e.g. "E5 but no Copilot") is still representable.

The **source of truth is the administrator's explicit choice in Settings**.
SKU auto-detection (:func:`suggest_from_skus`) is an optional helper that only
*pre-fills* the form — it is never authoritative, so an unrecognised E5 SKU can
never block a feature.

Only three license-driven gates exist:

``copilot_seats``
    A full Microsoft 365 Copilot license is present, so the Graph
    interaction-history / usage-report APIs return data. Gates the API
    conversation collection and the official usage reports.
``e5``
    An E5 plan is present. Only affects audit-log retention messaging — never
    a hard gate.
``agent_inventory``
    Agent365 — the ``/copilot/agentRegistrations`` API returns the agent
    inventory. Gates the agent inventory feature.

eDiscovery, Dataverse (Teams) transcripts and Power Platform consumption are
always available: they depend on tenant *usage*, not on the M365 license tier,
so they are not represented as gates here.
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Any

# ---------------------------------------------------------------------------
# License-detection knowledge (used only for the optional "suggest" helper).
# ---------------------------------------------------------------------------

# Microsoft 365 Copilot *service plan* IDs (the inner plans of a SKU). We probe
# ``subscribedSkus`` and treat a SKU as Copilot-carrying when it includes any of
# these plans. This is the most stable signal; the shared plans appear across
# the commercial, EDU, Sales and Service SKUs.
COPILOT_SERVICE_PLAN_IDS: set[str] = {
    "3f30311c-6b1e-49a9-ab65-1c52d2bb8e80",  # M365_COPILOT_BUSINESS_CHAT
    "a62f8878-de10-42f3-b68f-6149a25ceb97",  # M365_COPILOT_APPS (commercial/EDU/Sales)
    "b95945de-b3bd-46db-8437-f2beb6ea2347",  # M365_COPILOT_TEAMS (commercial/EDU)
    "931e4a88-a67f-48b5-814f-16a5f1e6028d",  # M365_COPILOT_INTELLIGENT_SEARCH (commercial/EDU)
    "0aedf20c-091d-420b-aadf-30c042609612",  # M365_COPILOT_SHAREPOINT (commercial/EDU)
    "12d3a26a-c0b9-4cdd-9a5d-99ec6f1f5c75",  # M365 Copilot for Service (placeholder)
}

# Best-effort E5 indicators. The "e5" capability only drives audit-retention
# messaging, so this is a conservative, non-authoritative hint for the suggest
# helper. Microsoft 365 Advanced Auditing (long retention) ships with E5 and is
# the signal most relevant to what the capability represents.
E5_INDICATOR_SERVICE_PLAN_IDS: set[str] = {
    "2f442157-a11c-46b9-ae5b-6e39ff4e5849",  # M365 Advanced Auditing (E5)
    "a413a9ff-720c-4789-9ae5-d39a4d20f04e",  # Microsoft 365 Communications Compliance (E5)
    "bf6f5520-59e3-4f82-974b-7dbbc4fd27c7",  # Microsoft Insider Risk Management (E5)
}

# ---------------------------------------------------------------------------
# Presets (stable keys persisted in settings).
# ---------------------------------------------------------------------------

PRESET_ME3 = "me3"
PRESET_ME3_COPILOT = "me3_copilot"
PRESET_ME5_COPILOT = "me5_copilot"
PRESET_AGENT365 = "agent365"
PRESET_CUSTOM = "custom"

PRESETS: tuple[str, ...] = (
    PRESET_ME3,
    PRESET_ME3_COPILOT,
    PRESET_ME5_COPILOT,
    PRESET_AGENT365,
)

# preset -> (copilot_seats, e5, agent_inventory). Additive/monotonic.
_PRESET_FLAGS: dict[str, tuple[bool, bool, bool]] = {
    PRESET_ME3: (False, False, False),
    PRESET_ME3_COPILOT: (True, False, False),
    PRESET_ME5_COPILOT: (True, True, False),
    PRESET_AGENT365: (True, True, True),
}

# Collection kinds gated by a capability. Kinds not listed are always allowed
# (they depend on tenant usage / are license-agnostic).
KIND_REQUIRED_CAPABILITY: dict[str, str] = {
    "conversation": "copilot_seats",
    "usage": "copilot_seats",
    "diagnostics": "agent_inventory",
}


@dataclass(frozen=True)
class CapabilityProfile:
    """Resolved capability set plus provenance."""

    copilot_seats: bool = False
    e5: bool = False
    agent_inventory: bool = False
    preset: str = PRESET_CUSTOM
    source: str = "default"  # "manual" | "detected" | "default"
    updated_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def allows_kind(self, kind: str) -> bool:
        """Whether the given collection kind is permitted by this profile."""
        required = KIND_REQUIRED_CAPABILITY.get(kind)
        if required is None:
            return True
        return bool(getattr(self, required, False))


def preset_for(copilot_seats: bool, e5: bool, agent_inventory: bool) -> str:
    """Return the preset label for a capability combination, or ``custom``."""
    combo = (bool(copilot_seats), bool(e5), bool(agent_inventory))
    for preset, flags in _PRESET_FLAGS.items():
        if flags == combo:
            return preset
    return PRESET_CUSTOM


def profile_from_preset(
    preset: str, *, source: str = "manual", updated_at: str | None = None
) -> CapabilityProfile:
    """Build a :class:`CapabilityProfile` from a preset key."""
    flags = _PRESET_FLAGS.get(preset)
    if flags is None:
        raise ValueError(f"Unknown preset: {preset!r}")
    seats, e5, agent = flags
    return CapabilityProfile(
        copilot_seats=seats,
        e5=e5,
        agent_inventory=agent,
        preset=preset,
        source=source,
        updated_at=updated_at,
    )


def profile_from_toggles(
    toggles: dict[str, Any], *, source: str = "manual", updated_at: str | None = None
) -> CapabilityProfile:
    """Build a :class:`CapabilityProfile` from individual capability toggles."""
    seats = bool(toggles.get("copilot_seats"))
    e5 = bool(toggles.get("e5"))
    agent = bool(toggles.get("agent_inventory"))
    return CapabilityProfile(
        copilot_seats=seats,
        e5=e5,
        agent_inventory=agent,
        preset=preset_for(seats, e5, agent),
        source=source,
        updated_at=updated_at,
    )


def default_unconfigured_profile() -> CapabilityProfile:
    """Profile used before the admin configures licensing: everything on.

    Until an administrator explicitly chooses a configuration in Settings, the
    app does not gate anything — it behaves exactly as it did before capability
    gating existed, so nothing silently disappears for existing profiles. The
    UI distinguishes this state via ``source == "default"`` and only enforces
    gates once the admin has made an explicit choice.
    """
    return CapabilityProfile(
        copilot_seats=True,
        e5=True,
        agent_inventory=True,
        preset=PRESET_CUSTOM,
        source="default",
    )


def profile_from_settings(raw: dict[str, Any] | None) -> CapabilityProfile:
    """Rehydrate a persisted profile dict (settings JSON) into a profile."""
    if not isinstance(raw, dict):
        return CapabilityProfile()
    seats = bool(raw.get("copilot_seats"))
    e5 = bool(raw.get("e5"))
    agent = bool(raw.get("agent_inventory"))
    preset = raw.get("preset") or preset_for(seats, e5, agent)
    return CapabilityProfile(
        copilot_seats=seats,
        e5=e5,
        agent_inventory=agent,
        preset=str(preset),
        source=str(raw.get("source") or "manual"),
        updated_at=raw.get("updated_at"),
    )


def _sku_service_plan_ids(skus: Iterable[dict[str, Any]]) -> set[str]:
    plans: set[str] = set()
    for sku in skus:
        for plan in sku.get("servicePlans", []) or []:
            plan_id = plan.get("servicePlanId")
            if plan_id:
                plans.add(str(plan_id))
    return plans


def suggest_from_skus(
    subscribed_skus: Iterable[dict[str, Any]],
    *,
    agent_inventory: bool = False,
    updated_at: str | None = None,
) -> CapabilityProfile:
    """Best-effort capability suggestion from ``subscribedSkus``.

    This only pre-fills the Settings form; the administrator confirms it. The
    ``agent_inventory`` flag is supplied by the caller from a live
    ``/copilot/agentRegistrations`` probe (the SKU list alone cannot reveal it).
    """
    plans = _sku_service_plan_ids(subscribed_skus)
    seats = bool(plans & COPILOT_SERVICE_PLAN_IDS)
    e5 = bool(plans & E5_INDICATOR_SERVICE_PLAN_IDS)
    agent = bool(agent_inventory)
    return CapabilityProfile(
        copilot_seats=seats,
        e5=e5,
        agent_inventory=agent,
        preset=preset_for(seats, e5, agent),
        source="detected",
        updated_at=updated_at,
    )
