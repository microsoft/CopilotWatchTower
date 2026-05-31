"""Conversation threading + topic/time clustering.

Pure-Python, dependency-free. Builds three layers of grouping on top of
the flat ``interactions`` table:

1. **Session grouping** — interactions sharing a Graph ``session_id`` form
   the atomic unit. NULL session ids are bucketed per-interaction (each
   becomes its own micro-session).
2. **Prompt/response pairing** — within a session, pair ``userPrompt``
   turns with the nearest following ``aiResponse``. If both share a
   ``request_id``, that link is preferred; otherwise the next response
   in chronological order is treated as the answer.
3. **Topic/time clustering** — sessions belonging to the same user are
   merged into a *thread* when both:
     * the idle gap between them is <= :data:`IDLE_GAP_MINUTES`, and
     * the Jaccard similarity of their normalised prompt tokens is
       >= :data:`TOPIC_JACCARD_THRESHOLD`.
   Otherwise a new thread starts. Thread ids are deterministic hashes
   of the (user, sorted session ids) tuple so re-computing is idempotent.

Localised stopwords (English + Korean) keep topic comparison usable on
Korean tenants without bringing in scikit-learn or fastText.
"""
from __future__ import annotations

import hashlib
import logging
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger(__name__)


# ---- Tunables ----------------------------------------------------------
# Centralised so we can move them into the settings table later without
# touching call sites. See `/memories/session/plan.md` Locked-in Defaults.

IDLE_GAP_MINUTES: int = 30
TOPIC_JACCARD_THRESHOLD: float = 0.3
TITLE_MAX_LEN: int = 80
MIN_TOKEN_LEN: int = 2


# Compact stopword lists: enough to remove the most common noise words
# without shipping a full NLP corpus. Korean entries are particle/affix
# style fragments commonly attached to prompts ("을", "는", "에서", ...).
_STOPWORDS_EN: frozenset[str] = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "can",
        "could", "did", "do", "does", "for", "from", "had", "has", "have",
        "he", "her", "him", "his", "how", "i", "if", "in", "into", "is",
        "it", "its", "just", "let", "like", "make", "may", "me", "my",
        "no", "not", "now", "of", "on", "one", "or", "our", "out", "she",
        "should", "so", "some", "than", "that", "the", "their", "them",
        "then", "there", "these", "they", "this", "those", "to", "too",
        "two", "up", "us", "use", "was", "way", "we", "were", "what",
        "when", "where", "which", "who", "why", "will", "with", "would",
        "you", "your", "please", "thanks", "thank",
    }
)

_STOPWORDS_KO: frozenset[str] = frozenset(
    {
        "그리고", "그러나", "그래서", "그런데", "또한", "이것", "그것", "저것",
        "이거", "그거", "저거", "있다", "없다", "하다", "되다", "이다",
        "입니다", "합니다", "있어요", "없어요", "주세요", "해주세요",
        "있는", "없는", "되는", "하는", "그", "이", "저", "수", "것",
        "등", "더", "또", "및", "위해", "대한", "대해", "에서", "에게",
        "으로", "로서", "로써", "에는", "에서는", "까지", "부터", "한테",
        "께서", "보다", "처럼", "같이", "마저", "조차", "라도", "라서",
        "하지만", "그렇지만", "그렇다면", "안녕하세요", "감사합니다",
    }
)


_STOPWORDS: frozenset[str] = _STOPWORDS_EN | _STOPWORDS_KO


# Match Latin words, Korean syllable blocks, and CJK ideographs together.
# Numbers alone get dropped (only-digit tokens) to avoid keyword noise.
_TOKEN_RE = re.compile(r"[A-Za-z]+|[\uac00-\ud7a3]+|[\u4e00-\u9fff]+")


# ---- Data classes ------------------------------------------------------


@dataclass
class TurnInput:
    """Minimal projection of an InteractionRow used by the engine.

    Decoupling from db.InteractionRow keeps the algorithm testable
    without any SQLite fixture (synthetic inputs work directly).
    """

    id: str
    user_id: str
    session_id: Optional[str]
    request_id: Optional[str]
    created_at: str
    interaction_type: Optional[str]
    app: Optional[str]
    body_text: Optional[str]
    grounding_text: Optional[str] = None


@dataclass
class TurnPair:
    """A prompt paired with its answer (either may be ``None``)."""

    prompt: Optional[TurnInput]
    response: Optional[TurnInput]


@dataclass
class ThreadGroup:
    """Computed thread grouping output."""

    id: str
    user_id: str
    started_at: str
    ended_at: str
    app: Optional[str]
    session_ids: list[str]
    interaction_ids: list[str] = field(default_factory=list)
    prompt_count: int = 0
    response_count: int = 0
    turn_count: int = 0
    topic_keywords: list[str] = field(default_factory=list)
    title: Optional[str] = None

    @property
    def computed_at(self) -> str:
        return _iso_now()


# ---- Public API --------------------------------------------------------


def tokenize(text: Optional[str]) -> list[str]:
    """Lowercase, stopword-filter, and tokenize ``text``."""
    if not text:
        return []
    tokens: list[str] = []
    for raw in _TOKEN_RE.findall(text):
        tok = raw.lower()
        if len(tok) < MIN_TOKEN_LEN:
            continue
        if tok in _STOPWORDS:
            continue
        tokens.append(tok)
    return tokens


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    """Set-based Jaccard similarity. Returns 0.0 when both sides empty."""
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 0.0
    return len(sa & sb) / float(len(sa | sb))


def pair_turns(turns: Sequence[TurnInput]) -> list[TurnPair]:
    """Pair ``userPrompt`` and ``aiResponse`` turns within one session.

    Order is by ``created_at`` ASC. Matching strategy:
      1. If two adjacent turns share a ``request_id`` and types align,
         pair them.
      2. Otherwise pair each prompt with the nearest following response
         that has not been claimed yet.
      3. Leftover prompts/responses surface as half-pairs (the other
         side is ``None``) so the UI can still render them.
    """
    ordered = sorted(turns, key=lambda t: t.created_at)
    pairs: list[TurnPair] = []
    used: set[str] = set()

    # Pass 1: explicit request_id pairs.
    request_index: dict[str, list[TurnInput]] = {}
    for t in ordered:
        if t.request_id:
            request_index.setdefault(t.request_id, []).append(t)
    for _rid, group in request_index.items():
        prompts = [t for t in group if (t.interaction_type or "").lower() == "userprompt"]
        responses = [t for t in group if (t.interaction_type or "").lower() == "airesponse"]
        for prompt, response in zip(prompts, responses, strict=False):
            pairs.append(TurnPair(prompt=prompt, response=response))
            used.add(prompt.id)
            used.add(response.id)

    # Pass 2: nearest-following-response for unmatched prompts.
    pending_prompt: TurnInput | None = None
    for t in ordered:
        if t.id in used:
            continue
        kind = (t.interaction_type or "").lower()
        if kind == "userprompt":
            if pending_prompt is not None:
                pairs.append(TurnPair(prompt=pending_prompt, response=None))
            pending_prompt = t
        elif kind == "airesponse":
            if pending_prompt is not None:
                pairs.append(TurnPair(prompt=pending_prompt, response=t))
                pending_prompt = None
            else:
                pairs.append(TurnPair(prompt=None, response=t))
        else:
            # Unknown type — flush any pending prompt and pass the
            # turn through as a lone "prompt" side so it stays visible.
            if pending_prompt is not None:
                pairs.append(TurnPair(prompt=pending_prompt, response=None))
                pending_prompt = None
            pairs.append(TurnPair(prompt=t, response=None))
    if pending_prompt is not None:
        pairs.append(TurnPair(prompt=pending_prompt, response=None))

    pairs.sort(key=_pair_sort_key)
    return pairs


def compute_threads(turns: Sequence[TurnInput]) -> list[ThreadGroup]:
    """Cluster a user's turns into conversation threads.

    The input may span multiple users — they are processed independently
    and their threads returned together (sorted by ``started_at`` DESC).
    """
    by_user: dict[str, list[TurnInput]] = {}
    for t in turns:
        if not t.user_id or not t.created_at:
            continue
        by_user.setdefault(t.user_id, []).append(t)

    out: list[ThreadGroup] = []
    for user_id, user_turns in by_user.items():
        out.extend(_compute_user_threads(user_id, user_turns))
    out.sort(key=lambda g: g.started_at, reverse=True)
    return out


# ---- Internals ---------------------------------------------------------


def _compute_user_threads(user_id: str, turns: Sequence[TurnInput]) -> list[ThreadGroup]:
    # Bucket by session_id; NULL sessions become singletons so they can
    # still be threaded with neighbours by topic/time.
    sessions: dict[str, list[TurnInput]] = {}
    null_counter = 0
    for t in turns:
        if t.session_id:
            sessions.setdefault(t.session_id, []).append(t)
        else:
            null_counter += 1
            sessions[f"__null__{null_counter}__{t.id}"] = [t]

    # Build session summaries (start/end + prompt-token set).
    session_summaries: list[_SessionSummary] = []
    for sid, ts in sessions.items():
        ts.sort(key=lambda x: x.created_at)
        prompt_tokens: set[str] = set()
        first_prompt_text: str | None = None
        app_counter: Counter[str] = Counter()
        prompt_count = 0
        response_count = 0
        for t in ts:
            if t.app:
                app_counter[t.app] += 1
            kind = (t.interaction_type or "").lower()
            if t.grounding_text:
                prompt_tokens.update(tokenize(t.grounding_text))
            if kind == "userprompt":
                prompt_count += 1
                tokens = tokenize(t.body_text)
                prompt_tokens.update(tokens)
                if first_prompt_text is None and t.body_text:
                    first_prompt_text = t.body_text
            elif kind == "airesponse":
                response_count += 1
        session_summaries.append(
            _SessionSummary(
                session_id=sid,
                started_at=ts[0].created_at,
                ended_at=ts[-1].created_at,
                prompt_tokens=prompt_tokens,
                turns=ts,
                first_prompt_text=first_prompt_text,
                dominant_app=app_counter.most_common(1)[0][0] if app_counter else None,
                prompt_count=prompt_count,
                response_count=response_count,
            )
        )

    session_summaries.sort(key=lambda s: s.started_at)

    # Merge adjacent sessions when both idle-gap and topic checks pass.
    clusters: list[list[_SessionSummary]] = []
    for s in session_summaries:
        if not clusters:
            clusters.append([s])
            continue
        prev = clusters[-1][-1]
        gap_min = _minutes_between(prev.ended_at, s.started_at)
        sim = jaccard(prev.prompt_tokens, s.prompt_tokens)
        if (
            gap_min is not None
            and gap_min <= IDLE_GAP_MINUTES
            and sim >= TOPIC_JACCARD_THRESHOLD
        ):
            clusters[-1].append(s)
        else:
            clusters.append([s])

    return [_finalise_thread(user_id, cluster) for cluster in clusters]


@dataclass
class _SessionSummary:
    session_id: str
    started_at: str
    ended_at: str
    prompt_tokens: set[str]
    turns: list[TurnInput]
    first_prompt_text: Optional[str]
    dominant_app: Optional[str]
    prompt_count: int
    response_count: int


def _finalise_thread(user_id: str, cluster: list[_SessionSummary]) -> ThreadGroup:
    started_at = cluster[0].started_at
    ended_at = cluster[-1].ended_at
    session_ids = [c.session_id for c in cluster if not c.session_id.startswith("__null__")]

    interaction_ids: list[str] = []
    app_counter: Counter[str] = Counter()
    title: Optional[str] = None
    prompt_count = 0
    response_count = 0
    for s in cluster:
        prompt_count += s.prompt_count
        response_count += s.response_count
        if s.dominant_app:
            app_counter[s.dominant_app] += len(s.turns)
        for t in s.turns:
            interaction_ids.append(t.id)
            if (t.interaction_type or "").lower() == "userprompt":
                if title is None and t.body_text:
                    title = _trim_title(t.body_text)
    if title is None:
        # No prompts at all — fall back to first response body.
        for s in cluster:
            for t in s.turns:
                if t.body_text:
                    title = _trim_title(t.body_text)
                    break
            if title is not None:
                break

    thread_id = _make_thread_id(user_id, session_ids or [str(t) for t in interaction_ids])

    return ThreadGroup(
        id=thread_id,
        user_id=user_id,
        started_at=started_at,
        ended_at=ended_at,
        app=app_counter.most_common(1)[0][0] if app_counter else None,
        session_ids=session_ids,
        interaction_ids=interaction_ids,
        prompt_count=prompt_count,
        response_count=response_count,
        turn_count=prompt_count + response_count,
        topic_keywords=[],
        title=title,
    )


def _make_thread_id(user_id: str, parts: list[str]) -> str:
    h = hashlib.sha1()  # not security-sensitive; just a stable digest
    h.update(user_id.encode("utf-8"))
    for p in sorted(parts):
        h.update(b"\x1f")
        h.update(p.encode("utf-8"))
    return f"thr_{h.hexdigest()[:32]}"


def _trim_title(text: str) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= TITLE_MAX_LEN:
        return cleaned
    return cleaned[: TITLE_MAX_LEN - 1] + "\u2026"


def _pair_sort_key(p: TurnPair) -> str:
    if p.prompt is not None:
        return p.prompt.created_at
    if p.response is not None:
        return p.response.created_at
    return ""


def _parse_iso(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _minutes_between(end_iso: str, start_iso: str) -> Optional[float]:
    a = _parse_iso(end_iso)
    b = _parse_iso(start_iso)
    if a is None or b is None:
        return None
    delta = (b - a).total_seconds() / 60.0
    return max(0.0, delta)


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
