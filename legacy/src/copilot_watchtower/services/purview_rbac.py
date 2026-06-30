"""Security & Compliance RBAC automation for Purview audit access.

Granting the calling service principal the Exchange/Purview audit-log
management role (preferably ``View-Only Audit Logs``) is what unblocks
the Microsoft 365 audit substrate for the Graph
``security.auditLog.queries`` API.

The wizard uses **Microsoft Graph beta**
``/roleManagement/exchange/roleAssignments`` when it has the bootstrap
admin's delegated token carrying ``RoleManagement.ReadWrite.Exchange``.
This bypasses the ExchangeOnlineManagement PowerShell stack entirely.
The PowerShell helper remains only for legacy/test callers that do not
pass a token.

The result is a structured outcome the UI can present clearly,
distinguishing "added", "already a member", and the various failure
reasons (module install blocked, admin cancelled sign-in, RBAC denied).
"""
from __future__ import annotations

import contextlib
import logging
import re
import shutil
import subprocess
import time
from dataclasses import dataclass

import httpx

from ..config import MS_GRAPH_BASE_BETA
from ..i18n import translate

log = logging.getLogger(__name__)

# Default user-facing role group name. The Graph API assigns Exchange
# management role definitions, not role groups; for this default we
# resolve to the audit-log roles below.
DEFAULT_ROLE_GROUP = "Audit Reader"

# Known display-name aliases for the Audit Reader role group across tenants,
# used only by the legacy PowerShell fallback.
#  - 'Audit Reader' (space): classic Exchange RBAC / Security & Compliance.
#  - 'AuditReader'  (PascalCase, no space): Microsoft Purview unified RBAC
#    catalog.
_AUDIT_READER_ALIASES: tuple[str, ...] = ("Audit Reader", "AuditReader")

# Graph /roleManagement/exchange/roleDefinitions returns Exchange
# management roles such as 'View-Only Audit Logs', not role groups such
# as 'Audit Reader'.  Prefer the read-only role, with 'Audit Logs' as a
# compatible fallback for tenants that don't expose the read-only name.
_AUDIT_LOG_ROLE_DEFINITION_ALIASES: tuple[str, ...] = (
    "View-Only Audit Logs",
    "Audit Logs",
    # Keep these last only as compatibility guards for beta/provider
    # naming drift. They are role-group names, not expected Graph role
    # definition names.
    "AuditReader",
    "Audit Reader",
)

# Freshly created service principals can take a few seconds to
# propagate into the Exchange / Purview catalog. Graph POST
# `roleAssignments` returns 400/404 with a 'Couldn't find object' or
# 'principalId' message until propagation completes. Retry a few
# times before surfacing as an error.
_GRAPH_RETRY_ATTEMPTS = 4
_GRAPH_RETRY_DELAY_S = 4.0
_NOT_FOUND_PATTERNS = re.compile(
    r"couldn'?t find|cannot find|not found|managementobjectnotfound|principal\s*id|"
    r"unknown user|object does not exist|\ucc3e\uc744 \uc218 \uc5c6",
    re.IGNORECASE,
)

# Treat anything matching this pattern as a successful no-op so we
# don't show a scary error when the admin re-runs the action.
_ALREADY_MEMBER_RE = re.compile(
    r"already (?:a member|exists|present)|is already added",
    re.IGNORECASE,
)

# Sentinel tokens we print from the PowerShell side so we can tell the
# stages apart in mixed stdout/stderr without parsing locale-dependent
# PS messages.
_TOK_INSTALL = "CWT_INSTALL_MODULE"
_TOK_CONNECT = "CWT_CONNECT"
_TOK_PRECHECK = "CWT_PRECHECK"
_TOK_NO_ROLE = "CWT_ROLE_NOT_FOUND"
_TOK_CANDIDATES = "CWT_CANDIDATES:"
_TOK_ADD = "CWT_ADD_MEMBER"
_TOK_ADDED = "CWT_ROLE_ADDED"
_TOK_ALREADY = "CWT_ROLE_ALREADY_MEMBER"
_TOK_DONE = "CWT_DONE"

# Guard against shell-injection via the SP object id / role group
# arguments (both come from our own DB but defense in depth is cheap).
_GUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
_ROLE_NAME_RE = re.compile(r"^[A-Za-z0-9 _\-]{1,64}$")

# PowerShell 7+ emits ANSI color escape codes by default; strip them
# before surfacing to the GUI label.  Belt-and-suspenders on top of the
# ``$PSStyle.OutputRendering = 'PlainText'`` we set inside the script.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s or "")


def _normalise_role_name(name: str) -> str:
    """Normalise role names for Graph beta provider naming drift."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _graph_role_definition_candidates(role_group: str) -> tuple[str, ...]:
    """Return roleDefinition display names to try for a requested role group."""
    if role_group == DEFAULT_ROLE_GROUP:
        return _AUDIT_LOG_ROLE_DEFINITION_ALIASES
    return (role_group,)


def _principal_type_allows_service_principal(role_def: object) -> bool:
    """Best-effort filter for Exchange roleDefinitions usable by SPs."""
    if not isinstance(role_def, dict):
        return False
    allowed = str(role_def.get("allowedPrincipalTypes") or "")
    if not allowed:
        # Older/beta responses may omit the property; let Graph decide.
        return True
    normalised = _normalise_role_name(allowed)
    return "serviceprincipal" in normalised or "application" in normalised


def _pick_graph_role_definition(
    role_defs: list[object],
    candidates: tuple[str, ...],
) -> dict[str, object] | None:
    """Pick the best matching Graph Exchange roleDefinition.

    Candidate order is meaningful: for audit log access we prefer
    'View-Only Audit Logs' over the broader 'Audit Logs'. Role names are
    normalised because Exchange/Purview beta responses sometimes differ
    by spaces or casing.
    """
    candidate_order = {
        _normalise_role_name(name): index
        for index, name in enumerate(candidates)
    }
    matches: list[tuple[int, int, dict[str, object]]] = []
    for entry in role_defs:
        if not isinstance(entry, dict):
            continue
        display_name = str(entry.get("displayName") or "")
        index = candidate_order.get(_normalise_role_name(display_name))
        if index is None:
            continue
        principal_penalty = 0 if _principal_type_allows_service_principal(entry) else 1
        matches.append((index, principal_penalty, entry))
    if not matches:
        return None
    matches.sort(key=lambda item: (item[0], item[1]))
    return matches[0][2]


def _audit_related_role_names(role_defs: list[object]) -> str:
    """Return a compact diagnostic list of audit-ish Graph role definitions."""
    names: list[str] = []
    for entry in role_defs:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("displayName") or "").strip()
        normalised = _normalise_role_name(name)
        if name and ("audit" in normalised or "log" in normalised):
            names.append(name)
    return ", ".join(sorted(dict.fromkeys(names))[:12])


@dataclass
class RbacOutcome:
    """Structured result of an :func:`ensure_audit_reader_role` call."""

    success: bool
    state: str        # "added" | "added_via_graph" | "already_member" |
                      # "powershell_missing" | "module_install_failed" |
                      # "signin_failed" | "rbac_denied" |
                      # "role_group_missing" | "graph_forbidden" |
                      # "graph_token_missing" | "graph_error" |
                      # "graph_unreachable" | "error"
    message: str
    stdout: str = ""
    stderr: str = ""
    returncode: int = 0


# ---------------------------------------------------------------------------
# Path 1: Microsoft Graph beta (preferred).
# ---------------------------------------------------------------------------

def _grant_via_graph(
    access_token: str,
    sp_object_id: str,
    role_group: str,
    *,
    http_client: object | None = None,
    timeout: float = 30.0,
    sleep: object | None = None,
) -> RbacOutcome | None:
    """Try to grant ``role_group`` to the SP via Graph beta.

    Returns a final :class:`RbacOutcome` on a definitive answer
    (success or unambiguous failure). Returns ``None`` only when the
    Graph endpoint itself is unreachable / unauthorised so the caller
    can decide how to surface that to the user. Freshly created SPs
    that haven't propagated to the Exchange catalog are retried
    internally; the caller does not need to retry separately.

    Args:
        access_token: Delegated bearer token carrying
            ``RoleManagement.ReadWrite.Exchange``.
        sp_object_id: Service-principal object id (GUID).
        role_group: Role name (default ``'Audit Reader'``).
        http_client: Optional injected client for tests. Must expose
            ``.get()`` and ``.post()`` returning httpx-like Response
            objects.
        timeout: Per-request HTTP timeout.
        sleep: Optional callable for tests to skip backoff sleeps.
    """
    if not access_token:
        return None
    sleep_fn = sleep or time.sleep

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    own_client = http_client is None
    client = http_client or httpx.Client(timeout=timeout)
    try:
        # ---- Look up the role definition id ----------------------
        # Graph Exchange roleAssignments expects an Exchange management
        # roleDefinition (for audit access: 'View-Only Audit Logs' or
        # 'Audit Logs'), not the classic/Purview role-group name
        # 'Audit Reader'. List all roleDefinitions and match locally so
        # beta provider filtering/name quirks don't hide valid roles.
        role_defs: list[object] = []
        rd_url: str | None = f"{MS_GRAPH_BASE_BETA}/roleManagement/exchange/roleDefinitions"
        while rd_url:
            try:
                rd_resp = client.get(rd_url, headers=headers)
            except httpx.HTTPError as e:
                log.warning("Graph roleDefinitions GET failed: %r", e)
                return None

            if rd_resp.status_code in (401, 403):
                log.info(
                    "Graph roleDefinitions GET unauthorised (%s) — token lacks "
                    "RoleManagement.ReadWrite.Exchange.",
                    rd_resp.status_code,
                )
                return RbacOutcome(
                    success=False,
                    state="graph_forbidden",
                    message=translate(
                        "purviewRbac.graphQueryForbidden", status=rd_resp.status_code
                    ),
                    stderr=_tail(rd_resp.text, 600),
                    returncode=rd_resp.status_code,
                )
            if rd_resp.status_code != 200:
                log.warning(
                    "Graph roleDefinitions GET unexpected status %s: %s",
                    rd_resp.status_code,
                    _tail(rd_resp.text, 400),
                )
                return RbacOutcome(
                    success=False,
                    state="graph_error",
                    message=translate(
                        "purviewRbac.graphQueryFailed",
                        status=rd_resp.status_code,
                        detail=_tail(rd_resp.text, 600),
                    ),
                    stderr=_tail(rd_resp.text, 600),
                    returncode=rd_resp.status_code,
                )
            try:
                payload = rd_resp.json()
            except ValueError:
                log.warning("Graph roleDefinitions returned non-JSON body")
                return RbacOutcome(
                    success=False,
                    state="graph_error",
                    message=translate("purviewRbac.graphQueryNotJson"),
                    stderr=_tail(rd_resp.text, 600),
                    returncode=rd_resp.status_code,
                )
            values = payload.get("value") or []
            if isinstance(values, list):
                role_defs.extend(values)
            next_link = payload.get("@odata.nextLink")
            rd_url = next_link if isinstance(next_link, str) and next_link else None

        candidates = _graph_role_definition_candidates(role_group)
        role_def_entry = _pick_graph_role_definition(role_defs, candidates)
        if role_def_entry is None:
            available = _audit_related_role_names(role_defs)
            available_line = (
                translate("purviewRbac.availableRoleDefs", available=available)
                if available
                else ""
            )
            expected = ", ".join(candidates)
            return RbacOutcome(
                success=False,
                state="role_group_missing",
                message=translate(
                    "purviewRbac.roleDefNotFound",
                    expected=expected,
                    availableLine=available_line,
                ),
            )

        role_def_id = role_def_entry.get("id")
        resolved_name = str(role_def_entry.get("displayName") or role_group)
        if not role_def_id:
            return None

        # ---- Create the role assignment ---------------------------
        # Fresh SPs can take a few seconds to propagate into the
        # Exchange/Purview catalog: Graph then returns 400/404 with a
        # "Couldn't find object" / "principalId" / ManagementObject
        # NotFoundException message until propagation completes. Retry
        # a few times before declaring failure.
        ra_url = f"{MS_GRAPH_BASE_BETA}/roleManagement/exchange/roleAssignments"
        body = {
            "principalId": f"/ServicePrincipals/{sp_object_id}",
            "roleDefinitionId": role_def_id,
            "directoryScopeId": "/",
            "appScopeId": None,
        }
        last_ra_resp = None
        for attempt in range(1, _GRAPH_RETRY_ATTEMPTS + 1):
            try:
                ra_resp = client.post(ra_url, headers=headers, json=body)
            except httpx.HTTPError as e:
                log.warning("Graph roleAssignments POST failed: %r", e)
                return None
            last_ra_resp = ra_resp

            if ra_resp.status_code == 201:
                return RbacOutcome(
                    success=True,
                    state="added_via_graph",
                    message=translate("purviewRbac.addedViaGraph", name=resolved_name),
                    stdout=_tail(ra_resp.text, 400),
                )
            if ra_resp.status_code == 409:
                # Already exists — idempotent success.
                return RbacOutcome(
                    success=True,
                    state="already_member",
                    message=translate("purviewRbac.alreadyInRole", name=resolved_name),
                    stdout=_tail(ra_resp.text, 400),
                )
            if ra_resp.status_code in (401, 403):
                # Token genuinely lacks the scope — no point retrying.
                log.info(
                    "Graph roleAssignments POST forbidden (%s).",
                    ra_resp.status_code,
                )
                return RbacOutcome(
                    success=False,
                    state="graph_forbidden",
                    message=translate(
                        "purviewRbac.graphGrantForbidden", status=ra_resp.status_code
                    ),
                    stderr=_tail(ra_resp.text, 600),
                    returncode=ra_resp.status_code,
                )

            # 400/404 — could be transient SP propagation. Inspect body.
            body_text = _tail(ra_resp.text, 800)
            if (
                ra_resp.status_code in (400, 404)
                and _NOT_FOUND_PATTERNS.search(body_text)
                and attempt < _GRAPH_RETRY_ATTEMPTS
            ):
                log.info(
                    "Graph POST roleAssignments attempt %d returned %d "
                    "(SP not yet propagated). Retrying in %.1fs...",
                    attempt,
                    ra_resp.status_code,
                    _GRAPH_RETRY_DELAY_S,
                )
                sleep_fn(_GRAPH_RETRY_DELAY_S)
                continue
            # Definitive Graph failure (no point retrying further).
            break

        # Fell through the retry loop — surface whatever the last
        # response was as a clean error (never silently fall back to PS).
        ra_resp = last_ra_resp
        assert ra_resp is not None  # loop ran at least once
        return RbacOutcome(
            success=False,
            state="graph_error",
            message=translate(
                "purviewRbac.graphGrantFailed",
                status=ra_resp.status_code,
                detail=_tail(ra_resp.text, 600),
            ),
            stderr=_tail(ra_resp.text, 600),
            returncode=ra_resp.status_code,
        )
    finally:
        if own_client:
            with contextlib.suppress(Exception):
                client.close()  # type: ignore[union-attr]


def _find_powershell() -> str | None:
    """Locate pwsh first (cross-platform), fall back to Windows PowerShell."""
    for name in ("pwsh", "pwsh.exe", "powershell", "powershell.exe"):
        path = shutil.which(name)
        if path:
            return path
    return None


def _build_script(sp_object_id: str, role_group: str) -> str:
    """Compose the inline PowerShell script.

    Tokens (``CWT_*``) are printed at each stage so the Python side can
    figure out where we got to without parsing localized PS errors.
    """
    # PowerShell single-quoted strings don't interpolate, so embedding
    # the validated GUID/role name directly is safe.
    # When the caller asks for the default Audit Reader role we also
    # accept the PascalCase Purview-unified form ('AuditReader') so
    # tenants on unified RBAC don't trigger a false "role missing".
    aliases = list(_AUDIT_READER_ALIASES) if role_group == DEFAULT_ROLE_GROUP else [role_group]
    ps_alias_array = ", ".join(f"'{a}'" for a in aliases)
    primary_role = aliases[0]
    return f"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
# Suppress ANSI color escapes (PS 7.2+) so error messages render cleanly
# in the GUI. Wrapped in a try because PS 5.1 has no $PSStyle.
try {{ $PSStyle.OutputRendering = 'PlainText' }} catch {{}}

# ---- Stale-session cleanup ---------------------------------------------
# A previous EXO/IPPS session left around in this user profile can cause
# Add-RoleGroupMember to be routed to the wrong recipient catalog
# (e.g. 'FfoRecipientSession'), where 'Audit Reader' looks missing.
# Tear everything down before we connect.
try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null }} catch {{}}
try {{
    Get-PSSession -ErrorAction SilentlyContinue |
        Where-Object {{ $_.ConfigurationName -match 'Microsoft\\.Exchange|Compliance' -or $_.ComputerName -match 'outlook|compliance' }} |
        Remove-PSSession -ErrorAction SilentlyContinue
}} catch {{}}

try {{
    # ---- Module install / upgrade -------------------------------------
    # Versions < 3.4 had stale-session caching bugs that route IPPS
    # cmdlets to EOP/FFO catalogs. Force a recent build.
    $existing = Get-Module -ListAvailable -Name ExchangeOnlineManagement |
        Sort-Object Version -Descending | Select-Object -First 1
    if (-not $existing -or [Version]$existing.Version -lt [Version]'3.4.0') {{
        Write-Host '{_TOK_INSTALL}'
        try {{
            Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber -SkipPublisherCheck -ErrorAction Stop
        }} catch {{
            Write-Error ("MODULE_INSTALL_FAILED: " + $_.Exception.Message)
            exit 2
        }}
    }}
    Import-Module ExchangeOnlineManagement -ErrorAction Stop

    # ---- Connect to Security & Compliance (IPPS) ----------------------
    Write-Host '{_TOK_CONNECT}'
    function Connect-Ipps {{
        try {{
            # 'Audit Reader' lives in Security & Compliance, not EXO.
            Connect-IPPSSession -ShowBanner:$false -ErrorAction Stop | Out-Null
            return $true
        }} catch {{
            return $false
        }}
    }}
    if (-not (Connect-Ipps)) {{
        try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}
        if (-not (Connect-Ipps)) {{
            Write-Error ("CONNECT_FAILED: Unable to establish a Security & Compliance (IPPS) session.")
            exit 3
        }}
    }}

    # ---- Verify we actually got an IPPS session -----------------------
    # If Get-ConnectionInformation reports only an EXO session (no IPPS),
    # the cmdlet calls will hit the wrong recipient catalog.  Force a
    # clean reconnect once before proceeding.
    function Test-IppsSession {{
        try {{
            $info = Get-ConnectionInformation -ErrorAction SilentlyContinue
            if (-not $info) {{ return $false }}
            foreach ($c in $info) {{
                $uri = [string]$c.ConnectionUri
                $tok = [string]$c.TokenStatus
                $name = [string]$c.Name
                if ($uri -match 'compliance\\.protection' -or $name -match 'IPPS|Compliance') {{ return $true }}
            }}
            return $false
        }} catch {{ return $false }}
    }}
    if (-not (Test-IppsSession)) {{
        try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}
        Connect-Ipps | Out-Null
    }}

    # ---- Pre-flight: role group must be visible on this session -------
    Write-Host '{_TOK_PRECHECK}'
    # Try each alias in turn; whichever one the tenant exposes wins.
    $aliases = @({ps_alias_array})
    $rg = $null
    $rgName = $null
    function Find-RoleGroupByAlias($aliases) {{
        foreach ($n in $aliases) {{
            try {{
                $tmp = Get-RoleGroup -Identity $n -ErrorAction SilentlyContinue
                if ($tmp) {{ return @{{ Group = $tmp; Name = $n }} }}
            }} catch {{}}
        }}
        return $null
    }}
    $hit = Find-RoleGroupByAlias $aliases
    if ($null -eq $hit) {{
        # One more clean reconnect attempt before declaring missing.
        try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}
        Connect-Ipps | Out-Null
        $hit = Find-RoleGroupByAlias $aliases
    }}
    if ($null -eq $hit) {{
        Write-Host '{_TOK_NO_ROLE}'
        $cands = @()
        try {{
            $cands = Get-RoleGroup -ErrorAction SilentlyContinue |
                Where-Object {{ $_.Name -match 'Audit|Reader|Compliance' }} |
                Select-Object -ExpandProperty Name
        }} catch {{}}
        if ($cands.Count -gt 0) {{ Write-Host ("{_TOK_CANDIDATES} " + ($cands -join ', ')) }}
        Write-Error ("ROLE_GROUP_ABSENT: '{primary_role}' is not visible on this tenant's IPPS session catalog (tried: " + ($aliases -join ', ') + ").")
        exit 5
    }}
    $rg = $hit.Group
    $rgName = $hit.Name

    # ---- Add the service principal as a member ------------------------
    Write-Host '{_TOK_ADD}'
    $attempts = 0
    $lastErr = $null
    while ($attempts -lt 2) {{
        $attempts++
        try {{
            Add-RoleGroupMember -Identity $rgName -Member '{sp_object_id}' -Confirm:$false -ErrorAction Stop
            Write-Host '{_TOK_ADDED}'
            $lastErr = $null
            break
        }} catch {{
            $msg = [string]$_.Exception.Message
            if ($msg -match 'already a member|already exists|is already added') {{
                Write-Host '{_TOK_ALREADY}'
                $lastErr = $null
                break
            }}
            $lastErr = $_
            if ($attempts -lt 2) {{
                # Reconnect for one more retry — covers transient
                # 'object not found on FfoRecipientSession' caused by
                # a session that drifted to the wrong catalog.
                try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}
                Connect-Ipps | Out-Null
            }}
        }}
    }}
    if ($lastErr) {{
        Write-Error ("ADD_MEMBER_FAILED: " + $lastErr.Exception.Message)
        try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}
        exit 4
    }}
}} finally {{
    try {{ Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}
}}
Write-Host '{_TOK_DONE}'
""".strip()


def ensure_audit_reader_role(
    sp_object_id: str,
    *,
    role_group: str = DEFAULT_ROLE_GROUP,
    timeout: float = 600.0,
    runner: object = None,
    access_token: str | None = None,
    http_client: object | None = None,
) -> RbacOutcome:
    """Add ``sp_object_id`` to the ``role_group``.

    Uses Microsoft Graph beta when a delegated bootstrap token is
    supplied (silent, no PowerShell, no interactive sign-in). The legacy
    PowerShell path is reached only by callers that do not pass a token.

    Args:
        sp_object_id: Service principal object ID (GUID).
        role_group: Role group name; defaults to ``Audit Reader``.
        timeout: Hard cap for the PowerShell process (default 10 min).
        runner: Optional callable matching :func:`subprocess.run` for
            tests to inject a fake PowerShell.
        access_token: Delegated bearer token from the bootstrap
            authenticator. If present, the Graph path is used exclusively.
        http_client: Optional injected httpx-like client for tests.

    Returns:
        :class:`RbacOutcome` describing the outcome.
    """
    if not _GUID_RE.match(sp_object_id or ""):
        return RbacOutcome(
            success=False,
            state="error",
            message=f"Invalid service principal object id: {sp_object_id!r}",
        )
    if not _ROLE_NAME_RE.match(role_group or ""):
        return RbacOutcome(
            success=False,
            state="error",
            message=f"Invalid role group name: {role_group!r}",
        )

    # ---- Path 1: Microsoft Graph beta ----------------------------------
    # Whenever the bootstrap delegated token is available we go through
    # Graph only — never silently fall back to PowerShell. PowerShell
    # surfaces the same Exchange catalog errors (SP propagation lag,
    # role display-name mismatch) in less-friendly form, and we already
    # request the ``RoleManagement.ReadWrite.Exchange`` scope at sign-in
    # so the token should work. If Graph fails the outcome contains a
    # clear, actionable message and the wizard's retry button lets the
    # operator retry without involving PowerShell.
    if access_token:
        log.info(
            "Granting role via Microsoft Graph (role=%s, sp=%s)",
            role_group,
            sp_object_id,
        )
        try:
            graph_outcome = _grant_via_graph(
                access_token,
                sp_object_id,
                role_group,
                http_client=http_client,
            )
        except Exception as e:  # noqa: BLE001 — never crash the caller
            log.exception("Graph-based role grant raised")
            return RbacOutcome(
                success=False,
                state="graph_error",
                message=translate("purviewRbac.graphException", error=repr(e)),
            )
        if graph_outcome is not None:
            return graph_outcome
        # ``None`` here means the HTTP layer itself was unreachable.
        return RbacOutcome(
            success=False,
            state="graph_unreachable",
            message=translate("purviewRbac.graphUnreachable"),
        )

    # ---- Path 2: PowerShell fallback (no token supplied) ---------------
    # Reached only by tests / legacy callers that don't pass a token.
    ps = _find_powershell()
    if ps is None:
        return RbacOutcome(
            success=False,
            state="powershell_missing",
            message=translate("purviewRbac.powershellMissing"),
        )

    script = _build_script(sp_object_id, role_group)
    log.info(
        "Running ExchangeOnline RBAC script (ps=%s, role=%s, sp=%s)",
        ps,
        role_group,
        sp_object_id,
    )

    run = runner or subprocess.run
    try:
        proc = run(  # type: ignore[misc]
            [ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return RbacOutcome(
            success=False,
            state="error",
            message=translate("purviewRbac.powershellTimeout", timeout=f"{timeout:.0f}"),
            stdout=(e.stdout or "") if isinstance(e.stdout, str) else "",
            stderr=(e.stderr or "") if isinstance(e.stderr, str) else "",
            returncode=-1,
        )
    except FileNotFoundError as e:
        return RbacOutcome(
            success=False,
            state="powershell_missing",
            message=translate("purviewRbac.powershellRunFailed", error=e),
        )

    out = _strip_ansi(proc.stdout or "")
    err = _strip_ansi(proc.stderr or "")
    rc = proc.returncode

    # Successful add or no-op.
    if _TOK_ADDED in out:
        return RbacOutcome(
            success=True,
            state="added",
            message=translate("purviewRbac.addedViaPowershell", roleGroup=role_group),
            stdout=out,
            stderr=err,
            returncode=rc,
        )
    if _TOK_ALREADY in out or _ALREADY_MEMBER_RE.search(err):
        return RbacOutcome(
            success=True,
            state="already_member",
            message=translate(
                "purviewRbac.alreadyMemberPowershell", roleGroup=role_group
            ),
            stdout=out,
            stderr=err,
            returncode=rc,
        )

    # Categorize known failure modes by exit code first.
    state, friendly = _classify_failure(rc, out, err)
    return RbacOutcome(
        success=False,
        state=state,
        message=friendly,
        stdout=out,
        stderr=err,
        returncode=rc,
    )


def _classify_failure(rc: int, out: str, err: str) -> tuple[str, str]:
    """Map exit code + log markers to a friendly Korean message."""
    if rc == 2 or "MODULE_INSTALL_FAILED" in err:
        return (
            "module_install_failed",
            translate("purviewRbac.moduleInstallFailed"),
        )
    if rc == 3 or "CONNECT_FAILED" in err:
        return (
            "signin_failed",
            translate("purviewRbac.signinFailed"),
        )
    if rc == 5 or "ROLE_GROUP_ABSENT" in err or _TOK_NO_ROLE in out:
        candidates = _extract_candidates(out)
        cand_line = (
            translate("purviewRbac.candidateRoleGroups", candidates=candidates)
            if candidates
            else ""
        )
        return (
            "role_group_missing",
            translate("purviewRbac.roleGroupNotAutoGranted", candLine=cand_line),
        )
    if rc == 4 or "ADD_MEMBER_FAILED" in err:
        # "Cannot find object" / "찾을 수 없" indicates the role group
        # doesn't exist on the endpoint we connected to (most common
        # cause: legacy code connected to Exchange Online instead of
        # the Security & Compliance endpoint).  Surface as its own
        # state so the operator doesn't waste time checking RBAC.
        if re.search(r"couldn'?t be found|cannot be found|찾을 수 없", err, re.IGNORECASE):
            return (
                "role_group_missing",
                translate(
                    "purviewRbac.roleGroupNotInCatalog", detail=_tail(err, 400)
                ),
            )
        return (
            "rbac_denied",
            translate("purviewRbac.roleGroupAddDenied", detail=_tail(err, 400)),
        )
    # Generic fallback — surface whatever the user is seeing.
    return (
        "error",
        translate(
            "purviewRbac.powershellFailed",
            rc=rc,
            detail=_tail(err, 400) or _tail(out, 400),
        ),
    )


def _tail(s: str, n: int) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return "…" + s[-n:]


def _extract_candidates(out: str) -> str:
    """Extract the comma-joined role-group names from the CWT_CANDIDATES line.

    The PowerShell script emits a line like ``CWT_CANDIDATES: Audit Manager,
    Compliance Administrator`` when the requested role group is missing
    but other Audit/Reader/Compliance-named groups exist on the IPPS
    session.  Returns the joined string, or empty if not present.
    """
    if not out:
        return ""
    for line in out.splitlines():
        line = line.strip()
        if line.startswith(_TOK_CANDIDATES):
            return line[len(_TOK_CANDIDATES):].strip()
    return ""


__all__ = [
    "DEFAULT_ROLE_GROUP",
    "RbacOutcome",
    "ensure_audit_reader_role",
]
