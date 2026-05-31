"""Parse Microsoft Purview eDiscovery export packages into interaction turns.

The non-premium eDiscovery experience does not expose review-set items
through Graph, so collection must download the *export package* and parse
it locally. Export packages are ZIP archives whose layout varies by
tenant/format, so this parser is intentionally tolerant: it walks every
entry and recognises the formats we can decode without heavy native
dependencies:

* ``.msg`` — the format we request from Graph (``exportFormat="msg"``);
  one Outlook item per message, parsed with :mod:`extract_msg`. The
  dependency is shipped with the app; if it is somehow missing the entry
  is skipped with a warning.
* ``.eml`` — parsed with the Python standard-library :mod:`email` parser
  (legacy/deprecated export format, still handled for resilience).
* ``.json`` / ``.jsonl`` — a normalised line/array form
  (``{conversationId, createdDateTime, prompt, response, app}``) used when
  the upstream flow has already shaped Copilot items; also the format our
  tests exercise.

Each recognised item is reconstructed into ordered prompt/response turns
so the existing threading engine groups them exactly like license-based
Copilot interactions.
"""
from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import message_from_bytes
from email.utils import parsedate_to_datetime
from typing import Any

from ..db import InteractionRow

log = logging.getLogger(__name__)

ProgressCb = Callable[[str], None]

USER_PROMPT = "userPrompt"
AI_RESPONSE = "aiResponse"

# Default app label for items we cannot otherwise attribute. Copilot
# mailbox items originate from BizChat / Microsoft 365 Copilot Chat.
DEFAULT_APP = "BizChat"

# Heuristic delimiters used to split a single Copilot mailbox item body
# into its prompt and response halves when both are stored together.
_PROMPT_MARKERS = (
    "user:",
    "prompt:",
    "사용자:",
    "질문:",
)
_RESPONSE_MARKERS = (
    "copilot:",
    "assistant:",
    "response:",
    "copilot 응답:",
    "응답:",
)

_TEAMS_ITEM_DATA_STREAM = "__substg1.0_8008001F"


@dataclass
class ParsedTurn:
    interaction_type: str
    body_text: str
    created_at: str
    request_id: str


@dataclass
class ParsedItem:
    item_id: str
    conversation_id: str | None
    created_at: str
    app: str | None
    turns: list[ParsedTurn] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


def _iso(value: Any) -> str:
    """Normalise an arbitrary timestamp to whole-second UTC ISO-8601."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                dt = parsedate_to_datetime(text)
            except (TypeError, ValueError):
                return text
    else:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    if dt.microsecond:
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def split_copilot_body(body: str) -> list[tuple[str, str]]:
    """Split a combined Copilot body into ordered (type, text) turns.

    Recognises common ``User:`` / ``Copilot:`` style delimiters. When no
    delimiter is found the whole body is treated as a single AI response
    so no content is lost.
    """
    if not body or not body.strip():
        return []
    lines = body.splitlines()
    turns: list[tuple[str, str]] = []
    current_type: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        if current_type and buffer:
            text = "\n".join(buffer).strip()
            if text:
                turns.append((current_type, text))

    for line in lines:
        lowered = line.strip().lower()
        matched_prompt = next((m for m in _PROMPT_MARKERS if lowered.startswith(m)), None)
        matched_response = next((m for m in _RESPONSE_MARKERS if lowered.startswith(m)), None)
        if matched_prompt is not None:
            flush()
            current_type = USER_PROMPT
            buffer = [line.strip()[len(matched_prompt):].strip()]
        elif matched_response is not None:
            flush()
            current_type = AI_RESPONSE
            buffer = [line.strip()[len(matched_response):].strip()]
        else:
            buffer.append(line)
    flush()

    if not turns:
        return [(AI_RESPONSE, body.strip())]
    return turns


def _turns_from_pairs(
    item_id: str, pairs: list[tuple[str, str]], created_at: str
) -> list[ParsedTurn]:
    """Assign deterministic request ids so prompt/response pairs group."""
    turns: list[ParsedTurn] = []
    pair_idx = 0
    last_type: str | None = None
    for turn_type, text in pairs:
        # Advance the pair index whenever a new prompt starts (or when two
        # responses appear back to back, to avoid collapsing them).
        if turn_type == USER_PROMPT or (turn_type == AI_RESPONSE and last_type == AI_RESPONSE):
            pair_idx += 1
        request_id = f"{item_id}#{pair_idx}"
        turns.append(
            ParsedTurn(
                interaction_type=turn_type,
                body_text=text,
                created_at=created_at,
                request_id=request_id,
            )
        )
        last_type = turn_type
    return turns


def _parse_normalised_record(rec: dict[str, Any], fallback_id: str) -> ParsedItem:
    item_id = str(rec.get("id") or rec.get("itemId") or fallback_id)
    conversation_id = rec.get("conversationId") or rec.get("conversation_id") or rec.get("threadId")
    created_at = _iso(rec.get("createdDateTime") or rec.get("created_at") or rec.get("date"))
    app = rec.get("app") or rec.get("appHost") or DEFAULT_APP
    pairs: list[tuple[str, str]] = []
    prompt = rec.get("prompt")
    response = rec.get("response")
    if prompt:
        pairs.append((USER_PROMPT, str(prompt)))
    if response:
        pairs.append((AI_RESPONSE, str(response)))
    if not pairs:
        pairs = split_copilot_body(str(rec.get("body") or ""))
    return ParsedItem(
        item_id=item_id,
        conversation_id=str(conversation_id) if conversation_id else None,
        created_at=created_at,
        app=str(app) if app else DEFAULT_APP,
        turns=_turns_from_pairs(item_id, pairs, created_at),
        raw=rec,
    )


def _parse_eml_bytes(data: bytes, name: str) -> ParsedItem | None:
    try:
        msg = message_from_bytes(data)
    except Exception:  # noqa: BLE001
        log.warning("Failed to parse eDiscovery .eml entry %s", name)
        return None
    subject = msg.get("Subject") or ""
    message_id = (msg.get("Message-ID") or name).strip("<>") or name
    conversation_id = (
        msg.get("Thread-Index")
        or msg.get("X-Conversation-Id")
        or msg.get("References")
        or message_id
    )
    created_at = _iso(msg.get("Date"))
    body = _eml_plain_body(msg)
    pairs = split_copilot_body(body) if body else []
    if subject and (not pairs or pairs[0][0] != USER_PROMPT):
        pairs = [(USER_PROMPT, subject)] + pairs
    return ParsedItem(
        item_id=message_id,
        conversation_id=str(conversation_id) if conversation_id else None,
        created_at=created_at,
        app=DEFAULT_APP,
        turns=_turns_from_pairs(message_id, pairs, created_at),
        raw={"subject": subject, "name": name},
    )


def _eml_plain_body(msg: Any) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
        return ""
    payload = msg.get_payload(decode=True)
    if payload:
        charset = msg.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    return str(msg.get_payload() or "")


def _parse_msg_bytes(data: bytes, name: str) -> ParsedItem | None:
    try:
        import extract_msg  # type: ignore
    except ImportError:
        log.warning(
            "eDiscovery export contains a .msg entry (%s) but 'extract_msg' "
            "is not installed; skipping. Install it to parse Outlook .msg items.",
            name,
        )
        return None
    try:
        m = extract_msg.openMsg(io.BytesIO(data))  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        log.warning("Failed to parse eDiscovery .msg entry %s", name)
        return None
    try:
        subject = _clean_msg_text(getattr(m, "subject", ""))
        message_id = _clean_msg_text(getattr(m, "messageId", None)) or name
        message_id = message_id.strip("<>") or name
        created_at = _iso(getattr(m, "date", None))

        item_data = _teams_item_data(m)
        if item_data:
            body = _clean_msg_text(item_data.get("content")) or _html_body_text(m)
            conversation_id = _clean_msg_text(item_data.get("threadId")) or message_id
            turn_type = _teams_turn_type(item_data)
            raw = {
                "subject": subject,
                "name": name,
                "messageId": message_id,
                "sender": _clean_msg_text(getattr(m, "sender", None)),
                "itemData": item_data,
            }
            turns = [
                ParsedTurn(
                    interaction_type=turn_type,
                    body_text=body,
                    created_at=created_at,
                    request_id=message_id,
                )
            ] if body else []
            return ParsedItem(
                item_id=message_id,
                conversation_id=conversation_id,
                created_at=created_at,
                app=DEFAULT_APP,
                turns=turns,
                raw=raw,
            )

        body = _clean_msg_text(getattr(m, "body", "")) or _html_body_text(m)
        pairs = split_copilot_body(body) if body else []
        if subject and (not pairs or pairs[0][0] != USER_PROMPT):
            pairs = [(USER_PROMPT, subject)] + pairs
        return ParsedItem(
            item_id=message_id,
            conversation_id=message_id,
            created_at=created_at,
            app=DEFAULT_APP,
            turns=_turns_from_pairs(message_id, pairs, created_at),
            raw={"subject": subject, "name": name},
        )
    finally:
        close = getattr(m, "close", None)
        if callable(close):
            close()


def _clean_msg_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        for encoding in ("utf-8", "cp949", "euc-kr", "utf-16le"):
            try:
                text = value.decode(encoding, errors="replace")
            except LookupError:
                continue
            if text and "\ufffd" not in text:
                break
        else:
            text = value.decode("utf-8", errors="replace")
    else:
        text = str(value)
    text = text.replace("\x00", "")
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def _teams_item_data(msg: Any) -> dict[str, Any] | None:
    try:
        raw = msg.getStream(_TEAMS_ITEM_DATA_STREAM)
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    try:
        text = raw.decode("utf-16le", errors="ignore").replace("\x00", "").strip()
        outer = json.loads(text)
        item_data = outer.get("ItemData")
        if isinstance(item_data, str):
            parsed = json.loads(item_data)
        elif isinstance(item_data, dict):
            parsed = item_data
        else:
            return None
    except Exception:  # noqa: BLE001
        log.debug("Failed to decode Teams ItemData stream", exc_info=True)
        return None
    return parsed if isinstance(parsed, dict) else None


def _teams_turn_type(item_data: dict[str, Any]) -> str:
    sender = str(item_data.get("messageFrom") or item_data.get("imdisplayname") or "")
    from_obj = item_data.get("from")
    if isinstance(from_obj, dict):
        recipient_type = str(from_obj.get("recipientType") or "")
        internal_id = str(from_obj.get("internalId") or "")
        if recipient_type.lower() == "applications" or internal_id.startswith("28:"):
            return AI_RESPONSE
    if sender.startswith("28:"):
        return AI_RESPONSE
    return USER_PROMPT


def _html_body_text(msg: Any) -> str:
    data = getattr(msg, "htmlBody", None) or b""
    if not isinstance(data, bytes) or not data:
        return ""
    best = ""
    best_score = -10_000
    for encoding in ("utf-8", "cp949", "euc-kr", "ks_c_5601-1987"):
        try:
            text = data.decode(encoding, errors="replace")
        except LookupError:
            continue
        score = -10 * text.count("\ufffd") + sum(1 for ch in text if "가" <= ch <= "힣")
        if score > best_score:
            best = text
            best_score = score
    best = re.sub(r"(?is)<(script|style).*?</\1>", " ", best)
    best = re.sub(r"(?s)<[^>]+>", " ", best)
    best = _html_unescape(best)
    return re.sub(r"[ \t\r\f\v]+", " ", best).strip()


def _html_unescape(value: str) -> str:
    import html

    return html.unescape(value)


def parse_export_bytes(
    data: bytes,
    *,
    on_progress: ProgressCb | None = None,
) -> list[ParsedItem]:
    """Parse a downloaded export package (ZIP) into Copilot items.

    When ``on_progress`` is supplied it receives short human-readable status
    lines as the package is opened, walked, and decoded so the UI log can show
    detailed unzip/parse progress instead of a single opaque "parsing" line.
    """
    if not data:
        if on_progress is not None:
            on_progress("내려받은 패키지가 비어 있습니다.")
        return []
    if zipfile.is_zipfile(io.BytesIO(data)):
        return _parse_zip(data, on_progress=on_progress)
    # Bare payload — try JSON, then a single .eml.
    if on_progress is not None:
        on_progress(
            f"ZIP이 아닌 단일 페이로드({_human_size(len(data))})를 해석합니다."
        )
    text = data.decode("utf-8", errors="replace")
    items = _parse_json_text(text, "payload")
    if items:
        if on_progress is not None:
            on_progress(f"JSON 페이로드에서 {len(items)}개 항목을 읽었습니다.")
        return items
    item = _parse_eml_bytes(data, "payload.eml")
    if on_progress is not None:
        on_progress("EML 페이로드 1건을 해석했습니다." if item else "해석 가능한 항목이 없습니다.")
    return [item] if item is not None else []


def _parse_zip(
    data: bytes,
    *,
    on_progress: ProgressCb | None = None,
) -> list[ParsedItem]:
    items: list[ParsedItem] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        entries = [info for info in zf.infolist() if not info.is_dir()]
        total = len(entries)
        if on_progress is not None:
            on_progress(
                f"ZIP 열기 완료 ({_human_size(len(data))}) · 항목 {total}개 압축 해제 시작"
            )
        counts = {"json": 0, "msg": 0, "eml": 0, "skipped": 0, "failed": 0}
        for idx, info in enumerate(entries, start=1):
            name = info.filename
            lowered = name.lower()
            try:
                entry = zf.read(info)
            except Exception:  # noqa: BLE001
                counts["failed"] += 1
                log.warning("Failed to read eDiscovery export entry %s", name)
                if on_progress is not None:
                    on_progress(f"  ✗ 압축 해제 실패: {name}")
                continue
            if lowered.endswith((".json", ".jsonl")):
                new = _parse_json_text(entry.decode("utf-8", errors="replace"), name)
                items.extend(new)
                counts["json"] += 1
                if on_progress is not None:
                    on_progress(
                        f"  [{idx}/{total}] JSON {name} → {len(new)}개 항목 "
                        f"({_human_size(len(entry))})"
                    )
            elif lowered.endswith(".eml"):
                parsed = _parse_eml_bytes(entry, name)
                if parsed is not None:
                    items.append(parsed)
                counts["eml"] += 1
                if on_progress is not None:
                    on_progress(
                        f"  [{idx}/{total}] EML {name} ({_human_size(len(entry))})"
                    )
            elif lowered.endswith(".msg"):
                parsed = _parse_msg_bytes(entry, name)
                if parsed is not None:
                    items.append(parsed)
                counts["msg"] += 1
                if on_progress is not None:
                    on_progress(
                        f"  [{idx}/{total}] MSG {name} ({_human_size(len(entry))})"
                    )
            else:
                # Other entries (manifests, summaries) are ignored.
                counts["skipped"] += 1
        if on_progress is not None:
            on_progress(
                "압축 해제/해석 완료 · "
                f"msg={counts['msg']} eml={counts['eml']} json={counts['json']} "
                f"건너뜀={counts['skipped']} 실패={counts['failed']} "
                f"→ 메시지 항목 {len(items)}개"
            )
    return items


def _human_size(num_bytes: int) -> str:
    """Format a byte count as a short human-readable string (e.g. ``1.2 MB``)."""
    size = float(max(0, num_bytes))
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _parse_json_text(text: str, name: str) -> list[ParsedItem]:
    text = text.strip()
    if not text:
        return []
    items: list[ParsedItem] = []
    # Try a JSON array first, then JSON Lines.
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, list):
        for idx, rec in enumerate(parsed):
            if isinstance(rec, dict):
                items.append(_parse_normalised_record(rec, f"{name}:{idx}"))
        return items
    if isinstance(parsed, dict):
        return [_parse_normalised_record(parsed, name)]
    # JSON Lines fallback.
    for idx, line in enumerate(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            items.append(_parse_normalised_record(rec, f"{name}:{idx}"))
    return items


def items_to_interaction_rows(
    items: list[ParsedItem],
    *,
    user_id: str,
    fetched_at: str | None = None,
) -> list[InteractionRow]:
    """Flatten parsed items into deduplicated InteractionRow turns."""
    fetched_at = fetched_at or _now_iso()
    rows: list[InteractionRow] = []
    seen: set[str] = set()
    for item in items:
        session_id = item.conversation_id or item.item_id
        for turn_idx, turn in enumerate(item.turns):
            row_id = f"ediscovery:{session_id}:{turn.request_id}:{turn_idx}:{turn.interaction_type}"
            if row_id in seen:
                continue
            seen.add(row_id)
            rows.append(
                InteractionRow(
                    id=row_id,
                    user_id=user_id,
                    session_id=session_id,
                    request_id=turn.request_id,
                    created_at=turn.created_at,
                    interaction_type=turn.interaction_type,
                    app=item.app or DEFAULT_APP,
                    body_text=turn.body_text,
                    body_content_type="text",
                    attachments_json=None,
                    raw_json=json.dumps(
                        {"source": "ediscovery", "item": item.raw}, ensure_ascii=False
                    ),
                    fetched_at=fetched_at,
                    source_type="ediscovery",
                )
            )
    return rows
