"""Display helpers for Copilot interaction rows."""
from __future__ import annotations

import json
import re
from typing import Any

from .db import InteractionRow

_ATTACHMENT_TAG_RE = re.compile(r"<attachment\b[^>]*>\s*</attachment>", re.IGNORECASE)
_IMAGE_PLACEHOLDERS = {"loading image", "loading image..."}
_IMAGE_PLACEHOLDER_NOTICE = (
    "이미지 생성 응답입니다. Graph 대화 API가 생성된 이미지 파일이나 최종 이미지 카드는 "
    "제공하지 않고 상태 텍스트만 반환했습니다."
)


def interaction_preview(row: InteractionRow, *, limit: int = 200) -> str:
    text = interaction_display_text(row).replace("\n", " ").strip()
    if not text:
        text = _link_summary(row, limit=3) or _attachment_summary(row) or "(본문 없음)"
    return text[:limit]


def interaction_display_text(row: InteractionRow) -> str:
    if _is_image_placeholder_only(row):
        return f"{_IMAGE_PLACEHOLDER_NOTICE}\n\n원본 표시: {row.body_text}"
    parts: list[str] = []
    body = _clean_body(row.body_text)
    if body:
        parts.append(body)
    for text in _attachment_texts(row):
        if text and text not in parts:
            parts.append(text)
    return "\n\n".join(parts).strip()


def interaction_detail_text(row: InteractionRow) -> str:
    sections: list[str] = []
    display = interaction_display_text(row)
    sections.append(display or "(본문 없음 - 첨부/링크 메타데이터만 제공됨)")
    links = _links(row)
    if links:
        lines = []
        for idx, link in enumerate(links, start=1):
            name = str(link.get("displayName") or link.get("title") or link.get("linkUrl") or f"link {idx}")
            url = str(link.get("linkUrl") or link.get("url") or "")
            line = f"{idx}. {name}"
            if url and url != name:
                line += f"\n   {url}"
            lines.append(line)
        sections.append("링크\n" + "\n".join(lines))
    attachments = _attachments(row)
    if attachments:
        lines = []
        for idx, attachment in enumerate(attachments, start=1):
            name = attachment.get("name") or attachment.get("attachmentId") or f"attachment {idx}"
            content_type = attachment.get("contentType") or ""
            lines.append(f"{idx}. {name}" + (f" ({content_type})" if content_type else ""))
        sections.append("첨부\n" + "\n".join(lines))
    if _is_image_placeholder_only(row):
        sections.append("참고\n감사 로그에는 이 요청/응답 ID가 남을 수 있지만, 이미지 바이너리나 완성 이미지 본문은 현재 수집 API 응답에 포함되지 않았습니다.")
    return "\n\n".join(sections).strip()


def _clean_body(value: str | None) -> str:
    if not value:
        return ""
    cleaned = _ATTACHMENT_TAG_RE.sub("", value).strip()
    return cleaned


def _is_image_placeholder_only(row: InteractionRow) -> bool:
    body = (row.body_text or "").strip().lower()
    if body not in _IMAGE_PLACEHOLDERS:
        return False
    return not _attachments(row) and not _links(row)


def _attachment_texts(row: InteractionRow) -> list[str]:
    texts: list[str] = []
    for attachment in _attachments(row):
        content = attachment.get("content")
        parsed = _parse_jsonish(content)
        if parsed is None:
            if isinstance(content, str) and content.strip() and not content.strip().startswith("{"):
                texts.append(content.strip())
            continue
        text = _extract_card_text(parsed)
        if text:
            texts.append(text)
    return texts


def _extract_card_text(value: Any) -> str:
    lines: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            text = node.get("text")
            if isinstance(text, str) and text.strip():
                lines.append(text.strip())
            title = node.get("title")
            val = node.get("value")
            if isinstance(title, str) and isinstance(val, str):
                lines.append(f"{title.strip()}: {val.strip()}")
            for key in ("body", "items", "columns", "facts"):
                child = node.get(key)
                if child is not None:
                    walk(child)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(value)
    return "\n".join(dict.fromkeys(lines))


def _attachment_summary(row: InteractionRow) -> str:
    attachments = _attachments(row)
    if not attachments:
        return ""
    labels = []
    for attachment in attachments[:3]:
        labels.append(str(attachment.get("name") or attachment.get("attachmentId") or "attachment"))
    if len(attachments) > 3:
        labels.append(f"+{len(attachments) - 3}")
    return "첨부: " + ", ".join(labels)


def _link_summary(row: InteractionRow, *, limit: int) -> str:
    links = _links(row)
    if not links:
        return ""
    labels = [str(link.get("displayName") or link.get("linkUrl") or "link") for link in links[:limit]]
    if len(links) > limit:
        labels.append(f"+{len(links) - limit}")
    return "링크: " + ", ".join(labels)


def _attachments(row: InteractionRow) -> list[dict[str, Any]]:
    payload = _loads(row.attachments_json)
    attachments = payload.get("attachments") if isinstance(payload, dict) else None
    if isinstance(attachments, list) and attachments:
        return [item for item in attachments if isinstance(item, dict)]
    raw = _loads(row.raw_json)
    raw_attachments = raw.get("attachments") if isinstance(raw, dict) else None
    if isinstance(raw_attachments, list):
        return [item for item in raw_attachments if isinstance(item, dict)]
    return []


def _links(row: InteractionRow) -> list[dict[str, Any]]:
    payload = _loads(row.attachments_json)
    links = payload.get("links") if isinstance(payload, dict) else None
    if isinstance(links, list) and links:
        return [item for item in links if isinstance(item, dict)]
    raw = _loads(row.raw_json)
    raw_links = raw.get("links") if isinstance(raw, dict) else None
    if isinstance(raw_links, list):
        return [item for item in raw_links if isinstance(item, dict)]
    return []


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_jsonish(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None