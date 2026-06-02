"""Unit tests for the OperationsController used by the web shell."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from copilot_watchtower.config import RuntimeOptions
from copilot_watchtower.db import Repository, initialize
from copilot_watchtower.profiles import ProfileRegistry
from copilot_watchtower.webshell.actions import OperationsController
from copilot_watchtower.webshell.bridge import Bridge, BridgeContext


@pytest.fixture
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "ops.db"
    initialize(db)
    return Repository(db)


@pytest.fixture
def options() -> RuntimeOptions:
    return RuntimeOptions(
        poll_interval_minutes=15,
        scope_mode="LICENSED",
        scope_group_id=None,
        scope_upns=[],
        language="ko_KR",
        auto_backup_enabled=False,
        auto_backup_mode="new",
    )


@pytest.fixture
def controller(qtbot, repo: Repository, options: RuntimeOptions) -> OperationsController:
    del qtbot
    return OperationsController(repo=repo, options=options, registry=None, profile_id=None)


def test_start_collection_without_credentials_returns_error(controller: OperationsController) -> None:
    result = controller.start_collection("conversation")
    assert result == {"ok": False, "error": "앱 등록이 완료되지 않아 토큰을 만들 수 없습니다."}


def test_stop_unknown_kind(controller: OperationsController) -> None:
    result = controller.stop_collection("audit")
    assert result["ok"] is False
    assert "실행 중인 작업이 없습니다" in result["error"]


def test_collection_status_initially_empty(controller: OperationsController) -> None:
    assert controller.collection_status() == {"running": []}


def test_update_settings_validates_inputs(controller: OperationsController, repo: Repository) -> None:
    bad = controller.update_settings({"poll_interval_minutes": "not-a-number"})
    assert bad["ok"] is False

    ok = controller.update_settings(
        {
            "poll_interval_minutes": 30,
            "scope_mode": "custom",
            "scope_upns": ["a@x", "b@x", " "],
            "language": "en_US",
            "auto_backup_enabled": True,
            "auto_backup_mode": "overwrite",
        }
    )
    assert ok == {"ok": True}
    assert controller.options.poll_interval_minutes == 30
    assert controller.options.scope_mode == "CUSTOM"
    assert controller.options.scope_upns == ["a@x", "b@x"]
    assert controller.options.language == "en_US"
    assert controller.options.auto_backup_enabled is True
    assert controller.options.auto_backup_mode == "overwrite"
    # Persisted to repo as well.
    assert repo.get_text_setting("poll_interval_minutes") == "30"
    assert repo.get_text_setting("scope_mode") == "CUSTOM"
    assert repo.get_text_setting("language") == "en_US"
    assert json.loads(repo.get_text_setting("scope_upns")) == ["a@x", "b@x"]
    assert repo.get_text_setting("auto_backup_enabled") == "1"
    assert repo.get_text_setting("auto_backup_mode") == "overwrite"


def test_auto_backup_starts_on_collection_finish_when_enabled(
    monkeypatch,
    qtbot,
    tmp_path: Path,
    repo: Repository,
    options: RuntimeOptions,
) -> None:
    del qtbot
    registry = ProfileRegistry.load(tmp_path / "profiles-root")
    profile = registry.add("Tenant A")
    registry.set_active(profile.id)

    controller = OperationsController(
        repo=repo,
        options=RuntimeOptions(
            poll_interval_minutes=options.poll_interval_minutes,
            scope_mode=options.scope_mode,
            scope_group_id=options.scope_group_id,
            scope_upns=list(options.scope_upns),
            language=options.language,
            auto_backup_enabled=True,
            auto_backup_mode="overwrite",
        ),
        registry=registry,
        profile_id=profile.id,
    )

    seen: dict[str, object] = {}

    def fake_build_backup_bundle(source_db_path, dest_dir, profile=None, **kwargs):
        seen["bundle_path"] = kwargs.get("bundle_path")
        bundle_path = kwargs.get("bundle_path") or (dest_dir / "generated.cwtbackup")
        Path(bundle_path).parent.mkdir(parents=True, exist_ok=True)
        Path(bundle_path).write_bytes(b"zip")
        return Path(bundle_path)

    monkeypatch.setattr("copilot_watchtower.webshell.actions.build_backup_bundle", fake_build_backup_bundle)
    monkeypatch.setattr(
        "copilot_watchtower.webshell.actions.read_backup_manifest",
        lambda path: {"row_total": 3, "tables": {"users": 1}, "created_at": "2026-06-02T00:00:00Z"},
    )
    monkeypatch.setattr(
        controller,
        "_run_maintenance",
        lambda name, task: seen.setdefault("result", task(lambda *_args: None)) or {"ok": True, "started": True},
    )

    controller._on_job_finished("audit")

    assert isinstance(seen["bundle_path"], Path)
    assert str(seen["bundle_path"]).endswith("-latest.cwtbackup")


def test_auto_backup_is_skipped_when_disabled(
    monkeypatch,
    qtbot,
    tmp_path: Path,
    repo: Repository,
    options: RuntimeOptions,
) -> None:
    del qtbot
    registry = ProfileRegistry.load(tmp_path / "profiles-root")
    profile = registry.add("Tenant A")
    registry.set_active(profile.id)

    controller = OperationsController(
        repo=repo,
        options=options,
        registry=registry,
        profile_id=profile.id,
    )

    called = {"value": False}
    monkeypatch.setattr(controller, "_run_maintenance", lambda *_args, **_kwargs: called.update(value=True))

    controller._on_job_finished("audit")

    assert called["value"] is False


def test_profile_actions_require_registry(controller: OperationsController) -> None:
    assert controller.switch_profile("missing")["ok"] is False
    assert controller.add_profile("foo")["ok"] is False
    assert controller.remove_profile("missing")["ok"] is False


def test_remove_profile_deletes_entra_app_before_local_data(
    monkeypatch,
    qtbot,
    tmp_path: Path,
    repo: Repository,
    options: RuntimeOptions,
) -> None:
    del qtbot
    registry = ProfileRegistry.load(tmp_path / "profiles-root")
    current = registry.add("current")
    target = registry.add("delete-me")
    registry.set_active(current.id)

    target_db = registry.profile_db_path(target.id)
    initialize(target_db)
    target_repo = Repository(target_db)
    target_repo.set_text_setting("tenant_id", "tenant-1")
    target_repo.set_text_setting("client_id", "app-1")
    target_repo.set_text_setting("app_object_id", "object-1")
    del target_repo

    provider_calls: list[dict] = []
    delete_calls: list[tuple[str, str]] = []

    class FakeProvider:
        def __init__(self, tenant_id: str, scopes: list[str], **kwargs: object) -> None:
            provider_calls.append({"tenant_id": tenant_id, "scopes": scopes, **kwargs})

        def acquire(self) -> str:
            return "delegated-token"

    class FakeRegistrar:
        def __init__(self, token: str, tenant_id: str) -> None:
            delete_calls.append(("init", f"{token}:{tenant_id}"))

        def __enter__(self) -> "FakeRegistrar":
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def delete_application(self, object_id: str) -> bool:
            delete_calls.append(("delete", object_id))
            return True

    monkeypatch.setattr("copilot_watchtower.webshell.actions.DelegatedDeviceCodeTokenProvider", FakeProvider)
    monkeypatch.setattr("copilot_watchtower.webshell.actions.AppRegistrar", FakeRegistrar)

    controller = OperationsController(
        repo=repo,
        options=options,
        registry=registry,
        profile_id=current.id,
    )

    result = controller.remove_profile(target.id, delete_data=True)

    assert result["ok"] is True
    assert result["app_deleted"] is True
    assert delete_calls == [("init", "delegated-token:tenant-1"), ("delete", "object-1")]
    assert provider_calls[0]["tenant_id"] == "tenant-1"
    assert provider_calls[0]["allow_device_code"] is False
    assert registry.get(target.id) is None
    assert not registry.profile_dir(target.id).exists()


def test_remove_profile_keeps_local_profile_when_app_delete_fails(
    monkeypatch,
    qtbot,
    tmp_path: Path,
    repo: Repository,
    options: RuntimeOptions,
) -> None:
    del qtbot
    registry = ProfileRegistry.load(tmp_path / "profiles-root")
    current = registry.add("current")
    target = registry.add("delete-me")

    target_db = registry.profile_db_path(target.id)
    initialize(target_db)
    target_repo = Repository(target_db)
    target_repo.set_text_setting("tenant_id", "tenant-1")
    target_repo.set_text_setting("client_id", "app-1")
    target_repo.set_text_setting("app_object_id", "object-1")
    del target_repo

    class FakeProvider:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def acquire(self) -> str:
            return "delegated-token"

    class FakeRegistrar:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> "FakeRegistrar":
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def delete_application(self, object_id: str) -> bool:
            raise RuntimeError(f"boom {object_id}")

    monkeypatch.setattr("copilot_watchtower.webshell.actions.DelegatedDeviceCodeTokenProvider", FakeProvider)
    monkeypatch.setattr("copilot_watchtower.webshell.actions.AppRegistrar", FakeRegistrar)

    controller = OperationsController(
        repo=repo,
        options=options,
        registry=registry,
        profile_id=current.id,
    )

    result = controller.remove_profile(target.id, delete_data=True)

    assert result["ok"] is False
    assert "Entra 앱 삭제 실패" in result["error"]
    assert registry.get(target.id) is not None
    assert registry.profile_dir(target.id).exists()


def test_open_system_dialog_emits_signal(qtbot, controller: OperationsController) -> None:
    del qtbot
    captured: list[str] = []
    controller.system_dialog_requested.connect(captured.append)

    assert controller.open_system_dialog("settings") == {"ok": True, "kind": "settings"}
    assert controller.open_system_dialog("factory_reset") == {"ok": True, "kind": "factory_reset"}
    assert controller.open_system_dialog("bogus")["ok"] is False

    assert captured == ["settings", "factory_reset"]


def test_emit_event_marshals_through_main_thread(qtbot, controller: OperationsController) -> None:
    import json
    import threading

    received: list[dict] = []
    controller.event.connect(lambda payload: received.append(json.loads(payload)))

    # Emit from a worker thread to make sure the proxy queues it back to the
    # main (QApplication) thread before reaching ``event``.
    worker = threading.Thread(target=lambda: controller._emit_event("log", {"kind": "conversation", "line": "hi"}))
    worker.start()
    worker.join()

    qtbot.waitUntil(lambda: bool(received), timeout=1000)
    assert received[-1]["type"] == "log"
    assert received[-1]["payload"]["kind"] == "conversation"


def test_bridge_action_slots_round_trip(qtbot, repo: Repository, options: RuntimeOptions) -> None:
    del qtbot
    controller = OperationsController(repo=repo, options=options, registry=None, profile_id=None)
    bridge = Bridge(BridgeContext(repo=repo, options=options), controller)

    payload = json.loads(bridge.collection_status())
    assert payload == {"running": []}

    payload = json.loads(bridge.collection_stop("audit"))
    assert payload["ok"] is False

    payload = json.loads(bridge.settings_update(json.dumps({"poll_interval_minutes": 20})))
    assert payload == {"ok": True}
    assert controller.options.poll_interval_minutes == 20
