"""Automated Entra ID app registration via Microsoft Graph.

The bootstrap administrator signs in with delegated permissions
(``Application.ReadWrite.All`` + ``AppRoleAssignment.ReadWrite.All``)
once. This module then creates a dedicated application and service
principal in the tenant, generates a client secret, and prepares the
admin-consent URL.

The admin consent itself happens in a browser session driven by the
onboarding wizard; this module just supplies the URL and verifies the
result.
"""
from __future__ import annotations

import logging
import secrets
import socket
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx

from ..config import (
    GRAPH_APP_ROLE_AGENT_REGISTRATION_READ_ALL,
    GRAPH_APP_ROLE_AI_ENTERPRISE_INTERACTION_READ_ALL,
    GRAPH_APP_ROLE_APPLICATION_READ_ALL,
    GRAPH_APP_ROLE_AUDIT_LOG_READ_ALL,
    GRAPH_APP_ROLE_AUDIT_LOGS_QUERY_READ_ALL,
    GRAPH_APP_ROLE_COPILOT_PACKAGES_READ_ALL,
    GRAPH_APP_ROLE_COPILOT_POLICY_SETTINGS_READ,
    GRAPH_APP_ROLE_ORGANIZATION_READ_ALL,
    GRAPH_APP_ROLE_REPORT_SETTINGS_READWRITE_ALL,
    GRAPH_APP_ROLE_REPORTS_READ_ALL,
    GRAPH_APP_ROLE_USER_READ_ALL,
    GRAPH_DELEGATED_SCOPE_APP_CATALOG_READ_ALL,
    GRAPH_DELEGATED_SCOPE_COPILOT_PACKAGES_READ_ALL,
    GRAPH_DELEGATED_SCOPE_EDISCOVERY_READWRITE_ALL,
    MS_GRAPH_BASE_V1,
    MS_GRAPH_RESOURCE_ID,
)

log = logging.getLogger(__name__)


@dataclass
class RegisteredApp:
    """Credentials of a newly created Entra ID application."""

    app_id: str           # application (client) ID
    object_id: str        # directoryObject id of the application
    sp_object_id: str     # service principal object id (consent target)
    tenant_id: str
    display_name: str
    client_secret: str    # plain text; caller is responsible for protecting it
    secret_expires_at: str


# Single source of truth for the Microsoft Graph permissions this tool
# requests at app-registration time. Each entry is (display_name, guid,
# graph_type). The onboarding wizard renders the human-readable names
# from REQUIRED_GRAPH_PERMISSION_NAMES, and REQUIRED_RESOURCE_ACCESS (the
# payload sent to Graph) is derived from the same list — so the announced
# permissions and the actually-requested permissions can never drift.
# A regression test asserts the two stay in lockstep.
REQUIRED_GRAPH_PERMISSIONS: list[tuple[str, str, str]] = [
    ("AiEnterpriseInteraction.Read.All", GRAPH_APP_ROLE_AI_ENTERPRISE_INTERACTION_READ_ALL, "Role"),
    ("User.Read.All", GRAPH_APP_ROLE_USER_READ_ALL, "Role"),
    ("Organization.Read.All", GRAPH_APP_ROLE_ORGANIZATION_READ_ALL, "Role"),
    # v2 — audit + reports. AuditLog.Read.All gives Entra audits /
    # sign-ins. AuditLogsQuery.Read.All unlocks the Purview unified
    # log via Graph. Reports.Read.All pulls the Copilot usage CSVs.
    ("AuditLog.Read.All", GRAPH_APP_ROLE_AUDIT_LOG_READ_ALL, "Role"),
    ("AuditLogsQuery.Read.All", GRAPH_APP_ROLE_AUDIT_LOGS_QUERY_READ_ALL, "Role"),
    ("Reports.Read.All", GRAPH_APP_ROLE_REPORTS_READ_ALL, "Role"),
    ("ReportSettings.ReadWrite.All", GRAPH_APP_ROLE_REPORT_SETTINGS_READWRITE_ALL, "Role"),
    # Copilot admin / agent inventory. AgentRegistration.Read.All
    # unlocks /copilot/agentRegistrations, CopilotPackages.Read.All
    # unlocks /copilot/admin/catalog/packages, and
    # CopilotPolicySettings.Read unlocks policy setting probes.
    ("AgentRegistration.Read.All", GRAPH_APP_ROLE_AGENT_REGISTRATION_READ_ALL, "Role"),
    ("CopilotPackages.Read.All", GRAPH_APP_ROLE_COPILOT_PACKAGES_READ_ALL, "Role"),
    ("CopilotPolicySettings.Read", GRAPH_APP_ROLE_COPILOT_POLICY_SETTINGS_READ, "Role"),
    # Application.Read.All lets the app read service principals and their
    # appRoleAssignments. The "existing app" (BYOA) onboarding path uses the
    # app-only token to verify that every required Graph role was actually
    # granted to the customer-managed registration, so missing permissions are
    # surfaced at setup time rather than mid-collection.
    ("Application.Read.All", GRAPH_APP_ROLE_APPLICATION_READ_ALL, "Role"),
    # Delegated scope (type "Scope") for the Purview eDiscovery pipeline.
    # eDiscovery uses delegated auth (app-only is Premium-only), and the
    # scope requires admin consent. Declaring it here means the bootstrap
    # admin's tenant-wide admin consent also grants it, so a separate,
    # non-admin eDiscovery Manager can run collection without a blocked
    # per-user consent prompt.
    ("eDiscovery.ReadWrite.All (Delegated)", GRAPH_DELEGATED_SCOPE_EDISCOVERY_READWRITE_ALL, "Scope"),
    # Delegated scopes (type "Scope") for the Copilot package / agent catalog
    # sync. The catalog probe (/copilot/admin/catalog/packages) runs with a
    # delegated token, so declaring these here lets the bootstrap admin's
    # tenant-wide consent at profile creation cover them — otherwise a newly
    # onboarded profile fails the catalog step with a 401 and saves no agents.
    ("CopilotPackages.Read.All (Delegated)", GRAPH_DELEGATED_SCOPE_COPILOT_PACKAGES_READ_ALL, "Scope"),
    ("AppCatalog.Read.All (Delegated)", GRAPH_DELEGATED_SCOPE_APP_CATALOG_READ_ALL, "Scope"),
]

# Human-readable permission names, in announce order, for UI surfaces.
REQUIRED_GRAPH_PERMISSION_NAMES: list[str] = [
    name for name, _id, _type in REQUIRED_GRAPH_PERMISSIONS
]

REQUIRED_RESOURCE_ACCESS = {
    "resourceAppId": MS_GRAPH_RESOURCE_ID,
    "resourceAccess": [
        {"id": _id, "type": _type} for _name, _id, _type in REQUIRED_GRAPH_PERMISSIONS
    ],
}
REQUIRED_RESOURCE_ACCESSES = [REQUIRED_RESOURCE_ACCESS]


def _default_display_name() -> str:
    host = socket.gethostname() or "host"
    suffix = secrets.token_hex(3)
    return f"CopilotWatchTower-{host}-{suffix}"


class AppRegistrar:
    """Drives the create-app sequence on Microsoft Graph."""

    def __init__(self, delegated_token: str, tenant_id: str) -> None:
        self.tenant_id = tenant_id
        self._client = httpx.Client(
            base_url=MS_GRAPH_BASE_V1,
            headers={
                "Authorization": f"Bearer {delegated_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=30.0,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> AppRegistrar:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- destruction ------------------------------------------------

    def delete_application(self, app_object_id: str) -> bool:
        """Delete the application registration from Entra ID.

        Used by the factory-reset flow when the operator wants to fully
        tear down the tool. Deleting the application also tombstones
        the associated service principal, so we don't need to delete
        it separately.

        Returns ``True`` when the resource was found and deleted, or
        ``False`` if the application was already gone (404). Any other
        Graph error is raised.
        """
        log.info("Deleting application object_id=%s", app_object_id)
        r = self._client.delete(f"/applications/{app_object_id}")
        if r.status_code == 404:
            log.info("Application %s already absent (404)", app_object_id)
            return False
        _raise_for_graph(r)
        return True

    # ---- main flow ---------------------------------------------------

    def register(self, display_name: str | None = None) -> RegisteredApp:
        name = display_name or _default_display_name()
        log.info("Creating Entra ID application %r", name)
        app = self._create_application(name)
        log.info("Created application object_id=%s app_id=%s", app["id"], app["appId"])

        sp = self._create_service_principal(app["appId"])
        log.info("Created service principal object_id=%s", sp["id"])

        secret = self._add_password(app["id"])
        log.info("Generated client secret (display=%s, expires=%s)", secret["displayName"], secret["endDateTime"])

        return RegisteredApp(
            app_id=app["appId"],
            object_id=app["id"],
            sp_object_id=sp["id"],
            tenant_id=self.tenant_id,
            display_name=name,
            client_secret=secret["secretText"],
            secret_expires_at=secret["endDateTime"],
        )

    # ---- individual calls -------------------------------------------

    def _create_application(self, display_name: str) -> dict:
        payload = {
            "displayName": display_name,
            "signInAudience": "AzureADMyOrg",
            "description": "Tenant-admin tool that collects Microsoft 365 Copilot interaction history.",
            "tags": ["CopilotWatchTower", "TenantAdminTool"],
            "requiredResourceAccess": REQUIRED_RESOURCE_ACCESSES,
        }
        r = self._client.post("/applications", json=payload)
        _raise_for_graph(r)
        return r.json()

    def _create_service_principal(self, app_id: str) -> dict:
        payload = {"appId": app_id, "tags": ["WindowsAzureActiveDirectoryIntegratedApp"]}
        r = self._client.post("/servicePrincipals", json=payload)
        _raise_for_graph(r)
        return r.json()

    def _add_password(self, app_object_id: str) -> dict:
        end = datetime.now(UTC) + timedelta(days=180)
        # passwordCredential identifier — random GUID-shaped string for
        # bookkeeping. The portal would auto-generate this; we mirror the
        # behaviour explicitly to keep secret rotation auditable.
        identifier = secrets.token_hex(8)
        payload = {
            "passwordCredential": {
                "displayName": f"copilot-watchtower-{identifier}",
                "endDateTime": end.isoformat().replace("+00:00", "Z"),
            }
        }
        r = self._client.post(f"/applications/{app_object_id}/addPassword", json=payload)
        _raise_for_graph(r)
        return r.json()

    def set_redirect_uri(self, app_object_id: str, redirect_uri: str) -> None:
        """Register ``redirect_uri`` as a Web platform reply URL.

        The Entra admin-consent endpoint refuses to redirect to a URI
        that is not on the application's reply-URL allow-list
        (``AADSTS500113``). Because we bind the local callback server
        to a random loopback port, we cannot know the URI until just
        before opening the consent prompt — so we PATCH it in here.

        Loopback HTTP URIs are explicitly permitted under the ``web``
        platform per OAuth 2.0 BCP-212 (RFC 8252), so we register the
        URI there rather than under ``publicClient``.
        """
        log.info("Registering redirect URI %s on app %s", redirect_uri, app_object_id)
        payload = {"web": {"redirectUris": [redirect_uri]}}
        r = self._client.patch(f"/applications/{app_object_id}", json=payload)
        _raise_for_graph(r)

    def verify_redirect_uri(
        self,
        app_object_id: str,
        redirect_uri: str,
        *,
        timeout: float = 30.0,
        interval: float = 1.0,
    ) -> bool:
        """Poll Graph until ``redirect_uri`` shows up on the app.

        A blind ``time.sleep`` after PATCH is unreliable — Entra's
        Graph read replica and its auth endpoint propagate writes on
        independent schedules.  Polling the read replica until we can
        confirm the URI is there gives us much higher confidence that
        the subsequent ``/adminconsent`` request won't fail with
        ``AADSTS500113``.  Returns ``True`` once the URI is observed,
        ``False`` if we time out.
        """
        import time

        deadline = time.monotonic() + timeout
        attempts = 0
        while True:
            attempts += 1
            try:
                r = self._client.get(
                    f"/applications/{app_object_id}?$select=web"
                )
                _raise_for_graph(r)
                web = r.json().get("web") or {}
                uris = web.get("redirectUris") or []
                if redirect_uri in uris:
                    log.info(
                        "Redirect URI confirmed on app %s after %d attempt(s)",
                        app_object_id,
                        attempts,
                    )
                    return True
            except Exception:  # noqa: BLE001 — keep polling on transient errors
                log.warning(
                    "Transient error while verifying redirect URI (attempt %d)",
                    attempts,
                    exc_info=True,
                )
            if time.monotonic() >= deadline:
                log.warning(
                    "Redirect URI %s not visible on app %s after %.0fs (%d attempts)",
                    redirect_uri,
                    app_object_id,
                    timeout,
                    attempts,
                )
                return False
            time.sleep(interval)

    def add_redirect_uri(self, app_object_id: str, redirect_uri: str) -> None:
        """Append ``redirect_uri`` to the Web platform reply URL list.

        Unlike :meth:`set_redirect_uri` this is non-destructive — it
        preserves any reply URLs already registered (e.g. the loopback
        URL used during initial onboarding). Required before opening
        ``/adminconsent`` against a URI that hasn't been registered yet
        (``AADSTS50011``).
        """
        r = self._client.get(f"/applications/{app_object_id}?$select=web")
        _raise_for_graph(r)
        web = r.json().get("web") or {}
        existing = list(web.get("redirectUris") or [])
        if redirect_uri in existing:
            return
        existing.append(redirect_uri)
        log.info(
            "Appending redirect URI %s on app %s (total=%d)",
            redirect_uri,
            app_object_id,
            len(existing),
        )
        payload = {"web": {"redirectUris": existing}}
        r2 = self._client.patch(f"/applications/{app_object_id}", json=payload)
        _raise_for_graph(r2)

    def find_application_object_id(self, app_id: str) -> str:
        """Look up the directoryObject id of an application by its appId.

        Raises ``LookupError`` if the application is not visible to the
        signed-in admin (e.g. deleted, soft-deleted, or in a different
        tenant).
        """
        # OData escape: double up single quotes inside the filter value.
        safe = app_id.replace("'", "''")
        r = self._client.get(
            f"/applications?$filter=appId eq '{safe}'&$select=id,appId"
        )
        _raise_for_graph(r)
        items = r.json().get("value", [])
        if not items:
            raise LookupError(f"Application with appId={app_id!r} not found")
        return str(items[0]["id"])

    def patch_required_resource_access(self, app_object_id: str) -> None:
        """Refresh the app's required API permission set.

        Existing entries for unrelated resource APIs are preserved; entries
        managed by this app (Microsoft Graph and MicrosoftPurviewEDiscovery)
        are replaced with the current canonical payload so newly-added roles
        appear on the next admin-consent prompt.
        """
        targets = {entry["resourceAppId"]: entry for entry in REQUIRED_RESOURCE_ACCESSES}
        r = self._client.get(
            f"/applications/{app_object_id}?$select=requiredResourceAccess"
        )
        _raise_for_graph(r)
        current = r.json().get("requiredResourceAccess") or []
        merged: list[dict] = []
        seen: set[str] = set()
        for entry in current:
            resource_app_id = entry.get("resourceAppId")
            if resource_app_id in targets:
                merged.append(targets[resource_app_id])
                seen.add(resource_app_id)
            else:
                merged.append(entry)
        for resource_app_id, target in targets.items():
            if resource_app_id not in seen:
                merged.append(target)

        log.info(
            "Updating requiredResourceAccess on %s (resources=%d)",
            app_object_id,
            len(targets),
        )
        payload = {"requiredResourceAccess": merged}
        r2 = self._client.patch(f"/applications/{app_object_id}", json=payload)
        _raise_for_graph(r2)


def admin_consent_url(tenant_id: str, app_id: str, redirect_uri: str, state: str) -> str:
    from urllib.parse import urlencode

    qs = urlencode({"client_id": app_id, "state": state, "redirect_uri": redirect_uri})
    return f"https://login.microsoftonline.com/{tenant_id}/adminconsent?{qs}"


def _raise_for_graph(response: httpx.Response) -> None:
    if response.is_success:
        return
    try:
        detail = response.json()
    except Exception:
        detail = response.text
    raise httpx.HTTPStatusError(
        f"Graph request failed ({response.status_code}): {detail}",
        request=response.request,
        response=response,
    )
