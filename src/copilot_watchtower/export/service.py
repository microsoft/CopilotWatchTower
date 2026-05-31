"""Export interactions to CSV / JSON / XLSX, and threads to MD / HTML / JSON."""
from __future__ import annotations

import csv
import html
import json
import logging
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path

from ..db import InteractionRow, Repository, ThreadRow
from ..interaction_rendering import interaction_display_text
from ..time_format import format_kst

log = logging.getLogger(__name__)


_COLUMNS = [
    "id",
    "user_id",
    "session_id",
    "request_id",
    "created_at",
    "interaction_type",
    "app",
    "body_text",
    "body_content_type",
    "attachments_json",
    "fetched_at",
]


def export_csv(rows: Iterable[InteractionRow], path: Path) -> int:
    n = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            d = asdict(row)
            d.pop("raw_json", None)
            writer.writerow(d)
            n += 1
    return n


def export_json(rows: Iterable[InteractionRow], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    for row in rows:
        d = asdict(row)
        # Re-parse raw_json so the output is hierarchical instead of a string blob.
        if d.get("raw_json"):
            try:
                d["raw_json"] = json.loads(d["raw_json"])
            except json.JSONDecodeError:
                pass
        if d.get("attachments_json"):
            try:
                d["attachments_json"] = json.loads(d["attachments_json"])
            except json.JSONDecodeError:
                pass
        items.append(d)
    path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(items)


def export_xlsx(rows: Iterable[InteractionRow], path: Path) -> int:
    from openpyxl import Workbook

    path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("interactions")
    ws.append(_COLUMNS)
    n = 0
    for row in rows:
        d = asdict(row)
        ws.append([d.get(col) for col in _COLUMNS])
        n += 1
    wb.save(path)
    return n


def export(rows: Iterable[InteractionRow], path: Path) -> int:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return export_csv(rows, path)
    if suffix == ".json":
        return export_json(rows, path)
    if suffix in {".xlsx", ".xlsm"}:
        return export_xlsx(rows, path)
    raise ValueError(f"Unsupported export format: {suffix}")


# ---- thread exporters --------------------------------------------------

# These are the user-facing artefact formats for the chat-thread view.
# The ConversationThreadsView pulls these via the export view when the
# user picks "스레드 내보내기".


def export_thread_markdown(
    repo: Repository, threads: Iterable[ThreadRow], path: Path
) -> int:
    """Concatenate Markdown renderings of multiple threads into one file.

    Each thread is separated by an ``---`` horizontal rule so the output
    stays readable as a single document.
    """
    # Local import avoids importing PySide6 from a headless export path.
    from .markdown import render_thread_markdown

    path.parent.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []
    n = 0
    for t in threads:
        turns = repo.thread_turns(t.id)
        parts.append(render_thread_markdown(t, turns))
        parts.append("\n---\n")
        n += 1
    path.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")
    return n


def export_thread_json(
    repo: Repository, threads: Iterable[ThreadRow], path: Path
) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: list[dict] = []
    n = 0
    for t in threads:
        turns = repo.thread_turns(t.id)
        payload.append(
            {
                "id": t.id,
                "user_id": t.user_id,
                "display_name": t.display_name,
                "upn": t.upn,
                "started_at": t.started_at,
                "ended_at": t.ended_at,
                "app": t.app,
                "turn_count": t.turn_count,
                "prompt_count": t.prompt_count,
                "response_count": t.response_count,
                "title": t.title,
                "session_ids": t.session_ids,
                "turns": [
                    {
                        "id": x.id,
                        "created_at": x.created_at,
                        "interaction_type": x.interaction_type,
                        "app": x.app,
                        "session_id": x.session_id,
                        "request_id": x.request_id,
                        "body_text": x.body_text,
                    }
                    for x in turns
                ],
            }
        )
        n += 1
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return n


def export_thread_html(
    repo: Repository, threads: Iterable[ThreadRow], path: Path
) -> int:
    """Render threads as a single self-contained HTML document.

    Output uses inline CSS so the file is portable (email attachment,
    SharePoint upload, etc.) and renders as a chat transcript.
    """
    from ..services.threading_engine import TurnInput, pair_turns

    path.parent.mkdir(parents=True, exist_ok=True)
    css = (
        "body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#0f172a;}"
        "h1.thread{font-size:18px;margin:24px 0 4px;}"
        ".meta{color:#475569;font-size:12px;margin-bottom:12px;}"
        ".transcript{display:flex;flex-direction:column;gap:8px;max-width:780px;}"
        ".bubble{padding:10px 14px;border-radius:12px;max-width:70%;"
        "white-space:pre-wrap;word-wrap:break-word;font-size:13px;}"
        ".prompt{background:#2563eb;color:#fff;align-self:flex-end;}"
        ".response{background:#f1f5f9;color:#0f172a;align-self:flex-start;}"
        ".turn-meta{font-size:10px;color:#94a3b8;margin-top:4px;}"
        "hr.thread-sep{border:none;border-top:1px dashed #cbd5e1;margin:32px 0;}"
    )
    out: list[str] = []
    out.append("<!doctype html><html><head><meta charset='utf-8'>")
    out.append(f"<style>{css}</style>")
    out.append("<title>CopilotWatchTower — Threads</title></head><body>")
    n = 0
    for idx, t in enumerate(threads):
        if idx > 0:
            out.append("<hr class='thread-sep'>")
        out.append(f"<h1 class='thread'>{html.escape(t.title or '(제목 없음)')}</h1>")
        meta = (
            f"사용자: {html.escape(t.display_name or t.upn or t.user_id)} · "
            f"앱: {html.escape(t.app or '-')} · "
            f"기간 (KST): {html.escape(format_kst(t.started_at))} ~ {html.escape(format_kst(t.ended_at))} · "
            f"턴: {t.turn_count} (질문 {t.prompt_count} / 응답 {t.response_count})"
        )
        out.append(f"<div class='meta'>{meta}</div>")
        out.append("<div class='transcript'>")
        turns = repo.thread_turns(t.id)
        by_turn = {turn.id: turn for turn in turns}
        pairs = pair_turns(
            [
                TurnInput(
                    id=x.id,
                    user_id=x.user_id,
                    session_id=x.session_id,
                    request_id=x.request_id,
                    created_at=x.created_at,
                    interaction_type=x.interaction_type,
                    app=x.app,
                    body_text=x.body_text,
                )
                for x in turns
            ]
        )
        for pair in pairs:
            for side_obj, side in ((pair.prompt, "prompt"), (pair.response, "response")):
                if side_obj is None:
                    continue
                source_row = by_turn.get(side_obj.id)
                body = html.escape(interaction_display_text(source_row) if source_row else side_obj.body_text or "")
                turn_meta = f"{html.escape(side_obj.app or '-')} · {html.escape(format_kst(side_obj.created_at))}"
                out.append(
                    f"<div class='bubble {side}'>{body}"
                    f"<div class='turn-meta'>{turn_meta}</div></div>"
                )
        out.append("</div>")
        n += 1
    out.append("</body></html>")
    path.write_text("".join(out), encoding="utf-8")
    return n


def export_threads(
    repo: Repository, threads: Iterable[ThreadRow], path: Path
) -> int:
    """Dispatch helper that picks an exporter from the file suffix."""
    suffix = path.suffix.lower()
    threads_list = list(threads)
    if suffix == ".md":
        return export_thread_markdown(repo, threads_list, path)
    if suffix == ".html" or suffix == ".htm":
        return export_thread_html(repo, threads_list, path)
    if suffix == ".json":
        return export_thread_json(repo, threads_list, path)
    raise ValueError(f"Unsupported thread export format: {suffix}")
