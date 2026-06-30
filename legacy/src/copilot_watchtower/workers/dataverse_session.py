"""Shared Dataverse sign-in + environment enumeration for entity collectors.

The flow-run and agent-definition collectors both read first-party Dataverse
tables (``flowrun``, ``bot``, ``botcomponent``) the exact same way the
transcript collector reads ``conversationtranscript``: a headless maker-portal
sign-in captures one ``*.crm.dynamics.com`` bearer per environment (enumerated
via BAP), and only environments whose org token was actually minted can be
queried. This helper centralises that handshake so the two collectors don't
duplicate ~80 lines of token plumbing.

Unlike the transcript collector, **Developer environments are NOT excluded** —
autonomous flows and agent definitions absolutely exist in developer
environments (they are a common home for hastily-built, runaway-prone agents).
"""
from __future__ import annotations

import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from ..db import Repository
from ..i18n import translate
from ..security import unprotect
from ..services.dataverse import (
    DataverseClient,
    DataverseEnvironment,
    fetch_bap_environments,
)
from ..services.dataverse_browser_download import (
    CapturedDataverseTokens,
    EnvCaptureTarget,
    capture_dataverse_tokens,
)

log = logging.getLogger(__name__)

LogCb = Callable[[str], None]


class DataverseSessionError(RuntimeError):
    """No browser credentials configured for the Dataverse sign-in."""


@dataclass
class DataverseSession:
    client: DataverseClient
    environments: list[DataverseEnvironment]
    captured: CapturedDataverseTokens

    def queryable_environments(self) -> list[DataverseEnvironment]:
        """Environments whose per-org token was actually captured.

        When the maker portal only minted a token for some environments, the
        client would otherwise fall back to an unrelated org's token and 401.
        """
        hosts = set(self.captured.org_hosts)
        if not hosts:
            return list(self.environments)
        out: list[DataverseEnvironment] = []
        for env in self.environments:
            host = (urlsplit(env.url).hostname or "").lower()
            if not host or host in hosts:
                out.append(env)
        return out

    def close(self) -> None:
        with contextlib.suppress(Exception):  # pragma: no cover - defensive
            self.client.close()


def build_dataverse_session(
    repo: Repository,
    *,
    on_log: LogCb,
    add_self_as_admin: bool = False,
    timeout: float = 120.0,
) -> DataverseSession:
    """Sign in headless, enumerate environments via BAP, and return a session.

    Raises :class:`DataverseSessionError` when no browser credentials are
    stored. Propagates :class:`DataverseBrowserError` from the sign-in itself
    (the caller surfaces it via its ``error`` signal).
    """
    user = (
        repo.get_text_setting("ediscovery_browser_user")
        or repo.get_text_setting("exo_delegated_user")
        or ""
    )
    password_blob = repo.get_secret("ediscovery_browser_password") or repo.get_secret(
        "exo_delegated_password"
    )
    if not user or password_blob is None:
        raise DataverseSessionError(translate("worker.dvSession.noBrowserAccount"))
    password = str(unprotect(password_blob))

    environments: list[DataverseEnvironment] = []

    def _enumerate(bap_token: str) -> list[EnvCaptureTarget]:
        envs = fetch_bap_environments(bap_token)
        environments.extend(envs)
        if envs:
            on_log(translate("worker.dvSession.envConfirmed", count=len(envs)))
        targets: list[EnvCaptureTarget] = []
        for env in envs:
            host = (urlsplit(env.url).hostname or "").lower()
            targets.append(
                EnvCaptureTarget(
                    env_id=env.id, org_host=host, label=env.friendly_name or env.url
                )
            )
        return targets

    on_log(translate("worker.dvSession.capturing"))
    captured = capture_dataverse_tokens(
        username=user,
        password=password,
        on_log=on_log,
        enumerate_environments=_enumerate,
        add_self_as_admin=add_self_as_admin,
    )
    # When BAP enumeration returned nothing (rare), fall back to org hosts that
    # the capture did mint tokens for so the collector still has targets.
    if not environments:
        environments = [
            DataverseEnvironment(id=host, url=f"https://{host}", friendly_name=host)
            for host in captured.org_hosts
        ]
    client = DataverseClient(captured.token_for, timeout=timeout)
    return DataverseSession(client=client, environments=environments, captured=captured)
