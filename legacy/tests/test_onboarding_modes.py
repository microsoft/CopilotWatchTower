"""Tests for the onboarding wizard's auto vs existing-app (BYOA) modes."""
from __future__ import annotations

from pathlib import Path

import pytest

from copilot_watchtower.config import GRAPH_APP_ROLE_APPLICATION_READ_ALL
from copilot_watchtower.db import Repository, initialize
from copilot_watchtower.security import unprotect
from copilot_watchtower.services.appreg import (
    REQUIRED_GRAPH_PERMISSION_NAMES,
    REQUIRED_GRAPH_PERMISSIONS,
)
from copilot_watchtower.ui import onboarding_wizard as ow


@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "byoa.db"
    initialize(db)
    return Repository(db)


# ----- permission wiring -------------------------------------------------


def test_application_read_all_role_is_requested() -> None:
    assert GRAPH_APP_ROLE_APPLICATION_READ_ALL == "9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30"
    role_ids = {guid for _n, guid, typ in REQUIRED_GRAPH_PERMISSIONS if typ == "Role"}
    assert GRAPH_APP_ROLE_APPLICATION_READ_ALL in role_ids
    assert "Application.Read.All" in REQUIRED_GRAPH_PERMISSION_NAMES


# ----- mode selection routing -------------------------------------------


def test_mode_select_routes_auto_to_device(qtbot) -> None:
    page = ow.ModeSelectPage()
    qtbot.addWidget(page)
    page.auto_radio.setChecked(True)
    assert page.use_existing_app() is False
    assert page.nextId() == ow.PAGE_DEVICE


def test_mode_select_routes_existing_to_app_guide(qtbot) -> None:
    page = ow.ModeSelectPage()
    qtbot.addWidget(page)
    page.existing_radio.setChecked(True)
    assert page.use_existing_app() is True
    assert page.nextId() == ow.PAGE_APP_GUIDE


def test_app_guide_lists_required_permissions(qtbot) -> None:
    from PySide6.QtWidgets import QTextBrowser

    page = ow.AppSetupGuidePage()
    qtbot.addWidget(page)
    body = page.findChild(QTextBrowser)
    assert body is not None
    html = body.toHtml()
    for name, _guid, _typ in REQUIRED_GRAPH_PERMISSIONS:
        assert name in html, f"guide is missing permission: {name}"
    assert page.nextId() == ow.PAGE_MANUAL_CREDS


def test_manual_creds_routes_to_delegated_login(qtbot) -> None:
    page = ow.ManualCredentialsPage()
    qtbot.addWidget(page)
    assert page.nextId() == ow.PAGE_DELEGATED_LOGIN


def test_delegated_login_routes_to_browser_creds(qtbot) -> None:
    manual = ow.ManualCredentialsPage()
    page = ow.DelegatedLoginPage(manual)
    qtbot.addWidget(page)
    # Optional step: complete even when no sign-in ran.
    assert page.isComplete() is True
    assert page.nextId() == ow.PAGE_BROWSER_CREDS
    assert page.token_cache_blob_or_none() is None


# ----- manual credential validation -------------------------------------


def test_manual_creds_incomplete_until_validated(qtbot) -> None:
    page = ow.ManualCredentialsPage()
    qtbot.addWidget(page)
    page.tenant_edit.setText("contoso.onmicrosoft.com")
    page.client_edit.setText("client-1")
    page.secret_edit.setText("secret-1")
    # No validation yet → still incomplete.
    assert page.isComplete() is False


def test_manual_creds_complete_on_ok_check(qtbot) -> None:
    page = ow.ManualCredentialsPage()
    qtbot.addWidget(page)
    page._on_finished(
        ow._ManualCredCheck(
            ok=True,
            state="ok",
            message="ok",
            display_name="Contoso",
            tenant_domain="contoso.com",
        )
    )
    assert page.isComplete() is True


def test_manual_creds_missing_roles_is_warning_not_block(qtbot) -> None:
    page = ow.ManualCredentialsPage()
    qtbot.addWidget(page)
    page._on_finished(
        ow._ManualCredCheck(
            ok=True,
            state="missing_roles",
            message="missing",
            missing_roles=("User.Read.All",),
        )
    )
    # ok=True → advancing is allowed even with a missing-role warning.
    assert page.isComplete() is True
    assert "User.Read.All" in page.detail.text()


def test_manual_creds_auth_failure_blocks(qtbot) -> None:
    page = ow.ManualCredentialsPage()
    qtbot.addWidget(page)
    page._on_finished(
        ow._ManualCredCheck(ok=False, state="auth_failed", message="bad creds")
    )
    assert page.isComplete() is False


def test_manual_cred_worker_reports_missing_roles(monkeypatch: pytest.MonkeyPatch) -> None:
    required_roles = [
        guid for _n, guid, typ in REQUIRED_GRAPH_PERMISSIONS if typ == "Role"
    ]
    granted = set(required_roles[:-1])  # drop one → reported missing

    class _FakeProvider:
        def __init__(self, *_a, **_k) -> None:
            pass

        def acquire(self) -> str:
            return "tok"

    class _FakeGraph:
        def __init__(self, *_a, **_k) -> None:
            pass

        def organization_summary(self) -> dict[str, str | None]:
            return {"id": "t", "display_name": "Contoso", "domain": "contoso.com"}

        def granted_app_role_ids(self, _client_id: str) -> set[str]:
            return granted

        def close(self) -> None:
            pass

    monkeypatch.setattr(ow, "AppOnlyTokenProvider", _FakeProvider)
    monkeypatch.setattr(ow, "GraphClient", _FakeGraph)

    captured: list[ow._ManualCredCheck] = []
    worker = ow._ManualCredWorker("t", "c", "s")
    worker.finished.connect(captured.append)
    worker.run()

    assert len(captured) == 1
    check = captured[0]
    assert check.ok is True
    assert check.state == "missing_roles"
    assert check.missing_roles  # at least one missing
    assert check.display_name == "Contoso"


def test_manual_cred_worker_cannot_verify_on_graph_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from copilot_watchtower.services.graph import GraphError

    class _FakeProvider:
        def __init__(self, *_a, **_k) -> None:
            pass

        def acquire(self) -> str:
            return "tok"

    class _FakeGraph:
        def __init__(self, *_a, **_k) -> None:
            pass

        def organization_summary(self) -> dict[str, str | None]:
            return {"id": "t", "display_name": "Contoso", "domain": "contoso.com"}

        def granted_app_role_ids(self, _client_id: str) -> set[str]:
            raise GraphError(403, {"error": "forbidden"})

        def close(self) -> None:
            pass

    monkeypatch.setattr(ow, "AppOnlyTokenProvider", _FakeProvider)
    monkeypatch.setattr(ow, "GraphClient", _FakeGraph)

    captured: list[ow._ManualCredCheck] = []
    worker = ow._ManualCredWorker("t", "c", "s")
    worker.finished.connect(captured.append)
    worker.run()

    assert len(captured) == 1
    check = captured[0]
    assert check.ok is True
    assert check.state == "cannot_verify"


def test_manual_cred_worker_auth_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeProvider:
        def __init__(self, *_a, **_k) -> None:
            pass

        def acquire(self) -> str:
            raise RuntimeError("invalid_client")

    monkeypatch.setattr(ow, "AppOnlyTokenProvider", _FakeProvider)

    captured: list[ow._ManualCredCheck] = []
    worker = ow._ManualCredWorker("t", "c", "s")
    worker.finished.connect(captured.append)
    worker.run()

    assert len(captured) == 1
    assert captured[0].ok is False
    assert captured[0].state == "auth_failed"


# ----- existing-app completion persistence ------------------------------


def test_finish_existing_app_persists_settings(qtbot, repo: Repository) -> None:
    wiz = ow.OnboardingWizard(repo)
    qtbot.addWidget(wiz)
    wiz.mode.existing_radio.setChecked(True)
    wiz.manual_creds.tenant_edit.setText("contoso.onmicrosoft.com")
    wiz.manual_creds.client_edit.setText("client-xyz")
    wiz.manual_creds.secret_edit.setText("super-secret")
    wiz.manual_creds._check = ow._ManualCredCheck(
        ok=True,
        state="ok",
        message="ok",
        display_name="Contoso",
        tenant_domain="contoso.com",
    )
    wiz.ediscovery_browser.user_edit.setText("admin@contoso.com")
    wiz.ediscovery_browser.password_edit.setText("browser-pw")

    completed: list[object] = []
    wiz.completed.connect(completed.append)

    wiz._finish_existing_app()

    assert repo.get_text_setting("tenant_id") == "contoso.onmicrosoft.com"
    assert repo.get_text_setting("client_id") == "client-xyz"
    assert repo.get_text_setting("app_externally_managed") == "1"
    assert repo.get_text_setting("bootstrap_complete") == "1"
    assert repo.get_text_setting("app_object_id") == ""
    assert repo.get_text_setting("sp_object_id") == ""
    assert repo.get_text_setting("secret_expires_at") == ""
    assert repo.get_text_setting("display_name") == "Contoso"
    assert repo.get_text_setting("tenant_domain") == "contoso.com"
    assert unprotect(repo.get_secret("client_secret")) == "super-secret"
    assert repo.get_text_setting("ediscovery_browser_user") == "admin@contoso.com"
    assert unprotect(repo.get_secret("ediscovery_browser_password")) == "browser-pw"
    assert len(completed) == 1


def test_is_existing_app_mode_reflects_selection(qtbot, repo: Repository) -> None:
    wiz = ow.OnboardingWizard(repo)
    qtbot.addWidget(wiz)
    assert wiz.is_existing_app_mode() is False
    wiz.mode.existing_radio.setChecked(True)
    assert wiz.is_existing_app_mode() is True


def test_browser_creds_nextid_branches_on_mode(qtbot, repo: Repository) -> None:
    wiz = ow.OnboardingWizard(repo)
    qtbot.addWidget(wiz)
    # Auto mode → usage page next.
    wiz.mode.auto_radio.setChecked(True)
    assert wiz.ediscovery_browser.nextId() == ow.PAGE_USAGE
    # Existing-app mode → straight to done.
    wiz.mode.existing_radio.setChecked(True)
    assert wiz.ediscovery_browser.nextId() == ow.PAGE_DONE


def test_consent_nextid_skips_byoa_pages(qtbot, repo: Repository) -> None:
    wiz = ow.OnboardingWizard(repo)
    qtbot.addWidget(wiz)
    assert wiz.consent.nextId() == ow.PAGE_BROWSER_CREDS

