"""Tests for the Exchange Online RBAC automation wrapper.

We mock :func:`subprocess.run` via the ``runner`` injection point so
no actual PowerShell is required for CI.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass

import pytest

from copilot_watchtower.services import purview_rbac as rbac


@dataclass
class _FakeProc:
    stdout: str = ""
    stderr: str = ""
    returncode: int = 0


def _make_runner(proc: _FakeProc, *, raise_exc: Exception | None = None):
    """Build a fake subprocess.run that returns ``proc`` (or raises)."""
    calls: list[tuple] = []

    def runner(cmd, *args, **kwargs):
        calls.append((tuple(cmd), kwargs))
        if raise_exc:
            raise raise_exc
        return proc

    runner.calls = calls  # type: ignore[attr-defined]
    return runner


# ---- Argument validation ------------------------------------------------


def test_invalid_sp_object_id_rejected_without_running_ps() -> None:
    runner = _make_runner(_FakeProc())
    outcome = rbac.ensure_audit_reader_role("not-a-guid", runner=runner)
    assert outcome.success is False
    assert outcome.state == "error"
    assert runner.calls == []  # type: ignore[attr-defined]


def test_invalid_role_group_rejected() -> None:
    runner = _make_runner(_FakeProc())
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        role_group="bad; injection`stuff",
        runner=runner,
    )
    assert outcome.success is False
    assert outcome.state == "error"
    assert runner.calls == []  # type: ignore[attr-defined]


# ---- Success states -----------------------------------------------------


def test_role_added_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_INSTALL_MODULE\nCWT_CONNECT\nCWT_ADD_MEMBER\nCWT_ROLE_ADDED\nCWT_DONE\n",
        stderr="",
        returncode=0,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is True
    assert outcome.state == "added"
    assert "Audit Reader" in outcome.message


def test_already_member_is_treated_as_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_CONNECT\nCWT_ADD_MEMBER\nCWT_ROLE_ALREADY_MEMBER\nCWT_DONE\n",
        stderr="",
        returncode=0,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is True
    assert outcome.state == "already_member"


# ---- Failure classifications --------------------------------------------


def test_module_install_failure_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_INSTALL_MODULE\n",
        stderr="MODULE_INSTALL_FAILED: access denied",
        returncode=2,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert outcome.state == "module_install_failed"
    assert "Install-Module" in outcome.message


def test_connect_failure_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_CONNECT\n",
        stderr="CONNECT_FAILED: user_cancelled",
        returncode=3,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert outcome.state == "signin_failed"


def test_rbac_denied_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_CONNECT\nCWT_ADD_MEMBER\n",
        stderr="ADD_MEMBER_FAILED: The user does not have permission",
        returncode=4,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert outcome.state == "rbac_denied"
    assert "Organization Management" in outcome.message


def test_role_group_missing_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    """'object not found' on the connected endpoint is its own state.

    This is the symptom of connecting to the wrong PowerShell endpoint
    (e.g., Exchange Online instead of Security & Compliance) and should
    not be reported as an RBAC permission problem.
    """
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_CONNECT\nCWT_ADD_MEMBER\n",
        stderr=(
            "ADD_MEMBER_FAILED: 'BLAPR22A14DC005.PROD.OUTLOOK.COM'에서 "
            "'Audit Reader' 개체를 찾을 수 없기 때문에 작업을 수행할 수 없습니다."
        ),
        returncode=4,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert outcome.state == "role_group_missing"
    assert "찾을 수 없" in outcome.message
    # No manual-grant guidance — user explicitly rejected that path.
    assert "purview.microsoft.com" not in outcome.message
    # Should hint at retry instead.
    assert ("다시 시도" in outcome.message) or ("재시도" in outcome.message)


def test_role_group_absent_preflight_classified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exit-code-5 pre-flight: PS detected the role group is missing before add.

    The PowerShell script's ``Get-RoleGroup -Identity`` pre-flight emits
    ``CWT_ROLE_NOT_FOUND`` and (optionally) ``CWT_CANDIDATES: ...`` then
    exits with code 5.  We classify this as ``role_group_missing`` and
    surface the candidate role-group names so the operator can diagnose.
    """
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout=(
            "CWT_CONNECT\nCWT_PRECHECK\nCWT_ROLE_NOT_FOUND\n"
            "CWT_CANDIDATES: Audit Manager, Compliance Administrator\n"
        ),
        stderr=(
            "ROLE_GROUP_ABSENT: 'Audit Reader' was not found in this "
            "tenant's Security & Compliance role group catalog."
        ),
        returncode=5,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert outcome.state == "role_group_missing"
    assert "Audit Manager" in outcome.message
    assert "Compliance Administrator" in outcome.message
    # No manual-grant guidance — only candidates and retry hint.
    assert "purview.microsoft.com" not in outcome.message


def test_role_group_absent_preflight_without_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the IPPS session returns zero similar role groups, still classify cleanly."""
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_CONNECT\nCWT_PRECHECK\nCWT_ROLE_NOT_FOUND\n",
        stderr="ROLE_GROUP_ABSENT: 'Audit Reader' was not found",
        returncode=5,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert outcome.state == "role_group_missing"
    # No manual-grant guidance — message focuses on retry / skip.
    assert "purview.microsoft.com" not in outcome.message
    assert ("다시 시도" in outcome.message) or ("건너뛰기" in outcome.message)



def test_ansi_escapes_stripped_from_output(monkeypatch: pytest.MonkeyPatch) -> None:
    """PS 7+ emits ANSI colors; they must not leak into the GUI message."""
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    # Same shape of garbage we saw in the screenshot.
    ansi_err = (
        "\x1b[31;1mWrite-Error\x1b[0m: "
        "\x1b[31;1mADD_MEMBER_FAILED: The user does not have permission\x1b[0m"
    )
    proc = _FakeProc(
        stdout="\x1b[36mCWT_CONNECT\x1b[0m\nCWT_ADD_MEMBER\n",
        stderr=ansi_err,
        returncode=4,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is False
    assert "\x1b[" not in outcome.message
    assert "\x1b[" not in outcome.stdout
    assert "\x1b[" not in outcome.stderr


# ---- Environment edge cases ---------------------------------------------


def test_missing_powershell_is_friendly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: None)
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(_FakeProc()),
    )
    assert outcome.success is False
    assert outcome.state == "powershell_missing"


def test_timeout_returns_outcome(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    err = subprocess.TimeoutExpired(cmd="ps", timeout=1.0)
    err.stdout = "partial"
    err.stderr = "partial-err"
    runner = _make_runner(_FakeProc(), raise_exc=err)
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        timeout=1.0,
        runner=runner,
    )
    assert outcome.success is False
    assert outcome.state == "error"
    assert "시간 초과" in outcome.message


# ---- Microsoft Graph beta path ------------------------------------------


@dataclass
class _FakeResp:
    status_code: int
    _json: object | None = None
    text: str = ""

    def json(self) -> object:
        if self._json is None:
            raise ValueError("no json")
        return self._json


class _FakeHttpClient:
    """Records GETs/POSTs and returns canned :class:`_FakeResp` objects.

    Pass GET and POST response sequences as lists; each call pops the
    next response. Lets tests assert on the requests as well as the
    returned outcome.
    """

    def __init__(
        self,
        get_responses: list[_FakeResp] | None = None,
        post_responses: list[_FakeResp] | None = None,
    ) -> None:
        self.get_responses = list(get_responses or [])
        self.post_responses = list(post_responses or [])
        self.get_calls: list[tuple[str, dict]] = []
        self.post_calls: list[tuple[str, dict, object]] = []

    def get(self, url, headers=None, **kwargs):  # noqa: D401
        self.get_calls.append((url, headers or {}))
        return self.get_responses.pop(0)

    def post(self, url, headers=None, json=None, **kwargs):  # noqa: D401
        self.post_calls.append((url, headers or {}, json))
        return self.post_responses.pop(0)

    def close(self) -> None:
        pass


def test_graph_path_added_success_skips_powershell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Token + Graph 201 → ``added_via_graph``, PowerShell never invoked."""
    # If anything calls into PS, fail loudly.
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    client = _FakeHttpClient(
        get_responses=[
            _FakeResp(
                status_code=200,
                _json={"value": [{"id": "role-def-id-001", "displayName": "View-Only Audit Logs"}]},
            )
        ],
        post_responses=[_FakeResp(status_code=201, text='{"id":"ra-001"}')],
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        access_token="fake-bearer-token",
        http_client=client,
    )
    assert outcome.success is True
    assert outcome.state == "added_via_graph"
    assert "Microsoft Graph" in outcome.message
    # Verify the request shape matches the documented API.
    assert len(client.post_calls) == 1
    url, headers, body = client.post_calls[0]
    assert url.endswith("/roleManagement/exchange/roleAssignments")
    assert headers["Authorization"] == "Bearer fake-bearer-token"
    assert body["principalId"] == "/ServicePrincipals/00000000-0000-0000-0000-000000000001"
    assert body["roleDefinitionId"] == "role-def-id-001"
    assert body["directoryScopeId"] == "/"


def test_graph_path_409_treated_as_already_member(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    client = _FakeHttpClient(
        get_responses=[
            _FakeResp(
                status_code=200,
                _json={"value": [{"id": "rd-1", "displayName": "View-Only Audit Logs"}]},
            )
        ],
        post_responses=[_FakeResp(status_code=409, text="already exists")],
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        access_token="t",
        http_client=client,
    )
    assert outcome.success is True
    assert outcome.state == "already_member"


def test_graph_path_403_returns_clear_error_no_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Token without RoleManagement.ReadWrite.Exchange → clear Graph error.

    The wizard now requires Graph for the role grant; falling back to
    the PowerShell catalog hides the real cause (missing scope), so we
    surface a ``graph_forbidden`` outcome with an actionable message
    instead.
    """
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    client = _FakeHttpClient(
        get_responses=[_FakeResp(status_code=403, text="insufficient_claims")],
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        access_token="t",
        http_client=client,
    )
    assert outcome.success is False
    assert outcome.state == "graph_forbidden"
    assert "RoleManagement.ReadWrite.Exchange" in outcome.message
    assert outcome.returncode == 403


def test_graph_path_no_role_def_returns_clear_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty Graph role-def lookup → ``role_group_missing`` outcome, no PS."""
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    client = _FakeHttpClient(
        get_responses=[_FakeResp(status_code=200, _json={"value": []})],
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        access_token="t",
        http_client=client,
    )
    assert outcome.success is False
    assert outcome.state == "role_group_missing"
    assert "View-Only Audit Logs" in outcome.message


def test_graph_path_definitive_400_does_not_fall_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 400 from POST roleAssignments without 'not found' wording is final."""
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    client = _FakeHttpClient(
        get_responses=[
            _FakeResp(
                status_code=200,
                _json={"value": [{"id": "rd-1", "displayName": "View-Only Audit Logs"}]},
            )
        ],
        post_responses=[_FakeResp(status_code=400, text='{"error":{"message":"bad"}}')],
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        access_token="t",
        http_client=client,
    )
    assert outcome.success is False
    assert outcome.state == "graph_error"
    assert outcome.returncode == 400


def test_graph_retries_on_sp_propagation_lag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """400/404 'Couldn't find object' is retried (SP propagation lag)."""
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    sleeps: list[float] = []
    client = _FakeHttpClient(
        get_responses=[
            _FakeResp(
                status_code=200,
                _json={"value": [{"id": "rd-1", "displayName": "View-Only Audit Logs"}]},
            )
        ],
        post_responses=[
            _FakeResp(
                status_code=400,
                text=(
                    '{"error":{"message":"Couldn\'t find object '
                    '\"00000000-0000-0000-0000-000000000001\". Please make '
                    'sure that it was spelled correctly..."}}'
                ),
            ),
            _FakeResp(
                status_code=400,
                text='{"error":{"message":"ManagementObjectNotFoundException"}}',
            ),
            _FakeResp(status_code=201, text='{"id":"ra-001"}'),
        ],
    )
    outcome = rbac._grant_via_graph(
        "fake-token",
        "00000000-0000-0000-0000-000000000001",
        "Audit Reader",
        http_client=client,
        sleep=lambda s: sleeps.append(s),
    )
    assert outcome is not None
    assert outcome.success is True
    assert outcome.state == "added_via_graph"
    # Three POST attempts before the 201.
    assert len(client.post_calls) == 3
    # Two sleeps (between the three attempts).
    assert len(sleeps) == 2


def test_no_access_token_uses_powershell_directly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a token, Graph isn't even attempted — straight to PS."""
    monkeypatch.setattr(rbac, "_find_powershell", lambda: "pwsh.exe")
    proc = _FakeProc(
        stdout="CWT_CONNECT\nCWT_ADD_MEMBER\nCWT_ROLE_ADDED\nCWT_DONE\n",
        returncode=0,
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        runner=_make_runner(proc),
    )
    assert outcome.success is True
    assert outcome.state == "added"


def test_graph_lookup_uses_audit_log_role_definition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Default Audit Reader request maps to Graph's audit-log roleDefinition.

    Graph Exchange ``roleDefinitions`` are management roles (for example
    ``View-Only Audit Logs``), not the classic role group name
    ``Audit Reader``. The lookup lists definitions and matches locally.
    """
    monkeypatch.setattr(rbac, "_find_powershell", lambda: pytest.fail("PS should not run"))
    client = _FakeHttpClient(
        get_responses=[
            _FakeResp(
                status_code=200,
                _json={
                    "value": [
                        {"id": "rd-address", "displayName": "Address Lists"},
                        {"id": "rd-auditlogs", "displayName": "View-Only Audit Logs"},
                    ]
                },
            )
        ],
        post_responses=[_FakeResp(status_code=201, text='{"id":"ra-001"}')],
    )
    outcome = rbac.ensure_audit_reader_role(
        "00000000-0000-0000-0000-000000000001",
        access_token="t",
        http_client=client,
    )
    assert outcome.success is True
    assert outcome.state == "added_via_graph"
    assert "View-Only Audit Logs" in outcome.message
    # GET lists all definitions; it doesn't filter on the role-group name.
    assert len(client.get_calls) == 1
    get_url, _ = client.get_calls[0]
    assert get_url.endswith("/roleManagement/exchange/roleDefinitions")
    assert "$filter" not in get_url
    # POST used the role definition id returned by the tenant.
    assert client.post_calls[0][2]["roleDefinitionId"] == "rd-auditlogs"
