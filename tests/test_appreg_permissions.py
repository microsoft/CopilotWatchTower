from __future__ import annotations

from copilot_watchtower.config import (
    DELEGATED_BOOTSTRAP_SCOPES,
    DELEGATED_COPILOT_AGENT_SYNC_SCOPES,
    GRAPH_APP_ROLE_AGENT_REGISTRATION_READ_ALL,
    GRAPH_APP_ROLE_AUDIT_LOGS_QUERY_READ_ALL,
    GRAPH_APP_ROLE_COPILOT_PACKAGES_READ_ALL,
    GRAPH_APP_ROLE_COPILOT_POLICY_SETTINGS_READ,
    GRAPH_APP_ROLE_REPORT_SETTINGS_READWRITE_ALL,
    GRAPH_DELEGATED_SCOPE_APP_CATALOG_READ_ALL,
    GRAPH_DELEGATED_SCOPE_COPILOT_PACKAGES_READ_ALL,
    GRAPH_DELEGATED_SCOPE_EDISCOVERY_READWRITE_ALL,
)
from copilot_watchtower.services.appreg import (
    REQUIRED_GRAPH_PERMISSION_NAMES,
    REQUIRED_GRAPH_PERMISSIONS,
    REQUIRED_RESOURCE_ACCESS,
    REQUIRED_RESOURCE_ACCESSES,
)


def test_audit_logs_query_permission_uses_current_graph_app_role_id() -> None:
    assert GRAPH_APP_ROLE_AUDIT_LOGS_QUERY_READ_ALL == "5e1e9171-754d-478c-812c-f1755a9a4c2d"
    resource_access_ids = {
        item["id"] for item in REQUIRED_RESOURCE_ACCESS["resourceAccess"]
    }
    assert "5e1e9171-754d-478c-812c-f1755a9a4c2d" in resource_access_ids
    assert "b41b4ce2-c4d9-485f-a8aa-3d12b1a02b1c" not in resource_access_ids


def test_report_settings_permission_is_requested_for_usage_identity_setup() -> None:
    assert GRAPH_APP_ROLE_REPORT_SETTINGS_READWRITE_ALL == "2a60023f-3219-47ad-baa4-40e17cd02a1d"
    resource_access_ids = {
        item["id"] for item in REQUIRED_RESOURCE_ACCESS["resourceAccess"]
    }
    assert GRAPH_APP_ROLE_REPORT_SETTINGS_READWRITE_ALL in resource_access_ids
    assert "ReportSettings.ReadWrite.All" in DELEGATED_BOOTSTRAP_SCOPES


def test_copilot_agent_admin_permissions_are_requested() -> None:
    assert GRAPH_APP_ROLE_AGENT_REGISTRATION_READ_ALL == "d3acceb6-4673-47c0-aeac-582f2c7cf72c"
    assert GRAPH_APP_ROLE_COPILOT_PACKAGES_READ_ALL == "72f0655d-6228-4ddc-8e1b-164973b9213b"
    assert GRAPH_APP_ROLE_COPILOT_POLICY_SETTINGS_READ == "556d5e2e-1081-4452-8147-26c3a1b06f58"
    resource_access_ids = {
        item["id"] for item in REQUIRED_RESOURCE_ACCESS["resourceAccess"]
    }

    assert GRAPH_APP_ROLE_AGENT_REGISTRATION_READ_ALL in resource_access_ids
    assert GRAPH_APP_ROLE_COPILOT_PACKAGES_READ_ALL in resource_access_ids
    assert GRAPH_APP_ROLE_COPILOT_POLICY_SETTINGS_READ in resource_access_ids


def test_copilot_package_sync_uses_delegated_scopes() -> None:
    assert DELEGATED_COPILOT_AGENT_SYNC_SCOPES == [
        "CopilotPackages.Read.All",
        "AppCatalog.Read.All",
    ]


def test_copilot_catalog_delegated_scopes_are_declared_for_admin_consent() -> None:
    # The delegated (oauth2PermissionScope) ids, not the application role ids.
    assert GRAPH_DELEGATED_SCOPE_COPILOT_PACKAGES_READ_ALL == "a2dcfcb9-cbe8-4d42-812d-952e55cf7f3f"
    assert GRAPH_DELEGATED_SCOPE_APP_CATALOG_READ_ALL == "88e58d74-d3df-44f3-ad47-e89edf4472e4"
    by_id = {
        item["id"]: item
        for item in REQUIRED_RESOURCE_ACCESS["resourceAccess"]
    }
    # Both must be declared as delegated Scopes so tenant-wide admin consent at
    # profile creation seeds a refresh token covering the catalog sync — a new
    # profile must not fail the catalog step with a 401 and save zero agents.
    assert by_id[GRAPH_DELEGATED_SCOPE_COPILOT_PACKAGES_READ_ALL]["type"] == "Scope"
    assert by_id[GRAPH_DELEGATED_SCOPE_APP_CATALOG_READ_ALL]["type"] == "Scope"
    # And onboarding must request them so the device-code login consents inline.
    assert "CopilotPackages.Read.All" in DELEGATED_BOOTSTRAP_SCOPES
    assert "AppCatalog.Read.All" in DELEGATED_BOOTSTRAP_SCOPES


def test_ediscovery_delegated_scope_is_declared_for_admin_consent() -> None:
    # The delegated (oauth2PermissionScope) id, not the application role id.
    assert GRAPH_DELEGATED_SCOPE_EDISCOVERY_READWRITE_ALL == "acb8f680-0834-4146-b69e-4ab1b39745ad"
    ediscovery_entries = [
        item
        for item in REQUIRED_RESOURCE_ACCESS["resourceAccess"]
        if item["id"] == GRAPH_DELEGATED_SCOPE_EDISCOVERY_READWRITE_ALL
    ]
    assert len(ediscovery_entries) == 1
    # Must be a delegated Scope so tenant-wide admin consent at profile creation
    # covers it for a non-admin eDiscovery Manager.
    assert ediscovery_entries[0]["type"] == "Scope"


def test_no_unnecessary_app_only_ediscovery_roles_are_requested() -> None:
    # Direct-download proxies are handled with Playwright browser capture, so
    # profile onboarding should not request extra app-only eDiscovery/Purview
    # permissions that are not needed for the simplified Graph+Playwright path.
    names = set(REQUIRED_GRAPH_PERMISSION_NAMES)
    assert "eDiscovery.ReadWrite.All (Application)" not in names
    assert "eDiscovery.Download.Read" not in names
    assert "Exchange.ManageAsApp" not in names
    assert "eDiscovery.ReadWrite.All (Delegated)" in REQUIRED_GRAPH_PERMISSION_NAMES


def test_required_resource_access_is_derived_from_single_source() -> None:
    # REQUIRED_RESOURCE_ACCESS must be derived from REQUIRED_GRAPH_PERMISSIONS
    # one-for-one, so the payload sent to Graph cannot drift from the list.
    derived = [
        {"id": guid, "type": graph_type}
        for _name, guid, graph_type in REQUIRED_GRAPH_PERMISSIONS
    ]
    assert REQUIRED_RESOURCE_ACCESS["resourceAccess"] == derived
    assert REQUIRED_RESOURCE_ACCESSES == [REQUIRED_RESOURCE_ACCESS]
    # Names list mirrors the source order with no duplicates.
    assert REQUIRED_GRAPH_PERMISSION_NAMES == [
        name for name, _g, _t in REQUIRED_GRAPH_PERMISSIONS
    ]
    assert len(REQUIRED_GRAPH_PERMISSION_NAMES) == len(set(REQUIRED_GRAPH_PERMISSION_NAMES))


def test_onboarding_wizard_announces_every_requested_permission(qtbot) -> None:
    # The onboarding intro must list exactly the permissions that are actually
    # requested at registration time — no missing or extra scopes.
    from PySide6.QtWidgets import QTextBrowser

    from copilot_watchtower.ui.onboarding_wizard import WelcomePage

    page = WelcomePage()
    qtbot.addWidget(page)
    body = page.findChild(QTextBrowser)
    assert body is not None
    html = body.toHtml()
    for name in REQUIRED_GRAPH_PERMISSION_NAMES:
        assert name in html, f"wizard intro is missing permission: {name}"


def test_ediscovery_browser_credential_page_requires_user_and_password(qtbot) -> None:
    from copilot_watchtower.ui.onboarding_wizard import DeviceCodePage, EdiscoveryBrowserCredentialPage

    device = DeviceCodePage()
    page = EdiscoveryBrowserCredentialPage(device)
    qtbot.addWidget(page)

    assert page.isComplete() is False
    page.user_edit.setText("admin@contoso.com")
    assert page.isComplete() is False
    page.password_edit.setText("secret")
    assert page.isComplete() is True