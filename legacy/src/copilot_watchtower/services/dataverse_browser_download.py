"""Browser-driven capture of Dataverse (``*.crm.dynamics.com``) tokens.

Dataverse Web API tokens are **per-resource**: the Global Discovery Service and
each environment org have distinct token audiences. Rather than minting and
refreshing standalone delegated tokens (which expire independently and force
re-logins), the Dataverse transcript collector drives a real Power Apps maker
portal sign-in with headless Chromium and reuses every ``*.crm.dynamics.com``
bearer token the SPA already acquires — mirroring the consumption collector.

The login flow and bearer extraction helpers are shared with
:mod:`.consumption_browser_download` / :mod:`.ediscovery_browser_download`.
"""
from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from ..config import (
    BAP_RESOURCE,
    BAP_TOKEN_HOST_FRAGMENT,
    DATAVERSE_DISCOVERY_RESOURCE,
    DATAVERSE_TOKEN_HOST_FRAGMENT,
    POWERAPPS_MAKER_ENV_SOLUTIONS_URL,
    POWERAPPS_MAKER_ENV_URL,
    POWERAPPS_MAKER_URL,
    POWERPLATFORM_ADMIN_ENV_URL,
)
from ..i18n import translate
from .consumption_browser_download import extract_bearer_token

log = logging.getLogger(__name__)

LogCb = Callable[[str], None]


@dataclass(frozen=True)
class EnvCaptureTarget:
    """An environment whose per-org Dataverse token should be minted.

    ``org_host`` is the expected ``*.crm.dynamics.com`` host (derived from the
    BAP ``instanceUrl``); the browser polls the MSAL cache until a token for
    that exact host appears, so it can tell which environments were collectable.
    """

    env_id: str
    org_host: str
    label: str


class DataverseBrowserError(RuntimeError):
    """Raised when the headless browser cannot obtain a Dataverse token."""


def _host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except Exception:  # pragma: no cover - defensive
        return ""


def extract_dataverse_tokens_from_storage(
    storage: dict[str, str],
    *,
    host_fragment: str = DATAVERSE_TOKEN_HOST_FRAGMENT,
) -> dict[str, str]:
    """Scan an MSAL ``localStorage`` dump for Dataverse access tokens.

    The maker-portal SPA acquires per-environment ``*.crm.dynamics.com`` tokens
    silently (hidden-iframe MSAL flow) and persists them in ``localStorage`` as
    JSON blobs whose ``target`` scope carries the org URL (e.g.
    ``https://contoso.crm.dynamics.com/.default``). When no outbound request
    exposes an ``Authorization`` header in time, we recover one token per host
    from this cache. Returns ``{host: token}``.
    """
    tokens: dict[str, str] = {}
    for key, value in storage.items():
        if not value:
            continue
        haystack = f"{key} {value}".lower()
        if host_fragment not in haystack:
            continue
        try:
            blob = json.loads(value)
        except (ValueError, TypeError):
            continue
        if not isinstance(blob, dict):
            continue
        secret = blob.get("secret") or blob.get("accessToken") or blob.get("access_token")
        if not isinstance(secret, str) or not secret.strip():
            continue
        # Determine the audience host from the token's scope/target.
        target = ""
        for field in ("target", "realm", "scopes"):
            candidate = blob.get(field)
            if isinstance(candidate, str) and host_fragment in candidate.lower():
                target = candidate
                break
        host = ""
        for token_part in target.replace(",", " ").split():
            part_host = _host_of(token_part)
            if host_fragment in part_host:
                host = part_host
                break
        if not host:
            # Fall back to any crm host mentioned in the cache key itself.
            for token_part in key.replace("-", " ").split():
                if host_fragment in token_part.lower():
                    host = token_part.lower()
                    break
        if not host:
            host = host_fragment  # last-resort bucket; token_for falls back too
        tokens.setdefault(host, secret.strip())
    return tokens


def _scrape_storage_tokens(page: Any) -> dict[str, str]:
    """Read the current origin's localStorage + sessionStorage for Dataverse tokens.

    MSAL caches access tokens per origin, so this must run while the page is on
    the origin that performed the token acquisition (the maker portal).
    """
    script = (
        "(name) => { const s = window[name]; const o = {};"
        " if (!s) return o;"
        " for (let i = 0; i < s.length; i++) {"
        " const k = s.key(i); o[k] = s.getItem(k); }"
        " return o; }"
    )
    merged: dict[str, str] = {}
    for store_name in ("localStorage", "sessionStorage"):
        try:
            raw = page.evaluate(script, store_name)
        except Exception:
            raw = {}
        found = extract_dataverse_tokens_from_storage(
            {str(k): str(v) for k, v in (raw or {}).items()}
        )
        for host, token in found.items():
            merged.setdefault(host, token)
    return merged


def _mint_env_token(
    page: Any,
    tokens: dict[str, str],
    *,
    url: str,
    org_host: str,
) -> bool:
    """Navigate to ``url`` and poll the MSAL cache until ``org_host`` appears.

    Loading a maker page for a specific environment makes the SPA silently mint
    that environment's org-audience Dataverse token (hidden-iframe MSAL flow).
    The token is often never a sniffable outbound request, so we poll
    ``localStorage``/``sessionStorage`` a few times. Returns ``True`` once a
    token for ``org_host`` is captured.
    """
    try:
        page.goto(url, timeout=45_000, wait_until="domcontentloaded")
    except Exception:  # noqa: BLE001 - per-env best effort
        return False
    # Slower environments need more than one short wait before the org API call
    # (and its silent token acquisition) completes.
    with contextlib.suppress(Exception):
        page.wait_for_load_state("networkidle", timeout=20_000)
    for _ in range(4):
        page.wait_for_timeout(2_500)
        for host, token in _scrape_storage_tokens(page).items():
            tokens.setdefault(host, token)
        if org_host and org_host in tokens:
            return True
    return False


# Button labels used by the Power Platform admin center "add myself" control,
# across locales. The admin center localizes the System administrator panel, so
# we try the signed-in tenant's likely labels (Korean first, then English).
_SELF_ADD_BUTTON_LABELS = (
    "나 추가",
    "나를 추가",
    "내 계정 추가",
    "본인 추가",
    "Add myself",
    "Add me",
    "Add yourself",
)
# Labels for the confirmation button that may appear in a follow-up dialog.
_SELF_ADD_CONFIRM_LABELS = ("추가", "확인", "예", "Add", "Confirm", "Yes", "OK")


def try_self_add_as_admin(
    page: Any,
    *,
    env_id: str,
    label: str,
    on_log: LogCb | None = None,
) -> bool:
    """Best-effort: add the signed-in user to an environment via the admin center.

    Navigates the already-authenticated browser session to the Power Platform
    admin center page for ``env_id`` and clicks the "add myself" button — the
    same action a tenant admin performs manually on the System administrator
    panel — so the user gains access to an environment they could not otherwise
    reach (no maker access ⇒ no org token could be minted).

    This is deliberately fragile UI automation: admin-center button labels are
    localized and the portal DOM changes over time, so it **never raises** and
    returns ``True`` only when a candidate button was actually clicked. The
    caller should re-attempt the silent token mint afterwards and treat failure
    as "skip this environment".
    """

    def _log(message: str) -> None:
        if on_log is not None:
            on_log(message)

    admin_url = POWERPLATFORM_ADMIN_ENV_URL.format(env_id=env_id)
    _log(translate("dataverseDl.addSelfTrying", label=label))
    try:
        page.goto(admin_url, timeout=45_000, wait_until="domcontentloaded")
    except Exception:  # noqa: BLE001 - best effort
        _log(translate("dataverseDl.adminCenterOpenFailed", label=label))
        return False
    with contextlib.suppress(Exception):
        page.wait_for_load_state("networkidle", timeout=20_000)
    page.wait_for_timeout(3_000)

    clicked = False
    for text in _SELF_ADD_BUTTON_LABELS:
        try:
            locator = page.get_by_role("button", name=text, exact=False)
            if locator.count() == 0:
                # Some controls render as links/menu items, not buttons.
                locator = page.get_by_text(text, exact=False)
            if locator.count() == 0:
                continue
            locator.first.click(timeout=8_000)
            clicked = True
            break
        except Exception:  # noqa: BLE001 - try the next candidate label
            continue

    if not clicked:
        _log(translate("dataverseDl.addSelfButtonNotFound", label=label))
        return False

    # A confirmation dialog may follow; click through it if present.
    page.wait_for_timeout(1_500)
    for text in _SELF_ADD_CONFIRM_LABELS:
        try:
            confirm = page.get_by_role("button", name=text, exact=False)
            if confirm.count() == 0:
                continue
            confirm.first.click(timeout=4_000)
            break
        except Exception:  # noqa: BLE001 - confirmation is optional
            continue

    # Give the admin API call time to grant access before the caller retries.
    page.wait_for_timeout(4_000)
    _log(translate("dataverseDl.addSelfDone", label=label))
    return True


class CapturedDataverseTokens:
    """Maps a request URL to the bearer token captured for that host.

    Dataverse audiences are per-host, so the collector captures one token per
    ``*.crm.dynamics.com`` host (each environment org plus the Global Discovery
    Service) and resolves the right one for each outbound request.
    """

    def __init__(self, tokens: dict[str, str]) -> None:
        # host (lowercase) -> bearer token
        self._tokens = dict(tokens)

    @property
    def hosts(self) -> list[str]:
        return list(self._tokens)

    @property
    def org_hosts(self) -> list[str]:
        """Environment org hosts (excludes the Global Discovery Service host).

        When the maker portal only ever mints an org-audience token (never a
        discovery-audience one), the collector can skip Global Discovery and
        query these orgs directly — their tokens are already in hand.
        """
        disco = _host_of(DATAVERSE_DISCOVERY_RESOURCE)
        return [
            host
            for host in self._tokens
            if DATAVERSE_TOKEN_HOST_FRAGMENT in host and host != disco
        ]

    @property
    def bap_token(self) -> str | None:
        """The captured BAP-audience token, used to enumerate environments."""
        return self._tokens.get(_host_of(BAP_RESOURCE))

    def token_for(self, url: str) -> str:
        host = _host_of(url)
        token = self._tokens.get(host)
        if token:
            return token
        # Fall back to any captured token (single-environment tenants often
        # share the same audience for discovery + org calls).
        if self._tokens:
            return next(iter(self._tokens.values()))
        raise DataverseBrowserError(
            translate("dataverseDl.tokenNotFoundForHost", host=host)
        )


def capture_dataverse_tokens(
    *,
    username: str,
    password: str,
    maker_url: str = POWERAPPS_MAKER_URL,
    timeout_ms: int = 180_000,
    on_log: LogCb | None = None,
    enumerate_environments: Callable[[str], list[EnvCaptureTarget]] | None = None,
    add_self_as_admin: bool = False,
) -> CapturedDataverseTokens:
    """Sign into the maker portal headless and capture Dataverse tokens.

    Returns one bearer token per observed ``*.crm.dynamics.com`` host plus the
    BAP host. Raises :class:`DataverseBrowserError` when no Dataverse-audience
    token is seen (e.g. the stored admin lacks access to any environment).

    When ``enumerate_environments`` is supplied, it is called with the captured
    BAP token and must return the :class:`EnvCaptureTarget` list to collect. The
    browser then navigates the maker SPA to each environment so MSAL silently
    mints that environment's org token — the only reliable way to obtain a token
    per environment when the Global Discovery Service audience is unreachable.
    Each environment is polled until its ``org_host`` token appears (or a short
    budget elapses); this step is best-effort and never aborts the capture.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise DataverseBrowserError(
            translate("consumption.playwrightMissing")
        ) from exc

    if not username or not password:
        raise DataverseBrowserError(translate("consumption.noCredentials"))

    # Imported lazily so the login helper stays a single shared implementation.
    from .ediscovery_browser_download import _complete_microsoft_login, current_page_is_sign_in

    def _log(message: str) -> None:
        if on_log is not None:
            on_log(message)

    tokens: dict[str, str] = {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, channel="chromium-headless-shell"
        )
        context = browser.new_context()
        page = context.new_page()

        def _on_request(request: Any) -> None:
            try:
                host = _host_of(request.url)
                # Capture both per-environment Dataverse tokens and the BAP
                # token (used to enumerate every environment the user can reach).
                if (
                    DATAVERSE_TOKEN_HOST_FRAGMENT not in host
                    and BAP_TOKEN_HOST_FRAGMENT not in host
                ):
                    return
                if host in tokens:
                    return
                token = extract_bearer_token(dict(request.headers))
                if token:
                    tokens[host] = token
            except Exception:  # pragma: no cover - listener must never raise
                pass

        page.on("request", _on_request)

        try:
            _log(translate("dataverseDl.tryAutoLogin"))
            # The login redirect may interrupt the initial navigation.
            with contextlib.suppress(Exception):
                page.goto(maker_url, timeout=60_000, wait_until="domcontentloaded")
            _complete_microsoft_login(page, username=username, password=password)

            # Let the maker portal home settle. On load it enumerates
            # environments via the Global Discovery Service, which both fires a
            # sniffable Bearer request and seeds the MSAL token cache in this
            # origin's localStorage.
            page.wait_for_timeout(10_000)

            # Scrape the MSAL token cache *on the maker-portal origin* before
            # navigating anywhere else. localStorage/sessionStorage are
            # per-origin, so this must run while the page is still on
            # make.powerapps.com — the org token is often minted silently via a
            # hidden iframe and never appears as a sniffable outbound request.
            for host, token in _scrape_storage_tokens(page).items():
                tokens.setdefault(host, token)

            # Nudge the SPA to call the Global Discovery Service so we also
            # capture a discovery-audience token, then let environment calls
            # settle.
            try:
                page.goto(
                    DATAVERSE_DISCOVERY_RESOURCE + "/api/discovery/v2.0/Instances",
                    timeout=30_000,
                    wait_until="domcontentloaded",
                )
                page.wait_for_timeout(4_000)
                for host, token in _scrape_storage_tokens(page).items():
                    tokens.setdefault(host, token)
            except Exception:
                pass

            # If the caller wants per-environment collection and we captured a
            # BAP token, enumerate the environments and visit each one in the
            # maker SPA so MSAL silently mints that environment's org token.
            bap_token = tokens.get(_host_of(BAP_RESOURCE))
            if enumerate_environments is not None and bap_token:
                try:
                    targets = enumerate_environments(bap_token)
                except Exception as exc:  # noqa: BLE001 - best effort
                    _log(translate("dataverseDl.envEnumFailed", error=exc))
                    targets = []
                # Skip environments whose token we already captured passively.
                pending = [
                    t for t in targets if not (t.org_host and t.org_host in tokens)
                ]
                if pending:
                    _log(translate("dataverseDl.mintingTokens", count=len(pending)))
                for target in pending:
                    # Visit the maker home first; if that page never calls the
                    # org Web API (so MSAL mints no token) fall back to the
                    # solutions page, which always reads from the environment's
                    # Dataverse and forces the silent token acquisition.
                    minted = _mint_env_token(
                        page,
                        tokens,
                        url=POWERAPPS_MAKER_ENV_URL.format(env_id=target.env_id),
                        org_host=target.org_host,
                    )
                    if not minted and target.org_host:
                        minted = _mint_env_token(
                            page,
                            tokens,
                            url=POWERAPPS_MAKER_ENV_SOLUTIONS_URL.format(
                                env_id=target.env_id
                            ),
                            org_host=target.org_host,
                        )
                    if not minted and target.org_host:
                        # Final fallback: navigate straight to the environment's
                        # Dataverse origin. The org web app calls its own Web API
                        # on load, so the request listener / storage scrape catch
                        # the bearer even when the maker SPA (a different origin)
                        # never minted it — e.g. environments in another region
                        # (orgX.crm5.dynamics.com) whose token the maker pages do
                        # not acquire silently in time.
                        minted = _mint_env_token(
                            page,
                            tokens,
                            url=f"https://{target.org_host}/",
                            org_host=target.org_host,
                        )
                    if not target.org_host:
                        continue
                    if minted or target.org_host in tokens:
                        _log(translate("dataverseDl.tokenObtained", label=target.label))
                    else:
                        # The user could not mint a token for this environment
                        # (typically no maker/admin access). If the operator
                        # opted in, add ourselves via the admin center and retry.
                        recovered = False
                        if add_self_as_admin:
                            added = try_self_add_as_admin(
                                page,
                                env_id=target.env_id,
                                label=target.label,
                                on_log=on_log,
                            )
                            if added:
                                recovered = _mint_env_token(
                                    page,
                                    tokens,
                                    url=POWERAPPS_MAKER_ENV_SOLUTIONS_URL.format(
                                        env_id=target.env_id
                                    ),
                                    org_host=target.org_host,
                                )
                                if not recovered:
                                    recovered = _mint_env_token(
                                        page,
                                        tokens,
                                        url=f"https://{target.org_host}/",
                                        org_host=target.org_host,
                                    )
                        if recovered or target.org_host in tokens:
                            _log(
                                translate(
                                    "dataverseDl.tokenObtainedAfterAdmin",
                                    label=target.label,
                                )
                            )
                        else:
                            _log(
                                translate(
                                    "dataverseDl.tokenFailedSkip",
                                    label=target.label,
                                    host=target.org_host,
                                )
                            )

            if tokens:
                _log(
                    translate("dataverseDl.tokensSecured", count=len(tokens))
                    + ", ".join(sorted(tokens))
                )
                return CapturedDataverseTokens(tokens)

            if current_page_is_sign_in(page):
                raise DataverseBrowserError(translate("dataverseDl.signInIncomplete"))
            raise DataverseBrowserError(
                translate("dataverseDl.noTokensFound")
            )
        finally:
            with contextlib.suppress(Exception):  # pragma: no cover - defensive
                browser.close()
