"""Unit tests for the Dataverse Copilot Studio transcript collector.

Covers the layers that do not require the live (unofficial) Dataverse Web API:

* :func:`parse_environments_json` — Global Discovery Service envelope parsing;
* :func:`parse_conversation_transcript` — Bot Framework activity flattening,
  role classification, channel/session mapping, ``teams_only`` filtering, and
  defensive handling of string/list/empty content;
* :class:`DataverseClient` — discovery + transcript paging against a mocked
  httpx transport (no network);
* :class:`Repository` persistence + threading for ``source_type='dataverse'``.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from copilot_watchtower.db import Repository, UserRow, initialize
from copilot_watchtower.db.repository import SOURCE_DATAVERSE
from copilot_watchtower.services.dataverse import (
    AI_RESPONSE,
    USER_PROMPT,
    DataverseClient,
    DataverseEnvironment,
    fetch_bap_environments,
    parse_bap_environments_json,
    parse_conversation_transcript,
    parse_environments_json,
)
from copilot_watchtower.services.dataverse_browser_download import (
    CapturedDataverseTokens,
    DataverseBrowserError,
    extract_dataverse_tokens_from_storage,
    try_self_add_as_admin,
)
from copilot_watchtower.services.threading_service import recompute_threads_for_user
from copilot_watchtower.workers.dataverse_collector import DataverseCollectorWorker


# --------------------------------------------------------------------------
# Environment discovery parsing
# --------------------------------------------------------------------------


def test_parse_environments_json_prefers_api_url_and_dedupes() -> None:
    data = {
        "value": [
            {
                "Id": "env-1",
                "ApiUrl": "https://org1.crm.dynamics.com/",
                "Url": "https://org1.crm.dynamics.com",
                "FriendlyName": "Contoso (default)",
            },
            {
                "Id": "env-1-dup",
                "ApiUrl": "https://org1.crm.dynamics.com",
            },
            {
                "Id": "env-2",
                "Url": "https://org2.crm.dynamics.com",
                "UniqueName": "org2",
            },
        ]
    }
    envs = parse_environments_json(data)
    assert [e.url for e in envs] == [
        "https://org1.crm.dynamics.com",
        "https://org2.crm.dynamics.com",
    ]
    assert envs[0].friendly_name == "Contoso (default)"
    assert envs[1].friendly_name == "org2"


def test_parse_environments_json_handles_non_dict() -> None:
    assert parse_environments_json([]) == []
    assert parse_environments_json({"value": "nope"}) == []


# --------------------------------------------------------------------------
# Transcript parsing
# --------------------------------------------------------------------------


def _teams_transcript() -> dict:
    return {
        "activities": [
            {
                "type": "message",
                "id": "a1",
                "timestamp": "2024-05-01T10:00:00Z",
                "channelId": "msteams",
                "from": {"id": "29:abc", "name": "Jin", "role": "user",
                         "aadObjectId": "aad-jin"},
                "conversation": {"id": "conv-1"},
                "text": "안녕하세요 에이전트",
            },
            {
                "type": "message",
                "id": "a2",
                "timestamp": "2024-05-01T10:00:02Z",
                "channelId": "msteams",
                "from": {"id": "bot", "name": "Agent", "role": "bot"},
                "conversation": {"id": "conv-1"},
                "text": "무엇을 도와드릴까요?",
            },
            {
                "type": "typing",
                "id": "a3",
                "channelId": "msteams",
                "from": {"role": "bot"},
            },
        ]
    }


def test_parse_conversation_transcript_teams_pairs_user_and_bot() -> None:
    parsed = parse_conversation_transcript(
        _teams_transcript(),
        transcript_id="t-1",
        environment_id="env-1",
        fetched_at="2024-05-02T00:00:00Z",
    )
    # The typing activity (no text) is dropped; two message turns remain.
    assert len(parsed.rows) == 2
    user_row, bot_row = parsed.rows
    assert user_row.interaction_type == USER_PROMPT
    assert bot_row.interaction_type == AI_RESPONSE
    # Both turns attributed to the same human (the user), keyed on AAD id.
    assert user_row.user_id == bot_row.user_id == "dataverse:aad-jin"
    assert user_row.session_id == "conv-1"
    assert user_row.app == "msteams"
    assert user_row.source_type == SOURCE_DATAVERSE
    assert parsed.participants == {"dataverse:aad-jin": "Jin"}
    # raw_json carries the source marker + environment for traceability.
    raw = json.loads(user_row.raw_json)
    assert raw["source"] == "dataverse"
    assert raw["environment_id"] == "env-1"
    assert raw["channel_id"] == "msteams"


def test_parse_conversation_transcript_accepts_json_string_content() -> None:
    content = json.dumps(_teams_transcript())
    parsed = parse_conversation_transcript(
        content, transcript_id="t-2", environment_id="env-1"
    )
    assert len(parsed.rows) == 2


def test_parse_conversation_transcript_normalises_epoch_timestamp() -> None:
    # Copilot Studio transcripts express the Bot Framework activity timestamp as
    # an epoch *integer* (seconds), not an ISO 8601 string. A raw epoch string
    # sorts before any "2025-..." date, so such turns fall outside the default
    # date-range filter and vanish from the views. The parser must emit ISO.
    transcript = {
        "activities": [
            {
                "type": "message",
                "id": "a1",
                "timestamp": 1779342567,  # 2026-05-21T05:49:27Z
                "channelId": "msteams",
                "from": {"id": "29:abc", "name": "Jin", "role": "user",
                         "aadObjectId": "aad-jin"},
                "conversation": {"id": "conv-1"},
                "text": "안녕하세요",
            },
            {
                "type": "message",
                "id": "a2",
                "timestamp": 1779342576647,  # same instant in milliseconds
                "channelId": "msteams",
                "from": {"id": "bot", "name": "Agent", "role": "bot"},
                "conversation": {"id": "conv-1"},
                "text": "무엇을 도와드릴까요?",
            },
        ]
    }
    parsed = parse_conversation_transcript(
        transcript, transcript_id="t-epoch", environment_id="env-1"
    )
    assert len(parsed.rows) == 2
    user_row, bot_row = parsed.rows
    assert user_row.created_at == "2026-05-21T05:49:27Z"
    # The millisecond-scale epoch is divided down to the same calendar day.
    assert bot_row.created_at.startswith("2026-05-21T")


def test_parse_conversation_transcript_handles_integer_roles() -> None:
    # Real Copilot Studio transcripts encode ``from.role`` as an integer enum
    # (1 = user, 0 = bot) rather than the documented "user"/"bot" strings. The
    # parser must classify turns and resolve the human from that enum; the user
    # turn carries the only AAD object id, so every turn is attributed to it.
    transcript = {
        "activities": [
            {
                "type": "message",
                "id": "b1",
                "timestamp": "2025-05-21T05:49:27Z",
                "channelId": "msteams",
                "from": {"id": "bot-29", "role": 0},  # bot greeting, no AAD
                "conversation": {"id": "conv-int"},
                "text": "안녕하세요, 저는 HR Helper입니다",
            },
            {
                "type": "message",
                "id": "u1",
                "timestamp": "2025-05-21T05:49:40Z",
                "channelId": "msteams",
                "from": {"id": "29:user", "role": 1,
                         "aadObjectId": "aad-int-user"},
                "conversation": {"id": "conv-int"},
                "text": "사과 판매량 합은?",
            },
        ]
    }
    parsed = parse_conversation_transcript(
        transcript, transcript_id="t-int", environment_id="env-1"
    )
    assert len(parsed.rows) == 2
    bot_row, user_row = parsed.rows
    assert bot_row.interaction_type == AI_RESPONSE
    assert user_row.interaction_type == USER_PROMPT
    # Both turns attributed to the AAD-identified human, not "unknown".
    assert bot_row.user_id == user_row.user_id == "dataverse:aad-int-user"
    assert parsed.participants == {"dataverse:aad-int-user": "dataverse:aad-int-user"}


def test_parse_conversation_transcript_accepts_bare_list() -> None:
    activities = _teams_transcript()["activities"]
    parsed = parse_conversation_transcript(
        activities, transcript_id="t-3", environment_id="env-1"
    )
    assert len(parsed.rows) == 2


def test_parse_conversation_transcript_registers_participant_for_anonymous_user() -> None:
    # No AAD/from id → user resolves to dataverse:unknown, but rows still
    # reference it, so it must be registered as a participant (FK safety).
    content = {
        "activities": [
            {
                "type": "message",
                "id": "a1",
                "channelId": "msteams",
                "from": {"role": "user"},
                "conversation": {"id": "conv-x"},
                "text": "익명 질문",
            }
        ]
    }
    parsed = parse_conversation_transcript(
        content, transcript_id="t-anon", environment_id="env-1"
    )
    assert len(parsed.rows) == 1
    user_id = parsed.rows[0].user_id
    assert user_id == "dataverse:unknown"
    assert user_id in parsed.participants


def test_parse_conversation_transcript_teams_only_filters_other_channels() -> None:
    content = {
        "activities": [
            {
                "type": "message",
                "id": "w1",
                "channelId": "directline",
                "from": {"id": "u", "role": "user"},
                "conversation": {"id": "c-web"},
                "text": "web question",
            },
            {
                "type": "message",
                "id": "m1",
                "channelId": "msteams",
                "from": {"id": "u", "role": "user"},
                "conversation": {"id": "c-teams"},
                "text": "teams question",
            },
        ]
    }
    all_rows = parse_conversation_transcript(
        content, transcript_id="t", environment_id="e"
    )
    assert len(all_rows.rows) == 2
    teams_rows = parse_conversation_transcript(
        content, transcript_id="t", environment_id="e", teams_only=True
    )
    assert [r.app for r in teams_rows.rows] == ["msteams"]


def test_dataverse_worker_ensure_users_resolves_bare_guid_name(tmp_path: Path) -> None:
    db = tmp_path / "worker-users.db"
    initialize(db)
    repo = Repository(db)
    bare_id = "6cc1a6af-e4b7-12a7-56b9-a39bd37f242c"
    repo.upsert_users([UserRow(bare_id, None, "Resolved Dataverse User", True, False, False)])

    worker = DataverseCollectorWorker(repo)
    worker._ensure_users({f"dataverse:{bare_id}": f"dataverse:{bare_id}"})

    users = {user.id: user for user in repo.list_all_users()}
    assert users[f"dataverse:{bare_id}"].display_name == "Resolved Dataverse User"


def test_parse_conversation_transcript_empty_and_invalid() -> None:
    assert parse_conversation_transcript(
        "", transcript_id="t", environment_id="e"
    ).rows == []
    assert parse_conversation_transcript(
        "not json", transcript_id="t", environment_id="e"
    ).rows == []
    assert parse_conversation_transcript(
        {"activities": []}, transcript_id="t", environment_id="e"
    ).rows == []


# --------------------------------------------------------------------------
# HTTP client (mocked transport)
# --------------------------------------------------------------------------


def _client_with_handler(handler) -> DataverseClient:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    return DataverseClient(lambda _url: "fake-token", http_client=http)


def test_client_discover_environments() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "globaldisco" in str(request.url)
        assert request.headers["Authorization"] == "Bearer fake-token"
        return httpx.Response(
            200,
            json={"value": [{"Id": "env-1", "ApiUrl": "https://org1.crm.dynamics.com"}]},
        )

    client = _client_with_handler(handler)
    envs = client.discover_environments()
    assert envs[0].url == "https://org1.crm.dynamics.com"
    client.close()


def test_client_fetch_transcript_rows_follows_paging() -> None:
    page2_url = "https://org1.crm.dynamics.com/api/data/v9.2/conversationtranscripts?$skiptoken=2"
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if "skiptoken" not in str(request.url):
            return httpx.Response(
                200,
                json={
                    "value": [
                        {
                            "conversationtranscriptid": "t-1",
                            "content": json.dumps(_teams_transcript()),
                        }
                    ],
                    "@odata.nextLink": page2_url,
                },
            )
        return httpx.Response(
            200,
            json={
                "value": [
                    {
                        "conversationtranscriptid": "t-2",
                        "content": json.dumps(_teams_transcript()),
                    }
                ]
            },
        )

    client = _client_with_handler(handler)
    env = DataverseEnvironment(id="env-1", url="https://org1.crm.dynamics.com")
    parsed = client.fetch_transcript_rows(env, since="2024-01-01T00:00:00Z")
    # Two transcripts × two turns each.
    assert len(parsed.rows) == 4
    assert len(calls) == 2
    # The first request carries the createdon filter.
    assert "createdon" in calls[0]
    client.close()


def test_client_raises_on_http_error() -> None:
    from copilot_watchtower.services.dataverse import DataverseError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="forbidden")

    client = _client_with_handler(handler)
    with pytest.raises(DataverseError) as exc:
        client.discover_environments()
    assert exc.value.status == 403
    client.close()


# --------------------------------------------------------------------------
# Repository persistence + threading
# --------------------------------------------------------------------------


@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


def test_repository_persists_dataverse_interactions_and_threads(repo: Repository) -> None:
    repo.upsert_users(
        [UserRow("dataverse:aad-jin", None, "Jin", True, False, False)]
    )
    parsed = parse_conversation_transcript(
        _teams_transcript(), transcript_id="t-1", environment_id="env-1"
    )
    assert repo.upsert_interactions(parsed.rows) == 2

    # Dataverse rows must not leak into the default (api) source views.
    assert repo.total_interactions(source_type="api") == 0
    rows = repo.interactions_for_user("dataverse:aad-jin", source_type=SOURCE_DATAVERSE)
    assert len(rows) == 2

    user = UserRow("dataverse:aad-jin", None, "Jin", True, False, False)
    n = recompute_threads_for_user(repo, user, source_type=SOURCE_DATAVERSE)
    assert n == 1
    threads = repo.list_threads(source_type=SOURCE_DATAVERSE)
    assert len(threads) == 1
    assert threads[0].source_type == SOURCE_DATAVERSE


def test_repair_dataverse_attribution_fixes_unknown_users(repo: Repository) -> None:
    from copilot_watchtower.services.dataverse import repair_dataverse_attribution

    # Simulate the old bug: every turn stored as a user prompt owned by the
    # placeholder ``dataverse:unknown`` user, with the integer role enum kept
    # verbatim in raw_json. A Graph-collected directory row carries the real
    # display name for the AAD id.
    repo.upsert_users(
        [
            UserRow("dataverse:unknown", None, "알 수 없는 사용자", True, False, False),
            UserRow("aad-int-user", "jin@contoso.com", "진 사용자", True, True, True),
        ]
    )

    def _raw(activity: dict) -> str:
        return json.dumps(
            {
                "source": "dataverse",
                "environment_id": "env-1",
                "agent_id": None,
                "channel_id": "msteams",
                "activity": activity,
            },
            ensure_ascii=False,
        )

    bot_activity = {
        "type": "message",
        "id": "b1",
        "channelId": "msteams",
        "from": {"id": "bot-29", "role": 0},
        "conversation": {"id": "conv-int"},
        "text": "안녕하세요",
    }
    user_activity = {
        "type": "message",
        "id": "u1",
        "channelId": "msteams",
        "from": {"id": "29:user", "role": 1, "aadObjectId": "aad-int-user"},
        "conversation": {"id": "conv-int"},
        "text": "사과 판매량 합은?",
    }
    from copilot_watchtower.db.repository import InteractionRow

    repo.upsert_interactions(
        [
            InteractionRow(
                id="dataverse:t-int:b1:0",
                user_id="dataverse:unknown",
                session_id="conv-int",
                request_id="b1",
                created_at="2025-05-21T05:49:27Z",
                interaction_type=USER_PROMPT,
                app="msteams",
                body_text="안녕하세요",
                body_content_type="text",
                attachments_json=None,
                raw_json=_raw(bot_activity),
                fetched_at="2025-05-22T00:00:00Z",
                source_type=SOURCE_DATAVERSE,
            ),
            InteractionRow(
                id="dataverse:t-int:u1:1",
                user_id="dataverse:unknown",
                session_id="conv-int",
                request_id="u1",
                created_at="2025-05-21T05:49:40Z",
                interaction_type=USER_PROMPT,
                app="msteams",
                body_text="사과 판매량 합은?",
                body_content_type="text",
                attachments_json=None,
                raw_json=_raw(user_activity),
                fetched_at="2025-05-22T00:00:00Z",
                source_type=SOURCE_DATAVERSE,
            ),
        ]
    )

    updated = repair_dataverse_attribution(repo)
    assert updated == 2

    # Both turns now belong to the AAD-identified human; the bot turn is
    # reclassified as an AI response.
    rows = repo.interactions_for_user(
        "dataverse:aad-int-user", source_type=SOURCE_DATAVERSE
    )
    assert len(rows) == 2
    by_id = {r.id: r for r in rows}
    assert by_id["dataverse:t-int:b1:0"].interaction_type == AI_RESPONSE
    assert by_id["dataverse:t-int:u1:1"].interaction_type == USER_PROMPT
    # No turns remain on the placeholder user.
    assert repo.interactions_for_user(
        "dataverse:unknown", source_type=SOURCE_DATAVERSE
    ) == []
    # A thread is rebuilt for the corrected user with a resolved display name.
    threads = repo.list_threads(source_type=SOURCE_DATAVERSE)
    assert len(threads) == 1
    assert threads[0].user_id == "dataverse:aad-int-user"


# --------------------------------------------------------------------------
# Browser token capture: MSAL localStorage fallback
# --------------------------------------------------------------------------


def test_extract_tokens_from_storage_maps_per_host() -> None:
    storage = {
        "uid.utid-login.windows.net-accesstoken-cid-tid-https://org1.crm.dynamics.com/.default": json.dumps(
            {
                "secret": "org1-token",
                "target": "https://org1.crm.dynamics.com/.default",
                "realm": "tid",
            }
        ),
        "uid.utid-login.windows.net-accesstoken-cid-tid-https://globaldisco.crm.dynamics.com/.default": json.dumps(
            {
                "secret": "disco-token",
                "target": "https://globaldisco.crm.dynamics.com/user_impersonation",
            }
        ),
        "msal.account.keys": json.dumps({"some": "unrelated"}),
        "graph-token": json.dumps(
            {"secret": "graph", "target": "https://graph.microsoft.com/.default"}
        ),
    }

    tokens = extract_dataverse_tokens_from_storage(storage)

    assert tokens == {
        "org1.crm.dynamics.com": "org1-token",
        "globaldisco.crm.dynamics.com": "disco-token",
    }


def test_extract_tokens_from_storage_ignores_invalid_blobs() -> None:
    storage = {
        "x-crm.dynamics.com": "not-json",
        "y-crm.dynamics.com": json.dumps({"target": "https://o.crm.dynamics.com"}),
        "z": json.dumps({"secret": "tok", "target": "https://o.crm.dynamics.com/.default"}),
    }

    tokens = extract_dataverse_tokens_from_storage(storage)

    assert tokens == {"o.crm.dynamics.com": "tok"}


def test_extract_tokens_from_storage_captures_regional_hosts() -> None:
    # Non-North-America environments live on numbered hosts such as
    # ``crm21.dynamics.com`` (Korea). The substring ``crm.dynamics.com`` is NOT
    # present in those hosts, so the matcher must use the ``.dynamics.com``
    # suffix or these tokens are silently dropped.
    storage = {
        "uid-accesstoken-https://org9643f6c5.crm21.dynamics.com/.default": json.dumps(
            {
                "secret": "kor-token",
                "target": "https://org9643f6c5.crm21.dynamics.com/.default",
            }
        ),
        "uid-accesstoken-https://org5.crm5.dynamics.com/.default": json.dumps(
            {
                "secret": "apac-token",
                "target": "https://org5.crm5.dynamics.com/.default",
            }
        ),
    }

    tokens = extract_dataverse_tokens_from_storage(storage)

    assert tokens == {
        "org9643f6c5.crm21.dynamics.com": "kor-token",
        "org5.crm5.dynamics.com": "apac-token",
    }


def test_captured_tokens_org_hosts_includes_regional_excludes_discovery() -> None:
    captured = CapturedDataverseTokens(
        {
            "org9643f6c5.crm21.dynamics.com": "kor",
            "org1.crm.dynamics.com": "na",
            "globaldisco.crm.dynamics.com": "disco",
            "api.bap.microsoft.com": "bap",
        }
    )
    assert set(captured.org_hosts) == {
        "org9643f6c5.crm21.dynamics.com",
        "org1.crm.dynamics.com",
    }


def test_captured_tokens_token_for_matches_host_then_falls_back() -> None:
    captured = CapturedDataverseTokens(
        {"org1.crm.dynamics.com": "t1", "org2.crm.dynamics.com": "t2"}
    )
    assert captured.token_for("https://org2.crm.dynamics.com/api/data/v9.2/x") == "t2"
    assert captured.token_for("https://other.crm.dynamics.com/api") in {"t1", "t2"}


def test_captured_tokens_token_for_raises_when_empty() -> None:
    captured = CapturedDataverseTokens({})
    with pytest.raises(DataverseBrowserError):
        captured.token_for("https://org1.crm.dynamics.com/api")


def test_captured_tokens_org_hosts_excludes_discovery() -> None:
    captured = CapturedDataverseTokens(
        {
            "globaldisco.crm.dynamics.com": "disco",
            "org1.crm.dynamics.com": "t1",
            "org2.crm.dynamics.com": "t2",
        }
    )
    assert sorted(captured.org_hosts) == [
        "org1.crm.dynamics.com",
        "org2.crm.dynamics.com",
    ]


# --------------------------------------------------------------------------
# BAP environment enumeration
# --------------------------------------------------------------------------


def test_parse_bap_environments_json_extracts_org_and_skips_no_instance() -> None:
    data = {
        "value": [
            {
                "name": "11111111-1111-1111-1111-111111111111",
                "properties": {
                    "displayName": "Contoso (default)",
                    "linkedEnvironmentMetadata": {
                        # instanceApiUrl carries the full Web API root; we must
                        # normalise it back to the org origin.
                        "instanceApiUrl": "https://org1.crm.dynamics.com/api/data/v9.2/",
                        "instanceUrl": "https://org1.crm.dynamics.com/",
                    },
                },
            },
            {
                # No linked Dataverse instance → no transcripts → skipped.
                "name": "22222222-2222-2222-2222-222222222222",
                "properties": {"displayName": "Teams-only env"},
            },
            {
                "name": "33333333-3333-3333-3333-333333333333",
                "properties": {
                    "displayName": "Fabrikam",
                    "linkedEnvironmentMetadata": {
                        "instanceApiUrl": "https://org3.crm.dynamics.com/api/data/v9.2/",
                    },
                },
            },
        ]
    }
    envs = parse_bap_environments_json(data)
    assert [e.url for e in envs] == [
        "https://org1.crm.dynamics.com",
        "https://org3.crm.dynamics.com",
    ]
    assert envs[0].id == "11111111-1111-1111-1111-111111111111"
    assert envs[0].friendly_name == "Contoso (default)"


def test_parse_bap_environments_json_captures_sku() -> None:
    data = {
        "value": [
            {
                "name": "aaaa",
                "properties": {
                    "displayName": "Prod",
                    "environmentSku": "Production",
                    "linkedEnvironmentMetadata": {
                        "instanceUrl": "https://org1.crm.dynamics.com/",
                    },
                },
            },
            {
                "name": "bbbb",
                "properties": {
                    "displayName": "My Dev",
                    "environmentSku": "Developer",
                    "linkedEnvironmentMetadata": {
                        "instanceUrl": "https://org2.crm.dynamics.com/",
                    },
                },
            },
        ]
    }
    envs = parse_bap_environments_json(data)
    skus = {e.friendly_name: e.sku for e in envs}
    assert skus == {"Prod": "Production", "My Dev": "Developer"}


def test_fetch_bap_environments_uses_token_and_parses() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "api.bap.microsoft.com" in str(request.url)
        assert request.headers["Authorization"] == "Bearer bap-token"
        return httpx.Response(
            200,
            json={
                "value": [
                    {
                        "name": "env-1",
                        "properties": {
                            "displayName": "Contoso",
                            "linkedEnvironmentMetadata": {
                                "instanceUrl": "https://org1.crm.dynamics.com/"
                            },
                        },
                    }
                ]
            },
        )

    http = httpx.Client(transport=httpx.MockTransport(handler))
    envs = fetch_bap_environments("bap-token", http_client=http)
    assert envs[0].url == "https://org1.crm.dynamics.com"
    assert envs[0].id == "env-1"
    http.close()


def test_fetch_bap_environments_raises_on_error() -> None:
    from copilot_watchtower.services.dataverse import DataverseError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(DataverseError) as exc:
        fetch_bap_environments("bap-token", http_client=http)
    assert exc.value.status == 401


# --------------------------------------------------------------------------
# Opt-in "add myself as system administrator" via the admin center
# --------------------------------------------------------------------------


class _FakeLocator:
    """Minimal stand-in for a Playwright locator used by ``try_self_add_as_admin``."""

    def __init__(self, matches: int, recorder: list[str], tag: str) -> None:
        self._matches = matches
        self._recorder = recorder
        self._tag = tag

    def count(self) -> int:
        return self._matches

    @property
    def first(self) -> "_FakeLocator":
        return self

    def click(self, timeout: int | None = None) -> None:  # noqa: ARG002
        self._recorder.append(self._tag)


class _FakePage:
    """Fake page that exposes buttons whose accessible name is in ``buttons``."""

    def __init__(self, buttons: set[str], *, goto_raises: bool = False) -> None:
        self._buttons = buttons
        self._goto_raises = goto_raises
        self.clicks: list[str] = []
        self.last_url: str | None = None

    def goto(self, url: str, *, timeout: int | None = None, wait_until: str | None = None) -> None:  # noqa: ARG002
        if self._goto_raises:
            raise RuntimeError("navigation blocked")
        self.last_url = url

    def wait_for_load_state(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003, ARG002
        return None

    def wait_for_timeout(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003, ARG002
        return None

    def get_by_role(self, role: str, *, name: str, exact: bool = True) -> _FakeLocator:  # noqa: ARG002
        return _FakeLocator(1 if name in self._buttons else 0, self.clicks, f"role:{name}")

    def get_by_text(self, text: str, *, exact: bool = True) -> _FakeLocator:  # noqa: ARG002
        return _FakeLocator(1 if text in self._buttons else 0, self.clicks, f"text:{text}")


def test_try_self_add_as_admin_clicks_korean_button_and_navigates() -> None:
    page = _FakePage(buttons={"나 추가", "추가"})
    logs: list[str] = []

    added = try_self_add_as_admin(
        page, env_id="env-1", label="prod kr", on_log=logs.append
    )

    assert added is True
    assert page.last_url is not None and "env-1" in page.last_url
    assert "role:나 추가" in page.clicks  # the add-myself button was clicked
    assert any("시스템 관리자로 추가" in line for line in logs)


def test_try_self_add_as_admin_returns_false_when_button_absent() -> None:
    page = _FakePage(buttons=set())
    logs: list[str] = []

    added = try_self_add_as_admin(
        page, env_id="env-2", label="dev kr", on_log=logs.append
    )

    assert added is False
    assert page.clicks == []
    assert any("찾지 못했습니다" in line for line in logs)


def test_try_self_add_as_admin_returns_false_when_navigation_fails() -> None:
    page = _FakePage(buttons={"나 추가"}, goto_raises=True)

    added = try_self_add_as_admin(page, env_id="env-3", label="env3")

    assert added is False
    assert page.clicks == []


def test_captured_tokens_bap_token_and_org_hosts_excludes_bap() -> None:
    captured = CapturedDataverseTokens(
        {
            "api.bap.microsoft.com": "bap",
            "org1.crm.dynamics.com": "t1",
        }
    )
    assert captured.bap_token == "bap"
    # The BAP host is not a Dataverse org and must not be collected as one.
    assert captured.org_hosts == ["org1.crm.dynamics.com"]

