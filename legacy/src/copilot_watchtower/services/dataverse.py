"""Client + parsers for Dataverse Copilot Studio conversation transcripts.

Copilot Studio (custom-engine agents) persists **every** channel's
conversation — Microsoft Teams, the demo web chat, Direct Line, etc. — into
the Dataverse ``conversationtranscript`` table of the environment that hosts
the agent. The Microsoft Graph ``getAllEnterpriseInteractions`` substrate the
rest of this app reads only captures *BizChat-channel* turns, so an agent that
a user chats with **from Teams** is invisible there. Reading the Dataverse
table directly recovers those Teams (and other-channel) conversations.

There is no first-party "list every agent's transcripts" API, so this module
talks to the Dataverse **Web API** of each environment directly:

* Global Discovery Service
  (``https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances``)
  enumerates the environments (orgs) the signed-in admin can reach.
* Per environment,
  ``GET {org}/api/data/v9.2/conversationtranscripts`` returns the transcript
  rows; each row's ``content`` column is a JSON string holding a Bot Framework
  *activity* array. ``activity.channelId == "msteams"`` marks a Teams turn.

Auth is the ``*.crm.dynamics.com`` bearer token captured from a real headless
maker-portal sign-in (see :mod:`.dataverse_browser_download`) — mirroring the
consumption collector — so there is no standalone delegated token to expire.

The JSON parsers (:func:`parse_environments_json`,
:func:`parse_conversation_transcript`) are deliberately decoupled from the HTTP
layer so they can be unit-tested with synthetic fixtures regardless of the
(unofficial, undocumented) endpoint shape.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..config import (
    BAP_ENVIRONMENTS_URL,
    DATAVERSE_API_VERSION,
    DATAVERSE_DISCOVERY_INSTANCES_URL,
)
from ..db.repository import SOURCE_DATAVERSE, InteractionRow
from ..i18n import translate

log = logging.getLogger(__name__)

USER_PROMPT = "userPrompt"
AI_RESPONSE = "aiResponse"

# Channel ids the Bot Framework stamps onto each activity. Stored verbatim in
# the ``app`` column so :func:`app_labels.display_app_name` can render them.
TEAMS_CHANNEL_ID = "msteams"

TokenForUrl = Callable[[str], str]


class DataverseError(RuntimeError):
    def __init__(self, status: int | None, detail: object) -> None:
        super().__init__(f"Dataverse API error {status}: {detail}")
        self.status = status
        self.detail = detail


@dataclass
class DataverseEnvironment:
    """A single Dataverse environment (org) reachable by the admin."""

    id: str
    # Web API root, e.g. https://contoso.crm.dynamics.com. Always normalised
    # without a trailing slash.
    url: str
    friendly_name: str | None = None
    # BAP environment SKU (e.g. "Production", "Sandbox", "Developer", "Default",
    # "Trial"). Developer environments never hold Copilot conversation
    # transcripts, so callers exclude them from collection entirely.
    sku: str | None = None


@dataclass
class ParsedTranscript:
    """Result of flattening one ``conversationtranscript`` row."""

    rows: list[InteractionRow] = field(default_factory=list)
    # user_id -> display name, for minimal UserRow upserts by the worker.
    participants: dict[str, str] = field(default_factory=dict)
    # Diagnostics so the operator can tell "empty table" from "all filtered".
    records_seen: int = 0          # conversationtranscript rows returned
    activities_seen: int = 0       # message activities encountered (any channel)
    skipped_non_teams: int = 0     # message activities dropped by teams_only
    skipped_empty: int = 0         # message activities with no usable text
    # When a record's ``content`` could not be coerced into an activity list,
    # a short hint about its actual shape (top-level type/keys) for debugging.
    content_shape: str | None = None


# ---------------------------------------------------------------------------
# Pure parsers (HTTP-free, unit-testable)
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalise_timestamp(value: Any, *, fallback: str) -> str:
    """Return a UTC ISO 8601 string for a Bot Framework activity timestamp.

    Copilot Studio transcript activities express the timestamp as an *epoch
    integer* (seconds, or milliseconds when the value is large), whereas the
    rest of the store uses ISO 8601 strings. Persisting the raw epoch number
    breaks the date-range filter (a string ``"1780015999"`` sorts before
    ``"2025-..."``) so such turns silently vanish from the conversation views.
    Normalise numeric epochs to ISO; pass through values that already look like
    ISO timestamps unchanged.
    """
    if value is None:
        return fallback
    # Numeric epoch (int/float, or a string that is purely digits).
    epoch: float | None = None
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        epoch = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            epoch = float(text)
        else:
            # Already an ISO 8601 (or other non-numeric) timestamp string.
            return text or fallback
    if epoch is None:
        return fallback
    # Heuristic: values past ~year 33658 in seconds are really milliseconds.
    if epoch >= 1e12:
        epoch /= 1000.0
    try:
        return datetime.fromtimestamp(epoch, tz=UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except (OverflowError, OSError, ValueError):
        return fallback


def parse_environments_json(data: Any) -> list[DataverseEnvironment]:
    """Parse the Global Discovery Service ``Instances`` response.

    The payload is an OData envelope ``{"value": [ {ApiUrl, Url, ...}, ... ]}``.
    We prefer ``ApiUrl`` (the Web API root) and fall back to ``Url``.
    """
    items = data.get("value") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    envs: list[DataverseEnvironment] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_url = (
            item.get("ApiUrl")
            or item.get("apiUrl")
            or item.get("Url")
            or item.get("url")
            or ""
        )
        url = str(raw_url).strip().rstrip("/")
        if not url or url in seen:
            continue
        seen.add(url)
        env_id = str(
            item.get("Id")
            or item.get("id")
            or item.get("EnvironmentId")
            or item.get("environmentId")
            or url
        )
        name = (
            item.get("FriendlyName")
            or item.get("friendlyName")
            or item.get("UniqueName")
            or item.get("uniqueName")
        )
        envs.append(
            DataverseEnvironment(
                id=env_id, url=url, friendly_name=str(name) if name else None
            )
        )
    return envs


def _origin(url: str) -> str:
    """Normalise a URL to its ``scheme://host[:port]`` origin (no path).

    BAP returns ``instanceApiUrl`` as the full Web API root
    (``https://org.crm.dynamics.com/api/data/v9.2/``); the transcript client
    appends ``/api/data/...`` itself, so we strip back to the org origin.
    """
    parts = urlsplit(url.strip())
    if parts.scheme and parts.hostname:
        host = parts.hostname
        if parts.port:
            host = f"{host}:{parts.port}"
        return f"{parts.scheme}://{host}"
    return url.strip().rstrip("/")


def parse_bap_environments_json(data: Any) -> list[DataverseEnvironment]:
    """Parse the BAP ``environments`` response into Dataverse environments.

    The payload is ``{"value": [ {name, properties: {displayName,
    linkedEnvironmentMetadata: {instanceUrl, instanceApiUrl, ...}}}, ... ]}``.
    Environments without a linked Dataverse instance hold no transcripts and
    are skipped. ``name`` is the environment GUID used to drive the maker SPA to
    that environment so MSAL mints its org token.
    """
    items = data.get("value") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    envs: list[DataverseEnvironment] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        props = item.get("properties")
        props = props if isinstance(props, dict) else {}
        meta = props.get("linkedEnvironmentMetadata")
        meta = meta if isinstance(meta, dict) else {}
        raw_url = (
            meta.get("instanceUrl")
            or meta.get("instanceApiUrl")
            or meta.get("InstanceUrl")
            or meta.get("InstanceApiUrl")
            or ""
        )
        if not str(raw_url).strip():
            # No Dataverse instance → no conversationtranscript table.
            continue
        url = _origin(str(raw_url))
        if not url or url in seen:
            continue
        seen.add(url)
        env_id = str(item.get("name") or item.get("id") or url)
        name = (
            props.get("displayName")
            or props.get("DisplayName")
            or meta.get("friendlyName")
            or env_id
        )
        raw_sku = (
            props.get("environmentSku")
            or props.get("EnvironmentSku")
            or props.get("environmentType")
            or props.get("EnvironmentType")
        )
        envs.append(
            DataverseEnvironment(
                id=env_id,
                url=url,
                friendly_name=str(name) if name else None,
                sku=str(raw_sku) if raw_sku else None,
            )
        )
    return envs


def fetch_bap_environments(
    bap_token: str,
    *,
    http_client: httpx.Client | None = None,
    timeout: float = 60.0,
) -> list[DataverseEnvironment]:
    """List environments via the BAP API using a captured BAP bearer token.

    The BAP audience differs from both the Global Discovery Service and the
    per-org Dataverse audience, so this takes the dedicated ``bap_token`` rather
    than the per-host ``token_for`` resolver. Raises :class:`DataverseError` on
    a non-success response.
    """
    client = http_client if http_client is not None else httpx.Client(timeout=timeout)
    try:
        resp = client.get(
            BAP_ENVIRONMENTS_URL,
            headers={
                "Authorization": f"Bearer {bap_token}",
                "Accept": "application/json",
            },
        )
        if not resp.is_success:
            raise DataverseError(resp.status_code, _safe_text(resp))
        try:
            data = resp.json()
        except ValueError as exc:
            raise DataverseError(
                resp.status_code,
                translate("dataverse.bapNotJson"),
            ) from exc
        return parse_bap_environments_json(data)
    finally:
        if http_client is None:
            client.close()


def _coerce_activities(content: Any) -> list[dict[str, Any]]:
    """Return the activity list from a transcript ``content`` value.

    ``content`` may be a JSON string or already-decoded structure, and the
    activities may sit at the top level (a bare list) or under an
    ``activities`` key. We accept all shapes defensively.
    """
    data = content
    if isinstance(data, (str, bytes)):
        try:
            data = json.loads(data)
        except (ValueError, TypeError):
            return []
    if isinstance(data, dict):
        activities = data.get("activities")
        if isinstance(activities, list):
            return [a for a in activities if isinstance(a, dict)]
        return []
    if isinstance(data, list):
        return [a for a in data if isinstance(a, dict)]
    return []


def _describe_content_shape(content: Any) -> str:
    """Return a short, log-safe hint about an un-parseable ``content`` value.

    Used only for diagnostics when :func:`_coerce_activities` yields nothing,
    so the operator can see whether the JSON shape differs from the expected
    Bot Framework activity array.
    """
    data = content
    if isinstance(data, (str, bytes)):
        text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
        stripped = text.strip()
        if not stripped:
            return translate("dataverse.shapeEmptyString")
        try:
            data = json.loads(stripped)
        except (ValueError, TypeError):
            return translate("dataverse.shapeNonJsonString", prefix=repr(stripped[:60]))
    if isinstance(data, dict):
        keys = ", ".join(list(data.keys())[:8]) or translate("dataverse.shapeNoKeys")
        return translate("dataverse.shapeDict", keys=keys)
    if isinstance(data, list):
        return translate("dataverse.shapeList", length=len(data))
    if data is None:
        return translate("dataverse.shapeNone")
    return type(data).__name__


def _normalise_role(value: Any) -> str:
    """Return ``"user"`` | ``"bot"`` | ``""`` for a Bot Framework role value.

    The documented form is the string ``"user"`` / ``"bot"``, but Copilot
    Studio ``conversationtranscript`` activities encode the role as an integer
    enum instead: ``1`` for the human and ``0`` for the bot. If we only compared
    against the string form, every turn fell through to the default and was
    misclassified as a user prompt (and the human resolved to ``unknown``).
    Handle both encodings.
    """
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        ivalue = int(value)
        if ivalue == 1:
            return "user"
        if ivalue == 0:
            return "bot"
        return ""
    text = str(value).strip().lower()
    if text in ("user", "bot"):
        return text
    if text == "1":
        return "user"
    if text == "0":
        return "bot"
    return ""


def _has_aad_object_id(sender: Any) -> bool:
    """True when a ``from``/``recipient`` carries an Entra AAD object id.

    Only human Teams users surface an ``aadObjectId``; the bot identity never
    does. This is the strongest available signal that an activity came from a
    person, so we treat it as authoritative when classifying turns.
    """
    if not isinstance(sender, dict):
        return False
    return bool(sender.get("aadObjectId") or sender.get("aadobjectid"))


def _activity_role(activity: dict[str, Any]) -> str:
    """Classify an activity as a user prompt or an AI response.

    Bot Framework marks the sender role on ``from.role``. Copilot Studio encodes
    this as an integer enum (``1`` user / ``0`` bot), so the presence of an
    ``aadObjectId`` (only ever set for a real person) is used as the primary
    signal, with the role enum and the recipient role as fallbacks.
    """
    sender = activity.get("from") or {}
    if _has_aad_object_id(sender):
        return USER_PROMPT
    role = _normalise_role(sender.get("role") if isinstance(sender, dict) else None)
    if role == "user":
        return USER_PROMPT
    if role == "bot":
        return AI_RESPONSE
    recipient = activity.get("recipient") or {}
    rrole = _normalise_role(
        recipient.get("role") if isinstance(recipient, dict) else None
    )
    if rrole == "bot":
        return USER_PROMPT
    if rrole == "user":
        return AI_RESPONSE
    return USER_PROMPT


def _participant_id(activity: dict[str, Any]) -> tuple[str, str | None]:
    """Return a stable (user_id, display_name) for the human participant.

    Prefers the Teams AAD object id surfaced on ``from.aadObjectId``; falls
    back to ``from.id``. The id is prefixed so it never collides with a real
    Graph user id and stays attributable in the UI/threads.
    """
    sender = activity.get("from") or {}
    if not isinstance(sender, dict):
        return ("dataverse:unknown", None)
    aad = sender.get("aadObjectId") or sender.get("aadobjectid")
    raw = aad or sender.get("id") or "unknown"
    name = sender.get("name")
    return (f"dataverse:{raw}", str(name) if name else None)


def parse_conversation_transcript(
    content: Any,
    *,
    transcript_id: str,
    environment_id: str,
    agent_id: str | None = None,
    fetched_at: str | None = None,
    teams_only: bool = False,
) -> ParsedTranscript:
    """Flatten one ``conversationtranscript`` row into interaction turns.

    Each Bot Framework *message* activity becomes one :class:`InteractionRow`.
    The conversation id groups the turns into a session/thread; the channel id
    is stored as the ``app`` so Teams turns render as "Teams" in the UI.

    When ``teams_only`` is set, non-Teams activities are skipped (used when the
    operator only wants to recover the Teams-channel conversations that the
    Graph substrate misses).
    """
    fetched_at = fetched_at or _now_iso()
    activities = _coerce_activities(content)
    result = ParsedTranscript()
    seen: set[str] = set()

    if not activities:
        # No activity array could be extracted — record the shape so the
        # worker can report why this transcript produced no turns.
        result.content_shape = _describe_content_shape(content)
        return result

    # Resolve the human participant once per transcript so every turn (user and
    # bot) is attributed to the same end user — the bot's ``from`` is the agent.
    # Prefer a turn that carries an Entra AAD object id (a real Teams user);
    # only fall back to the first user-role turn when none is present.
    human_user_id = "dataverse:unknown"
    human_name: str | None = None
    for activity in activities:
        if _has_aad_object_id(activity.get("from")):
            human_user_id, human_name = _participant_id(activity)
            break
    else:
        for activity in activities:
            if _activity_role(activity) == USER_PROMPT:
                human_user_id, human_name = _participant_id(activity)
                break

    for idx, activity in enumerate(activities):
        if str(activity.get("type") or "").lower() != "message":
            continue
        result.activities_seen += 1
        text = activity.get("text")
        if not isinstance(text, str) or not text.strip():
            result.skipped_empty += 1
            continue
        channel_id = str(activity.get("channelId") or "").strip()
        if teams_only and channel_id.lower() != TEAMS_CHANNEL_ID:
            result.skipped_non_teams += 1
            continue

        interaction_type = _activity_role(activity)
        conversation = activity.get("conversation") or {}
        session_id = (
            str(conversation.get("id"))
            if isinstance(conversation, dict) and conversation.get("id")
            else transcript_id
        )
        activity_id = str(activity.get("id") or f"{idx}")
        row_id = f"dataverse:{transcript_id}:{activity_id}:{idx}"
        if row_id in seen:
            continue
        seen.add(row_id)

        created_at = _normalise_timestamp(
            activity.get("timestamp") or activity.get("localTimestamp"),
            fallback=fetched_at,
        )

        result.rows.append(
            InteractionRow(
                id=row_id,
                user_id=human_user_id,
                session_id=session_id,
                request_id=activity_id,
                created_at=created_at,
                interaction_type=interaction_type,
                app=channel_id or None,
                body_text=text,
                body_content_type="text",
                attachments_json=None,
                raw_json=json.dumps(
                    {
                        "source": "dataverse",
                        "environment_id": environment_id,
                        "agent_id": agent_id,
                        "channel_id": channel_id,
                        "activity": activity,
                    },
                    ensure_ascii=False,
                ),
                fetched_at=fetched_at,
                source_type=SOURCE_DATAVERSE,
            )
        )

    if human_user_id != "dataverse:unknown":
        result.participants[human_user_id] = human_name or human_user_id
    elif result.rows:
        # Some transcripts have no AAD-identified human (e.g. anonymous web
        # chat or activities lacking a ``from`` id). The rows still reference
        # ``dataverse:unknown`` as their user, so register that participant to
        # satisfy the interactions→users foreign key.
        result.participants.setdefault(human_user_id, translate("dataverse.unknownUser"))
    return result


def _transcript_key(row: InteractionRow) -> str:
    """Group key that ties every turn of one transcript together.

    Row ids are minted as ``dataverse:{transcript_id}:{activity_id}:{idx}``,
    so the transcript id is the second colon-delimited segment. Falls back to
    the session id when the shape is unexpected.
    """
    rid = row.id or ""
    if rid.startswith("dataverse:"):
        parts = rid.split(":")
        if len(parts) >= 3 and parts[1]:
            return parts[1]
    return row.session_id or rid


def repair_dataverse_attribution(repo: Any) -> int:
    """Re-attribute already-collected Dataverse turns to the right user.

    Earlier collections classified every turn as a user prompt and resolved the
    human to ``dataverse:unknown`` because the activity ``role`` is an integer
    enum that the old parser did not understand. This re-reads each stored
    activity from ``raw_json``, recomputes the correct ``interaction_type`` and
    the per-transcript human participant, updates the rows in place, ensures a
    ``users`` row exists for each participant (with a friendly name resolved
    from the Graph directory when possible), and rebuilds the Dataverse threads.

    Safe to run repeatedly; returns the number of interactions updated.
    """
    rows = repo.list_interactions(source_type=SOURCE_DATAVERSE, limit=1_000_000)
    if not rows:
        return 0

    groups: dict[str, list[InteractionRow]] = {}
    for row in rows:
        groups.setdefault(_transcript_key(row), []).append(row)

    updates: list[tuple[str, str, str]] = []
    participants: dict[str, str | None] = {}

    for grp in groups.values():
        parsed: list[tuple[InteractionRow, dict[str, Any]]] = []
        for row in grp:
            try:
                payload = json.loads(row.raw_json) if row.raw_json else {}
            except (TypeError, ValueError):
                payload = {}
            activity = payload.get("activity") if isinstance(payload, dict) else None
            parsed.append((row, activity if isinstance(activity, dict) else {}))

        human_user_id = "dataverse:unknown"
        human_name: str | None = None
        for _row, activity in parsed:
            if _has_aad_object_id(activity.get("from")):
                human_user_id, human_name = _participant_id(activity)
                break
        else:
            for _row, activity in parsed:
                if _activity_role(activity) == USER_PROMPT:
                    human_user_id, human_name = _participant_id(activity)
                    break

        if human_user_id not in participants or participants[human_user_id] is None:
            participants[human_user_id] = human_name

        for row, activity in parsed:
            interaction_type = _activity_role(activity)
            updates.append((row.id, human_user_id, interaction_type))

    if not updates:
        return 0

    # Resolve friendly names from the Graph directory: a Dataverse participant
    # ``dataverse:<aad>`` maps to the Graph user keyed on the bare ``<aad>``.
    bare_ids = {
        uid.split("dataverse:", 1)[1]: uid
        for uid in participants
        if uid.startswith("dataverse:") and uid != "dataverse:unknown"
    }
    graph_names = repo.display_names_for_ids(bare_ids.keys())
    for bare, display in graph_names.items():
        uid = bare_ids.get(bare)
        if uid and not participants.get(uid):
            participants[uid] = display

    from ..db.repository import UserRow
    from .threading_service import recompute_threads_for_user

    user_rows: list[UserRow] = []
    for uid, name in participants.items():
        display = name
        if uid == "dataverse:unknown" and not display:
            display = translate("dataverse.unknownUser")
        user_rows.append(
            UserRow(
                id=uid,
                upn=None,
                display_name=display,
                enabled=True,
                has_copilot_license=False,
                in_scope=False,
            )
        )
    if user_rows:
        repo.upsert_users(user_rows)

    updated = repo.update_interaction_attribution(updates)

    # Rebuild threads for every Dataverse participant (and drop any stale
    # ``unknown`` threads left behind once their turns moved to real users).
    repo.delete_user_threads("dataverse:unknown", source_type=SOURCE_DATAVERSE)
    for user_row in user_rows:
        recompute_threads_for_user(repo, user_row, source_type=SOURCE_DATAVERSE)

    log.info(
        translate("dataverse.attributionDone", interactions=updated, users=len(user_rows))
    )
    return updated


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


class DataverseClient:
    """Synchronous client over the Dataverse Web API of each environment.

    ``token_for(url)`` must return a bearer token whose audience matches the
    host of ``url`` (Dataverse tokens are per-resource). The captured-token
    provider in :mod:`.dataverse_browser_download` supplies one token per
    ``*.crm.dynamics.com`` host plus the Global Discovery Service host.
    """

    def __init__(
        self,
        token_for: TokenForUrl,
        *,
        timeout: float = 120.0,
        http_client: httpx.Client | None = None,
        page_size: int = 200,
    ) -> None:
        self.token_for = token_for
        self.page_size = page_size
        self._client = (
            http_client if http_client is not None else httpx.Client(timeout=timeout)
        )

    def close(self) -> None:
        self._client.close()

    # ---- helpers ---------------------------------------------------

    def _headers(
        self, url: str, *, page_size: int | None = None, prefer_extra: str | None = None
    ) -> dict[str, str]:
        prefer_parts: list[str] = []
        if page_size:
            prefer_parts.append(f"odata.maxpagesize={page_size}")
        if prefer_extra:
            prefer_parts.append(prefer_extra)
        headers = {
            "Authorization": f"Bearer {self.token_for(url)}",
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        }
        if prefer_parts:
            headers["Prefer"] = ",".join(prefer_parts)
        return headers

    def _get_json(
        self,
        url: str,
        *,
        params: dict[str, str] | None = None,
        page_size: int | None = None,
        prefer_extra: str | None = None,
    ) -> Any:
        resp = self._client.get(
            url,
            headers=self._headers(url, page_size=page_size, prefer_extra=prefer_extra),
            params=params,
        )
        if not resp.is_success:
            raise DataverseError(resp.status_code, _safe_text(resp))
        try:
            return resp.json()
        except ValueError as exc:
            raise DataverseError(
                resp.status_code,
                translate("dataverse.unexpectedNonJson"),
            ) from exc

    # ---- discovery -------------------------------------------------

    def discover_environments(self) -> list[DataverseEnvironment]:
        """List the Dataverse environments the signed-in admin can reach."""
        data = self._get_json(DATAVERSE_DISCOVERY_INSTANCES_URL)
        return parse_environments_json(data)

    # ---- generic entity reader -------------------------------------

    def fetch_entity_rows(
        self,
        env: DataverseEnvironment,
        entity_set: str,
        *,
        select: str | None = None,
        filter: str | None = None,  # noqa: A002 - mirrors the OData option name
        orderby: str | None = None,
        top: int | None = None,
        max_pages: int = 50,
        extra_params: dict[str, str] | None = None,
        include_formatted: bool = False,
    ) -> list[dict[str, Any]]:
        """Fetch raw rows from any Dataverse entity set in one environment.

        Generic OData reader shared by the flow-run and agent-definition
        collectors (transcripts keep their own bespoke parser). Follows
        ``@odata.nextLink`` paging up to ``max_pages`` and returns the raw
        record dicts so each caller parses its own shape. ``select``/``filter``/
        ``orderby``/``top`` map to the matching OData ``$`` system query options.
        When ``include_formatted`` is set, lookup/choice columns also return
        their ``@OData...FormattedValue`` display strings (e.g. flow/owner name).
        """
        base = env.url.rstrip("/")
        url: str | None = f"{base}/api/data/{DATAVERSE_API_VERSION}/{entity_set}"
        params: dict[str, str] | None = dict(extra_params or {})
        if select:
            params["$select"] = select
        if filter:
            params["$filter"] = filter
        if orderby:
            params["$orderby"] = orderby
        if top:
            params["$top"] = str(top)
        prefer_extra = 'odata.include-annotations="*"' if include_formatted else None
        rows: list[dict[str, Any]] = []
        pages = 0
        while url and pages < max_pages:
            data = self._get_json(
                url, params=params or None, page_size=self.page_size, prefer_extra=prefer_extra
            )
            params = None  # the nextLink already carries the query
            for record in data.get("value", []) if isinstance(data, dict) else []:
                if isinstance(record, dict):
                    rows.append(record)
            url = data.get("@odata.nextLink") if isinstance(data, dict) else None
            pages += 1
        return rows

    # ---- transcripts -----------------------------------------------

    def fetch_transcript_rows(
        self,
        env: DataverseEnvironment,
        *,
        since: str | None = None,
        until: str | None = None,
        fetched_at: str | None = None,
        teams_only: bool = False,
        max_pages: int = 50,
    ) -> ParsedTranscript:
        """Fetch + parse all conversation transcripts for one environment.

        ``since``/``until`` are ISO-8601 timestamps filtered on ``createdon``.
        Follows OData ``@odata.nextLink`` paging up to ``max_pages``.
        """
        fetched_at = fetched_at or _now_iso()
        base = env.url.rstrip("/")
        url: str | None = f"{base}/api/data/{DATAVERSE_API_VERSION}/conversationtranscripts"
        params: dict[str, str] | None = {
            "$select": "conversationtranscriptid,content,createdon,name,schematype",
            "$orderby": "createdon desc",
        }
        filters = []
        if since:
            filters.append(f"createdon gt {since}")
        if until:
            filters.append(f"createdon le {until}")
        if filters:
            params["$filter"] = " and ".join(filters)

        merged = ParsedTranscript()
        pages = 0
        while url and pages < max_pages:
            data = self._get_json(url, params=params, page_size=self.page_size)
            params = None  # nextLink already carries the query
            for record in data.get("value", []) if isinstance(data, dict) else []:
                if not isinstance(record, dict):
                    continue
                merged.records_seen += 1
                transcript_id = str(
                    record.get("conversationtranscriptid")
                    or record.get("conversationtranscriptId")
                    or record.get("name")
                    or ""
                )
                if not transcript_id:
                    continue
                parsed = parse_conversation_transcript(
                    record.get("content"),
                    transcript_id=transcript_id,
                    environment_id=env.id,
                    agent_id=record.get("_botid_value") or record.get("schematype"),
                    fetched_at=fetched_at,
                    teams_only=teams_only,
                )
                merged.rows.extend(parsed.rows)
                merged.participants.update(parsed.participants)
                merged.activities_seen += parsed.activities_seen
                merged.skipped_non_teams += parsed.skipped_non_teams
                merged.skipped_empty += parsed.skipped_empty
                if merged.content_shape is None and parsed.content_shape:
                    merged.content_shape = parsed.content_shape
            url = data.get("@odata.nextLink") if isinstance(data, dict) else None
            pages += 1
        return merged


def _safe_text(resp: httpx.Response) -> str:
    try:
        return resp.text[:2_000]
    except Exception:  # pragma: no cover - defensive
        return "<unreadable response body>"
