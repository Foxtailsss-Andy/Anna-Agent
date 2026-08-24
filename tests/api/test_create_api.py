"""R1-T5b — Create API drives the platform QueryEngine single-call primitive.

The API-layer counterpart of ``tests/create/test_create_skill_draft.py``: the
orchestrators injected into ``create_app`` now carry a fake ``stream_model``
through the shared engine seam (``engine=QueryEngine(settings=...,
deps=QueryDeps(stream_model=fake))``) instead of a fake ``model_provider``. Each
fake yields ONE round — a ``final`` ModelChunk carrying the ``create.emit_*_draft``
tool call — mirroring Create's real single structured-output call. All API
behavioral assertions (review artifact, activation, sandbox, save/session
guards, 404) are preserved.
"""
from pathlib import Path

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.create.app.orchestrator import CreateOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


def _emit_stream(tool_call: ModelToolCall) -> FakeStreamModel:
    """A single-round fake: one ``final`` chunk carrying the emit tool call."""
    return FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    tool_calls=(tool_call,),
                    finish_reason="tool_calls",
                ),
            ]
        ]
    )


def _skill_stream() -> FakeStreamModel:
    return _emit_stream(
        ModelToolCall(
            id="call_skill",
            name="create.emit_skill_draft",
            arguments={
                "skill_id": "hiker/collection-risk-analysis",
                "name": "collection-risk-analysis",
                "version": "0.1.0",
                "description": "Analyze collection risk from Hiker data.",
                "allowed_tools": ["hiker.report.get_collection_summary"],
                "forbidden_tools": ["reimbursement.submit"],
                "body": "# Collection Risk Analysis\n\nUse Hiker data only.",
            },
        )
    )


def _prompt_stream() -> FakeStreamModel:
    return _emit_stream(
        ModelToolCall(
            id="call_prompt",
            name="create.emit_prompt_draft",
            arguments={
                "prompt_id": "finance/monthly-review",
                "title": "月度经营复盘 Prompt",
                "description": "Summarize monthly financial operating data.",
                "body": "请基于 {period} 的收入、费用和应收数据生成经营复盘。",
                "variables": ["period"],
            },
        )
    )


def _python_tool_stream() -> FakeStreamModel:
    return _emit_stream(
        ModelToolCall(
            id="call_python_tool",
            name="create.emit_python_tool_draft",
            arguments={
                "tool_id": "finance.calculate_overdue_ratio",
                "name": "calculate_overdue_ratio",
                "description": "Calculate overdue receivables ratio.",
                "code": (
                    "import json, sys\n"
                    "payload = json.loads(sys.stdin.read())\n"
                    "print(payload['overdue_receivables'] / payload['total_receivables'])\n"
                ),
                "fixture_input": (
                    "{\"total_receivables\": 200000, \"overdue_receivables\": 50000}"
                ),
            },
        )
    )


def _orchestrator(stream, *, project_root: Path, workspace_root: Path) -> CreateOrchestrator:
    return CreateOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=stream)
        ),
        settings=_CONFIGURED_SETTINGS,
        project_root=project_root,
        workspace_root=workspace_root,
    )


def test_default_create_skill_draft_fails_setup_instead_of_fake_success(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    client = TestClient(create_app())

    response = client.post(
        "/api/create/skills",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "prompt": "创建一个 Hiker 回款风险分析 Skill",
        },
    )

    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "failed"
    assert body["error_code"] == "model_not_configured"
    assert body["artifact"] is None


def test_create_prompt_draft_api_returns_review_artifact_without_live_save(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _prompt_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))

    response = client.post(
        "/api/create/drafts",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "创建一个月度经营复盘 Prompt",
        },
    )

    body = response.json()
    assert response.status_code == 200
    assert body["kind"] == "prompt"
    assert body["status"] == "ready_for_review"
    assert body["artifact"]["kind"] == "prompt"
    assert body["artifact"]["prompt_id"] == "finance/monthly-review"
    assert not (project_root / "prompts" / "finance" / "monthly-review.md").exists()


def test_create_prompt_draft_api_activates_prompt_after_confirmation(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _prompt_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))
    create_response = client.post(
        "/api/create/drafts",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "创建一个月度经营复盘 Prompt",
        },
    )
    run_id = create_response.json()["id"]

    response = client.post(
        f"/api/create/drafts/{run_id}/activate",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={"confirmed_by": "u_demo"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "saved"
    assert body["kind"] == "prompt"
    live_prompt = project_root / "prompts" / "finance" / "monthly-review.md"
    assert live_prompt.exists()
    assert "{period}" in live_prompt.read_text(encoding="utf-8")


def test_create_draft_activation_checks_session_before_writing_live_prompt(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _prompt_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))
    create_response = client.post(
        "/api/create/drafts",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "创建一个月度经营复盘 Prompt",
        },
    )
    run_id = create_response.json()["id"]

    response = client.post(
        f"/api/create/drafts/{run_id}/activate",
        headers={"X-Anna-Workspace-ID": "other", "X-Anna-User-ID": "u_demo"},
        json={"confirmed_by": "u_demo"},
    )

    assert response.status_code == 403
    assert not (project_root / "prompts" / "finance" / "monthly-review.md").exists()


def test_create_python_tool_draft_api_runs_fixture_without_live_save(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _python_tool_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))

    response = client.post(
        "/api/create/drafts",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "python_tool",
            "prompt": "创建一个逾期应收比例 Python 工具",
        },
    )

    body = response.json()
    assert response.status_code == 200
    assert body["kind"] == "python_tool"
    assert body["status"] == "ready_for_review"
    assert body["artifact"]["kind"] == "python_tool"
    assert body["artifact"]["tool_id"] == "finance.calculate_overdue_ratio"
    assert body["sandbox_result"]["passed"] is True
    assert body["activation_eligibility"] == {
        "activation_allowed": False,
        "safe_for_review": True,
        "blocking_reasons": [
            "hardened_sandbox_required",
            "python_tool_activation_review_required",
            "production_tool_registry_binding_required",
        ],
        "evidence": [
            "fixture_passed",
            "ast_preflight_policy_recorded",
            "secret_boundary_enforced",
            "timeout_enforced",
            "output_cap_enforced",
        ],
    }
    assert "0.25" in body["sandbox_result"]["stdout"]
    assert not (project_root / "tools" / "finance.calculate_overdue_ratio.py").exists()


def test_create_python_tool_activation_api_is_blocked(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _python_tool_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))
    create_response = client.post(
        "/api/create/drafts",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "python_tool",
            "prompt": "创建一个逾期应收比例 Python 工具",
        },
    )
    run_id = create_response.json()["id"]

    response = client.post(
        f"/api/create/drafts/{run_id}/activate",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={"confirmed_by": "u_demo"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["error_code"] == "python_tool_activation_blocked"
    assert body["activation_eligibility"]["activation_allowed"] is False
    assert "hardened_sandbox_required" in body["activation_eligibility"]["blocking_reasons"]
    assert not (project_root / "tools" / "finance.calculate_overdue_ratio.py").exists()


def test_create_skill_draft_api_saves_only_after_confirmation(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))

    response = client.post(
        "/api/create/skills",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "prompt": "创建一个 Hiker 回款风险分析 Skill",
        },
    )
    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "ready_for_review"
    assert not (project_root / "skills" / "hiker" / "collection-risk-analysis" / "SKILL.md").exists()

    save_response = client.post(
        f"/api/create/skills/{body['id']}/save",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={"confirmed_by": "u_demo"},
    )

    assert save_response.status_code == 200
    assert save_response.json()["status"] == "saved"
    loaded = SkillLoader(project_root=project_root).load("hiker/collection-risk-analysis")
    assert loaded.name == "collection-risk-analysis"


def test_create_skill_save_checks_session_before_writing_live_skill(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))
    create_response = client.post(
        "/api/create/skills",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "prompt": "创建一个 Hiker 回款风险分析 Skill",
        },
    )
    run_id = create_response.json()["id"]

    response = client.post(
        f"/api/create/skills/{run_id}/save",
        headers={"X-Anna-Workspace-ID": "other", "X-Anna-User-ID": "u_demo"},
        json={"confirmed_by": "u_demo"},
    )

    assert response.status_code == 403
    assert not (project_root / "skills" / "hiker" / "collection-risk-analysis" / "SKILL.md").exists()


def test_create_skill_save_unknown_run_returns_404(tmp_path):
    orchestrator = _orchestrator(
        _skill_stream(),
        project_root=tmp_path / "project",
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))

    response = client.post(
        "/api/create/skills/create_run_missing/save",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={"confirmed_by": "u_demo"},
    )

    assert response.status_code == 404


def test_list_create_drafts_scopes_to_header_workspace(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        _prompt_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))
    headers = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"}

    created = client.post(
        "/api/create/drafts",
        headers=headers,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "创建一个月度经营复盘 Prompt",
        },
    ).json()

    listed = client.get("/api/create/drafts", headers=headers)
    assert listed.status_code == 200
    runs = listed.json()
    assert [run["id"] for run in runs] == [created["id"]]
    assert runs[0]["kind"] == "prompt"

    other = client.get(
        "/api/create/drafts",
        headers={"X-Anna-Workspace-ID": "other-ws", "X-Anna-User-ID": "u_demo"},
    )
    assert other.status_code == 200
    assert other.json() == []


def test_list_create_drafts_returns_newest_first_and_scopes_to_actor_and_workspace(tmp_path):
    """Locks in the ordering contract the frontend Artifact Center depends on
    (``services/create/app/orchestrator.py::CreateOrchestrator.list_runs``):
    runs for a given (workspace, actor) come back NEWEST-FIRST, and runs from
    a different actor or a different workspace must not leak in.

    Each governed ``create_draft`` call consumes one script round from the
    fake stream, so the fake below is built with one round per POST made in
    this test (2 for the primary actor, 1 for another actor, 1 for another
    workspace).
    """
    project_root = tmp_path / "project"
    project_root.mkdir()

    def _round():
        return _prompt_stream()._scripts[0]

    orchestrator = _orchestrator(
        FakeStreamModel([_round(), _round(), _round(), _round()]),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    client = TestClient(create_app(create_orchestrator=orchestrator))
    headers = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"}

    first = client.post(
        "/api/create/drafts",
        headers=headers,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "创建第一个月度经营复盘 Prompt",
        },
    ).json()
    second = client.post(
        "/api/create/drafts",
        headers=headers,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "创建第二个月度经营复盘 Prompt",
        },
    ).json()

    # A different actor in the SAME workspace must not appear in u_demo's list.
    other_actor_headers = {"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_other"}
    client.post(
        "/api/create/drafts",
        headers=other_actor_headers,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_other",
            "kind": "prompt",
            "prompt": "另一个用户创建的 Prompt",
        },
    )

    # A different workspace (same actor id) must also not appear.
    other_workspace_headers = {"X-Anna-Workspace-ID": "other-ws", "X-Anna-User-ID": "u_demo"}
    client.post(
        "/api/create/drafts",
        headers=other_workspace_headers,
        json={
            "workspace_id": "other-ws",
            "actor_user_id": "u_demo",
            "kind": "prompt",
            "prompt": "另一个工作区创建的 Prompt",
        },
    )

    listed = client.get("/api/create/drafts", headers=headers)
    assert listed.status_code == 200
    runs = listed.json()
    # Newest-first: the second-created run's id is at index 0.
    assert [run["id"] for run in runs] == [second["id"], first["id"]]

    other_actor_ids = [
        run["id"] for run in client.get("/api/create/drafts", headers=other_actor_headers).json()
    ]
    assert first["id"] not in other_actor_ids
    assert second["id"] not in other_actor_ids

    other_workspace_ids = [
        run["id"]
        for run in client.get("/api/create/drafts", headers=other_workspace_headers).json()
    ]
    assert first["id"] not in other_workspace_ids
    assert second["id"] not in other_workspace_ids
