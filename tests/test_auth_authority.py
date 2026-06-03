from __future__ import annotations

import copilot_watchtower.services.auth as auth_mod
from copilot_watchtower.config import DELEGATED_BOOTSTRAP_SCOPES
from copilot_watchtower.services.auth import (
    AUTHORITY_COMMON,
    BootstrapAuthenticator,
    DelegatedAuthExpiredError,
    DelegatedDeviceCodeTokenProvider,
    authority_for,
    delegated_token_cache_path,
)
import pytest


class _FakePublicClient:
    last_kwargs: dict[str, object] = {}

    def __init__(self, **kwargs: object) -> None:
        _FakePublicClient.last_kwargs = kwargs


def test_bootstrap_authenticator_pins_authority_to_tenant(monkeypatch) -> None:
    monkeypatch.setattr(auth_mod.msal, "PublicClientApplication", _FakePublicClient)
    tenant = "11111111-2222-3333-4444-555555555555"
    BootstrapAuthenticator(tenant_id=tenant)
    assert _FakePublicClient.last_kwargs["authority"] == authority_for(tenant)


def test_bootstrap_authenticator_defaults_to_organizations(monkeypatch) -> None:
    monkeypatch.setattr(auth_mod.msal, "PublicClientApplication", _FakePublicClient)
    BootstrapAuthenticator()
    assert _FakePublicClient.last_kwargs["authority"] == AUTHORITY_COMMON


def test_bootstrap_authenticator_attaches_serialisable_cache(monkeypatch) -> None:
    monkeypatch.setattr(auth_mod.msal, "PublicClientApplication", _FakePublicClient)
    auth = BootstrapAuthenticator()
    # The MSAL app must receive the same cache instance the authenticator
    # later serialises, so the onboarding refresh token can be persisted.
    cache = _FakePublicClient.last_kwargs["token_cache"]
    assert isinstance(cache, auth_mod.msal.SerializableTokenCache)
    assert cache is auth._cache
    # serialize_cache returns a JSON string even when the cache is empty.
    assert isinstance(auth.serialize_cache(), str)


def test_onboarding_requests_ediscovery_scope() -> None:
    # Onboarding must request eDiscovery so the cached refresh token can
    # mint eDiscovery tokens silently — no second device-code prompt.
    assert "eDiscovery.ReadWrite.All" in DELEGATED_BOOTSTRAP_SCOPES


def test_onboarding_requests_copilot_catalog_scopes() -> None:
    # Onboarding must also request the delegated Copilot catalog scopes so the
    # seeded refresh token covers the background catalog sync. Without these a
    # newly onboarded profile fails the catalog step with a 401 and saves zero
    # agents until the admin manually re-registers permissions.
    assert "CopilotPackages.Read.All" in DELEGATED_BOOTSTRAP_SCOPES
    assert "AppCatalog.Read.All" in DELEGATED_BOOTSTRAP_SCOPES


def test_delegated_token_cache_path_is_tenant_scoped(tmp_path) -> None:
    tenant = "11111111-2222-3333-4444-555555555555"
    path = delegated_token_cache_path(tmp_path, tenant)
    assert path.parent == tmp_path
    assert path.name == f".token_cache.{tenant[:8]}.bin"


def test_provider_raises_expired_when_device_code_disabled(monkeypatch) -> None:
    # Background collectors construct the provider with allow_device_code=False.
    # With an empty cache the silent loop yields nothing, so acquire() must
    # raise DelegatedAuthExpiredError instead of popping a device-code prompt.
    monkeypatch.setattr(auth_mod.msal, "PublicClientApplication", _FakePublicClient)
    provider = DelegatedDeviceCodeTokenProvider(
        "11111111-2222-3333-4444-555555555555",
        ["eDiscovery.ReadWrite.All"],
        allow_device_code=False,
    )
    provider._app = _FakeSilentApp(accounts=[])
    with pytest.raises(DelegatedAuthExpiredError):
        provider.acquire()


def test_provider_returns_token_from_silent_cache(monkeypatch) -> None:
    monkeypatch.setattr(auth_mod.msal, "PublicClientApplication", _FakePublicClient)
    provider = DelegatedDeviceCodeTokenProvider(
        "11111111-2222-3333-4444-555555555555",
        ["eDiscovery.ReadWrite.All"],
        allow_device_code=False,
    )
    provider._app = _FakeSilentApp(
        accounts=[{"username": "admin@contoso.com"}],
        silent_token="cached-access-token",
    )
    assert provider.acquire() == "cached-access-token"


class _FakeSilentApp:
    def __init__(self, accounts, silent_token=None) -> None:
        self._accounts = accounts
        self._silent_token = silent_token

    def get_accounts(self):
        return self._accounts

    def acquire_token_silent(self, scopes, account):  # noqa: ARG002
        if self._silent_token:
            return {"access_token": self._silent_token}
        return None
