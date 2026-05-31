from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from copilot_watchtower.config import RuntimeOptions
from copilot_watchtower.db import InteractionRow, Repository, UserRow, initialize
from copilot_watchtower.workers.collector import CollectorWorker


@pytest.fixture()
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


@dataclass
class _Interaction:
    id: str
    created_at: str = "2026-05-22T10:00:00Z"
    session_id: str | None = "s1"
    request_id: str | None = "r1"
    interaction_type: str | None = "userPrompt"
    app: str | None = "BizChat"
    body_text: str | None = "hello"
    body_content_type: str | None = "text"
    attachments: list = None  # type: ignore[assignment]
    links: list = None  # type: ignore[assignment]
    mentions: list = None  # type: ignore[assignment]
    raw: dict = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.attachments = self.attachments or []
        self.links = self.links or []
        self.mentions = self.mentions or []
        self.raw = self.raw or {"id": self.id}


class _Graph:
    def __init__(self, interactions: list[_Interaction]) -> None:
        self.interactions = interactions
        self.seen_since: str | None = None

    def list_interactions(self, user_id: str, since: str | None = None):
        self.seen_since = since
        yield from self.interactions


def test_collector_counts_rechecked_overlap_as_zero_new(repo: Repository) -> None:
    user = UserRow("u1", "u1@x", "User One", True, True, True)
    repo.upsert_users([user])
    repo.upsert_interactions(
        [
            InteractionRow(
                id="i-existing",
                user_id="u1",
                session_id="s1",
                request_id="r1",
                created_at="2026-05-22T10:00:00Z",
                interaction_type="userPrompt",
                app="BizChat",
                body_text="old",
                body_content_type="text",
                attachments_json=None,
                raw_json='{"id":"i-existing"}',
                fetched_at="2026-05-22T10:00:00Z",
            )
        ]
    )
    repo.update_collection_state(
        "u1",
        last_collected_at="2026-05-22T10:00:00Z",
        backfill_complete=True,
    )
    graph = _Graph([_Interaction("i-existing")])
    worker = CollectorWorker(repo, graph, RuntimeOptions())  # type: ignore[arg-type]

    new_count = worker._collect_user(user)

    assert new_count == 0
    assert repo.total_interactions() == 1
    assert graph.seen_since is not None


def test_collector_counts_only_new_overlap_rows(repo: Repository) -> None:
    user = UserRow("u1", "u1@x", "User One", True, True, True)
    repo.upsert_users([user])
    repo.upsert_interactions(
        [
            InteractionRow(
                id="i-existing",
                user_id="u1",
                session_id="s1",
                request_id="r1",
                created_at="2026-05-22T10:00:00Z",
                interaction_type="userPrompt",
                app="BizChat",
                body_text="old",
                body_content_type="text",
                attachments_json=None,
                raw_json='{"id":"i-existing"}',
                fetched_at="2026-05-22T10:00:00Z",
            )
        ]
    )
    graph = _Graph([_Interaction("i-existing"), _Interaction("i-new")])
    worker = CollectorWorker(repo, graph, RuntimeOptions())  # type: ignore[arg-type]

    new_count = worker._collect_user(user)

    assert new_count == 1
    assert repo.total_interactions() == 2