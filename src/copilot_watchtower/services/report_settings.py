"""Microsoft 365 usage report privacy settings via Microsoft Graph."""
from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from ..config import MS_GRAPH_BASE_BETA

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ReportSettingsOutcome:
    success: bool
    state: str
    message: str
    display_concealed_names: bool | None = None


class ReportSettingsClient:
    def __init__(self, access_token: str, *, http_client: httpx.Client | None = None) -> None:
        self._client = http_client or httpx.Client(timeout=30.0)
        self._owns_client = http_client is None
        self._headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "ReportSettingsClient":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def get_display_concealed_names(self) -> bool | None:
        response = self._client.get(
            f"{MS_GRAPH_BASE_BETA}/admin/reportSettings",
            headers=self._headers,
        )
        response.raise_for_status()
        payload = response.json()
        value = payload.get("value") if isinstance(payload.get("value"), dict) else payload
        setting = value.get("displayConcealedNames") if isinstance(value, dict) else None
        return bool(setting) if setting is not None else None

    def set_display_concealed_names(self, value: bool) -> None:
        response = self._client.patch(
            f"{MS_GRAPH_BASE_BETA}/admin/reportSettings",
            headers=self._headers,
            json={"displayConcealedNames": value},
        )
        response.raise_for_status()


def ensure_usage_reports_show_user_details(access_token: str) -> ReportSettingsOutcome:
    """Turn off concealed names for Microsoft 365 usage reports.

    ``displayConcealedNames=false`` means reports include identifiable user,
    group, and site names. This is a tenant-level privacy setting.
    """
    try:
        with ReportSettingsClient(access_token) as client:
            current = client.get_display_concealed_names()
            if current is False:
                return ReportSettingsOutcome(
                    success=True,
                    state="already_visible",
                    message="사용량 보고서가 이미 사용자 이름/UPN을 표시하도록 설정되어 있습니다.",
                    display_concealed_names=False,
                )
            client.set_display_concealed_names(False)
            after = client.get_display_concealed_names()
            if after is False:
                return ReportSettingsOutcome(
                    success=True,
                    state="updated",
                    message="사용량 보고서 익명화 설정을 해제했습니다. 다음 수집부터 실제 사용자 정보가 표시됩니다.",
                    display_concealed_names=False,
                )
            return ReportSettingsOutcome(
                success=False,
                state="not_confirmed",
                message="사용량 보고서 설정 변경을 요청했지만 결과를 확인하지 못했습니다. 잠시 후 다시 수집해 보세요.",
                display_concealed_names=after,
            )
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:800]
        log.warning("Failed to update report settings: %s", detail)
        return ReportSettingsOutcome(
            success=False,
            state="graph_error",
            message=(
                "사용량 보고서 실명 표시 설정을 변경하지 못했습니다. "
                "ReportSettings.ReadWrite.All 권한과 적절한 관리자 역할이 필요합니다.\n"
                f"Graph 응답: {detail}"
            ),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Unexpected report settings failure")
        return ReportSettingsOutcome(
            success=False,
            state="error",
            message=f"사용량 보고서 실명 표시 설정 중 예기치 못한 오류: {exc!r}",
        )