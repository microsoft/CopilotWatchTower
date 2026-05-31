"""Tests for the conversation threading engine.

These exercise the three layers independently:
  * tokenisation + stopword removal
  * prompt/response pairing (request_id and chronological fallback)
  * session/topic clustering against the locked-in defaults

The engine is dependency-free, so tests use plain ``TurnInput`` lists.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from copilot_watchtower.services import threading_engine as te


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _turn(
    idx: int,
    *,
    user: str = "u1",
    session: str | None = "s1",
    request: str | None = None,
    type_: str = "userPrompt",
    text: str = "",
    minute: int = 0,
    app: str = "BizChat",
) -> te.TurnInput:
    base = datetime(2025, 1, 1, 9, 0, 0, tzinfo=timezone.utc)
    return te.TurnInput(
        id=f"i{idx}",
        user_id=user,
        session_id=session,
        request_id=request,
        created_at=_iso(base + timedelta(minutes=minute)),
        interaction_type=type_,
        app=app,
        body_text=text,
    )


# ---- tokenisation / similarity -----------------------------------------


def test_tokenize_strips_stopwords_and_short_tokens() -> None:
    tokens = te.tokenize("Please summarize the Q3 report for me, thanks!")
    assert "summarize" in tokens
    assert "report" in tokens
    assert "please" not in tokens
    assert "thanks" not in tokens
    assert "for" not in tokens


def test_tokenize_handles_korean() -> None:
    tokens = te.tokenize("분기별 매출 보고서를 작성해 주세요")
    assert "분기별" in tokens
    assert "매출" in tokens
    assert "보고서를" in tokens or "보고서" in tokens
    assert "주세요" not in tokens  # stopword


def test_jaccard_basic() -> None:
    assert te.jaccard(["a", "b"], ["a", "b"]) == 1.0
    assert te.jaccard(["a", "b"], ["c", "d"]) == 0.0
    assert te.jaccard(["a", "b", "c"], ["b", "c", "d"]) == pytest.approx(0.5)


# ---- pair_turns --------------------------------------------------------


def test_pair_turns_uses_request_id_when_available() -> None:
    turns = [
        _turn(1, type_="userPrompt", request="r1", minute=0, text="hello"),
        _turn(2, type_="userPrompt", request="r2", minute=1, text="follow up"),
        _turn(3, type_="aiResponse", request="r2", minute=2, text="reply2"),
        _turn(4, type_="aiResponse", request="r1", minute=3, text="reply1"),
    ]
    pairs = te.pair_turns(turns)
    # All four turns must surface in exactly two pairs (no halves).
    assert len(pairs) == 2
    by_prompt = {p.prompt.id: p.response.id for p in pairs if p.prompt and p.response}
    assert by_prompt["i1"] == "i4"
    assert by_prompt["i2"] == "i3"


def test_pair_turns_falls_back_to_chronology() -> None:
    turns = [
        _turn(1, type_="userPrompt", minute=0, text="q1"),
        _turn(2, type_="aiResponse", minute=1, text="a1"),
        _turn(3, type_="userPrompt", minute=5, text="q2"),
        _turn(4, type_="aiResponse", minute=6, text="a2"),
    ]
    pairs = te.pair_turns(turns)
    assert len(pairs) == 2
    assert pairs[0].prompt.id == "i1" and pairs[0].response.id == "i2"
    assert pairs[1].prompt.id == "i3" and pairs[1].response.id == "i4"


def test_pair_turns_orphan_prompt_surfaces_as_half_pair() -> None:
    turns = [
        _turn(1, type_="userPrompt", minute=0, text="q1"),
        _turn(2, type_="userPrompt", minute=1, text="q2"),
        _turn(3, type_="aiResponse", minute=2, text="a2"),
    ]
    pairs = te.pair_turns(turns)
    assert len(pairs) == 2
    # First prompt has no response (it gets pre-empted by the next prompt).
    first = pairs[0]
    second = pairs[1]
    assert first.prompt.id == "i1"
    assert first.response is None
    assert second.prompt.id == "i2"
    assert second.response.id == "i3"


# ---- compute_threads ---------------------------------------------------


def test_compute_threads_groups_by_session() -> None:
    turns = [
        _turn(1, session="sA", text="alpha analytics dashboard"),
        _turn(2, session="sA", type_="aiResponse", text="answer", minute=1),
        _turn(3, session="sB", text="totally unrelated cooking recipe", minute=200),
        _turn(4, session="sB", type_="aiResponse", text="recipe answer", minute=201),
    ]
    threads = te.compute_threads(turns)
    assert len(threads) == 2
    sessions = {tuple(sorted(t.session_ids)) for t in threads}
    assert sessions == {("sA",), ("sB",)}


def test_compute_threads_merges_topic_similar_sessions_within_idle_gap() -> None:
    turns = [
        _turn(1, session="sA", text="quarterly revenue report breakdown"),
        _turn(2, session="sA", type_="aiResponse", minute=1, text="ok"),
        # Same topic, 10 minutes later, different session id: must merge.
        _turn(3, session="sB", minute=11, text="quarterly revenue chart"),
        _turn(4, session="sB", type_="aiResponse", minute=12, text="here"),
    ]
    threads = te.compute_threads(turns)
    assert len(threads) == 1
    t = threads[0]
    assert set(t.session_ids) == {"sA", "sB"}
    assert t.prompt_count == 2
    assert t.response_count == 2
    assert t.turn_count == 4


def test_compute_threads_splits_on_idle_gap_even_when_similar() -> None:
    turns = [
        _turn(1, session="sA", text="quarterly revenue report"),
        _turn(2, session="sA", type_="aiResponse", minute=1, text="ok"),
        # Same topic but 90 minutes later → above 30m idle gap → split.
        _turn(3, session="sB", minute=91, text="quarterly revenue follow up"),
        _turn(4, session="sB", type_="aiResponse", minute=92, text="ok"),
    ]
    threads = te.compute_threads(turns)
    assert len(threads) == 2


def test_compute_threads_splits_on_unrelated_topic_within_window() -> None:
    turns = [
        _turn(1, session="sA", text="quarterly revenue report"),
        _turn(2, session="sB", minute=5, text="kubernetes cluster autoscaling"),
    ]
    threads = te.compute_threads(turns)
    # Same window but Jaccard ~= 0 → two separate threads.
    assert len(threads) == 2


def test_compute_threads_uses_grounding_text_as_topic_signal() -> None:
    turns = [
        _turn(
            1,
            session="sA",
            text="휴가 규정 알려줘",
            minute=0,
        ),
        _turn(
            2,
            session="sB",
            text="근태 기준 설명해줘",
            minute=10,
        ),
    ]
    no_grounding = te.compute_threads(turns)
    assert len(no_grounding) == 2

    enriched = [
        te.TurnInput(**{**turn.__dict__, "grounding_text": "휴가 근태 가이드 docx"})
        for turn in turns
    ]
    with_grounding = te.compute_threads(enriched)
    assert len(with_grounding) == 1
    assert with_grounding[0].topic_keywords == []


def test_compute_threads_extracts_title_without_exposing_keywords() -> None:
    turns = [
        _turn(1, session="sA", text="Summarize the marketing budget proposal"),
        _turn(2, session="sA", type_="aiResponse", minute=1, text="reply"),
        _turn(3, session="sA", minute=2, text="Compare marketing budget to last year"),
    ]
    threads = te.compute_threads(turns)
    assert len(threads) == 1
    t = threads[0]
    assert t.topic_keywords == []
    assert t.title is not None and "Summarize" in t.title


def test_compute_threads_is_idempotent() -> None:
    turns = [
        _turn(1, session="sA", text="alpha report"),
        _turn(2, session="sA", type_="aiResponse", minute=1),
    ]
    a = te.compute_threads(turns)
    b = te.compute_threads(turns)
    assert [t.id for t in a] == [t.id for t in b]


def test_compute_threads_partitions_by_user() -> None:
    turns = [
        _turn(1, user="u1", session="sA", text="shared topic words"),
        _turn(2, user="u2", session="sA", text="shared topic words", minute=1),
    ]
    threads = te.compute_threads(turns)
    # Even with identical sessions/topic, threads must be per-user.
    assert len({t.user_id for t in threads}) == 2
