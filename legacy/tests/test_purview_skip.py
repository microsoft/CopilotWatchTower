"""Unit tests for the per-profile ``purview_rbac_granted`` skip flag.

These tests verify that once a previous wizard run has successfully
granted the Purview audit-log role for a profile, subsequent entries to
:class:`PurviewRolePage` short-circuit the PowerShell call entirely
(no ``Connect-IPPSSession`` popup, no QThread started).
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from copilot_watchtower.db import Repository, initialize


@pytest.fixture()
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


@pytest.fixture()
def fake_registration_page() -> SimpleNamespace:
    """Stand-in for RegistrationPage that exposes ``app().sp_object_id``."""
    return SimpleNamespace(
        app=lambda: SimpleNamespace(
            sp_object_id="00000000-0000-0000-0000-000000000001"
        )
    )


@pytest.fixture()
def fake_device_page() -> SimpleNamespace:
    """Stand-in for DeviceCodePage that exposes a bootstrap Graph token."""
    return SimpleNamespace(token=lambda: "fake-bootstrap-token")


def test_skip_when_flag_already_set(qtbot, repo, fake_registration_page):
    """If ``purview_rbac_granted == '1'``, the page must not start a worker."""
    # Local import so we don't construct QApplication at module import time
    # — pytest-qt's ``qtbot`` fixture ensures one exists before this runs.
    from copilot_watchtower.ui.onboarding_wizard import PurviewRolePage

    repo.set_text_setting("purview_rbac_granted", "1")

    page = PurviewRolePage(fake_registration_page, repo)
    qtbot.addWidget(page)
    page.initializePage()

    outcome = page.outcome()
    assert outcome is not None, "Page should have a synthetic outcome"
    assert outcome.success is True
    assert outcome.state == "already_granted"
    assert page._thread is None, "No QThread should be spawned on skip"
    assert page._running is False
    assert page.isComplete() is True


def test_runs_when_flag_absent(monkeypatch, qtbot, repo, fake_registration_page, fake_device_page):
    """Without the flag, the Graph worker is started."""
    from copilot_watchtower.ui.onboarding_wizard import PurviewRolePage

    # Sanity: the flag really isn't set.
    assert repo.get_text_setting("purview_rbac_granted") is None

    # Replace ensure_audit_reader_role so we don't call Graph in this unit test.
    from copilot_watchtower.services import purview_rbac as _mod
    from copilot_watchtower.services.purview_rbac import RbacOutcome

    monkeypatch.setattr(
        _mod,
        "ensure_audit_reader_role",
        lambda *a, **kw: RbacOutcome(
            success=True, state="added", message="stub: added"
        ),
    )
    # The worker imports the symbol into the wizard module — patch that
    # binding too.
    from copilot_watchtower.ui import onboarding_wizard as _wiz

    monkeypatch.setattr(
        _wiz, "ensure_audit_reader_role", _mod.ensure_audit_reader_role
    )

    page = PurviewRolePage(fake_registration_page, repo, device_page=fake_device_page)
    qtbot.addWidget(page)
    page.initializePage()

    # Wait for the worker thread to finish (it's instantaneous with the stub).
    qtbot.waitUntil(lambda: page.outcome() is not None, timeout=2000)
    outcome = page.outcome()
    assert outcome is not None
    assert outcome.state == "added"
    assert outcome.success is True


def test_no_repo_means_no_skip(monkeypatch, qtbot, fake_registration_page, fake_device_page):
    """Defensive: ``repo=None`` must not crash and must not short-circuit."""
    from copilot_watchtower.services import purview_rbac as _mod
    from copilot_watchtower.services.purview_rbac import RbacOutcome
    from copilot_watchtower.ui import onboarding_wizard as _wiz
    from copilot_watchtower.ui.onboarding_wizard import PurviewRolePage

    monkeypatch.setattr(
        _mod,
        "ensure_audit_reader_role",
        lambda *a, **kw: RbacOutcome(
            success=True, state="added", message="stub: added"
        ),
    )
    monkeypatch.setattr(
        _wiz, "ensure_audit_reader_role", _mod.ensure_audit_reader_role
    )

    page = PurviewRolePage(fake_registration_page, repo=None, device_page=fake_device_page)
    qtbot.addWidget(page)
    page.initializePage()

    qtbot.waitUntil(lambda: page.outcome() is not None, timeout=2000)
    assert page.outcome().state == "added"


def test_skip_button_persists_flag_and_marks_complete(
    monkeypatch, qtbot, repo, fake_registration_page, fake_device_page
):
    """Skip button: confirms, marks complete, persists ``purview_rbac_granted``."""
    from PySide6.QtWidgets import QMessageBox

    from copilot_watchtower.services import purview_rbac as _mod
    from copilot_watchtower.services.purview_rbac import RbacOutcome
    from copilot_watchtower.ui import onboarding_wizard as _wiz
    from copilot_watchtower.ui.onboarding_wizard import PurviewRolePage

    # Make the worker return a failure so the page is in a state where
    # the skip button is the right escape hatch (mirrors the screenshot:
    # role_group_missing).
    monkeypatch.setattr(
        _mod,
        "ensure_audit_reader_role",
        lambda *a, **kw: RbacOutcome(
            success=False,
            state="role_group_missing",
            message="stub: role group missing",
        ),
    )
    monkeypatch.setattr(
        _wiz, "ensure_audit_reader_role", _mod.ensure_audit_reader_role
    )
    # Auto-confirm the "건너뛰기 확인" dialog.
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.Yes
    )

    page = PurviewRolePage(fake_registration_page, repo, device_page=fake_device_page)
    qtbot.addWidget(page)
    page.initializePage()
    qtbot.waitUntil(lambda: page.outcome() is not None, timeout=2000)
    assert page.outcome().state == "role_group_missing"

    # Now the user clicks Skip.
    page._on_skip_clicked()

    outcome = page.outcome()
    assert outcome is not None
    assert outcome.success is True
    assert outcome.state == "skipped_by_user"
    assert page.isComplete() is True
    # Flag is persisted so future wizard runs auto-skip.
    assert repo.get_text_setting("purview_rbac_granted") == "1"
    # Skip button disables itself after use.
    assert page.skip_btn.isEnabled() is False


def test_skip_is_cancelled_when_user_declines_confirmation(
    monkeypatch, qtbot, repo, fake_registration_page, fake_device_page
):
    """If the user picks 'No' in the confirmation dialog, nothing changes."""
    from PySide6.QtWidgets import QMessageBox

    from copilot_watchtower.services import purview_rbac as _mod
    from copilot_watchtower.services.purview_rbac import RbacOutcome
    from copilot_watchtower.ui import onboarding_wizard as _wiz
    from copilot_watchtower.ui.onboarding_wizard import PurviewRolePage

    monkeypatch.setattr(
        _mod,
        "ensure_audit_reader_role",
        lambda *a, **kw: RbacOutcome(
            success=False, state="rbac_denied", message="stub: denied"
        ),
    )
    monkeypatch.setattr(
        _wiz, "ensure_audit_reader_role", _mod.ensure_audit_reader_role
    )
    monkeypatch.setattr(
        QMessageBox, "question", lambda *a, **kw: QMessageBox.No
    )

    page = PurviewRolePage(fake_registration_page, repo, device_page=fake_device_page)
    qtbot.addWidget(page)
    page.initializePage()
    qtbot.waitUntil(lambda: page.outcome() is not None, timeout=2000)
    assert page.outcome().state == "rbac_denied"

    page._on_skip_clicked()

    # Outcome unchanged, no flag persisted.
    assert page.outcome().state == "rbac_denied"
    assert repo.get_text_setting("purview_rbac_granted") is None
    assert page.skip_btn.isEnabled() is True
