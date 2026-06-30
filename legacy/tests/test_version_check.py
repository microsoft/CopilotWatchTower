"""Tests for the version-check service and the bridge update slots."""
from __future__ import annotations

import json

import httpx
import pytest

from copilot_watchtower.services import version_check as vc


def _release_payload(**overrides):
    payload = {
        "tag_name": "v0.3.0",
        "name": "CopilotWatchTower 0.3.0",
        "html_url": "https://github.com/microsoft/CopilotWatchTower/releases/tag/v0.3.0",
        "body": "release notes",
        "published_at": "2024-05-01T00:00:00Z",
        "prerelease": False,
        "assets": [
            {
                "name": "CopilotWatchTower.msix",
                "browser_download_url": "https://example.test/CopilotWatchTower.msix",
            }
        ],
    }
    payload.update(overrides)
    return payload


def test_parse_semver_strips_v_prefix() -> None:
    assert vc.parse_semver("v1.2.3") == (1, 2, 3)
    assert vc.parse_semver("1.2.3") == (1, 2, 3)


def test_parse_semver_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        vc.parse_semver("not-a-version")


def test_compare_versions_orders_correctly() -> None:
    assert vc.compare_versions("0.1.0", "0.2.0") == -1
    assert vc.compare_versions("0.2.0", "0.2.0") == 0
    assert vc.compare_versions("1.0.0", "0.9.9") == 1


def test_parse_release_payload_extracts_msix_asset() -> None:
    release = vc.parse_release_payload(_release_payload())
    assert release.version == "0.3.0"
    assert release.tag == "v0.3.0"
    assert release.download_url == "https://example.test/CopilotWatchTower.msix"
    assert release.prerelease is False


def test_parse_release_payload_requires_tag() -> None:
    with pytest.raises(vc.VersionCheckError):
        vc.parse_release_payload({"name": "no tag"})


def test_fetch_latest_release_parses_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "User-Agent" in request.headers
        return httpx.Response(200, json=_release_payload())

    client = httpx.Client(transport=httpx.MockTransport(handler))
    release = vc.fetch_latest_release(client=client)
    assert release.version == "0.3.0"


def test_fetch_latest_release_404_raises_friendly() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "Not Found"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(vc.VersionCheckError) as exc:
        vc.fetch_latest_release(client=client)
    assert "릴리스" in str(exc.value)


def test_check_for_update_flags_new_version() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_release_payload())

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = vc.check_for_update("0.1.0", client=client)
    assert result["ok"] is True
    assert result["update_available"] is True
    assert result["latest_version"] == "0.3.0"


def test_check_for_update_same_version_not_available() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_release_payload(tag_name="v0.1.0"))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = vc.check_for_update("0.1.0", client=client)
    assert result["ok"] is True
    assert result["update_available"] is False


def test_check_for_update_network_error_returns_ok_false() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = vc.check_for_update("0.1.0", client=client)
    assert result["ok"] is False
    assert "error" in result


def test_bridge_check_for_updates_uses_service(qtbot, monkeypatch: pytest.MonkeyPatch) -> None:
    from copilot_watchtower.webshell import bridge as bridge_mod

    del qtbot  # ensures a QApplication exists
    captured = {}

    def fake_check(current_version: str):
        captured["current"] = current_version
        return {"ok": True, "current_version": current_version, "update_available": False}

    monkeypatch.setattr(
        "copilot_watchtower.services.version_check.check_for_update", fake_check
    )

    ctx = bridge_mod.BridgeContext(repo=None)
    b = bridge_mod.Bridge(ctx)
    result = json.loads(b.check_for_updates())
    assert result["ok"] is True
    assert captured["current"] == bridge_mod.__version__


def test_bridge_app_version_reports_installed(qtbot) -> None:
    from copilot_watchtower.webshell import bridge as bridge_mod

    del qtbot
    ctx = bridge_mod.BridgeContext(repo=None)
    b = bridge_mod.Bridge(ctx)
    result = json.loads(b.app_version())
    assert result["ok"] is True
    assert result["version"] == bridge_mod.__version__


def test_bridge_open_external_url_rejects_non_http(qtbot) -> None:
    from copilot_watchtower.webshell import bridge as bridge_mod

    del qtbot
    ctx = bridge_mod.BridgeContext(repo=None)
    b = bridge_mod.Bridge(ctx)
    result = json.loads(b.open_external_url("file:///etc/passwd"))
    assert result["ok"] is False
