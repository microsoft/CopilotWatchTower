"""Spike: probe the Dataverse ``bot`` + ``botcomponent`` tables for agent YAML.

The planned *predictive* tier scores an agent's **risk before it runs away** by
statically analysing its definition. Microsoft stores a Copilot Studio agent's
authoring components (topics, triggers, tools, knowledge sources, settings) in
the Dataverse ``botcomponent`` table, where the ``data`` column holds the
component "in OBI format" (the declarative agent definition) and ``content``
holds structure/metadata. ``bot`` is the agent master record.

This probe verifies, against a real tenant, the assumptions the predictive tier
depends on:

1. Drive a headless maker-portal sign-in, enumerate environments via BAP, and
   capture each environment's ``*.crm.dynamics.com`` bearer token.
2. For each environment, list ``bots`` (agent master) and ``botcomponents``.
3. Tally the **ComponentType** distribution — confirm we can see Triggers (5),
   External Triggers (17), Custom GPT (15), Knowledge Sources (16), etc., the
   raw material for the risk score.
4. Confirm the ``data`` (OBI) / ``content`` columns are **parseable** (JSON?
   YAML-ish?) so the risk parser has something to read.
5. Confirm ``_parentbotid_value`` joins a component back to its ``bot``.

Run:

    $env:PYTHONUTF8="1"; $env:PYTHONIOENCODING="utf-8"
    .\\.venv\\Scripts\\python.exe scripts\\spike_botcomponents.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from copilot_watchtower.config import DATAVERSE_API_VERSION  # noqa: E402
from copilot_watchtower.db import Repository  # noqa: E402
from copilot_watchtower.security import unprotect  # noqa: E402
from copilot_watchtower.services.dataverse import (  # noqa: E402
    DataverseClient,
    DataverseError,
    fetch_bap_environments,
)
from copilot_watchtower.services.dataverse_browser_download import (  # noqa: E402
    EnvCaptureTarget,
    capture_dataverse_tokens,
)

# botcomponent.componenttype picklist (Microsoft Learn entity reference).
COMPONENT_TYPE_LABELS = {
    0: "Topic",
    1: "Skill",
    2: "BotVariable",
    3: "BotEntity",
    4: "Dialog",
    5: "Trigger",
    6: "LanguageUnderstanding",
    7: "LanguageGeneration",
    8: "DialogSchema",
    9: "Topic(V2)",
    10: "BotTranslations(V2)",
    11: "BotEntity(V2)",
    12: "BotVariable(V2)",
    13: "Skill(V2)",
    14: "BotFileAttachment",
    15: "CustomGPT",
    16: "KnowledgeSource",
    17: "ExternalTrigger",
    18: "CopilotSettings",
    19: "TestCase",
}


def _out_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    folder = Path(base) / "CopilotWatchTower"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _find_profile_db() -> Path | None:
    root = _out_dir()
    candidates = list((root / "profiles").glob("*/store.db"))
    legacy = root / "store.db"
    if legacy.exists():
        candidates.append(legacy)
    for db in candidates:
        try:
            repo = Repository(db)
            if repo.get_text_setting("ediscovery_browser_user") or repo.get_text_setting(
                "exo_delegated_user"
            ):
                return db
        except Exception:
            continue
    return None


def _classify_payload(value: object) -> str:
    """Describe how a ``data``/``content`` payload parses (JSON / YAML-ish)."""
    if value is None:
        return "none"
    text = value if isinstance(value, str) else json.dumps(value)
    stripped = text.strip()
    if not stripped:
        return "empty"
    try:
        json.loads(stripped)
        return "json"
    except (ValueError, TypeError):
        pass
    # OBI/declarative agents often serialise as YAML — detect heuristically
    # (the spike avoids importing a YAML lib that may be absent).
    head = stripped.splitlines()[0][:60] if stripped.splitlines() else ""
    if ":" in head and not stripped.startswith("{"):
        return f"yaml-ish (head={head!r})"
    return f"other (head={stripped[:40]!r})"


def _fetch(client: DataverseClient, env_url: str, entity_set: str, select: str, top: int) -> list[dict]:
    base = env_url.rstrip("/")
    url = f"{base}/api/data/{DATAVERSE_API_VERSION}/{entity_set}"
    params = {"$select": select, "$top": str(top)}
    try:
        data = client._get_json(url, params=params, page_size=top)
    except DataverseError:
        # Retry without $select in case a column name is unavailable in-tenant.
        data = client._get_json(url, params={"$top": str(top)}, page_size=top)
    rows = data.get("value", []) if isinstance(data, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def _enumerate_targets():
    captured_envs: list = []

    def _enumerate(bap_token: str) -> list[EnvCaptureTarget]:
        all_envs = fetch_bap_environments(bap_token)
        captured_envs.extend(all_envs)
        targets: list[EnvCaptureTarget] = []
        for env in all_envs:
            host = (urlsplit(env.url).hostname or "").lower()
            targets.append(
                EnvCaptureTarget(
                    env_id=env.id, org_host=host, label=env.friendly_name or env.url
                )
            )
        return targets

    return _enumerate, captured_envs


def main() -> int:
    db = _find_profile_db()
    if db is None:
        print("프로필 데이터베이스를 찾지 못했습니다. 앱을 먼저 실행/설정하세요.")
        return 2
    repo = Repository(db)
    user = (
        repo.get_text_setting("ediscovery_browser_user")
        or repo.get_text_setting("exo_delegated_user")
        or ""
    )
    blob = repo.get_secret("ediscovery_browser_password") or repo.get_secret(
        "exo_delegated_password"
    )
    if not user or blob is None:
        print("브라우저 로그인 계정이 저장되어 있지 않습니다. 앱 설정에서 등록하세요.")
        return 2
    password = str(unprotect(blob))

    print(f"○ {user} 계정으로 Dataverse 토큰을 캡처합니다…")
    enumerate_cb, captured_envs = _enumerate_targets()
    tokens = capture_dataverse_tokens(
        username=user,
        password=password,
        on_log=lambda line: print("  ", line),
        enumerate_environments=enumerate_cb,
    )
    print("• 캡처된 호스트:", ", ".join(tokens.hosts))
    print(f"• BAP 환경 {len(captured_envs)}개")

    client = DataverseClient(tokens.token_for)
    dump_path = _out_dir() / "botcomponents_spike.jsonl"
    dump_path.write_text("", encoding="utf-8")
    captured_hosts = set(tokens.org_hosts)
    try:
        for env in captured_envs:
            host = (urlsplit(env.url).hostname or "").lower()
            label = env.friendly_name or env.url
            if captured_hosts and host and host not in captured_hosts:
                print(f"\n=== {label} — 토큰 없음, 건너뜀 ===")
                continue
            print(f"\n=== {label} | {env.url} (sku={env.sku}) ===")

            # 1) Agent master records.
            try:
                bots = _fetch(
                    client,
                    env.url,
                    "bots",
                    "botid,name,schemaname,statecode,createdon,modifiedon",
                    100,
                )
            except DataverseError as exc:
                print(f"   ⚠ bots 실패: HTTP {exc.status}: {str(exc.detail)[:160]}")
                bots = []
            bot_names = {str(b.get("botid")): b.get("name") for b in bots}
            print(f"   에이전트(bot) {len(bots)}개: {[b.get('name') for b in bots][:10]}")

            # 2) Authoring components (incl. OBI ``data``).
            try:
                comps = _fetch(
                    client,
                    env.url,
                    "botcomponents",
                    "botcomponentid,name,componenttype,schemaname,statecode,"
                    "componentstate,modifiedon,_parentbotid_value,content,data",
                    300,
                )
            except DataverseError as exc:
                print(f"   ⚠ botcomponents 실패: HTTP {exc.status}: {str(exc.detail)[:160]}")
                continue
            if not comps:
                print("   botcomponent 0건")
                continue

            print(f"   botcomponent {len(comps)}건 | 컬럼: {sorted(comps[0].keys())}")

            # ComponentType distribution.
            ctype: dict[str, int] = {}
            for c in comps:
                raw = c.get("componenttype")
                key = COMPONENT_TYPE_LABELS.get(raw, f"({raw})")
                ctype[key] = ctype.get(key, 0) + 1
            print(f"   ComponentType: {ctype}")

            # data/content parseability.
            data_shapes: dict[str, int] = {}
            for c in comps:
                shape = _classify_payload(c.get("data"))
                base = shape.split(" ")[0]
                data_shapes[base] = data_shapes.get(base, 0) + 1
            print(f"   data(OBI) 파싱 형태: {data_shapes}")

            # ParentBotId join coverage.
            linked = sum(1 for c in comps if str(c.get("_parentbotid_value") or "").strip())
            print(
                f"   _parentbotid_value 보유: {linked}/{len(comps)} "
                f"(에이전트 귀속 가능 여부)"
            )

            with dump_path.open("a", encoding="utf-8") as fh:
                for c in comps[:40]:
                    parent = str(c.get("_parentbotid_value") or "")
                    fh.write(
                        json.dumps(
                            {
                                "env": env.url,
                                "botcomponentid": c.get("botcomponentid"),
                                "name": c.get("name"),
                                "componenttype": c.get("componenttype"),
                                "componenttype_label": COMPONENT_TYPE_LABELS.get(
                                    c.get("componenttype")
                                ),
                                "parentbotid": parent,
                                "parentbot_name": bot_names.get(parent),
                                "data_shape": _classify_payload(c.get("data")),
                                "data_head": (str(c.get("data") or ""))[:400],
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
        print(f"\n덤프: {dump_path}")
        print(
            "\n판정 가이드: (1) data(OBI)가 json/yaml-ish로 파싱되면 정적 위험 분석 가능. "
            "(2) ComponentType에 Trigger(5)/ExternalTrigger(17)가 보이면 자율 여부 판별 가능. "
            "(3) _parentbotid_value가 있으면 컴포넌트→에이전트 귀속 가능."
        )
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
