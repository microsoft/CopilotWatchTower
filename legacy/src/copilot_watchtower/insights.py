"""Rule-based insight helpers for Copilot activity analytics."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkIntent:
    key: str
    label: str
    tone: str = "neutral"


INTENT_ORDER: tuple[str, ...] = (
    "summarize",
    "create",
    "analyze",
    "search",
    "transform",
    "admin_security",
    "other",
)

INTENTS: dict[str, WorkIntent] = {
    "summarize": WorkIntent("summarize", "요약/캐치업", "positive"),
    "create": WorkIntent("create", "초안/생성", "positive"),
    "analyze": WorkIntent("analyze", "분석/표/데이터", "positive"),
    "search": WorkIntent("search", "질문/찾기", "neutral"),
    "transform": WorkIntent("transform", "수정/번역/톤", "neutral"),
    "admin_security": WorkIntent("admin_security", "관리/보안", "warning"),
    "other": WorkIntent("other", "기타", "neutral"),
}

_ADMIN_APPS = (
    "admin",
    "azure",
    "defender",
    "intune",
    "purview",
    "security",
    "teamsadmin",
)

_KEYWORDS: dict[str, tuple[str, ...]] = {
    "summarize": (
        "summarize",
        "summary",
        "recap",
        "catch up",
        "key takeaways",
        "action item",
        "tl;dr",
        "요약",
        "정리",
        "회의록",
        "핵심",
        "결론",
        "액션아이템",
        "따라잡",
    ),
    "create": (
        "draft",
        "write",
        "compose",
        "create",
        "generate",
        "brainstorm",
        "outline",
        "proposal",
        "email draft",
        "초안",
        "작성",
        "생성",
        "만들",
        "써줘",
        "브레인스토밍",
        "제안서",
    ),
    "analyze": (
        "analyze",
        "analysis",
        "compare",
        "chart",
        "table",
        "pivot",
        "formula",
        "spreadsheet",
        "trend",
        "insight",
        "분석",
        "비교",
        "표",
        "차트",
        "수식",
        "추세",
        "인사이트",
    ),
    "search": (
        "find",
        "search",
        "where",
        "what",
        "why",
        "how",
        "explain",
        "tell me",
        "show me",
        "찾아",
        "검색",
        "어디",
        "무엇",
        "왜",
        "어떻게",
        "알려",
        "설명",
    ),
    "transform": (
        "translate",
        "rewrite",
        "rephrase",
        "tone",
        "grammar",
        "polish",
        "shorten",
        "fix",
        "edit",
        "번역",
        "수정",
        "고쳐",
        "다듬",
        "톤",
        "문체",
        "짧게",
    ),
    "admin_security": (
        "policy",
        "permission",
        "rbac",
        "audit",
        "compliance",
        "dlp",
        "sensitivity",
        "risk",
        "incident",
        "권한",
        "정책",
        "감사",
        "규정",
        "보안",
        "위험",
        "민감",
        "차단",
    ),
}


def classify_work_intent(text: str | None, app: str | None = None) -> WorkIntent:
    """Classify a prompt into a coarse work-intent bucket.

    This intentionally stays transparent and deterministic. The result is
    an operational signal, not an official Microsoft usage taxonomy.
    """
    haystack = f"{text or ''} {app or ''}".lower()
    app_l = (app or "").lower()

    if any(token in app_l for token in _ADMIN_APPS):
        return INTENTS["admin_security"]

    for key in ("admin_security", "summarize", "analyze", "create", "transform", "search"):
        if _contains_any(haystack, _KEYWORDS[key]):
            return INTENTS[key]

    if "?" in (text or ""):
        return INTENTS["search"]
    if app_l in {"excel", "powerbi", "power bi"}:
        return INTENTS["analyze"]
    if app_l in {"word", "powerpoint", "outlook"}:
        return INTENTS["create"]
    return INTENTS["other"]


def intent_label(key: str) -> str:
    return INTENTS.get(key, INTENTS["other"]).label


def _contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)