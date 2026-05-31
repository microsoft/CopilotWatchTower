"""MSAL-based authentication services.

Two flows live here:

1. **Device code (delegated)** — used once during onboarding by a
   tenant administrator. The signed-in account must hold a directory
   role permitted to create app registrations and grant admin consent
   (e.g. *Cloud Application Administrator*).

2. **Client credentials (app-only)** — used for routine collection
   after the Entra ID app has been created and granted admin consent.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

import msal

from ..config import (
    BOOTSTRAP_CLIENT_ID,
    CLIENT_CREDENTIALS_SCOPE,
    DELEGATED_BOOTSTRAP_SCOPES,
)

log = logging.getLogger(__name__)

AUTHORITY_COMMON = "https://login.microsoftonline.com/organizations"


class DelegatedAuthExpiredError(RuntimeError):
    """A cached delegated token could not be refreshed silently.

    Raised by :class:`DelegatedDeviceCodeTokenProvider` when no usable
    refresh token is available *and* interactive device-code fallback is
    disabled. The caller should stop and direct the user to re-register
    permissions (Settings → 권한 재등록), which re-seeds the token cache.
    """


def authority_for(tenant_id: str) -> str:
    return f"https://login.microsoftonline.com/{tenant_id}"


def delegated_token_cache_path(parent: Path, tenant_id: str) -> Path:
    """Return the on-disk MSAL cache path shared by all delegated flows.

    Onboarding seeds this cache so later delegated collection (Copilot
    catalog sync, Purview eDiscovery) can acquire tokens silently instead
    of prompting the admin for a fresh device-code login every time.
    """
    return parent / f".token_cache.{tenant_id[:8]}.bin"


@dataclass
class DeviceCodePrompt:
    user_code: str
    verification_uri: str
    message: str
    expires_in: int
    interval: int


@dataclass
class DeviceCodeResult:
    access_token: str
    id_token_claims: dict[str, object]
    expires_in: int
    tenant_id: str
    upn: str | None


class BootstrapAuthenticator:
    """Drives the delegated device-code flow used during onboarding.

    The MSAL helper is intentionally split into two calls so the GUI
    can render the user code immediately and then poll asynchronously.
    """

    def __init__(self, scopes: Iterable[str] | None = None, tenant_id: str | None = None) -> None:
        self.scopes = list(scopes) if scopes else list(DELEGATED_BOOTSTRAP_SCOPES)
        # When the target tenant is known (e.g. re-authenticating against an
        # existing profile for permission upgrade or factory reset), pin the
        # authority to that tenant. Otherwise (first-run onboarding) use the
        # multi-tenant /organizations authority and let the admin choose.
        authority = authority_for(tenant_id) if tenant_id else AUTHORITY_COMMON
        # Attach a serialisable cache so the refresh token obtained during
        # onboarding can be persisted and reused later for silent delegated
        # token acquisition (Copilot catalog sync, Purview eDiscovery).
        self._cache = msal.SerializableTokenCache()
        self._app = msal.PublicClientApplication(
            client_id=BOOTSTRAP_CLIENT_ID,
            authority=authority,
            token_cache=self._cache,
        )
        self._flow: dict[str, object] | None = None
        self._cancel = threading.Event()

    def serialize_cache(self) -> str:
        """Return the serialised MSAL token cache (contains the refresh token).

        Persist this to :func:`delegated_token_cache_path` after a successful
        :meth:`poll` so later delegated flows skip the device-code prompt.
        """
        return self._cache.serialize()

    def warm_scopes(self, scopes: Iterable[str]) -> bool:
        """Pre-acquire a token for a *different* resource/audience silently.

        The device-code flow can only consent to one resource (audience) at a
        time, so resources like the Purview eDiscovery export endpoint
        (:data:`PURVIEW_EXPORT_SCOPE`) cannot be bundled into the bootstrap
        sign-in. MSAL refresh tokens are multi-resource, however, so right
        after the bootstrap login we can silently mint that second-audience
        token from the just-signed-in account. This warms the shared token
        cache (so eDiscovery export downloads never prompt) and surfaces a
        missing consent at onboarding time instead of mid-download.

        Returns ``True`` when a token was obtained, ``False`` otherwise (e.g.
        the resource still needs admin consent). Best-effort: never raises.
        """
        scope_list = list(scopes)
        try:
            for account in self._app.get_accounts():
                result = self._app.acquire_token_silent(scope_list, account=account)
                if isinstance(result, dict) and result.get("access_token"):
                    return True
        except Exception:  # noqa: BLE001 — warm-up is best-effort
            log.exception("Failed to warm token cache for scopes %s", scope_list)
        return False


    def initiate(self) -> DeviceCodePrompt:
        flow = self._app.initiate_device_flow(scopes=self.scopes)
        if "user_code" not in flow:
            raise RuntimeError(f"Failed to start device code flow: {flow}")
        self._flow = flow
        return DeviceCodePrompt(
            user_code=str(flow["user_code"]),
            verification_uri=str(flow["verification_uri"]),
            message=str(flow.get("message", "")),
            expires_in=int(flow.get("expires_in", 900)),
            interval=int(flow.get("interval", 5)),
        )

    def cancel(self) -> None:
        self._cancel.set()

    def poll(self, on_progress: Callable[[int], None] | None = None) -> DeviceCodeResult:
        """Block until the device code is consumed or the flow expires.

        Runs on a worker thread. ``on_progress`` is called with elapsed
        seconds at each polling tick so the UI can show a countdown.
        """
        assert self._flow is not None, "initiate() must be called first"
        # Optional progress ticker — MSAL hides per-poll callbacks, so we
        # emit elapsed seconds on a short timer instead.
        start = time.monotonic()
        if on_progress is not None:
            stop_ticker = threading.Event()

            def _tick() -> None:
                while not stop_ticker.is_set():
                    on_progress(int(time.monotonic() - start))
                    if stop_ticker.wait(1.0):
                        return

            ticker = threading.Thread(target=_tick, daemon=True)
            ticker.start()
        else:
            stop_ticker = None  # type: ignore[assignment]
            ticker = None  # type: ignore[assignment]

        try:
            result = self._app.acquire_token_by_device_flow(self._flow)
        finally:
            if stop_ticker is not None:
                stop_ticker.set()
            if ticker is not None:
                ticker.join(timeout=1.5)

        if self._cancel.is_set():
            raise RuntimeError("Device code flow cancelled by user.")
        if "access_token" not in result:
            raise RuntimeError(f"Device code flow failed: {result}")

        claims = result.get("id_token_claims", {}) or {}
        tenant_id = str(claims.get("tid") or "")
        upn = claims.get("preferred_username") or claims.get("upn")
        return DeviceCodeResult(
            access_token=result["access_token"],
            id_token_claims=claims,
            expires_in=int(result.get("expires_in", 3600)),
            tenant_id=tenant_id,
            upn=str(upn) if upn else None,
        )


class AppOnlyTokenProvider:
    """Caches client-credentials tokens for the registered Entra app."""

    def __init__(self, tenant_id: str, client_id: str, client_secret: str) -> None:
        self.tenant_id = tenant_id
        self.client_id = client_id
        self._secret = client_secret
        self._app = msal.ConfidentialClientApplication(
            client_id=client_id,
            client_credential=client_secret,
            authority=authority_for(tenant_id),
        )
        self._lock = threading.Lock()
        self._scope_cache: dict[tuple[str, ...], tuple[str, float]] = {}

    def acquire(self) -> str:
        return self.acquire_for_scopes([CLIENT_CREDENTIALS_SCOPE])

    def acquire_for_scopes(self, scopes: Iterable[str]) -> str:
        scope_key = tuple(scopes)
        with self._lock:
            now = time.monotonic()
            cached = self._scope_cache.get(scope_key)
            if cached and now < cached[1] - 60:
                return cached[0]
            result = self._app.acquire_token_for_client(scopes=list(scope_key))
            if "access_token" not in result:
                raise RuntimeError(f"Client credentials acquire failed: {result}")
            token = str(result["access_token"])
            self._scope_cache[scope_key] = (token, now + int(result.get("expires_in", 3600)))
            return token

    def invalidate(self) -> None:
        with self._lock:
            self._scope_cache.clear()


class DelegatedDeviceCodeTokenProvider:
    """Caches delegated Graph tokens and falls back to device-code login."""

    def __init__(
        self,
        tenant_id: str,
        scopes: Iterable[str],
        *,
        client_id: str = BOOTSTRAP_CLIENT_ID,
        cache_path: Path | None = None,
        on_prompt: Callable[[DeviceCodePrompt], None] | None = None,
        allow_device_code: bool = True,
    ) -> None:
        self.tenant_id = tenant_id
        self.scopes = list(scopes)
        self.client_id = client_id
        self.cache_path = cache_path
        self.on_prompt = on_prompt
        self.allow_device_code = allow_device_code
        self._lock = threading.Lock()
        self._cache = msal.SerializableTokenCache()
        if cache_path is not None and cache_path.exists():
            try:
                self._cache.deserialize(cache_path.read_text(encoding="utf-8"))
            except Exception:
                log.exception("Failed to read delegated token cache %s", cache_path)
        self._app = msal.PublicClientApplication(
            client_id=client_id,
            authority=authority_for(tenant_id),
            token_cache=self._cache,
        )

    def acquire(self) -> str:
        return self.acquire_for_scopes(self.scopes)

    def acquire_for_scopes(self, scopes: Iterable[str]) -> str:
        """Acquire a delegated token for an arbitrary resource/scope set.

        MSAL refresh tokens are multi-resource: the cached account seeded
        during onboarding (Graph + eDiscovery consent) can mint a token for
        a *different* audience silently. This is what lets eDiscovery export
        downloads reuse the same sign-in to obtain the Purview/Exchange
        compliance-audience token the proxy service demands, without a
        second interactive login.
        """
        scope_list = list(scopes)
        with self._lock:
            for account in self._app.get_accounts():
                result = self._app.acquire_token_silent(scope_list, account=account)
                token = result.get("access_token") if isinstance(result, dict) else None
                if token:
                    self._persist_cache()
                    return str(token)

            if not self.allow_device_code:
                # Silent acquisition failed and the caller opted out of an
                # interactive prompt (e.g. background eDiscovery collection).
                # Signal that the user must re-register permissions, which
                # refreshes the cached refresh token.
                raise DelegatedAuthExpiredError(
                    "위임 로그인 토큰이 만료되었거나 캐시에 없습니다. "
                    "설정 → 권한 재등록을 실행해 다시 로그인하세요."
                )

            flow = self._app.initiate_device_flow(scopes=scope_list)
            if "user_code" not in flow:
                raise RuntimeError(f"Failed to start device code flow: {flow}")
            prompt = DeviceCodePrompt(
                user_code=str(flow["user_code"]),
                verification_uri=str(flow["verification_uri"]),
                message=str(flow.get("message", "")),
                expires_in=int(flow.get("expires_in", 900)),
                interval=int(flow.get("interval", 5)),
            )
            if self.on_prompt is not None:
                self.on_prompt(prompt)
            result = self._app.acquire_token_by_device_flow(flow)
            if "access_token" not in result:
                raise RuntimeError(f"Device code flow failed: {result}")
            self._persist_cache()
            return str(result["access_token"])

    def invalidate(self) -> None:
        # MSAL controls delegated-token freshness via the serialized cache.
        return

    def _persist_cache(self) -> None:
        if self.cache_path is None or not self._cache.has_state_changed:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(self._cache.serialize(), encoding="utf-8")
        except Exception:
            log.exception("Failed to write delegated token cache %s", self.cache_path)
