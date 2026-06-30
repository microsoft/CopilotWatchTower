"""Markdown rendering helpers for export pipelines.

These helpers used to live inside the PySide ``ConversationThreadsView``;
they were pulled out so the export pipeline does not depend on the GUI
package, and so the new web shell can reuse the same formatter.
"""
from __future__ import annotations

from ..db import InteractionRow, ThreadRow
from ..i18n import translate
from ..interaction_rendering import interaction_display_text
from ..services.threading_engine import TurnInput, pair_turns
from ..time_format import format_kst


def render_thread_markdown(thread: ThreadRow, turns: list[InteractionRow]) -> str:
    """Render a thread + its turns as plain Markdown."""
    by_turn = {turn.id: turn for turn in turns}
    lines: list[str] = []
    lines.append(f"# {thread.title or translate('export.untitled')}")
    lines.append("")
    lines.append(f"- {translate('export.user')}: {thread.display_name or thread.upn or thread.user_id}")
    lines.append(f"- {translate('export.app')}: {thread.app or '-'}")
    lines.append(
        f"- {translate('export.period')}: {format_kst(thread.started_at)} ~ {format_kst(thread.ended_at)}"
    )
    lines.append(
        f"- {translate('export.turns', turns=thread.turn_count, prompts=thread.prompt_count, responses=thread.response_count)}"
    )
    lines.append("")
    pairs = pair_turns(
        [
            TurnInput(
                id=t.id,
                user_id=t.user_id,
                session_id=t.session_id,
                request_id=t.request_id,
                created_at=t.created_at,
                interaction_type=t.interaction_type,
                app=t.app,
                body_text=t.body_text,
            )
            for t in turns
        ]
    )
    for idx, pair in enumerate(pairs, start=1):
        if pair.prompt is not None:
            lines.append(
                f"## Turn {idx} — {translate('export.turnUser')} [{format_kst(pair.prompt.created_at)}]"
            )
            lines.append("")
            lines.append(interaction_display_text(by_turn[pair.prompt.id]).rstrip())
            lines.append("")
        if pair.response is not None:
            lines.append(
                f"### {translate('export.copilotResponseHeading')} [{format_kst(pair.response.created_at)}]"
            )
            lines.append("")
            lines.append(interaction_display_text(by_turn[pair.response.id]).rstrip())
            lines.append("")
    return "\n".join(lines)
