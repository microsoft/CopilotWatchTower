from __future__ import annotations

from copilot_watchtower.insights import classify_work_intent


def test_classify_work_intent_summarize_korean() -> None:
    assert classify_work_intent("회의 내용을 요약하고 액션아이템 정리해줘").key == "summarize"


def test_classify_work_intent_analyze_from_excel_context() -> None:
    assert classify_work_intent("Find trends and make a chart", app="Excel").key == "analyze"


def test_classify_work_intent_admin_security_from_app_host() -> None:
    assert classify_work_intent("show risky policy changes", app="Microsoft Purview").key == "admin_security"


def test_classify_work_intent_search_from_question() -> None:
    assert classify_work_intent("Where is the Q3 planning document?").key == "search"