"""Tests for the backend message catalog and active-language switching.

The default language is Korean, so the rest of the suite asserts Korean
strings without any setup. These tests exercise the English (``en_US``)
rendering path and confirm the catalog stays in sync for both languages.
"""
from __future__ import annotations

import pytest

from copilot_watchtower.i18n import (
    get_active_language,
    set_active_language,
    translate,
)
from copilot_watchtower.i18n.messages import MESSAGES
from copilot_watchtower.services import admin_diagnostics, audit_query
from copilot_watchtower.webshell import actions


@pytest.fixture(autouse=True)
def _reset_active_language():
    """Keep tests isolated: always restore Korean after each test."""
    previous = get_active_language()
    yield
    set_active_language(previous)


# ---- translate() core behavior --------------------------------------


def test_translate_defaults_to_korean():
    set_active_language("ko_KR")
    assert translate("audit.affectedUsers", count=3) == "영향 사용자: 3명"


def test_translate_english():
    set_active_language("en_US")
    assert translate("audit.affectedUsers", count=3) == "Affected users: 3"


def test_translate_explicit_language_overrides_active():
    set_active_language("ko_KR")
    assert translate("audit.topApps", "en_US") == "Top apps"
    # Active language is unchanged by an explicit override.
    assert get_active_language() == "ko_KR"


def test_translate_unknown_key_returns_key():
    assert translate("does.not.exist") == "does.not.exist"


def test_translate_missing_params_returns_template():
    # Missing format params must not raise; the raw template is returned.
    assert "{count}" in translate("audit.affectedUsers")


def test_unknown_language_falls_back_to_korean():
    set_active_language("ja_JP")  # unsupported -> normalized to ko_KR
    assert get_active_language() == "ko_KR"
    assert translate("audit.topApps") == "상위 앱"


# ---- catalog integrity ----------------------------------------------


def test_every_entry_has_both_languages():
    missing = [
        key
        for key, langs in MESSAGES.items()
        if "ko_KR" not in langs or "en_US" not in langs
    ]
    assert not missing, f"entries missing a translation: {missing}"


def test_placeholders_match_across_languages():
    import re

    def fields(template: str) -> set[str]:
        return set(re.findall(r"{(\w+)}", template))

    mismatched = [
        key
        for key, langs in MESSAGES.items()
        if fields(langs["ko_KR"]) != fields(langs["en_US"])
    ]
    assert not mismatched, f"placeholder mismatch ko/en: {mismatched}"


# ---- service-layer rendering follows the active language ------------


def test_audit_window_detail_english():
    set_active_language("en_US")
    assert audit_query._window_detail("2024-01-01", "2024-01-31") == (
        "Range: 2024-01-01 ~ 2024-01-31"
    )


def test_audit_counter_detail_english():
    from collections import Counter

    set_active_language("en_US")
    detail = audit_query._counter_detail(
        translate("audit.topApps"), Counter({"Microsoft 365 Copilot": 1})
    )
    assert detail == "Top apps: Microsoft 365 Copilot ×1"


def test_admin_diag_error_summary_english():
    set_active_language("en_US")
    assert admin_diagnostics._error_summary("forbidden") == (
        "Access denied by permissions or admin policy (consent may be pending)"
    )
    assert admin_diagnostics._error_summary(
        "forbidden", "Agent 365 license required"
    ) == "Tenant without an Agent 365 license (agent catalog unavailable)"


def test_admin_diag_limited_mode_english():
    set_active_language("en_US")
    assert admin_diagnostics._summarize_limited_mode(
        {"isEnabledForGroup": True, "groupId": "G1"}
    ) == "Group limited mode on (G1)"


def test_run_log_summary_english():
    set_active_language("en_US")
    summary = actions._run_log_summary(
        "conversation", {"users": 2, "interactions": 10, "errors": 0}
    )
    assert summary == "Users 2 · Conversations 10 · Errors 0"


def test_run_log_summary_korean_unchanged():
    set_active_language("ko_KR")
    summary = actions._run_log_summary(
        "conversation", {"users": 2, "interactions": 10, "errors": 0}
    )
    assert summary == "사용자 2 · 대화 10 · 오류 0"
