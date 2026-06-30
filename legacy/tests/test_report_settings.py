from __future__ import annotations

import httpx

from copilot_watchtower.services.report_settings import ReportSettingsClient


def test_report_settings_get_handles_value_wrapper() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        return httpx.Response(200, json={"value": {"displayConcealedNames": True}})

    client = ReportSettingsClient("token", http_client=httpx.Client(transport=httpx.MockTransport(handler)))

    assert client.get_display_concealed_names() is True


def test_report_settings_patch_sends_false() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        seen.append(__import__("json").loads(request.content.decode("utf-8")))
        return httpx.Response(204)

    client = ReportSettingsClient("token", http_client=httpx.Client(transport=httpx.MockTransport(handler)))

    client.set_display_concealed_names(False)

    assert seen == [{"displayConcealedNames": False}]