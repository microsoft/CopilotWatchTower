"""Client for the unofficial Power Platform Licensing / consumption API.

The Power Platform Admin Center (PPAC) reads tenant licensing/consumption data
from a service hosted at ``https://licensing.powerplatform.microsoft.com``.
There is **no published contract** for this API. The real endpoints PPAC calls
were discovered by capturing the admin-center SPA's network traffic (see
``scripts/spike_licensing.py``); the collector targets those directly:

* ``GET /v1.0/tenants/{tid}/CurrencyReports`` → per-currency purchase/allocation
  for Copilot Studio messages (``MCSMessages``), M365 Copilot, Windows 365
  PAYGO, etc. This is the primary Copilot-relevant consumption signal.
* ``GET /v0.1-alpha/tenants/{tid}/TenantCapacity`` → Dataverse storage
  (Database/File/Log) actual vs. rated consumption.
* ``GET /v2.0/tenants/{tid}/entitlements/MCSMessages/resources`` → the
  granular **per-environment / per-agent** Copilot Studio message consumption
  (the "리소스별 메시지 소비 > 다운로드" table). Returns every environment's
  agents in one call.
* ``GET /v2.0/tenants/{tid}/environments/entitlementConsumptions/MCSMessages``
  → per-environment allocated/consumed/available message capacity.

These endpoints return JSON **directly** (no async request→poll→download CSV
flow — the per-user CSV reports are behind a separate, manually-triggered PPAC
"Download report" action that is not auto-loaded). Auth is the licensing-
audience bearer token the PPAC SPA mints, captured via a real headless sign-in
(see :mod:`..services.consumption_browser_download`). The signed-in user must
be a Power Platform Admin or Global Admin or the service returns 403.

The JSON parsers (:func:`parse_currency_reports_json`,
:func:`parse_tenant_capacity_json`) and the legacy CSV parser
(:func:`parse_consumption_csv`) are deliberately decoupled from the HTTP layer
so they can be unit-tested with synthetic fixtures regardless of endpoint
drift.
"""
from __future__ import annotations

import csv
import datetime as _dt
import io
import json
import logging
from collections.abc import Iterable
from typing import Any

import httpx

from ..config import (
    LICENSING_API_RESOURCE,
    LICENSING_REPORT_UNITS,
)
from ..db.repository import ConsumptionRow

log = logging.getLogger(__name__)


class LicensingError(RuntimeError):
    def __init__(self, status: int | None, detail: object) -> None:
        super().__init__(f"Licensing API error {status}: {detail}")
        self.status = status
        self.detail = detail


# Candidate CSV header names for each logical field. The licensing CSV column
# names are not contractual, so we match case-insensitively against a set of
# observed/expected aliases and fall back gracefully when a column is absent.
_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "usage_date": ("date", "usagedate", "reportdate", "day", "consumptiondate"),
    "user_id": ("userid", "user id", "aaduserid", "objectid", "userobjectid", "userprincipalid"),
    "environment_id": ("environmentid", "environment id", "envid"),
    "environment_name": ("environmentname", "environment name", "envname", "environment"),
    "product": ("product", "productname", "capacitytype", "consumptiontype", "metertype"),
    "quantity": (
        "quantity",
        "messages",
        "messagecount",
        "credits",
        "creditsconsumed",
        "requests",
        "apicalls",
        "count",
        "consumed",
        "usage",
    ),
}


def _normalize_header(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum() or ch == " ").strip()


def _build_header_index(fieldnames: Iterable[str]) -> dict[str, str]:
    """Map each logical field to the matching actual CSV column name."""
    lookup = { _normalize_header(f): f for f in fieldnames }
    resolved: dict[str, str] = {}
    for logical, aliases in _HEADER_ALIASES.items():
        for alias in aliases:
            key = _normalize_header(alias)
            if key in lookup:
                resolved[logical] = lookup[key]
                break
    return resolved


def _to_float(value: Any) -> float:
    if value is None:
        return 0.0
    s = str(value).strip().replace(",", "")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_consumption_csv(
    csv_bytes: bytes | str,
    report_type: str,
    *,
    window_start: str | None = None,
    window_end: str | None = None,
) -> list[ConsumptionRow]:
    """Parse a licensing consumption CSV into :class:`ConsumptionRow` records.

    Resilient to header drift: unknown columns are ignored and the full
    original row is preserved as JSON in ``raw_json``.
    """
    if isinstance(csv_bytes, bytes):
        text = csv_bytes.decode("utf-8-sig", errors="replace")
    else:
        text = csv_bytes
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return []
    index = _build_header_index(reader.fieldnames)
    unit = LICENSING_REPORT_UNITS.get(report_type)

    rows: list[ConsumptionRow] = []
    for raw in reader:
        usage_date = (raw.get(index["usage_date"]) if "usage_date" in index else None) or ""
        usage_date = usage_date.strip()
        if not usage_date:
            # A consumption record without a date cannot be placed on the
            # timeline; skip it rather than bucket it incorrectly.
            continue
        # Normalize common date formats to YYYY-MM-DD when possible.
        usage_date = usage_date.split("T", 1)[0].strip()

        user_id = (raw.get(index["user_id"]) if "user_id" in index else None) or None
        if user_id is not None:
            user_id = user_id.strip() or None
        env_id = (raw.get(index["environment_id"]) if "environment_id" in index else None) or None
        if env_id is not None:
            env_id = env_id.strip() or None
        env_name = (raw.get(index["environment_name"]) if "environment_name" in index else None) or None
        product = (raw.get(index["product"]) if "product" in index else None) or None
        quantity = _to_float(raw.get(index["quantity"])) if "quantity" in index else 0.0

        rows.append(
            ConsumptionRow(
                report_type=report_type,
                usage_date=usage_date,
                environment_id=env_id,
                environment_name=(env_name.strip() if env_name else None),
                user_id=user_id,
                product=(product.strip() if product else None),
                quantity=quantity,
                unit=unit,
                window_start=window_start,
                window_end=window_end,
                raw_json=json.dumps(raw, ensure_ascii=False),
            )
        )
    return rows


def _today() -> str:
    return _dt.date.today().isoformat()


# Currencies whose values are whole licenses/seats rather than metered units.
_CURRENCY_UNITS: dict[str, str] = {
    "MCSMessages": "messages",
    "TenantM365Copilot": "licenses",
    "W365APAYGO": "licenses",
}


def parse_currency_reports_json(
    data: Any,
    *,
    snapshot_date: str,
    window_start: str | None = None,
    window_end: str | None = None,
) -> list[ConsumptionRow]:
    """Parse the ``CurrencyReports`` JSON into snapshot :class:`ConsumptionRow`.

    The endpoint returns a list of per-currency objects, e.g.::

        [{"currencyType": "MCSMessages", "purchased": 25000, "allocated": 5000},
         {"currencyType": "TenantM365Copilot", "purchased": 25, "allocated": 0}]

    Each present numeric field (``purchased`` / ``allocated`` / ``consumed``)
    becomes its own row, distinguished by ``product`` so the unique key
    ``(report_type, usage_date, user_key, product)`` stays stable. ``report_type``
    is the currency type so the UI can pivot per currency.
    """
    items = data if isinstance(data, list) else (data.get("value") if isinstance(data, dict) else None)
    if not isinstance(items, list):
        return []
    rows: list[ConsumptionRow] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        currency = str(item.get("currencyType") or "").strip()
        if not currency:
            continue
        unit = _CURRENCY_UNITS.get(currency) or LICENSING_REPORT_UNITS.get(currency, "units")
        for field in ("purchased", "allocated", "consumed"):
            value = item.get(field)
            if value is None:
                continue
            rows.append(
                ConsumptionRow(
                    report_type=currency,
                    usage_date=snapshot_date,
                    environment_id=None,
                    environment_name=None,
                    user_id=None,
                    product=field,
                    quantity=_to_float(value),
                    unit=unit,
                    window_start=window_start,
                    window_end=window_end,
                    raw_json=json.dumps(item, ensure_ascii=False),
                )
            )
    return rows


def _date_part(value: Any) -> str | None:
    """Return the ``YYYY-MM-DD`` portion of an ISO timestamp, or ``None``."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    return s.split("T", 1)[0].strip() or None


def parse_mcs_resource_rows(
    data: Any,
    *,
    snapshot_date: str,
    window_start: str | None = None,
    window_end: str | None = None,
) -> list[ConsumptionRow]:
    """Parse the per-resource Copilot Studio message consumption.

    Backs the PPAC "리소스별 메시지 소비 > 다운로드" table. Endpoint:
    ``GET /v2.0/tenants/{tid}/entitlements/MCSMessages/resources``. It returns
    a list of group objects, each carrying a ``resources`` array that breaks
    consumption down **per environment and per agent (resource)** across the
    whole tenant in a single call::

        [{"resources": [
            {"environmentId": "0db0…", "resourceId": "5d79…",
             "consumed": 11.05, "unit": "Messages",
             "metadata": {"ResourceName": "AgentStep1",
                          "NonBillableQuantity": 0.0},
             "asOfDate": "2026-05-31T09:44:48.233"}, …]}]

    Each resource becomes one ``report_type="MCSMessages:resource"`` row whose
    ``product`` is the agent name, ``environment_id`` the owning environment and
    ``quantity`` the billable message count. The non-billable quantity and the
    resource id are preserved in ``raw_json``.
    """
    groups = (
        data
        if isinstance(data, list)
        else ([data] if isinstance(data, dict) else [])
    )
    rows: list[ConsumptionRow] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        resources = group.get("resources")
        if not isinstance(resources, list):
            continue
        for res in resources:
            if not isinstance(res, dict):
                continue
            env_raw = res.get("environmentId")
            env_id = (str(env_raw).strip() or None) if env_raw else None
            meta = res.get("metadata") if isinstance(res.get("metadata"), dict) else {}
            name = str(meta.get("ResourceName") or res.get("resourceId") or "").strip() or None
            unit = str(res.get("unit") or "").strip().lower() or "messages"
            usage_date = _date_part(res.get("asOfDate")) or snapshot_date
            rows.append(
                ConsumptionRow(
                    report_type="MCSMessages:resource",
                    usage_date=usage_date,
                    environment_id=env_id,
                    environment_name=None,
                    user_id=None,
                    product=name,
                    quantity=_to_float(res.get("consumed")),
                    unit=unit,
                    window_start=window_start,
                    window_end=window_end,
                    raw_json=json.dumps(res, ensure_ascii=False),
                )
            )
    return rows


def parse_mcs_environment_rows(
    data: Any,
    *,
    snapshot_date: str,
    window_start: str | None = None,
    window_end: str | None = None,
) -> list[ConsumptionRow]:
    """Parse the per-environment Copilot Studio message entitlement snapshot.

    Endpoint: ``GET /v2.0/tenants/{tid}/environments/entitlementConsumptions/
    MCSMessages``. Each environment exposes its allocated / consumed / available
    message capacity::

        {"value": [{"environmentId": "70e5…", "environmentName": "…",
                    "entitlement": {"capacity": {
                        "allocated": {"value": 5000.0},
                        "consumed": {"value": 0.0},
                        "availableQuantity": 5000.0}}}]}

    Each environment yields rows keyed ``report_type="MCSMessages:environment"``
    with ``product`` in ``allocated`` / ``consumed`` / ``available``.
    """
    items = (
        data.get("value")
        if isinstance(data, dict)
        else (data if isinstance(data, list) else None)
    )
    if not isinstance(items, list):
        return []
    rows: list[ConsumptionRow] = []
    for env in items:
        if not isinstance(env, dict):
            continue
        env_raw = env.get("environmentId")
        env_id = (str(env_raw).strip() or None) if env_raw else None
        env_name = str(env.get("environmentName") or "").strip() or None
        ent = env.get("entitlement") if isinstance(env.get("entitlement"), dict) else {}
        cap = ent.get("capacity") if isinstance(ent.get("capacity"), dict) else {}

        def _cap_value(field: Any) -> Any:
            return field.get("value") if isinstance(field, dict) else field

        fields = (
            ("consumed", _cap_value(cap.get("consumed"))),
            ("allocated", _cap_value(cap.get("allocated"))),
            ("available", cap.get("availableQuantity")),
        )
        for product, value in fields:
            if value is None:
                continue
            rows.append(
                ConsumptionRow(
                    report_type="MCSMessages:environment",
                    usage_date=snapshot_date,
                    environment_id=env_id,
                    environment_name=env_name,
                    user_id=None,
                    product=product,
                    quantity=_to_float(value),
                    unit="messages",
                    window_start=window_start,
                    window_end=window_end,
                    raw_json=json.dumps(env, ensure_ascii=False),
                )
            )
    return rows


def parse_tenant_capacity_json(
    data: Any,
    *,
    snapshot_date: str,
    window_start: str | None = None,
    window_end: str | None = None,
) -> list[ConsumptionRow]:
    """Parse the ``TenantCapacity`` JSON into snapshot :class:`ConsumptionRow`.

    The response nests per-storage-type capacity under ``tenantCapacities``::

        {"tenantCapacities": [
            {"capacityType": "Database", "capacityUnits": "MB",
             "totalCapacity": 5120.0,
             "consumption": {"actual": 909.25, "rated": 1024.0}}]}

    Each storage type yields rows for its actual/rated consumption and total
    capacity, keyed under ``report_type = "Capacity:<type>"``.
    """
    caps = data.get("tenantCapacities") if isinstance(data, dict) else None
    if not isinstance(caps, list):
        return []
    rows: list[ConsumptionRow] = []
    for cap in caps:
        if not isinstance(cap, dict):
            continue
        ctype = str(cap.get("capacityType") or "").strip() or "Unknown"
        report_type = f"Capacity:{ctype}"
        unit = (str(cap.get("capacityUnits") or "").strip() or None)
        consumption = cap.get("consumption")
        consumption = consumption if isinstance(consumption, dict) else {}
        fields = (
            ("actual", consumption.get("actual")),
            ("rated", consumption.get("rated")),
            ("total", cap.get("totalCapacity")),
        )
        for product, value in fields:
            if value is None:
                continue
            rows.append(
                ConsumptionRow(
                    report_type=report_type,
                    usage_date=snapshot_date,
                    environment_id=None,
                    environment_name=None,
                    user_id=None,
                    product=product,
                    quantity=_to_float(value),
                    unit=unit,
                    window_start=window_start,
                    window_end=window_end,
                    raw_json=json.dumps(cap, ensure_ascii=False),
                )
            )
    return rows


class LicensingClient:
    """Synchronous client for the Power Platform Licensing consumption API.

    Calls the real PPAC endpoints discovered via traffic capture and returns
    :class:`ConsumptionRow` snapshots. Each collection is a point-in-time
    snapshot keyed on the collection date (the API exposes current tenant
    totals, not a per-day time series).
    """

    def __init__(
        self,
        token_provider: Any,
        tenant_id: str,
        *,
        timeout: float = 120.0,
        http_client: httpx.Client | None = None,
        base_url: str = LICENSING_API_RESOURCE,
    ) -> None:
        self.token_provider = token_provider
        self.tenant_id = tenant_id
        # Host root, e.g. https://licensing.powerplatform.microsoft.com. The
        # API version (v1.0 / v0.1-alpha) is part of each endpoint path.
        self.host = base_url.rstrip("/")
        self._client = http_client if http_client is not None else httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    # ---- helpers ---------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token_provider.acquire()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _get_json(self, path: str, params: dict[str, str] | None = None) -> Any:
        url = f"{self.host}{path}"
        resp = self._client.get(url, headers=self._headers(), params=params)
        if not resp.is_success:
            raise LicensingError(resp.status_code, _safe_text(resp))
        try:
            return resp.json()
        except ValueError as exc:
            raise LicensingError(
                resp.status_code,
                "예상치 못한 응답(비 JSON)입니다. 라이선싱 API 권한/토큰을 확인하세요.",
            ) from exc

    # ---- data fetches ----------------------------------------------

    def fetch_currency_rows(
        self,
        window_start: str | None = None,
        window_end: str | None = None,
        *,
        snapshot_date: str | None = None,
    ) -> list[ConsumptionRow]:
        """Fetch per-currency purchase/allocation/consumption for the tenant."""
        snap = snapshot_date or _today()
        data = self._get_json(
            f"/v1.0/tenants/{self.tenant_id}/CurrencyReports",
            params={"includeAllocations": "True", "includeConsumptions": "True"},
        )
        return parse_currency_reports_json(
            data, snapshot_date=snap, window_start=window_start, window_end=window_end
        )

    def fetch_capacity_rows(
        self,
        window_start: str | None = None,
        window_end: str | None = None,
        *,
        snapshot_date: str | None = None,
    ) -> list[ConsumptionRow]:
        """Fetch Dataverse storage (Database/File/Log) capacity consumption."""
        snap = snapshot_date or _today()
        data = self._get_json(f"/v0.1-alpha/tenants/{self.tenant_id}/TenantCapacity")
        return parse_tenant_capacity_json(
            data, snapshot_date=snap, window_start=window_start, window_end=window_end
        )

    def fetch_mcs_resource_rows(
        self,
        window_start: str | None = None,
        window_end: str | None = None,
        *,
        snapshot_date: str | None = None,
    ) -> list[ConsumptionRow]:
        """Fetch per-environment/per-agent Copilot Studio message consumption.

        This is the granular "리소스별 메시지 소비" breakdown — one row per agent
        (resource) with its owning environment and billable message count.
        """
        snap = snapshot_date or _today()
        data = self._get_json(
            f"/v2.0/tenants/{self.tenant_id}/entitlements/MCSMessages/resources"
        )
        return parse_mcs_resource_rows(
            data, snapshot_date=snap, window_start=window_start, window_end=window_end
        )

    def fetch_mcs_environment_rows(
        self,
        window_start: str | None = None,
        window_end: str | None = None,
        *,
        snapshot_date: str | None = None,
    ) -> list[ConsumptionRow]:
        """Fetch per-environment Copilot Studio message entitlement snapshot."""
        snap = snapshot_date or _today()
        data = self._get_json(
            f"/v2.0/tenants/{self.tenant_id}/environments/entitlementConsumptions/MCSMessages"
        )
        return parse_mcs_environment_rows(
            data, snapshot_date=snap, window_start=window_start, window_end=window_end
        )

    def fetch_all_rows(
        self, window_start: str | None = None, window_end: str | None = None
    ) -> list[ConsumptionRow]:
        """Fetch every supported snapshot in one pass.

        Each source is independent: a failure in one is raised to the caller,
        which decides whether to continue with the others.
        """
        rows: list[ConsumptionRow] = []
        rows.extend(self.fetch_currency_rows(window_start, window_end))
        rows.extend(self.fetch_capacity_rows(window_start, window_end))
        rows.extend(self.fetch_mcs_resource_rows(window_start, window_end))
        rows.extend(self.fetch_mcs_environment_rows(window_start, window_end))
        return rows


def _safe_text(resp: httpx.Response) -> str:
    try:
        return resp.text[:500]
    except Exception:  # pragma: no cover - defensive
        return "<unreadable response body>"
