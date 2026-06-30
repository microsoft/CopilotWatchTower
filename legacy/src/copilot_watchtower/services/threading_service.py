"""Shared conversation-thread recomputation.

Both the live collector and the eDiscovery collector rebuild a user's
``conversation_threads`` rows from their current interactions using an
identical sequence (delete -> compute -> upsert -> assign). The backup
restore flow needs the same logic. This module hosts the single
implementation so all three callers stay consistent.
"""

from __future__ import annotations

import logging

from ..db import Repository, UserRow
from .thread_audit_enrichment import build_grounding_text_map
from .threading_engine import TurnInput, compute_threads

log = logging.getLogger(__name__)


def recompute_threads_for_user(
    repo: Repository, user: UserRow, *, source_type: str
) -> int:
    """Rebuild ``conversation_threads`` for one user and source.

    Always recomputes the full set for the user so cross-batch merges
    stay consistent. The work is local — no Graph calls. Returns the
    number of threads written.
    """
    interactions = repo.interactions_for_user(user.id, source_type=source_type)
    grounding_map = build_grounding_text_map(
        interactions, repo.audit_events_for_user(user.id, user.upn)
    )
    turns = [
        TurnInput(
            id=i.id,
            user_id=i.user_id,
            session_id=i.session_id,
            request_id=i.request_id,
            created_at=i.created_at,
            interaction_type=i.interaction_type,
            app=i.app,
            body_text=i.body_text,
            grounding_text=grounding_map.get(i.id),
        )
        for i in interactions
    ]
    threads = compute_threads(turns, source_type=source_type)
    # Replace prior thread set: drop the user's threads, insert fresh,
    # then stamp interactions with their new thread_id.
    repo.delete_user_threads(user.id, source_type=source_type)
    if threads:
        repo.upsert_threads(threads, source_type=source_type)
        mapping: list[tuple[str, str]] = []
        for t in threads:
            for iid in t.interaction_ids:
                mapping.append((iid, t.id))
        if mapping:
            repo.assign_threads_to_interactions(mapping)
    return len(threads)


def recompute_threads_for_all_users(repo: Repository, *, source_type: str) -> int:
    """Recompute threads for every user that has interactions of ``source_type``.

    Returns the total number of threads written across all users.
    """
    total = 0
    for user in repo.users_with_interactions(source_type=source_type):
        try:
            total += recompute_threads_for_user(repo, user, source_type=source_type)
        except Exception:  # noqa: BLE001 — one bad user must not abort the rest
            log.exception(
                "Thread re-compute failed for user %s (source=%s)",
                user.id,
                source_type,
            )
    return total
