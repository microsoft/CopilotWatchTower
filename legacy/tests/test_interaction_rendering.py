from __future__ import annotations

import json

from copilot_watchtower.db import InteractionRow
from copilot_watchtower.interaction_rendering import (
    interaction_detail_text,
    interaction_display_text,
    interaction_preview,
)


def _row(*, body_text: str | None, attachments_json: str | None = None, raw_json: str | None = None) -> InteractionRow:
    return InteractionRow(
        id="i1",
        user_id="u1",
        session_id="s1",
        request_id="r1",
        created_at="2026-05-22T21:11:47Z",
        interaction_type="aiResponse",
        app="BizChat",
        body_text=body_text,
        body_content_type="text",
        attachments_json=attachments_json,
        raw_json=raw_json or "{}",
        fetched_at="2026-05-22T21:12:00Z",
    )


def test_attachment_only_body_extracts_adaptive_card_text_and_links() -> None:
    attachments_json = json.dumps(
        {
            "attachments": [
                {
                    "attachmentId": "att-1",
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": json.dumps(
                        {
                            "type": "AdaptiveCard",
                            "body": [
                                {
                                    "type": "TextBlock",
                                    "text": "다음은 주요 뉴스 요약입니다\n- 첫 번째 뉴스",
                                }
                            ],
                        },
                        ensure_ascii=False,
                    ),
                }
            ],
            "links": [
                {
                    "displayName": "뉴스 출처",
                    "linkUrl": "https://example.com/news",
                    "linkType": "Web",
                }
            ],
            "mentions": [],
        },
        ensure_ascii=False,
    )
    row = _row(
        body_text='<attachment id="att-1"></attachment>',
        attachments_json=attachments_json,
    )

    assert interaction_display_text(row).startswith("다음은 주요 뉴스 요약입니다")
    assert "attachment" not in interaction_preview(row).lower()
    detail = interaction_detail_text(row)
    assert "첫 번째 뉴스" in detail
    assert "링크" in detail
    assert "뉴스 출처" in detail
    assert "https://example.com/news" in detail


def test_plain_body_is_preserved() -> None:
    row = _row(body_text="그냥 본문")

    assert interaction_display_text(row) == "그냥 본문"
    assert interaction_preview(row) == "그냥 본문"


def test_loading_image_placeholder_is_explained() -> None:
    row = _row(body_text="Loading image")

    display = interaction_display_text(row)
    assert "이미지 생성 응답" in display
    assert "원본 표시: Loading image" in display
    assert "이미지 생성 응답" in interaction_preview(row)
    assert "이미지 바이너리" in interaction_detail_text(row)
