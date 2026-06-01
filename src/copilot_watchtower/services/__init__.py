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
from .consumption_browser_download import (
    CapturedTokenProvider,
    ConsumptionBrowserError,
    capture_licensing_token,
)
from .dataverse import (
    DataverseClient,
    DataverseEnvironment,
    DataverseError,
    parse_conversation_transcript,
    parse_environments_json,
)
from .dataverse_browser_download import (
    CapturedDataverseTokens,
    DataverseBrowserError,
    capture_dataverse_tokens,
    extract_dataverse_tokens_from_storage,
)
from .graph import CopilotInteraction, GraphClient, GraphError, GraphUser
from .licensing import LicensingClient, LicensingError, parse_consumption_csv
from .report_settings import ReportSettingsOutcome, ensure_usage_reports_show_user_details

__all__ = [
    "AppOnlyTokenProvider",
    "AppRegistrar",
    "BootstrapAuthenticator",
    "CapturedDataverseTokens",
    "CapturedTokenProvider",
    "ConsentCallbackServer",
    "ConsentResult",
    "ConsumptionBrowserError",
    "CopilotInteraction",
    "DataverseBrowserError",
    "DataverseClient",
    "DataverseEnvironment",
    "DataverseError",
    "DelegatedAuthExpiredError",
    "DelegatedDeviceCodeTokenProvider",
    "DeviceCodePrompt",
    "DeviceCodeResult",
    "GraphClient",
    "GraphError",
    "GraphUser",
    "LicensingClient",
    "LicensingError",
    "RegisteredApp",
    "ReportSettingsOutcome",
    "admin_consent_url",
    "capture_dataverse_tokens",
    "capture_licensing_token",
    "delegated_token_cache_path",
    "ensure_usage_reports_show_user_details",
    "extract_dataverse_tokens_from_storage",
    "parse_conversation_transcript",
    "parse_environments_json",
    "parse_consumption_csv",
]
