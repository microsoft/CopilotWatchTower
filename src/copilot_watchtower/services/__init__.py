"""Service layer: authentication, app registration, Graph access."""

from .appreg import AppRegistrar, RegisteredApp, admin_consent_url
from .auth import (
    AppOnlyTokenProvider,
    BootstrapAuthenticator,
    DelegatedAuthExpiredError,
    DelegatedDeviceCodeTokenProvider,
    DeviceCodePrompt,
    DeviceCodeResult,
    delegated_token_cache_path,
)
from .consent_server import ConsentCallbackServer, ConsentResult
from .graph import CopilotInteraction, GraphClient, GraphError, GraphUser
from .report_settings import ReportSettingsOutcome, ensure_usage_reports_show_user_details

__all__ = [
    "AppOnlyTokenProvider",
    "AppRegistrar",
    "BootstrapAuthenticator",
    "ConsentCallbackServer",
    "ConsentResult",
    "CopilotInteraction",
    "DelegatedAuthExpiredError",
    "DelegatedDeviceCodeTokenProvider",
    "DeviceCodePrompt",
    "DeviceCodeResult",
    "GraphClient",
    "GraphError",
    "GraphUser",
    "RegisteredApp",
    "ReportSettingsOutcome",
    "admin_consent_url",
    "delegated_token_cache_path",
    "ensure_usage_reports_show_user_details",
]
