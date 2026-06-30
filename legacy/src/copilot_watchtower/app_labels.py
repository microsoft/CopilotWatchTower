"""Readable labels for raw Copilot interaction app identifiers."""
from __future__ import annotations

from .i18n import translate

# Labels that carry a localized fragment are stored as catalog keys and
# resolved to the active language at lookup time via :func:`_localized`.
_LOCALIZED_LABEL_KEYS = {"label.copilotStudioWeb"}

_SIMPLE_APP_LABELS = {
    "bizchat": "Copilot Chat",
    "webchat": "Copilot Chat",
    "copilot chat": "Copilot Chat",
    "microsoft 365 copilot": "Microsoft 365 Copilot",
    "teams": "Teams",
    "microsoft teams": "Teams",
    "skypeteams": "Teams",
    "msteams": "Teams",
    "directline": "label.copilotStudioWeb",
    "word": "Word",
    "excel": "Excel",
    "powerpoint": "PowerPoint",
    "power point": "PowerPoint",
    "outlook": "Outlook",
    "loop": "Loop",
    "onenote": "OneNote",
    "one note": "OneNote",
    "powerbi": "Power BI",
    "power bi": "Power BI",
    "forms": "Forms",
    "planner": "Planner",
    "stream": "Stream",
    "whiteboard": "Whiteboard",
    "sharepoint": "SharePoint",
    "share point": "SharePoint",
}


def _localized(label: str) -> str:
    """Resolve a catalog-key label to the active language; pass others through."""
    return translate(label) if label in _LOCALIZED_LABEL_KEYS else label


def display_app_name(value: str | None) -> str:
    """Return a human-readable label for a stored interaction app value.

    Graph interaction history can return values such as
    ``IPM.SkypeTeams.Message.Copilot.WebChat``. Those are useful as stable raw
    identifiers, but dashboard labels should read like product/app names.
    """
    text = str(value or "").strip()
    if not text:
        return "(unknown)"
    if text == "(unknown)":
        return text

    compact = _compact(text)
    simple = _SIMPLE_APP_LABELS.get(compact)
    if simple:
        return _localized(simple)

    if compact.startswith("ipm.skypeteams.message.copilot"):
        suffix = text.rsplit(".", 1)[-1]
        suffix_label = _SIMPLE_APP_LABELS.get(_compact(suffix)) or _title_identifier(suffix)
        if suffix_label == "Copilot Chat":
            return "Teams: Copilot Chat"
        if suffix_label:
            return f"Teams: {suffix_label}"
        return "Teams: Copilot"

    if "skypeteams" in compact or "microsoftteams" in compact:
        return "Teams"
    if "bizchat" in compact or "webchat" in compact:
        return "Copilot Chat"
    for needle, label in _SIMPLE_APP_LABELS.items():
        if needle.replace(" ", "") in compact.replace(" ", ""):
            return _localized(label)

    if "." in text:
        return _title_identifier(text.rsplit(".", 1)[-1]) or text
    return _title_identifier(text) or text


def _compact(value: str) -> str:
    return " ".join(value.replace("_", " ").replace("-", " ").strip().lower().split())


def _title_identifier(value: str) -> str:
    cleaned = value.replace("_", " ").replace("-", " ").strip()
    if not cleaned:
        return ""
    if cleaned.isupper() or cleaned.islower():
        return " ".join(part.capitalize() for part in cleaned.split())
    return cleaned