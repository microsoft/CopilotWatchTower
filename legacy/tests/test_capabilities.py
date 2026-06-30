"""Unit tests for the license-configuration capability model.

Three layers, no live Graph calls:

* pure helpers in ``services.capabilities`` (presets, toggles, settings
  round-trip, SKU-based suggestion, per-kind gating);
* ``OperationsController`` capability persistence + collection guardrail;
* ``Bridge`` capability JSON slots.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from copilot_watchtower.config import RuntimeOptions
from copilot_watchtower.db import Repository, initialize
from copilot_watchtower.services.capabilities import (
    PRESET_AGENT365,
    PRESET_CUSTOM,
    PRESET_ME3,
    PRESET_ME3_COPILOT,
    PRESET_ME5_COPILOT,
    CapabilityProfile,
    default_unconfigured_profile,
    preset_for,
    profile_from_preset,
    profile_from_settings,
    profile_from_toggles,
    suggest_from_skus,
)
from copilot_watchtower.webshell.actions import OperationsController
from copilot_watchtower.webshell.bridge import Bridge, BridgeContext

# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "caps.db"
    initialize(db)
    return Repository(db)


@pytest.fixture
def options() -> RuntimeOptions:
    return RuntimeOptions(
        poll_interval_minutes=15,
        scope_mode="LICENSED",
        scope_group_id=None,
        scope_upns=[],
        language="ko_KR",
        auto_backup_enabled=False,
        auto_backup_mode="new",
    )


@pytest.fixture
def controller(qtbot, repo: Repository, options: RuntimeOptions) -> OperationsController:
    del qtbot
    return OperationsController(repo=repo, options=options, registry=None, profile_id=None)


def _sku(*service_plan_ids: str) -> dict:
    return {"skuId": "sku-x", "servicePlans": [{"servicePlanId": p} for p in service_plan_ids]}


_COPILOT_PLAN = "3f30311c-6b1e-49a9-ab65-1c52d2bb8e80"  # M365_COPILOT_BUSINESS_CHAT
_E5_PLAN = "2f442157-a11c-46b9-ae5b-6e39ff4e5849"  # M365 Advanced Auditing (E5)


# --------------------------------------------------------------------------
# Pure helpers — presets / toggles / settings
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "preset,expected",
    [
        (PRESET_ME3, (False, False, False)),
        (PRESET_ME3_COPILOT, (True, False, False)),
        (PRESET_ME5_COPILOT, (True, True, False)),
        (PRESET_AGENT365, (True, True, True)),
    ],
)
def test_profile_from_preset(preset: str, expected: tuple[bool, bool, bool]) -> None:
    profile = profile_from_preset(preset)
    assert (profile.copilot_seats, profile.e5, profile.agent_inventory) == expected
    assert profile.preset == preset
    assert profile.source == "manual"


def test_profile_from_preset_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        profile_from_preset("enterprise-deluxe")


def test_preset_for_roundtrips_and_falls_back_to_custom() -> None:
    assert preset_for(False, False, False) == PRESET_ME3
    assert preset_for(True, True, True) == PRESET_AGENT365
    # E5 without Copilot is a real but non-preset combination.
    assert preset_for(False, True, False) == PRESET_CUSTOM


def test_profile_from_toggles_computes_preset_label() -> None:
    profile = profile_from_toggles({"copilot_seats": True, "e5": True, "agent_inventory": False})
    assert profile.preset == PRESET_ME5_COPILOT
    # Unknown combo -> custom.
    custom = profile_from_toggles({"copilot_seats": False, "e5": True})
    assert custom.preset == PRESET_CUSTOM
    assert custom.agent_inventory is False


def test_profile_from_settings_roundtrip() -> None:
    original = profile_from_preset(PRESET_ME5_COPILOT, updated_at="2026-06-09T00:00:00Z")
    restored = profile_from_settings(original.to_dict())
    assert restored == original


def test_profile_from_settings_handles_none() -> None:
    assert profile_from_settings(None) == CapabilityProfile()


def test_default_unconfigured_profile_enables_everything() -> None:
    profile = default_unconfigured_profile()
    assert profile.copilot_seats and profile.e5 and profile.agent_inventory
    assert profile.source == "default"


# --------------------------------------------------------------------------
# Pure helpers — SKU-based suggestion
# --------------------------------------------------------------------------

def test_suggest_me3_has_no_copilot_or_e5() -> None:
    profile = suggest_from_skus([_sku("00000000-0000-0000-0000-000000000001")])
    assert profile.copilot_seats is False
    assert profile.e5 is False
    assert profile.agent_inventory is False
    assert profile.preset == PRESET_ME3
    assert profile.source == "detected"


def test_suggest_detects_copilot_seats() -> None:
    profile = suggest_from_skus([_sku(_COPILOT_PLAN)])
    assert profile.copilot_seats is True
    assert profile.preset == PRESET_ME3_COPILOT


def test_suggest_detects_e5_and_copilot() -> None:
    profile = suggest_from_skus([_sku(_COPILOT_PLAN, _E5_PLAN)])
    assert profile.copilot_seats is True
    assert profile.e5 is True
    assert profile.preset == PRESET_ME5_COPILOT


def test_suggest_uses_agent_probe_for_agent365() -> None:
    profile = suggest_from_skus([_sku(_COPILOT_PLAN, _E5_PLAN)], agent_inventory=True)
    assert profile.agent_inventory is True
    assert profile.preset == PRESET_AGENT365


# --------------------------------------------------------------------------
# Pure helpers — per-kind gating
# --------------------------------------------------------------------------

def test_allows_kind_gates_by_capability() -> None:
    me3 = profile_from_preset(PRESET_ME3)
    assert me3.allows_kind("conversation") is False
    assert me3.allows_kind("usage") is False
    assert me3.allows_kind("diagnostics") is False
    # Ungated kinds are always allowed.
    assert me3.allows_kind("audit") is True
    assert me3.allows_kind("consumption") is True
    assert me3.allows_kind("transcripts") is True
    assert me3.allows_kind("ediscovery") is True

    copilot = profile_from_preset(PRESET_ME3_COPILOT)
    assert copilot.allows_kind("conversation") is True
    assert copilot.allows_kind("usage") is True
    assert copilot.allows_kind("diagnostics") is False  # needs Agent365

    agent365 = profile_from_preset(PRESET_AGENT365)
    assert agent365.allows_kind("diagnostics") is True


# --------------------------------------------------------------------------
# Controller — persistence + guardrail
# --------------------------------------------------------------------------

def test_get_capabilities_defaults_to_unconfigured(controller: OperationsController) -> None:
    payload = controller.get_capabilities()
    assert payload["source"] == "default"
    assert payload["copilot_seats"] is True  # nothing gated until configured
    assert PRESET_ME3 in payload["presets"]


def test_set_capabilities_preset_persists(controller: OperationsController) -> None:
    result = controller.set_capabilities({"preset": PRESET_ME5_COPILOT})
    assert result["ok"] is True
    again = controller.get_capabilities()
    assert again["preset"] == PRESET_ME5_COPILOT
    assert again["copilot_seats"] is True
    assert again["e5"] is True
    assert again["agent_inventory"] is False
    assert again["source"] == "manual"


def test_set_capabilities_toggles_persists(controller: OperationsController) -> None:
    result = controller.set_capabilities({"toggles": {"copilot_seats": True}})
    assert result["ok"] is True
    again = controller.get_capabilities()
    assert again["copilot_seats"] is True
    assert again["preset"] == PRESET_ME3_COPILOT


def test_unconfigured_does_not_gate_collection(controller: OperationsController) -> None:
    # No capability set -> falls through to the (missing) token provider error,
    # not a license gate.
    result = controller.start_collection("conversation")
    assert result["ok"] is False
    assert result.get("capability") is None


def test_me3_gates_copilot_collection(controller: OperationsController) -> None:
    controller.set_capabilities({"preset": PRESET_ME3})
    result = controller.start_collection("conversation")
    assert result["ok"] is False
    assert result["capability"] == "copilot_seats"
    diag = controller.start_collection("diagnostics")
    assert diag["capability"] == "agent_inventory"


def test_copilot_preset_passes_gate_but_blocks_agents(controller: OperationsController) -> None:
    controller.set_capabilities({"preset": PRESET_ME3_COPILOT})
    # Passes the capability gate, then fails on missing credentials.
    conv = controller.start_collection("conversation")
    assert conv.get("capability") is None
    assert conv["ok"] is False
    # Agent inventory still gated.
    diag = controller.start_collection("diagnostics")
    assert diag["capability"] == "agent_inventory"


def test_ungated_kind_not_blocked_on_me3(controller: OperationsController) -> None:
    controller.set_capabilities({"preset": PRESET_ME3})
    # audit is never gated -> reaches token provider, no capability error.
    result = controller.start_collection("audit")
    assert result.get("capability") is None


# --------------------------------------------------------------------------
# Bridge — JSON slots
# --------------------------------------------------------------------------

def test_bridge_capabilities_roundtrip(qtbot, repo: Repository, options: RuntimeOptions) -> None:
    del qtbot
    controller = OperationsController(repo=repo, options=options, registry=None, profile_id=None)
    bridge = Bridge(BridgeContext(repo=repo, options=options), controller)

    initial = json.loads(bridge.capabilities())
    assert initial["source"] == "default"

    set_result = json.loads(bridge.capabilities_set(json.dumps({"preset": PRESET_AGENT365})))
    assert set_result["ok"] is True
    assert set_result["capabilities"]["agent_inventory"] is True

    after = json.loads(bridge.capabilities())
    assert after["preset"] == PRESET_AGENT365
    assert after["source"] == "manual"


def test_bridge_capabilities_set_rejects_bad_json(qtbot, repo: Repository, options: RuntimeOptions) -> None:
    del qtbot
    controller = OperationsController(repo=repo, options=options, registry=None, profile_id=None)
    bridge = Bridge(BridgeContext(repo=repo, options=options), controller)
    result = json.loads(bridge.capabilities_set("not json"))
    assert result["ok"] is False
