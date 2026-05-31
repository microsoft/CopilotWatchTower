from __future__ import annotations

import io
import json
import sys
import types
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from copilot_watchtower.db import EdiscoveryJob, Repository, initialize
from copilot_watchtower.services import ediscovery, ediscovery_export
from copilot_watchtower.services.ediscovery import EdiscoveryOrchestrator


@pytest.fixture()
def repo(tmp_path: Path) -> Repository:
    db = tmp_path / "store.db"
    initialize(db)
    return Repository(db)


def _iso(hour: int = 12) -> str:
    return datetime(2026, 5, 1, hour, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _job(job_id: str = "job1", upn: str = "victim@contoso.com") -> EdiscoveryJob:
    now = _iso()
    return EdiscoveryJob(
        id=job_id,
        target_upn=upn,
        target_user_id=None,
        window_start="2026-05-01",
        window_end="2026-05-31",
        status="pending",
        case_id=None,
        search_id=None,
        operation_url=None,
        export_url=None,
        interactions_added=0,
        last_error=None,
        last_error_at=None,
        created_at=now,
        updated_at=now,
    )


# ---- repository CRUD ----------------------------------------------------


def test_ediscovery_job_crud(repo: Repository) -> None:
    job = _job()
    repo.upsert_ediscovery_job(job)
    fetched = repo.get_ediscovery_job(job.id)
    assert fetched is not None
    assert fetched.target_upn == "victim@contoso.com"
    assert fetched.status == "pending"

    job.status = "done"
    job.interactions_added = 7
    repo.upsert_ediscovery_job(job)
    again = repo.get_ediscovery_job(job.id)
    assert again is not None
    assert again.status == "done"
    assert again.interactions_added == 7

    jobs = repo.list_ediscovery_jobs()
    assert len(jobs) == 1
    assert jobs[0].id == job.id


# ---- export parser ------------------------------------------------------


def test_split_copilot_body_with_markers() -> None:
    body = "User: What is the revenue?\nCopilot: Revenue was $5M last quarter."
    turns = ediscovery_export.split_copilot_body(body)
    assert turns == [
        ("userPrompt", "What is the revenue?"),
        ("aiResponse", "Revenue was $5M last quarter."),
    ]


def test_split_copilot_body_no_markers_is_response() -> None:
    turns = ediscovery_export.split_copilot_body("Just some text")
    assert turns == [("aiResponse", "Just some text")]


def test_parse_export_bytes_json_zip() -> None:
    records = [
        {
            "id": "item1",
            "conversationId": "conv1",
            "createdDateTime": "2026-05-02T10:00:00Z",
            "app": "BizChat",
            "prompt": "Summarize Q2",
            "response": "Q2 was strong.",
        }
    ]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("items.json", json.dumps(records))
    items = ediscovery_export.parse_export_bytes(buf.getvalue())
    assert len(items) == 1
    item = items[0]
    assert item.conversation_id == "conv1"
    assert [t.interaction_type for t in item.turns] == ["userPrompt", "aiResponse"]


def test_parse_export_bytes_eml_zip() -> None:
    eml = (
        b"Subject: What is the weather?\r\n"
        b"Date: Sat, 02 May 2026 10:00:00 +0000\r\n"
        b"Message-ID: <abc@contoso.com>\r\n"
        b"Content-Type: text/plain; charset=utf-8\r\n\r\n"
        b"Copilot: It is sunny today."
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("msg.eml", eml)
    items = ediscovery_export.parse_export_bytes(buf.getvalue())
    assert len(items) == 1
    types = [t.interaction_type for t in items[0].turns]
    assert "userPrompt" in types
    assert "aiResponse" in types


def test_parse_msg_uses_teams_itemdata_stream(monkeypatch) -> None:
    inner = {
        "messageFrom": "8:orgid:user-id",
        "content": "커피주문하려구요\n중간크기에 고소한맛",
        "threadId": "19:thread@thread.v2",
        "contentSourceApplication": "MicrosoftTeams",
    }
    outer = {"SchemaVersion": 1, "ItemData": json.dumps(inner, ensure_ascii=False)}
    stream = json.dumps(outer, ensure_ascii=False).encode("utf-16le")

    class FakeMsg:
        subject = "\x00"
        messageId = "1777593743001\x00"
        date = datetime(2026, 5, 1, 0, 2, 23, tzinfo=timezone.utc)
        sender = "jechoi\x00 <jechoi@contoso.com\x00>"
        body = None
        htmlBody = "<html><body>fallback</body></html>".encode("cp949")

        def getStream(self, name: str):
            if name == "__substg1.0_8008001F":
                return stream
            return None

        def close(self) -> None:
            return None

    fake_module = types.SimpleNamespace(openMsg=lambda _data: FakeMsg())
    monkeypatch.setitem(sys.modules, "extract_msg", fake_module)

    item = ediscovery_export._parse_msg_bytes(b"fake-msg", "item_2.msg")

    assert item is not None
    assert item.item_id == "1777593743001"
    assert item.conversation_id == "19:thread@thread.v2"
    assert len(item.turns) == 1
    assert item.turns[0].interaction_type == "userPrompt"
    assert item.turns[0].body_text == "커피주문하려구요\n중간크기에 고소한맛"
    assert item.raw["itemData"]["contentSourceApplication"] == "MicrosoftTeams"


def test_teams_itemdata_application_sender_is_response() -> None:
    assert ediscovery_export._teams_turn_type(
        {
            "messageFrom": "28:bot-id",
            "from": {"internalId": "28:bot-id", "recipientType": "Applications"},
        }
    ) == "aiResponse"


def test_items_to_interaction_rows_dedupes() -> None:
    records = [
        {
            "id": "item1",
            "conversationId": "conv1",
            "createdDateTime": "2026-05-02T10:00:00Z",
            "prompt": "Hi",
            "response": "Hello",
        }
    ]
    items = ediscovery_export._parse_json_text(json.dumps(records), "x")
    rows1 = ediscovery_export.items_to_interaction_rows(items, user_id="u1")
    rows2 = ediscovery_export.items_to_interaction_rows(items, user_id="u1")
    assert len(rows1) == 2
    # Stable ids across runs so repo upsert is idempotent.
    assert {r.id for r in rows1} == {r.id for r in rows2}
    assert all(r.user_id == "u1" for r in rows1)


# ---- orchestrator -------------------------------------------------------


class _FakeGraph:
    """Minimal stub mirroring the GraphClient eDiscovery surface."""

    def __init__(self, export_payload: dict, package: bytes) -> None:
        self._export_payload = export_payload
        self._package = package
        self.calls: list[str] = []

    def preflight_ediscovery(self):
        self.calls.append("preflight")

    def create_ediscovery_case(self, display_name, *, description=None):
        self.calls.append("case")
        return {"id": "case-1", "displayName": display_name}

    def find_ediscovery_case(self, display_name):
        self.calls.append("find-case")
        return {"id": "case-1", "displayName": display_name}

    def find_ediscovery_search(self, case_id, display_name):
        self.calls.append("find-search")
        return {"id": "search-1", "displayName": display_name}

    def add_ediscovery_search(self, case_id, *, display_name, content_query, mailbox_emails):
        self.calls.append("search")
        assert mailbox_emails == ["victim@contoso.com"]
        return {"id": "search-1"}

    def estimate_ediscovery_search(self, case_id, search_id):
        self.calls.append("estimate")
        return {"operation_location": "https://graph/op/estimate", "status_code": 202}

    def export_ediscovery_search(
        self,
        case_id,
        search_id,
        *,
        display_name,
        export_format="msg",
        additional_options="splitSource, includeFolderAndPath, condensePaths, friendlyName",
    ):
        self.calls.append("export")
        assert export_format == "msg"
        assert "includeFolderAndPath" in additional_options
        return {"operation_location": "https://graph/op/export", "status_code": 202}

    def get_ediscovery_operation(self, operation_url):
        if operation_url.endswith("export"):
            return self._export_payload
        return {"status": "succeeded"}

    def download_ediscovery_export(self, download_url, *, on_progress=None):
        self.calls.append("download")
        assert download_url
        if on_progress is not None:
            on_progress(0, len(self._package))
            on_progress(len(self._package), len(self._package))
        return self._package


def _zip_with(records: list[dict]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("items.json", json.dumps(records))
    return buf.getvalue()


def test_orchestrator_full_pipeline(repo: Repository) -> None:
    package = _zip_with(
        [
            {
                "id": "i1",
                "conversationId": "conv1",
                "createdDateTime": "2026-05-02T10:00:00Z",
                "prompt": "secret prompt",
                "response": "secret answer",
            }
        ]
    )
    export_payload = {
        "status": "succeeded",
        "exportFileMetadata": [{"downloadUrl": "https://blob/export.zip"}],
    }
    graph = _FakeGraph(export_payload, package)
    job = _job()
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(graph, repo, poll_seconds=0, max_poll_seconds=5)
    rows = orch.run(job)

    assert graph.calls == ["preflight", "case", "search", "estimate", "export", "download"]
    assert len(rows) == 2
    assert job.case_id == "case-1"
    assert job.search_id == "search-1"
    assert job.export_url == "https://blob/export.zip"
    # body text preserved end to end
    bodies = {r.body_text for r in rows}
    assert "secret prompt" in bodies
    assert "secret answer" in bodies


def test_orchestrator_records_error_on_failed_export(repo: Repository) -> None:
    graph = _FakeGraph({"status": "failed", "statusDetail": "boom"}, b"")
    job = _job(job_id="job-err")
    repo.upsert_ediscovery_job(job)
    orch = EdiscoveryOrchestrator(graph, repo, poll_seconds=0, max_poll_seconds=5)
    with pytest.raises(ediscovery.EdiscoveryError):
        orch.run(job)
    saved = repo.get_ediscovery_job("job-err")
    assert saved is not None
    assert saved.status == "error"
    assert saved.last_error


def test_build_content_query_includes_dates() -> None:
    q = ediscovery.build_copilot_content_query("2026-05-01", "2026-05-31")
    assert "2026-05-01" in q
    assert "2026-05-31" in q
    assert "received" in q
    # Copilot-specific ItemClass surfaces must be present.
    assert "IPM.SkypeTeams.Message.Copilot.*" in q
    assert "IPM.SkypeTeams.TeamCopilot*" in q


# ---- resumption ---------------------------------------------------------


def test_orchestrator_resumes_from_export_operation(repo: Repository) -> None:
    """A job interrupted mid-export reconnects to its saved operation_url
    instead of re-creating the case/search/estimate/export."""
    package = _zip_with(
        [
            {
                "id": "i1",
                "conversationId": "conv1",
                "createdDateTime": "2026-05-02T10:00:00Z",
                "prompt": "resumed prompt",
                "response": "resumed answer",
            }
        ]
    )
    export_payload = {
        "status": "succeeded",
        "exportFileMetadata": [{"downloadUrl": "https://blob/export.zip"}],
    }
    graph = _FakeGraph(export_payload, package)
    job = _job(job_id="job-resume-export")
    job.status = "exporting"
    job.case_id = "case-1"
    job.search_id = "search-1"
    job.operation_url = "https://graph/op/export"
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(graph, repo, poll_seconds=0, max_poll_seconds=5)
    rows = orch.run(job)

    # No case/search/estimate/export re-issued — only the download happens.
    assert graph.calls == ["download"]
    assert len(rows) == 2
    assert job.export_url == "https://blob/export.zip"


def test_orchestrator_resumes_from_download(repo: Repository) -> None:
    """A job already past export jumps straight to download/parse."""
    package = _zip_with(
        [
            {
                "id": "i1",
                "conversationId": "conv1",
                "createdDateTime": "2026-05-02T10:00:00Z",
                "prompt": "p",
                "response": "r",
            }
        ]
    )
    graph = _FakeGraph({"status": "succeeded"}, package)
    job = _job(job_id="job-resume-download")
    job.status = "downloading"
    job.case_id = "case-1"
    job.search_id = "search-1"
    job.export_url = "https://blob/export.zip"
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(graph, repo, poll_seconds=0, max_poll_seconds=5)
    rows = orch.run(job)

    assert graph.calls == ["download"]
    assert len(rows) == 2


# ---- permission preflight ----------------------------------------------


def test_orchestrator_surfaces_preflight_denial(repo: Repository) -> None:
    """A 403 on the preflight check fails fast before any case is created."""
    from copilot_watchtower.services.graph import GraphError

    class _DeniedGraph(_FakeGraph):
        def preflight_ediscovery(self):
            self.calls.append("preflight")
            raise GraphError(403, "eDiscovery 접근이 거부되었습니다(403).")

    graph = _DeniedGraph({"status": "succeeded"}, b"")
    job = _job(job_id="job-denied")
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(graph, repo, poll_seconds=0, max_poll_seconds=5)
    with pytest.raises(ediscovery.EdiscoveryError):
        orch.run(job)

    # Nothing past preflight ran, and the failure is recorded on the job.
    assert graph.calls == ["preflight"]
    saved = repo.get_ediscovery_job("job-denied")
    assert saved is not None
    assert saved.status == "error"
    assert "403" in (saved.last_error or "")


def test_proxy_download_url_does_not_loop_reexport(repo: Repository) -> None:
    """The direct-download proxy goes straight to browser fallback; if no
    fallback is wired, the orchestrator errors without re-exporting."""

    proxy_url = (
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/"
        "ediscovery/api/proxy/exportaedblobFileResult(abc123)"
    )

    export_payload = {
        "status": "succeeded",
        "exportFileMetadata": [{"downloadUrl": proxy_url}],
    }
    graph = _FakeGraph(export_payload, b"")
    job = _job(job_id="job-proxy")
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(graph, repo, poll_seconds=0, max_poll_seconds=5)
    with pytest.raises(ediscovery.EdiscoveryError):
        orch.run(job)

    # Exactly one export; no token download attempt and no re-export loop.
    assert graph.calls.count("export") == 1
    assert graph.calls.count("download") == 0
    # The completed export pointer is preserved for diagnostics/resume.
    assert job.export_url == proxy_url


def test_proxy_url_uses_browser_downloader_immediately(repo: Repository) -> None:
    """Direct proxy URLs bypass backend token download and use browser capture."""
    proxy_url = (
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/"
        "ediscovery/api/proxy/exportaedblobFileResult(abc123)"
    )
    package = _zip_with(
        [
            {
                "id": "i1",
                "conversationId": "conv1",
                "createdDateTime": "2026-05-02T10:00:00Z",
                "prompt": "p",
                "response": "r",
            }
        ]
    )

    export_payload = {
        "status": "succeeded",
        "exportFileMetadata": [{"downloadUrl": proxy_url}],
    }
    graph = _FakeGraph(export_payload, package)
    job = _job(job_id="job-proxy-token")
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(
        graph,
        repo,
        browser_downloader=lambda url: package,
        poll_seconds=0,
        max_poll_seconds=5,
    )
    rows = orch.run(job)

    assert "download" not in graph.calls
    assert len(rows) == 2


def test_auth_redirect_uses_automatic_browser_fallback(repo: Repository) -> None:
    """When token download is rejected (auth redirect), the orchestrator uses
    the automatic headless browser downloader and parses its result."""
    from copilot_watchtower.services.graph import GraphError

    proxy_url = (
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/"
        "ediscovery/api/proxy/exportaedblobFileResult(abc123)"
    )

    class _RedirectGraph(_FakeGraph):
        def download_ediscovery_export(self, download_url, *, on_progress=None):
            self.calls.append("download")
            raise GraphError(401, "login redirect", auth_redirect=True)

    export_payload = {
        "status": "succeeded",
        "exportFileMetadata": [{"downloadUrl": proxy_url}],
    }
    graph = _RedirectGraph(export_payload, b"")
    job = _job(job_id="job-proxy-fallback")
    repo.upsert_ediscovery_job(job)
    package = _zip_with(
        [
            {
                "id": "i1",
                "conversationId": "conv1",
                "createdDateTime": "2026-05-02T10:00:00Z",
                "prompt": "p",
                "response": "r",
            }
        ]
    )
    seen: list[str] = []

    orch = EdiscoveryOrchestrator(
        graph,
        repo,
        browser_downloader=lambda url: seen.append(url) or package,
        poll_seconds=0,
        max_poll_seconds=5,
    )
    rows = orch.run(job)

    assert "download" not in graph.calls
    assert seen == [proxy_url]
    assert len(rows) == 2


def test_proxy_auth_failure_preserves_export_url(repo: Repository) -> None:
    """A proxy auth failure records an error but preserves the completed
    export URL so diagnostics can see exactly what Graph returned."""
    from copilot_watchtower.services.graph import GraphError

    proxy_url = (
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/"
        "ediscovery/api/proxy/exportaedblobFileResult(abc123)"
    )

    class _RedirectGraph(_FakeGraph):
        def download_ediscovery_export(self, download_url, *, on_progress=None):
            self.calls.append("download")
            raise GraphError(401, "login redirect", auth_redirect=True)

    export_payload = {
        "status": "succeeded",
        "exportFileMetadata": [{"downloadUrl": proxy_url}],
    }
    graph = _RedirectGraph(export_payload, b"")
    job = _job(job_id="job-proxy-cancel")
    repo.upsert_ediscovery_job(job)

    orch = EdiscoveryOrchestrator(
        graph,
        repo,
        poll_seconds=0,
        max_poll_seconds=5,
    )
    with pytest.raises(ediscovery.EdiscoveryError):
        orch.run(job)
    saved = repo.get_ediscovery_job("job-proxy-cancel")
    assert saved is not None
    assert saved.export_url == proxy_url


def test_azure_blob_sas_preferred_over_proxy_url(repo: Repository) -> None:
    """When Graph offers both a proxy URL and an Azure Blob SAS link, the
    programmatic SAS link must win."""
    url, is_proxy = EdiscoveryOrchestrator._extract_download_url(
        {
            "exportFileMetadata": [
                {
                    "downloadUrl": (
                        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/"
                        "ediscovery/api/proxy/exportaedblobFileResult(abc)"
                    )
                }
            ],
            "azureBlobUrl": "https://acct.blob.core.windows.net/container/export.zip",
            "azureBlobToken": "sv=2021&sig=xyz",
        }
    )
    assert url == "https://acct.blob.core.windows.net/container/export.zip?sv=2021&sig=xyz"
    assert is_proxy is False


def test_items_package_download_url_preferred_over_reports_zip(repo: Repository) -> None:
    url, is_proxy = EdiscoveryOrchestrator._extract_download_url(
        {
            "exportFileMetadata": [
                {
                    "fileName": "Reports-CopilotWatchTower.zip",
                    "size": 84_678,
                    "downloadUrl": "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/reports",
                },
                {
                    "fileName": "Items.1.001.Export_user.zip",
                    "size": 90_239_488,
                    "downloadUrl": "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/items",
                },
            ]
        }
    )
    assert url == "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/items"
    assert is_proxy is True


def test_reports_direct_download_proxy_url_is_detected() -> None:
    import base64
    import json

    payload = base64.b64encode(
        json.dumps({"FileName": "Reports-CopilotWatchTower-export"}).encode("utf-8")
    ).decode("ascii")
    url = (
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/ediscovery/api/proxy/"
        f"exportaedblobFileResult({payload})"
    )
    assert ediscovery._is_reports_download_url(url) is True

    payload2 = base64.b64encode(
        json.dumps({"FileName": "Items.1.001.Export_user.zip"}).encode("utf-8")
    ).decode("ascii")
    url2 = (
        "https://nam.proxyservice.ediscovery.svc.cloud.microsoft/ediscovery/api/proxy/"
        f"exportaedblobFileResult({payload2})"
    )
    assert ediscovery._is_reports_download_url(url2) is False


# ---- manual download + ZIP import escape hatch --------------------------


def test_worker_imports_local_zip_without_graph(repo: Repository, qtbot) -> None:
    """The import escape hatch ingests a manually-downloaded ZIP entirely
    offline: no Graph calls, interactions stored, job marked done."""
    del qtbot  # ensures a QApplication exists for the QObject worker
    from copilot_watchtower.workers.ediscovery_collector import (
        EdiscoveryCollectorWorker,
    )

    package = _zip_with(
        [
            {
                "id": "i1",
                "conversationId": "conv1",
                "createdDateTime": "2026-05-02T10:00:00Z",
                "prompt": "imported prompt",
                "response": "imported answer",
            }
        ]
    )
    zip_path = repo.db_path.parent / "manual-export.zip"
    zip_path.write_bytes(package)

    finished: list[tuple[str, int, int]] = []
    worker = EdiscoveryCollectorWorker(
        repo,
        "victim@contoso.com",
        trigger="import",
        import_path=str(zip_path),
    )
    worker.cycle_finished.connect(lambda upn, added, errors: finished.append((upn, added, errors)))
    worker.run()

    assert finished and finished[-1][1] == 2  # two turns (prompt + response)
    assert finished[-1][2] == 0  # no errors

    jobs = repo.list_ediscovery_jobs()
    assert len(jobs) == 1
    saved = jobs[0]
    assert saved.status == "done"
    assert saved.interactions_added == 2
    assert saved.export_url is None  # cleared after consuming the package

    rows = repo.list_interactions(user_id="victim@contoso.com")
    bodies = {r.body_text for r in rows}
    assert "imported prompt" in bodies
    assert "imported answer" in bodies
