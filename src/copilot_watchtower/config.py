"""Application paths and runtime configuration.

Centralizes resolution of per-user data directories on Windows
(`%LOCALAPPDATA%\\CopilotWatchTower`) and exposes the application
constants used by the rest of the package.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from . import __app_name__

# Microsoft Graph PowerShell well-known client ID — reused for the
# delegated bootstrap flow so administrators do not need to pre-register
# any Entra application before running the tool. Confirmed in the plan
# (`/memories/session/plan.md`, Phase 1).
BOOTSTRAP_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"

MS_GRAPH_RESOURCE_ID = "00000003-0000-0000-c000-000000000000"
MS_GRAPH_BASE_V1 = "https://graph.microsoft.com/v1.0"
MS_GRAPH_BASE_BETA = "https://graph.microsoft.com/beta"

# Update / release distribution. The desktop app checks the latest
# published GitHub Release to surface new versions in Settings.
GITHUB_REPO_SLUG = "microsoft/CopilotWatchTower"
GITHUB_RELEASES_LATEST_URL = (
    f"https://api.github.com/repos/{GITHUB_REPO_SLUG}/releases/latest"
)
GITHUB_RELEASES_PAGE_URL = f"https://github.com/{GITHUB_REPO_SLUG}/releases/latest"

# Application permission GUIDs (app role IDs on the Microsoft Graph SP).
GRAPH_APP_ROLE_AI_ENTERPRISE_INTERACTION_READ_ALL = "839c90ab-5771-41ee-aef8-a562e8487c1e"
GRAPH_APP_ROLE_USER_READ_ALL = "df021288-bdef-4463-88db-98f22de89214"
GRAPH_APP_ROLE_ORGANIZATION_READ_ALL = "498476ce-e0fe-48b0-b801-37ba7e2685c6"
# v2: audit + reports permissions (Phase B). All application-scoped Roles.
GRAPH_APP_ROLE_AUDIT_LOG_READ_ALL = "b0afded3-3588-46d8-8b3d-9842eff778da"
GRAPH_APP_ROLE_AUDIT_LOGS_QUERY_READ_ALL = "5e1e9171-754d-478c-812c-f1755a9a4c2d"
GRAPH_APP_ROLE_REPORTS_READ_ALL = "230c1aed-a721-4c5d-9cb4-a90514e508ef"
GRAPH_APP_ROLE_REPORT_SETTINGS_READWRITE_ALL = "2a60023f-3219-47ad-baa4-40e17cd02a1d"
# v3: Copilot admin/agent inventory APIs. These are application-scoped
# Microsoft Graph roles used by /copilot/agentRegistrations and the
# Copilot admin catalog/policy endpoints.
GRAPH_APP_ROLE_AGENT_REGISTRATION_READ_ALL = "d3acceb6-4673-47c0-aeac-582f2c7cf72c"
GRAPH_APP_ROLE_COPILOT_PACKAGES_READ_ALL = "72f0655d-6228-4ddc-8e1b-164973b9213b"
GRAPH_APP_ROLE_COPILOT_POLICY_SETTINGS_READ = "556d5e2e-1081-4452-8147-26c3a1b06f58"

# MicrosoftPurviewEDiscovery resource. Kept as a token-audience candidate for
# non-proxy export URLs; direct-download proxy URLs go through Playwright.
PURVIEW_EDISCOVERY_RESOURCE_ID = "b26e684c-5068-4120-a679-64a5d2c909d9"

# Delegated permission (oauth2PermissionScope) GUID for eDiscovery.ReadWrite.All
# on the Microsoft Graph SP. NOTE: this is the *delegated* scope id and is
# distinct from the application role id (b2620db1-3bf7-4c5b-9cb9-576d29eac736).
# It is declared in the app registration so the bootstrap admin's tenant-wide
# admin consent also covers eDiscovery — letting a non-admin eDiscovery Manager
# run collection later without hitting an individual consent prompt (which they
# cannot satisfy, since eDiscovery.ReadWrite.All requires admin consent).
GRAPH_DELEGATED_SCOPE_EDISCOVERY_READWRITE_ALL = "acb8f680-0834-4146-b69e-4ab1b39745ad"

# Delegated scopes used during bootstrap.
#
# ``RoleManagement.ReadWrite.Exchange`` lets the bootstrap admin grant the
# service principal the Exchange Online "View-Only Audit Logs" role via the
# Microsoft Graph beta ``/roleManagement/exchange/roleAssignments``
# endpoint — bypassing the brittle ExchangeOnlineManagement PowerShell
# path which can route role-group lookups to the wrong recipient catalog
# on tenants migrated to Microsoft Purview unified RBAC.
DELEGATED_BOOTSTRAP_SCOPES = [
    "Application.ReadWrite.All",
    "AppRoleAssignment.ReadWrite.All",
    "Directory.Read.All",
    "RoleManagement.ReadWrite.Exchange",
    "ReportSettings.ReadWrite.All",
    # Requested during onboarding so the bootstrap admin consents to (and
    # obtains a refresh token for) the new Purview eDiscovery experience in
    # the same sign-in. The cached refresh token then lets eDiscovery
    # collection acquire tokens silently — no second device-code login.
    "eDiscovery.ReadWrite.All",
]

DELEGATED_COPILOT_AGENT_SYNC_SCOPES = [
    "CopilotPackages.Read.All",
    "AppCatalog.Read.All",
]

# Delegated scopes for the new Microsoft Purview eDiscovery experience.
#
# The new eDiscovery Graph endpoints (``/security/cases/ediscoveryCases``)
# support *delegated* authentication, so an eDiscovery Manager can run
# on-demand collection of a single user's Copilot interactions (including
# users without a Copilot license, whose prompts/responses are still
# stored in their mailbox).
#
# IMPORTANT — this scope alone is NOT sufficient. Two further gates apply
# at run time and are outside the OAuth consent:
#   1. The signed-in user must belong to an eDiscovery role group
#      (eDiscovery Manager or Administrator) in Microsoft Purview, or the
#      API returns 403 even with a valid token.
#   2. Creating/exporting eDiscovery searches via these endpoints requires
#      the tenant's eDiscovery (Premium) capability; on non-premium
#      tenants the export/download stage may be rejected. Verify against a
#      live tenant before relying on the Graph export path.
DELEGATED_EDISCOVERY_SCOPES = [
    "eDiscovery.ReadWrite.All",
]

# Client-credentials scope (always /.default for app-only tokens).
CLIENT_CREDENTIALS_SCOPE = "https://graph.microsoft.com/.default"

# ---------------------------------------------------------------------------
# Power Platform Licensing API (unofficial)
# ---------------------------------------------------------------------------
#
# The Power Platform Admin Center (PPAC) downloads tenant consumption reports
# (Copilot Studio messages, AI Builder credits, Power Platform requests) from
# an *unofficial* licensing service. There is no published contract, so the
# exact request paths are subject to change without notice — by design the
# collector surfaces failures clearly rather than guessing silently.
#
# Auth model: a *delegated* token for the licensing audience. MSAL refresh
# tokens are multi-resource, so the account seeded during onboarding can mint
# a token for this audience silently (see DelegatedDeviceCodeTokenProvider).
# The signed-in user must be Power Platform Admin or Global Admin or the
# service returns 403.
LICENSING_API_RESOURCE = "https://licensing.powerplatform.microsoft.com"
LICENSING_API_BASE = f"{LICENSING_API_RESOURCE}/v1.0"
LICENSING_API_SCOPE = f"{LICENSING_API_RESOURCE}/.default"
DELEGATED_LICENSING_SCOPES = [LICENSING_API_SCOPE]

# Host that the consumption reports are served from. Used to recognise the
# bearer token the Power Platform Admin Center SPA mints for this audience.
LICENSING_API_HOST = "licensing.powerplatform.microsoft.com"

# Browser-driven collection (no standalone delegated token to expire).
# ---------------------------------------------------------------------------
# Rather than minting a separate MSAL delegated token for the licensing
# audience (which expires independently and forces a re-login), consumption
# collection drives a real Power Platform Admin Center sign-in with Playwright
# and reuses the licensing bearer token that the admin-center SPA already
# acquires. Collection therefore works whenever the stored admin can sign into
# PPAC — there is no separate token cache to expire.
PPAC_BASE_URL = "https://admin.powerplatform.microsoft.com"
# Page whose load drives the SPA to request a licensing-audience token.
PPAC_CONSUMPTION_URL = f"{PPAC_BASE_URL}/resources/capacity"

# Report-type identifiers exposed by the licensing service. These map to the
# consumption categories surfaced in PPAC. Stored verbatim in the
# ``report_type`` column so the UI can pivot on them.
LICENSING_REPORT_MCS_MESSAGES = "MCSMessages"            # Copilot Studio messages
LICENSING_REPORT_AI_BUILDER = "AIByUserAndEnvironment"   # AI Builder credits
LICENSING_REPORT_API_LICENSED = "ApiByLicensedUser"      # Power Platform requests (licensed)
LICENSING_REPORT_API_NONLICENSED = "ApiByNonLicensedUser"
LICENSING_REPORT_API_FLOW = "ApiByFlow"

LICENSING_REPORT_TYPES = (
    LICENSING_REPORT_MCS_MESSAGES,
    LICENSING_REPORT_AI_BUILDER,
    LICENSING_REPORT_API_LICENSED,
    LICENSING_REPORT_API_NONLICENSED,
    LICENSING_REPORT_API_FLOW,
)

# Unit each report measures (used for display and credit conversion).
LICENSING_REPORT_UNITS = {
    LICENSING_REPORT_MCS_MESSAGES: "messages",
    LICENSING_REPORT_AI_BUILDER: "credits",
    LICENSING_REPORT_API_LICENSED: "requests",
    LICENSING_REPORT_API_NONLICENSED: "requests",
    LICENSING_REPORT_API_FLOW: "requests",
}

# ---------------------------------------------------------------------------
# Dataverse — Copilot Studio conversation transcripts (custom engine agents)
# ---------------------------------------------------------------------------
# Copilot Studio persists *every* channel's conversation (Teams, web, etc.)
# into the Dataverse ``conversationtranscript`` table of the environment that
# hosts the agent. The Graph ``getAllEnterpriseInteractions`` substrate only
# captures BizChat-channel turns, so custom-engine agents chatted from Teams
# are invisible there. Reading the Dataverse table directly recovers them.
#
# Auth mirrors the consumption collector: rather than minting a standalone
# delegated token (which expires independently), we drive a real Power Apps
# maker-portal sign-in with Playwright and reuse the ``*.crm.dynamics.com``
# bearer tokens that the SPA already acquires for each environment + the
# Global Discovery Service.
DATAVERSE_DISCOVERY_RESOURCE = "https://globaldisco.crm.dynamics.com"
DATAVERSE_DISCOVERY_INSTANCES_URL = (
    f"{DATAVERSE_DISCOVERY_RESOURCE}/api/discovery/v2.0/Instances"
)
# Dataverse Web API version segment ({org}/api/data/{version}/...).
DATAVERSE_API_VERSION = "v9.2"
# Host fragment that identifies a Dataverse-audience bearer token / request.
# Regional Dataverse instances live on numbered hosts — North America is
# ``*.crm.dynamics.com`` but other regions are ``*.crmN.dynamics.com`` (e.g.
# Korea is ``*.crm21.dynamics.com``). Matching only ``crm.dynamics.com`` would
# silently drop every non-NA region's token, so we match the broader
# ``.dynamics.com`` suffix (the Global Discovery host is excluded separately).
DATAVERSE_TOKEN_HOST_FRAGMENT = ".dynamics.com"
# Maker portal page whose load drives the SPA to acquire Dataverse tokens.
POWERAPPS_MAKER_URL = "https://make.powerapps.com/environments"
# Maker portal page for a *specific* environment. Loading it makes the SPA
# silently mint that environment's org-audience Dataverse token via MSAL, which
# is how we obtain a token per environment (Global Discovery is unreachable).
POWERAPPS_MAKER_ENV_URL = "https://make.powerapps.com/environments/{env_id}/home"
# Fallback maker page that *always* calls the environment's Dataverse Web API
# (it lists solutions from the org), forcing MSAL to mint the org token when the
# home page alone does not trigger an org API call.
POWERAPPS_MAKER_ENV_SOLUTIONS_URL = (
    "https://make.powerapps.com/environments/{env_id}/solutions"
)
# Power Platform admin center page for a *specific* environment. A tenant admin
# can open it and add themselves to an environment they lack maker access to
# (the "+ 나 추가" / "Add myself" button on the System administrator panel),
# breaking the chicken-and-egg cycle where an org-audience Dataverse token can
# not be minted for an environment the signed-in user can not reach. Used only
# when the operator opts in via the collection page checkbox.
POWERPLATFORM_ADMIN_ENV_URL = (
    "https://admin.powerplatform.microsoft.com/manage/environments/{env_id}/hub"
)
# Business Application Platform (BAP) API. The maker portal calls this to
# enumerate every environment the signed-in user can reach (the Global
# Discovery Service token is a different audience we usually cannot mint), so we
# reuse the captured BAP token to list environments + their org URLs.
BAP_RESOURCE = "https://api.bap.microsoft.com"
BAP_API_VERSION = "2023-06-01"
BAP_ENVIRONMENTS_URL = (
    f"{BAP_RESOURCE}/providers/Microsoft.BusinessAppPlatform/environments"
    f"?api-version={BAP_API_VERSION}&$expand=properties.linkedEnvironmentMetadata"
)
# Host fragment that identifies a BAP-audience bearer token / request.
BAP_TOKEN_HOST_FRAGMENT = "api.bap.microsoft.com"
# Default look-back window. Copilot Studio transcripts default to a 30-day
# retention, so periodic collection inside that window is required to avoid
# permanent data loss.
DATAVERSE_DEFAULT_WINDOW_DAYS = 28

# Candidate audiences for *backend* eDiscovery export downloads from the
# eDiscovery proxy service (``*.proxyservice.ediscovery.svc.cloud.microsoft``).
#
# The Graph control plane (case/search/export create + poll) is authorised
# with a ``graph.microsoft.com`` token, but the proxy that streams the actual
# export package does NOT accept a Graph-audience token. Some tenants expose a
# server-side download path for Exchange/Purview audiences; newer
# IsDirectDownloadProxy links may still reject every access token and require
# an interactive id_token browser session. The app tries these audiences
# silently and, by design, does not open a manual browser fallback.
PURVIEW_EXPORT_SCOPE = f"{PURVIEW_EDISCOVERY_RESOURCE_ID}/.default"
PURVIEW_EXPORT_SCOPES = (
    PURVIEW_EXPORT_SCOPE,
    "https://ps.compliance.protection.outlook.com/.default",
    "https://outlook.office365.com/.default",
)

# Default polling cadence (minutes). User-overridable in settings.
DEFAULT_POLL_INTERVAL_MINUTES = 15

# Safety margin subtracted from the per-user watermark to absorb clock
# skew and late-arriving server-side records.
WATERMARK_SAFETY_MARGIN_SECONDS = 300

# Concurrency cap for per-user Graph requests.
MAX_CONCURRENT_USER_REQUESTS = 8


@dataclass(frozen=True)
class AppPaths:
    """Resolved filesystem locations for user data, logs, and i18n.

    The ``db_path`` attribute reflects the *currently selected profile*.
    Use :meth:`resolve` to obtain the shared shell (root/logs/i18n) and
    then :meth:`with_profile` to bind it to a specific profile's
    SQLite database.
    """

    root: Path
    data_dir: Path
    log_dir: Path
    db_path: Path
    i18n_dir: Path
    profile_id: str | None = None

    @classmethod
    def resolve(cls) -> "AppPaths":
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            root = Path(local_app) / __app_name__
        else:  # Linux/macOS dev environments
            root = Path.home() / ".local" / "share" / __app_name__
        data_dir = root
        log_dir = root / "logs"
        # Default to the legacy single-profile DB path; multi-profile
        # callers re-bind via :meth:`with_profile`.
        db_path = root / "store.db"
        # `i18n` ships with the package; allow override via env for tests.
        i18n_dir = Path(__file__).resolve().parent / "i18n"
        data_dir.mkdir(parents=True, exist_ok=True)
        log_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            root=root,
            data_dir=data_dir,
            log_dir=log_dir,
            db_path=db_path,
            i18n_dir=i18n_dir,
            profile_id=None,
        )

    def with_profile(self, profile_id: str, db_path: Path) -> "AppPaths":
        """Return a new ``AppPaths`` pointing at ``db_path`` for ``profile_id``."""
        return AppPaths(
            root=self.root,
            data_dir=self.data_dir,
            log_dir=self.log_dir,
            db_path=db_path,
            i18n_dir=self.i18n_dir,
            profile_id=profile_id,
        )


@dataclass
class RuntimeOptions:
    """Mutable runtime options. Persisted values live in the `settings`
    table; this object is loaded from there on startup."""

    poll_interval_minutes: int = DEFAULT_POLL_INTERVAL_MINUTES
    scope_mode: str = "LICENSED"  # ALL_ACTIVE | LICENSED | GROUP | CUSTOM
    scope_group_id: str | None = None
    scope_upns: list[str] = field(default_factory=list)
    backfill_done_initial: bool = False
    language: str = "ko_KR"  # ko_KR | en_US
    auto_backup_enabled: bool = False
    auto_backup_mode: str = "new"  # new | overwrite
