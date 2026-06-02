"""Microsoft Graph API client.

The client is responsible for:
* attaching a bearer token from the :class:`AppOnlyTokenProvider`;
* respecting 429 ``Retry-After`` headers;
* exponential backoff on 5xx;
* paginating ``@odata.nextLink`` automatically;
* limiting concurrent per-user fan-out (the collector worker
  schedules ``list_interactions`` for one user at a time, but the
  semaphore still defends against accidental misuse).

The Copilot interaction endpoint is in the ``beta`` namespace today;
isolate that URL in :meth:`GraphClient.list_interactions` so the rest
of the code stays on ``v1.0``.
"""
from __future__ import annotations

import logging
import random
import re
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from ..config import (
    MS_GRAPH_BASE_BETA,
    MS_GRAPH_BASE_V1,
    PURVIEW_EXPORT_SCOPES,
)
from .auth import AppOnlyTokenProvider

log = logging.getLogger(__name__)


@dataclass
class GraphUser:
    id: str
    upn: str | None
    display_name: str | None
    enabled: bool


@dataclass
class CopilotInteraction:
    id: str
    session_id: str | None
    request_id: str | None
    created_at: str
    interaction_type: str | None
    app: str | None
    body_text: str | None
    body_content_type: str | None
    attachments: list[dict[str, Any]]
    links: list[dict[str, Any]]
    mentions: list[dict[str, Any]]
    raw: dict[str, Any]


class GraphError(RuntimeError):
    def __init__(self, status: int, detail: object, *, auth_redirect: bool = False) -> None:
        super().__init__(f"Graph error {status}: {detail}")
        self.status = status
        self.detail = detail
        # True when the failure is an interactive sign-in redirect (the
        # delegated login expired), as opposed to a genuine HTTP error. The
        # eDiscovery orchestrator uses this to STOP and ask the user to
        # re-authenticate instead of pointlessly re-running the export with
        # the same expired token.
        self.auth_redirect = auth_redirect


class GraphClient:
    """Synchronous Graph wrapper. Collector worker calls this from a
    dedicated QThread, so a sync HTTP client keeps things simple."""

    MAX_RETRIES = 6

    def __init__(
        self,
        token_provider: AppOnlyTokenProvider,
        timeout: float = 60.0,
        *,
        http_client: httpx.Client | None = None,
        download_token_providers: list[Any] | None = None,
    ) -> None:
        self.token_provider = token_provider
        self._client = http_client if http_client is not None else httpx.Client(timeout=timeout)
        self._download_token_providers = list(download_token_providers or [])

    def close(self) -> None:
        self._client.close()

    # ---- helpers -----------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token_provider.acquire()}",
            "Accept": "application/json",
        }

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        attempt = 0
        while True:
            attempt += 1
            headers = kwargs.pop("headers", {}) | self._headers()
            r = self._client.request(method, url, headers=headers, **kwargs)
            if r.status_code == 401 and attempt == 1:
                # Token may have just rotated; invalidate cache and retry once.
                log.warning("Graph 401 — invalidating cached token and retrying")
                self.token_provider.invalidate()
                continue
            if r.status_code == 429 or r.status_code >= 500:
                if attempt > self.MAX_RETRIES:
                    raise GraphError(r.status_code, _safe_json(r))
                delay = _retry_delay(r, attempt)
                log.warning("Graph %s on %s — retry #%d in %.1fs", r.status_code, url, attempt, delay)
                time.sleep(delay)
                continue
            if not r.is_success:
                raise GraphError(r.status_code, _safe_json(r))
            return r

    def _paginate(self, url: str, params: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
        next_url: str | None = url
        next_params: dict[str, Any] | None = params
        while next_url:
            r = self._request("GET", next_url, params=next_params)
            payload = r.json()
            if isinstance(payload, list):
                items = payload
                next_url = None
            elif isinstance(payload, dict):
                raw_items = payload.get("value", [])
                items = raw_items if isinstance(raw_items, list) else []
                next_url = payload.get("@odata.nextLink")
            else:
                items = []
                next_url = None
            for item in items:
                yield item
            # nextLink already encodes the query string.
            next_params = None

    # ---- users -------------------------------------------------------

    def list_users(self) -> Iterator[GraphUser]:
        url = f"{MS_GRAPH_BASE_V1}/users"
        params = {
            "$select": "id,displayName,userPrincipalName,accountEnabled",
            "$top": 999,
        }
        for raw in self._paginate(url, params):
            yield GraphUser(
                id=str(raw["id"]),
                upn=raw.get("userPrincipalName"),
                display_name=raw.get("displayName"),
                enabled=bool(raw.get("accountEnabled", True)),
            )

    def group_member_ids(self, group_id: str) -> Iterator[str]:
        url = f"{MS_GRAPH_BASE_V1}/groups/{group_id}/transitiveMembers/microsoft.graph.user"
        for raw in self._paginate(url, {"$select": "id", "$top": 999}):
            yield str(raw["id"])

    def copilot_licensed_user_ids(self, copilot_sku_ids: set[str]) -> Iterator[str]:
        """Yield IDs of users that hold any of the given Copilot SKUs.

        Implemented as a single ``$filter=assignedLicenses/any(...)``
        request per SKU rather than per-user license lookups.
        """
        for sku in copilot_sku_ids:
            url = f"{MS_GRAPH_BASE_V1}/users"
            params = {
                "$select": "id",
                "$filter": f"assignedLicenses/any(x:x/skuId eq {sku})",
                "$top": 999,
            }
            for raw in self._paginate(url, params):
                yield str(raw["id"])

    def list_subscribed_skus(self) -> list[dict[str, Any]]:
        r = self._request("GET", f"{MS_GRAPH_BASE_V1}/subscribedSkus")
        return list(r.json().get("value", []))

    def organization_summary(self) -> dict[str, str | None]:
        r = self._request(
            "GET",
            f"{MS_GRAPH_BASE_V1}/organization",
            params={"$select": "id,displayName,verifiedDomains"},
        )
        items = r.json().get("value", [])
        if not items:
            return {"id": None, "display_name": None, "domain": None}
        org = items[0]
        domains = org.get("verifiedDomains") or []
        domain = _preferred_tenant_domain(domains)
        return {
            "id": str(org.get("id") or "") or None,
            "display_name": str(org.get("displayName") or "") or None,
            "domain": domain,
        }

    def tenant_domain(self) -> str | None:
        return self.organization_summary().get("domain")

    def resolve_user_by_upn(self, upn: str) -> GraphUser | None:
        try:
            r = self._request(
                "GET",
                f"{MS_GRAPH_BASE_V1}/users/{upn}",
                params={"$select": "id,displayName,userPrincipalName,accountEnabled"},
            )
        except GraphError as e:
            if e.status == 404:
                return None
            raise
        raw = r.json()
        return GraphUser(
            id=str(raw["id"]),
            upn=raw.get("userPrincipalName"),
            display_name=raw.get("displayName"),
            enabled=bool(raw.get("accountEnabled", True)),
        )

    # ---- copilot interactions ---------------------------------------

    def list_interactions(
        self,
        user_id: str,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> Iterator[CopilotInteraction]:
        """Stream Copilot interactions for ``user_id``.

        Graph requires *both* lower and upper bounds when a
        ``createdDateTime`` filter is provided
        (see Microsoft Learn: aiInteractionHistory:
        getAllEnterpriseInteractions — "When you use the createdDateTime
        filter, provide both a minimum and maximum time boundary.").
        When ``since`` is supplied we auto-pick ``until = now (UTC)``
        unless the caller overrides it. Both bounds are normalised to
        whole-second ISO-8601 (``YYYY-MM-DDTHH:MM:SSZ``) because the
        service rejects microsecond precision in some tenants.
        """
        url = (
            f"{MS_GRAPH_BASE_BETA}/copilot/users/{user_id}"
            "/interactionHistory/getAllEnterpriseInteractions"
        )
        params: dict[str, Any] = {"$top": 50}
        if since:
            lo = _normalise_graph_datetime(since)
            hi = _normalise_graph_datetime(until) if until else _utc_now_iso()
            params["$filter"] = (
                f"createdDateTime gt {lo} and createdDateTime lt {hi}"
            )

        for raw in self._paginate(url, params):
            yield _parse_interaction(raw)

    # ---- Purview audit (async) --------------------------------------

    def submit_audit_log_query(
        self,
        *,
        display_name: str,
        start: str,
        end: str,
        operation_filters: list[str] | None = None,
        user_principal_names: list[str] | None = None,
    ) -> str:
        """Create an asynchronous Purview audit log query.

        Returns the query id; poll :meth:`get_audit_log_query` until
        status == 'succeeded', then call :meth:`list_query_records`.

        Requires the ``AuditLogsQuery.Read.All`` application permission.
        Times are ISO-8601 UTC (``YYYY-MM-DDTHH:MM:SSZ``).
        """
        url = f"{MS_GRAPH_BASE_BETA}/security/auditLog/queries"
        body: dict[str, Any] = {
            "displayName": display_name,
            "filterStartDateTime": _normalise_graph_datetime(start),
            "filterEndDateTime": _normalise_graph_datetime(end),
        }
        if operation_filters:
            body["operationFilters"] = list(operation_filters)
        if user_principal_names:
            body["userPrincipalNameFilters"] = list(user_principal_names)
        r = self._request("POST", url, json=body)
        payload = r.json()
        return str(payload.get("id"))

    def get_audit_log_query(self, query_id: str) -> dict[str, Any]:
        url = f"{MS_GRAPH_BASE_BETA}/security/auditLog/queries/{query_id}"
        r = self._request("GET", url)
        return r.json()

    def wait_for_audit_query(
        self,
        query_id: str,
        *,
        poll_seconds: float = 10.0,
        max_seconds: float = 90.0,
    ) -> dict[str, Any]:
        """Poll the query until terminal state or ``max_seconds`` elapses.

        Returns the final query payload. If the deadline is reached
        before the query finishes, the payload is returned as-is so the
        caller can persist ``pending_query_id`` and try again next
        cycle.
        """
        deadline = time.monotonic() + max_seconds
        while True:
            payload = self.get_audit_log_query(query_id)
            status = (payload.get("status") or "").lower()
            if status in {"succeeded", "failed", "cancelled"}:
                return payload
            if time.monotonic() >= deadline:
                return payload
            time.sleep(poll_seconds)

    def list_audit_query_records(self, query_id: str) -> Iterator[dict[str, Any]]:
        url = f"{MS_GRAPH_BASE_BETA}/security/auditLog/queries/{query_id}/records"
        for raw in self._paginate(url, {"$top": 200}):
            yield raw

    # ---- Entra audit / sign-ins -------------------------------------

    def list_directory_audits(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Stream Entra directory audit events.

        Requires the ``AuditLog.Read.All`` application permission.
        """
        url = f"{MS_GRAPH_BASE_V1}/auditLogs/directoryAudits"
        params: dict[str, Any] = {"$top": 250}
        filt = _date_filter("activityDateTime", since, until)
        if filt:
            params["$filter"] = filt
        for raw in self._paginate(url, params):
            yield raw

    def list_sign_ins(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        url = f"{MS_GRAPH_BASE_V1}/auditLogs/signIns"
        params: dict[str, Any] = {"$top": 250}
        filt = _date_filter("createdDateTime", since, until)
        if filt:
            params["$filter"] = filt
        for raw in self._paginate(url, params):
            yield raw

    # ---- Copilot usage reports --------------------------------------
    #
    # Microsoft 365 Copilot report APIs are now documented under
    # ``/v1.0/copilot/reports``. Some tenants may still only expose the
    # older beta ``/reports`` functions, so callers below try v1.0 first
    # and fall back to beta on not-found style responses. We pin
    # ``$format=text/csv`` so the endpoint returns the CSV variant our
    # parser expects.

    def _fetch_report_csv(self, url: str) -> bytes:
        token = self.token_provider.acquire()
        # Build a separate request so we can attach auth only on the
        # initial Graph hop. ``follow_redirects`` lets httpx chase the
        # 302 to reports.office.com; that target is preauthenticated.
        with self._client.stream(
            "GET",
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "text/csv, application/octet-stream, */*",
            },
            follow_redirects=True,
        ) as resp:
            if resp.status_code == 401:
                # Token may have just rotated.
                self.token_provider.invalidate()
                token = self.token_provider.acquire()
                resp.close()
                with self._client.stream(
                    "GET",
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "text/csv, application/octet-stream, */*",
                    },
                    follow_redirects=True,
                ) as resp2:
                    if not resp2.is_success:
                        body = resp2.read()
                        raise GraphError(resp2.status_code, _safe_text(body))
                    return resp2.read()
            if not resp.is_success:
                body = resp.read()
                raise GraphError(resp.status_code, _safe_text(body))
            return resp.read()

    def _fetch_report_csv_with_fallback(self, primary_url: str, fallback_url: str) -> bytes:
        try:
            return self._fetch_report_csv(primary_url)
        except GraphError as ge:
            if ge.status not in (400, 404):
                raise
            log.info(
                "Copilot report v1 endpoint unavailable (status=%s); retrying beta endpoint.",
                ge.status,
            )
            return self._fetch_report_csv(fallback_url)

    def fetch_copilot_usage_user_detail(self, period: str = "D30") -> bytes:
        """Return CSV bytes from the Microsoft 365 Copilot user detail report.

        Requires the ``Reports.Read.All`` application permission.
        """
        return self._fetch_report_csv_with_fallback(
            (
                f"{MS_GRAPH_BASE_V1}/copilot/reports/"
                f"getMicrosoft365CopilotUsageUserDetail(period='{period}')"
                f"?$format=text/csv"
            ),
            (
                f"{MS_GRAPH_BASE_BETA}/reports/"
                f"getMicrosoft365CopilotUsageUserDetail(period='{period}')"
                f"?$format=text/csv"
            ),
        )

    def fetch_copilot_user_count_summary(self, period: str = "D30") -> bytes:
        """Return CSV bytes from the Microsoft 365 Copilot user count summary report."""
        return self._fetch_report_csv_with_fallback(
            (
                f"{MS_GRAPH_BASE_V1}/copilot/reports/"
                f"getMicrosoft365CopilotUserCountSummary(period='{period}')"
                f"?$format=text/csv"
            ),
            (
                f"{MS_GRAPH_BASE_BETA}/reports/"
                f"getMicrosoft365CopilotUserCountSummary(period='{period}')"
                f"?$format=text/csv"
            ),
        )

    def fetch_copilot_user_count_trend(self, period: str = "D30") -> bytes:
        """Return CSV bytes from the Microsoft 365 Copilot user count trend report."""
        return self._fetch_report_csv_with_fallback(
            (
                f"{MS_GRAPH_BASE_V1}/copilot/reports/"
                f"getMicrosoft365CopilotUserCountTrend(period='{period}')"
                f"?$format=text/csv"
            ),
            (
                f"{MS_GRAPH_BASE_BETA}/reports/"
                f"getMicrosoft365CopilotUserCountTrend(period='{period}')"
                f"?$format=text/csv"
            ),
        )

    def fetch_copilot_usage_user_counts(self, period: str = "D30") -> bytes:
        """Backward-compatible alias for the user count summary report."""
        return self.fetch_copilot_user_count_summary(period=period)

    # ---- Copilot admin diagnostics ---------------------------------

    def get_copilot_admin_limited_mode(self) -> dict[str, Any]:
        """Return Copilot limited mode settings, preferring v1 with beta fallback."""
        return self._get_json_with_fallback(
            f"{MS_GRAPH_BASE_V1}/copilot/admin/settings/limitedMode",
            f"{MS_GRAPH_BASE_BETA}/copilot/admin/settings/limitedMode",
        )

    def list_copilot_admin_policy_settings(self) -> list[dict[str, Any]]:
        """Return Copilot policy settings when the tenant/API exposes them."""
        return list(
            self._paginate(
                f"{MS_GRAPH_BASE_BETA}/copilot/admin/policySettings",
                {"$top": 50},
            )
        )

    def list_copilot_admin_catalog_packages(self) -> list[dict[str, Any]]:
        """Return Copilot admin catalog packages (apps/agents inventory)."""
        return list(
            self._paginate(
                f"{MS_GRAPH_BASE_BETA}/copilot/admin/catalog/packages",
                {"$top": 50},
            )
        )

    def list_copilot_agent_registrations(self) -> list[dict[str, Any]]:
        """Return Copilot agent registrations when available."""
        return list(
            self._paginate(
                f"{MS_GRAPH_BASE_BETA}/copilot/agentRegistrations",
                {"$top": 50},
            )
        )

    def _get_json_with_fallback(self, primary_url: str, fallback_url: str) -> dict[str, Any]:
        try:
            return self._request("GET", primary_url).json()
        except GraphError as ge:
            if ge.status not in (400, 404):
                raise
            log.info(
                "Copilot admin v1 endpoint unavailable (status=%s); retrying beta endpoint.",
                ge.status,
            )
            return self._request("GET", fallback_url).json()

    # ---- eDiscovery (new Microsoft Purview eDiscovery experience) ----
    #
    # These endpoints back the *new* eDiscovery experience and support
    # DELEGATED authentication at the non-premium tier (the signed-in
    # account must be a member of the *eDiscovery Manager* role group).
    # The collection flow is: create case -> add a search scoped to the
    # target user's mailbox -> run estimate -> export results -> download
    # the export package -> parse it into interaction turns.

    def preflight_ediscovery(self) -> None:
        """Cheaply verify the caller can use the eDiscovery Graph surface.

        Performs a single lightweight ``GET`` on the cases collection so
        permission/role/licensing failures surface *before* the expensive
        create/search/export pipeline starts. Translates the common
        gating failures into a clear, actionable :class:`GraphError`:

        * ``401`` — token/scope problem (consent not granted, wrong scope)
        * ``403`` — token is valid but the signed-in user lacks the
          eDiscovery role-group membership, or the tenant lacks the
          eDiscovery (Premium) capability required for these endpoints
        """
        url = f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases"
        try:
            self._request("GET", url, params={"$top": 1})
        except GraphError as exc:
            if exc.status == 403:
                raise GraphError(
                    403,
                    "eDiscovery 접근이 거부되었습니다(403). 로그인한 계정이 Microsoft "
                    "Purview의 eDiscovery Manager/Administrator 역할 그룹 멤버인지, "
                    "그리고 테넌트에 eDiscovery(Premium) 기능이 있는지 확인하세요.",
                ) from exc
            if exc.status == 401:
                raise GraphError(
                    401,
                    "eDiscovery 인증에 실패했습니다(401). delegated 스코프 "
                    "'eDiscovery.ReadWrite.All' 동의가 되었는지 확인하세요.",
                ) from exc
            raise

    def find_ediscovery_case(self, display_name: str) -> dict[str, Any] | None:
        """Return an existing eDiscovery case matching ``display_name``."""
        url = f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases"
        for raw in self._paginate(url, {"$top": 100}):
            if str(raw.get("displayName") or "") == display_name:
                return raw
        return None

    def create_ediscovery_case(
        self, display_name: str, *, description: str | None = None
    ) -> dict[str, Any]:
        """Create (or reuse) an eDiscovery case and return its resource."""
        existing = self.find_ediscovery_case(display_name)
        if existing is not None:
            return existing
        url = f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases"
        body: dict[str, Any] = {"displayName": display_name}
        if description:
            body["description"] = description
        return self._request("POST", url, json=body).json()

    def find_ediscovery_search(
        self, case_id: str, display_name: str
    ) -> dict[str, Any] | None:
        """Return an existing search on the case matching ``display_name``."""
        url = (
            f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases/{case_id}/searches"
        )
        for raw in self._paginate(url, {"$top": 100}):
            if str(raw.get("displayName") or "") == display_name:
                return raw
        return None

    def add_ediscovery_search(
        self,
        case_id: str,
        *,
        display_name: str,
        content_query: str,
        mailbox_emails: list[str],
    ) -> dict[str, Any]:
        """Create a search scoped to one or more user mailboxes.

        The Graph create-search endpoint rejects a search that has no data
        source (``400 BadRequest: At least one data source is required``) and
        ``additionalSources`` cannot be supplied inline. The supported flow is
        therefore two-phase:

        1. Create a non-custodial data source on the *case* for each mailbox
           (``userSource`` with ``includedSources: mailbox``) — no custodian
           hold required.
        2. Create the search binding those data sources via the
           ``noncustodialSources@odata.bind`` navigation property.

        ``content_query`` is a KeyQL/KQL string narrowing to the desired items
        (e.g. a date range and Copilot item class).
        """
        if not mailbox_emails:
            raise GraphError("eDiscovery search requires at least one mailbox")

        # Reuse a search with the same display name if it already exists on
        # the case (an earlier run may have created it before failing).
        existing_search = self.find_ediscovery_search(case_id, display_name)
        if existing_search is not None:
            return existing_search

        # Phase 1 — create a non-custodial data source per mailbox.
        ds_url = (
            f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases/{case_id}"
            f"/noncustodialDataSources"
        )

        def _list_existing() -> dict[str, str]:
            found: dict[str, str] = {}
            for raw in self._paginate(ds_url, {"$top": 100}):
                ds_obj = raw.get("dataSource") or {}
                email = str(ds_obj.get("email") or raw.get("email") or "").lower()
                ds_id = str(raw.get("id") or "")
                if email and ds_id:
                    found[email] = ds_id
            return found

        # Reuse data sources that already exist on the case (the same case is
        # reused across collection windows for one target user, so creating a
        # duplicate userSource for the same mailbox would otherwise fail).
        existing_by_email = _list_existing()

        bind_refs: list[str] = []
        for email in mailbox_emails:
            ds_id = existing_by_email.get(email.lower(), "")
            if not ds_id:
                try:
                    ds = self._request(
                        "POST",
                        ds_url,
                        json={
                            "dataSource": {
                                "@odata.type": "microsoft.graph.security.userSource",
                                "email": email,
                                "includedSources": "mailbox",
                            }
                        },
                    ).json()
                    ds_id = str(ds.get("id") or "")
                except GraphError as exc:
                    # The data source already exists on the case (a previous
                    # run created it before failing). Re-query and reuse it
                    # instead of treating the conflict as fatal.
                    if exc.status != 409:
                        raise
                    log.info(
                        "Non-custodial data source for %s already exists; reusing.",
                        email,
                    )
                    ds_id = _list_existing().get(email.lower(), "")
            if not ds_id:
                raise GraphError(
                    f"Failed to create non-custodial data source for {email}"
                )
            bind_refs.append(f"{ds_url}/{ds_id}")

        # Phase 2 — create the search bound to those data sources.
        url = (
            f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases/{case_id}/searches"
        )
        body: dict[str, Any] = {
            "displayName": display_name,
            "contentQuery": content_query,
            "noncustodialSources@odata.bind": bind_refs,
        }
        return self._request("POST", url, json=body).json()

    def estimate_ediscovery_search(self, case_id: str, search_id: str) -> dict[str, Any]:
        """Kick off statistics estimation for a search.

        Returns the HTTP response payload; the long-running operation id
        is exposed via the ``Location`` header on a 202 response.
        """
        url = (
            f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases/{case_id}"
            f"/searches/{search_id}/estimateStatistics"
        )
        r = self._request("POST", url)
        location = r.headers.get("Location") or r.headers.get("location")
        return {"operation_location": location, "status_code": r.status_code}

    def export_ediscovery_search(
        self,
        case_id: str,
        search_id: str,
        *,
        display_name: str,
        export_format: str = "msg",
        additional_options: str = "splitSource, includeFolderAndPath, condensePaths, friendlyName",
    ) -> dict[str, Any]:
        """Start an export of a search's results.

        Returns a dict with ``operation_location`` (the long-running
        operation URL from the ``Location`` header) so the caller can
        poll :meth:`get_ediscovery_operation`.
        """
        url = (
            f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases/{case_id}"
            f"/searches/{search_id}/exportResult"
        )
        body: dict[str, Any] = {
            "displayName": display_name,
            "exportCriteria": "searchHits",
            "additionalOptions": additional_options,
            "exportFormat": export_format,
        }
        r = self._request("POST", url, json=body)
        location = r.headers.get("Location") or r.headers.get("location")
        return {"operation_location": location, "status_code": r.status_code}

    def get_ediscovery_operation(self, operation_url: str) -> dict[str, Any]:
        """Fetch a long-running eDiscovery operation by its full URL."""
        url = operation_url
        if url and url.startswith("/"):
            url = f"https://graph.microsoft.com{url}"
        if not url.startswith("http"):
            url = f"{MS_GRAPH_BASE_V1}/security/cases/ediscoveryCases/operations/{url}"
        return self._request("GET", url).json()

    def wait_for_ediscovery_operation(
        self,
        operation_url: str,
        *,
        poll_seconds: float = 15.0,
        max_seconds: float = 120.0,
    ) -> dict[str, Any]:
        """Poll an operation until terminal or ``max_seconds`` elapses.

        Returns the final operation payload as-is when the deadline is
        reached so the caller can persist it and resume next cycle.
        """
        deadline = time.monotonic() + max_seconds
        while True:
            payload = self.get_ediscovery_operation(operation_url)
            status = (payload.get("status") or "").lower()
            if status in {"succeeded", "failed", "partiallysucceeded"}:
                return payload
            if time.monotonic() >= deadline:
                return payload
            time.sleep(poll_seconds)

    def download_ediscovery_export(
        self,
        download_url: str,
        *,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> bytes:
        """Download an export package from its URL.

        eDiscovery export URLs come in three shapes:

        * **Azure Blob SAS links** (``azureBlobUrl`` + ``azureBlobToken`` or
          a pre-signed ``downloadUrl``) — already authenticated by their
          query string. These live on a storage host (e.g.
          ``*.blob.core.windows.net``). Attaching a Microsoft Graph bearer
          token here makes the storage front door reject the request with a
          ``401 "Mise failed with error: ''"``, so we must NOT send it.
        * **Graph-hosted content URLs** (``graph.microsoft.com/...``) — need
          the AAD bearer + ``X-AllowWithAADToken`` header.
        * **eDiscovery proxy service URLs**
          (``*.proxyservice.ediscovery.svc.cloud.microsoft/...``) — the new
          eDiscovery export pipeline hands back a proxy link that streams the
          package. Without a bearer the proxy answers ``302`` to an
          interactive ``login.microsoftonline.com`` sign-in page, so the
          "download" silently returns an HTML login form instead of the zip.
          It must receive the delegated AAD bearer.

        We attach the bearer to every host *except* pre-signed blob storage
        links, and follow redirects to the final storage endpoint. httpx
        strips the ``Authorization`` header automatically on cross-origin
        redirects, so a proxy redirect to a blob SAS URL stays valid.

        When ``on_progress`` is supplied it is invoked periodically with
        ``(downloaded_bytes, total_bytes)`` (``total_bytes`` is ``0`` when the
        server does not advertise a ``Content-Length``) so callers can surface
        download progress in the UI log.
        """
        base_headers: dict[str, str] = {"Accept": "application/octet-stream, */*"}
        header_options: list[tuple[str, dict[str, str]]] = [("anonymous", base_headers)]
        if _needs_aad_bearer(download_url):
            header_options = []
            for label, token in self._download_bearer_candidates(download_url):
                headers_with_allow = dict(base_headers)
                headers_with_allow["Authorization"] = f"Bearer {token}"
                headers_with_allow["X-AllowWithAADToken"] = "true"
                header_options.append((f"{label}+allow", headers_with_allow))

                headers_plain = dict(base_headers)
                headers_plain["Authorization"] = f"Bearer {token}"
                header_options.append((label, headers_plain))
            if not header_options:
                raise GraphError(
                    401,
                    "eDiscovery export proxy requires an AAD bearer, but no "
                    "silent delegated token could be acquired.",
                    auth_redirect=True,
                )

        last_auth_error: GraphError | None = None
        for label, headers in header_options:
            try:
                return self._download_ediscovery_export_once(
                    download_url,
                    headers=headers,
                    on_progress=on_progress,
                )
            except GraphError as exc:
                if (
                    _is_ediscovery_proxy(download_url)
                    and (getattr(exc, "auth_redirect", False) or exc.status in (401, 403))
                ):
                    log.warning(
                        "eDiscovery proxy rejected backend token candidate %s: %s",
                        label,
                        exc.detail,
                    )
                    last_auth_error = exc
                    continue
                raise
        if last_auth_error is not None:
            raise last_auth_error
        raise GraphError(401, "No eDiscovery export download credential was usable")

    def _download_ediscovery_export_once(
        self,
        download_url: str,
        *,
        headers: dict[str, str],
        on_progress: Callable[[int, int], None] | None = None,
    ) -> bytes:
        next_url = download_url
        for _redirect_count in range(8):
            with self._client.stream(
                "GET",
                next_url,
                headers=headers,
                follow_redirects=False,
            ) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = (resp.headers.get("location") or "").strip()
                    if not location:
                        raise GraphError(resp.status_code, "Redirect without Location header")
                    next_url = urljoin(str(resp.url), location)
                    continue
                return self._read_download_response(resp, on_progress=on_progress)
        raise GraphError(310, "Too many redirects while downloading eDiscovery export")

    def _read_download_response(
        self,
        resp: httpx.Response,
        *,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> bytes:
        if not resp.is_success:
            body = resp.read()
            raise GraphError(resp.status_code, _safe_text(body))
        # A missing/expired delegated token makes the eDiscovery proxy
        # answer 200 with an interactive sign-in HTML page (after a 302
        # to login.microsoftonline.com) instead of the package. Parsing
        # that yields zero items and the job is silently marked "done".
        # Flag it as an auth redirect so the orchestrator STOPS and asks
        # the user to re-authenticate (re-exporting would reuse the same
        # expired token and loop), while keeping the job resumable.
        final_host = (resp.url.host or "").lower()
        content_type = (resp.headers.get("content-type") or "").lower()
        if _is_login_host(final_host) or content_type.startswith("text/html"):
            raise GraphError(
                401,
                "eDiscovery 다운로드가 로그인 페이지로 리디렉션되었습니다. "
                "위임 로그인이 만료되었을 수 있습니다 (호스트="
                f"{final_host or 'unknown'}, content-type={content_type or 'unknown'}).",
                auth_redirect=True,
            )
        total = 0
        try:
            total = int(resp.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            total = 0
        if on_progress is None:
            return resp.read()
        # Stream so we can report incremental download progress.
        chunks: list[bytes] = []
        downloaded = 0
        last_reported = 0
        on_progress(0, total)
        for chunk in resp.iter_bytes(chunk_size=256 * 1024):
            if not chunk:
                continue
            chunks.append(chunk)
            downloaded += len(chunk)
            # Throttle: report at most every ~1 MiB to avoid log spam.
            if downloaded - last_reported >= 1024 * 1024:
                last_reported = downloaded
                on_progress(downloaded, total)
        on_progress(downloaded, total)
        return b"".join(chunks)

    def _download_bearer_candidates(self, download_url: str) -> list[tuple[str, str]]:
        """Return backend bearer candidates for an export download.

        The IsDirectDownloadProxy URL used by some tenants is *not* a normal
        OAuth-protected file endpoint: in practice it may reject every access
        token and require an interactive ``id_token`` browser session. We still
        try all known Exchange/Purview audiences silently before giving up, but
        we intentionally do not fall back to a browser login from here.
        """
        candidates: list[tuple[str, str]] = []
        providers = [("primary", self.token_provider)] + [
            (f"extra-{idx}", provider)
            for idx, provider in enumerate(self._download_token_providers, start=1)
        ]
        for provider_label, provider in providers:
            acquire_for_scopes = getattr(provider, "acquire_for_scopes", None)
            if _is_ediscovery_proxy(download_url) and callable(acquire_for_scopes):
                for scope in PURVIEW_EXPORT_SCOPES:
                    try:
                        token = str(acquire_for_scopes([scope]))
                    except Exception:
                        log.warning(
                            "eDiscovery export token acquisition failed for %s scope %s",
                            provider_label,
                            scope,
                        )
                        log.debug("Token acquisition failure details", exc_info=True)
                        continue
                    candidates.append((f"{provider_label}:{scope}", token))
            try:
                candidates.append((f"{provider_label}:default", str(provider.acquire())))
            except Exception:
                log.warning("Default %s token acquisition failed", provider_label, exc_info=True)
        return candidates



# ---- module helpers ----------------------------------------------------


_GRAPH_DT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalise_graph_datetime(value: str) -> str:
    """Return ``value`` truncated to whole-second UTC ISO-8601 with ``Z``.

    Accepts ``2026-05-21T00:17:41.086956Z`` or ``...+00:00`` and emits
    ``2026-05-21T00:17:41Z``. Falls back to the original string if it
    does not look like an ISO timestamp.
    """
    if not value:
        return value
    m = _GRAPH_DT_RE.match(value)
    if m:
        return f"{m.group(1)}Z"
    return value


def _date_filter(field: str, since: str | None, until: str | None) -> str | None:
    """Build an OData ``$filter`` string for a datetime field.

    Returns ``None`` when both bounds are missing so the caller can skip
    the parameter entirely. Bounds use ``ge`` / ``lt`` for half-open
    intervals so paged collection windows can chain without overlap.
    """
    parts: list[str] = []
    if since:
        parts.append(f"{field} ge {_normalise_graph_datetime(since)}")
    if until:
        parts.append(f"{field} lt {_normalise_graph_datetime(until)}")
    if not parts:
        return None
    return " and ".join(parts)


def _is_graph_host(url: str) -> bool:
    """Return True when ``url`` targets a Microsoft Graph endpoint.

    Used to decide whether to attach an AAD bearer token: Graph-hosted
    download URLs need it, while pre-authenticated Azure Blob SAS links
    (the common eDiscovery export case) must not receive a Graph-audience
    token or the storage front door rejects it with ``401 Mise failed``.
    """
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "graph.microsoft.com" or host.endswith(".graph.microsoft.com")


def _is_ediscovery_proxy(url: str) -> bool:
    """Return True for the eDiscovery proxy service that streams export files.

    These hosts (``*.proxyservice.ediscovery.svc.cloud.microsoft``) require a
    Purview/Exchange compliance-audience token rather than a Graph-audience
    one, so the caller mints :data:`PURVIEW_EXPORT_SCOPE` for them.
    """
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    return "proxyservice.ediscovery" in host


def _needs_aad_bearer(url: str) -> bool:
    """Decide whether an eDiscovery download URL needs a delegated bearer.

    Pre-signed Azure Blob SAS links authenticate via their query string and
    reject a Graph-audience bearer (``401 "Mise failed"``), so they must be
    fetched anonymously. Every other host in the new eDiscovery export
    pipeline — Graph itself and the eDiscovery proxy service
    (``*.proxyservice.ediscovery.svc.cloud.microsoft``) — requires the bearer
    or it redirects to an interactive ``login.microsoftonline.com`` page and
    the download yields an HTML sign-in form instead of the package.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if not host:
        return False
    # Pre-signed Azure Blob SAS link: never attach a bearer.
    if host.endswith(".blob.core.windows.net"):
        return False
    return True


def _is_login_host(host: str) -> bool:
    """Return True when ``host`` is a Microsoft sign-in endpoint.

    Used to detect an eDiscovery export download that redirected to an
    interactive login page (which the proxy returns as HTTP 200 HTML when
    the delegated token is missing or expired).
    """
    host = (host or "").lower()
    return (
        host in {"login.microsoftonline.com", "login.microsoft.com"}
        or host.endswith(".login.microsoftonline.com")
        or host.endswith(".login.microsoft.com")
    )


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return response.text


def _safe_text(body: bytes) -> str:
    """Decode raw response bytes for use as an error detail string."""
    try:
        return body.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return repr(body[:512])


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    base = min(60.0, 2 ** attempt)
    return base + random.uniform(0, base * 0.2)


def _preferred_tenant_domain(domains: object) -> str | None:
    if not isinstance(domains, list):
        return None
    candidates = [domain for domain in domains if isinstance(domain, dict)]
    for domain in candidates:
        if domain.get("isInitial") and domain.get("name"):
            return str(domain["name"])
    for domain in candidates:
        if domain.get("isDefault") and domain.get("name"):
            return str(domain["name"])
    for domain in candidates:
        name = str(domain.get("name") or "")
        if name.endswith(".onmicrosoft.com"):
            return name
    for domain in candidates:
        if domain.get("name"):
            return str(domain["name"])
    return None


def _parse_interaction(raw: dict[str, Any]) -> CopilotInteraction:
    body = raw.get("body") or {}
    return CopilotInteraction(
        id=str(raw.get("id")),
        session_id=raw.get("sessionId"),
        request_id=raw.get("requestId"),
        created_at=str(raw.get("createdDateTime")),
        interaction_type=raw.get("interactionType"),
        app=raw.get("appClass") or raw.get("from", {}).get("application", {}).get("displayName"),
        body_text=body.get("content"),
        body_content_type=body.get("contentType"),
        attachments=list(raw.get("attachments") or []),
        links=list(raw.get("links") or []),
        mentions=list(raw.get("mentions") or []),
        raw=raw,
    )
