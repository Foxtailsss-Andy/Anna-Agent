"""R1-T5b — Create drives the platform QueryEngine's single-call primitive.

Create is a SINGLE structured-output model call (not a ReAct loop): the model
emits exactly one ``create.emit_*_draft`` tool call that IS the draft, then the
orchestrator does deterministic post-processing (write → audit → validate /
sandbox). These tests inject a fake ``stream_model`` through the shared engine
seam (``tests.support.engine_fakes.FakeStreamModel`` via
``engine=QueryEngine(settings=..., deps=QueryDeps(stream_model=fake))``); each
fake yields ONE round — a ``final`` ModelChunk carrying the emit tool call (or a
terminal ``error`` chunk for the failure paths). All behavioral assertions
(draft generation, validation, sandbox, save/activate, path safety, fail paths,
audit sequences) are preserved from the pre-migration ``call_model`` tests.
"""
import json
from pathlib import Path

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
    """A single-round fake: one ``final`` chunk carrying the emit tool call.

    Mirrors Create's real single call — the model emits exactly one
    ``create.emit_*_draft`` tool call and stops (no observation, no re-ask).
    """
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
                "description": "Calculate overdue receivables ratio from fixture JSON.",
                "code": (
                    "import json, sys\n"
                    "payload = json.loads(sys.stdin.read())\n"
                    "total = payload['total_receivables']\n"
                    "overdue = payload['overdue_receivables']\n"
                    "print(round(overdue / total, 4))\n"
                ),
                "fixture_input": (
                    "{\"total_receivables\": 200000, \"overdue_receivables\": 50000}"
                ),
            },
        )
    )


def _unknown_tool_stream() -> FakeStreamModel:
    return _emit_stream(
        ModelToolCall(
            id="call_skill",
            name="create.emit_skill_draft",
            arguments={
                "skill_id": "hiker/broken-tool",
                "name": "broken-tool",
                "version": "0.1.0",
                "description": "Broken draft.",
                "allowed_tools": ["hiker.report.not_registered"],
                "forbidden_tools": [],
                "body": "# Broken\n",
            },
        )
    )


def _dangerous_write_tool_stream() -> FakeStreamModel:
    return _emit_stream(
        ModelToolCall(
            id="call_skill",
            name="create.emit_skill_draft",
            arguments={
                "skill_id": "hiker/dangerous-write",
                "name": "dangerous-write",
                "version": "0.1.0",
                "description": "Dangerous draft.",
                "allowed_tools": ["reimbursement.submit"],
                "forbidden_tools": [],
                "body": "# Dangerous\n",
            },
        )
    )


def _failing_stream() -> FakeStreamModel:
    """A single terminal ``error`` chunk — the transport-failure path.

    Mirrors the real ``stream_model``'s ``_fail`` for a retryable transport
    error: ``model.call.failed`` (retryable) then a terminal error chunk.
    """
    return FakeStreamModel(
        [
            [
                ModelChunk(
                    "error",
                    error_code="model_call_failed",
                    message="provider unavailable",
                )
            ]
        ]
    )


def _engine(stream_model, *, settings: RuntimeSettings = _CONFIGURED_SETTINGS) -> QueryEngine:
    return QueryEngine(settings=settings, deps=QueryDeps(stream_model=stream_model))


def _orchestrator(
    *,
    stream,
    project_root: Path,
    workspace_root: Path,
    settings: RuntimeSettings = _CONFIGURED_SETTINGS,
) -> CreateOrchestrator:
    return CreateOrchestrator(
        engine=_engine(stream, settings=settings),
        settings=settings,
        project_root=project_root,
        workspace_root=workspace_root,
    )


def test_create_skill_draft_uses_model_writes_isolated_draft_and_validates_with_skill_loader(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    stream = _skill_stream()
    orchestrator = _orchestrator(
        stream=stream,
        project_root=project_root,
        workspace_root=workspace_root,
    )

    run = orchestrator.create_skill_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个 Hiker 回款风险分析 Skill",
    )

    assert run.status == "ready_for_review"
    assert run.artifact is not None
    assert run.validation is not None
    assert run.validation.valid is True
    assert run.validation.loaded_skill_id == "hiker/collection-risk-analysis"
    assert run.artifact.path.startswith(str(workspace_root))
    assert Path(run.artifact.path).exists()
    assert not (project_root / "skills" / "hiker" / "collection-risk-analysis" / "SKILL.md").exists()
    assert [tool["name"] for tool in stream.requests[0].tools] == [
        "create.emit_skill_draft",
        "create.emit_prompt_draft",
        "create.emit_python_tool_draft",
    ]
    assert [event.type for event in run.audit_events] == [
        "create.skill.run.created",
        "model.call.started",
        "model.call.completed",
        "create.skill.generated",
        "create.skill.validated",
    ]
    completed_event = next(event for event in run.audit_events if event.type == "model.call.completed")
    assert completed_event.payload["tool_call_count"] == 1
    assert completed_event.payload["requested_tool_names"] == ["create.emit_skill_draft"]

    saved = orchestrator.save_skill(run.id, confirmed_by="u_demo")
    assert saved.status == "saved"
    loaded = SkillLoader(project_root=project_root).load("hiker/collection-risk-analysis")
    assert loaded.name == "collection-risk-analysis"
    assert loaded.allowed_tools == ["hiker.report.get_collection_summary"]
    assert loaded.forbidden_tools == ["reimbursement.submit"]


def test_create_skill_draft_prompt_lists_registered_tools_for_allowed_tools(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    stream = _skill_stream()
    orchestrator = _orchestrator(
        stream=stream,
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    orchestrator.create_skill_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个 Hiker 回款风险预检 Skill",
    )

    system_message = stream.requests[0].messages[0]
    assert system_message["role"] == "system"
    # The model must see the real registry so it cannot invent allowed_tools.
    for registered_tool in ("hiker.report.get_collection_summary", "reimbursement.validate_draft"):
        assert registered_tool in system_message["content"]
    assert "allowed_tools" in system_message["content"]
    # Unregistered tool names from earlier live runs must not be suggested.
    assert "validate_tax_id" not in system_message["content"]


def test_create_skill_draft_missing_model_config_keeps_model_audit_empty(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    unconfigured = RuntimeSettings()
    stream = _skill_stream()
    orchestrator = CreateOrchestrator(
        engine=_engine(stream, settings=unconfigured),
        settings=unconfigured,
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    run = orchestrator.create_skill_draft("demo", "u_demo", "创建一个 Hiker 回款风险分析 Skill")

    assert run.status == "failed"
    assert run.error_code == "model_not_configured"
    assert run.error_message == "model endpoint and API key are required before running Anna Create"
    # No configured model → the fake never records a request and emits no audit.
    assert stream.requests == []
    assert [event.type for event in run.audit_events] == [
        "create.skill.run.created",
        "create.failed",
    ]


def test_create_skill_draft_records_model_provider_failure(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        stream=_failing_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    run = orchestrator.create_skill_draft("demo", "u_demo", "创建一个逾期应收风险分析 Skill")

    assert run.status == "failed"
    assert run.error_code == "model_call_failed"
    assert run.error_message == "provider unavailable"
    assert [event.type for event in run.audit_events] == [
        "create.skill.run.created",
        "model.call.started",
        "model.call.failed",
        "create.failed",
    ]
    failed_event = next(event for event in run.audit_events if event.type == "model.call.failed")
    assert failed_event.payload == {"error_code": "model_call_failed", "retryable": True}


def test_create_skill_draft_model_audit_excludes_prompts_previews_and_secrets(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        stream=_skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    prompt = "创建一个包含 api_key=super-secret-token 的 Hiker 回款风险分析 Skill"

    run = orchestrator.create_skill_draft("demo", "u_demo", prompt)

    audit_json = json.dumps(
        [event.model_dump() for event in run.audit_events],
        ensure_ascii=False,
    )
    assert prompt not in audit_json
    assert "Collection Risk Analysis" not in audit_json
    assert "super-secret-token" not in audit_json
    assert "api_key" not in audit_json


def test_create_skill_draft_fails_when_model_emits_unregistered_allowed_tool(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        stream=_unknown_tool_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    run = orchestrator.create_skill_draft("demo", "u_demo", "创建一个坏工具 Skill")

    assert run.status == "failed"
    assert run.error_code == "tool_not_registered"
    assert run.validation is not None
    assert run.validation.valid is False
    assert "hiker.report.not_registered" in run.validation.errors


def test_create_skill_draft_rejects_dangerous_write_tools_in_allowed_tools(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        stream=_dangerous_write_tool_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    run = orchestrator.create_skill_draft("demo", "u_demo", "创建一个危险写入 Skill")

    assert run.status == "failed"
    assert run.error_code == "dangerous_tool_allowed"
    assert run.validation is not None
    assert "reimbursement.submit" in run.validation.errors


def test_create_skill_save_refuses_to_overwrite_existing_live_skill(tmp_path):
    project_root = tmp_path / "project"
    live_skill = project_root / "skills" / "hiker" / "collection-risk-analysis" / "SKILL.md"
    live_skill.parent.mkdir(parents=True)
    live_skill.write_text(
        "---\n"
        "name: existing\n"
        "version: 0.1.0\n"
        "allowed_tools:\n"
        "forbidden_tools:\n"
        "---\n"
        "\n"
        "# Existing\n",
        encoding="utf-8",
    )
    orchestrator = _orchestrator(
        stream=_skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    run = orchestrator.create_skill_draft("demo", "u_demo", "创建一个 Hiker 回款风险分析 Skill")

    saved = orchestrator.save_skill(run.id, confirmed_by="u_demo")

    assert saved.status == "failed"
    assert saved.error_code == "skill_already_exists"
    assert "name: existing" in live_skill.read_text(encoding="utf-8")


def test_create_prompt_draft_uses_model_and_writes_isolated_prompt_artifact(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    orchestrator = _orchestrator(
        stream=_prompt_stream(),
        project_root=project_root,
        workspace_root=workspace_root,
    )

    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个月度经营复盘 Prompt",
        kind="prompt",
    )

    assert run.kind == "prompt"
    assert run.status == "ready_for_review"
    assert run.artifact is not None
    assert run.artifact.kind == "prompt"
    assert run.artifact.prompt_id == "finance/monthly-review"
    assert run.artifact.path.startswith(str(workspace_root))
    assert Path(run.artifact.path).exists()
    assert "{period}" in run.artifact.preview
    assert run.validation is not None
    assert run.validation.valid is True
    assert [event.type for event in run.audit_events] == [
        "create.prompt.run.created",
        "model.call.started",
        "model.call.completed",
        "create.prompt.generated",
        "create.prompt.validated",
    ]


def test_create_prompt_draft_saves_to_prompt_library_only_after_confirmation(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    orchestrator = _orchestrator(
        stream=_prompt_stream(),
        project_root=project_root,
        workspace_root=workspace_root,
    )
    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个月度经营复盘 Prompt",
        kind="prompt",
    )
    live_prompt = project_root / "prompts" / "finance" / "monthly-review.md"
    assert not live_prompt.exists()

    saved = orchestrator.activate_artifact(run.id, confirmed_by="u_demo")

    assert saved.status == "saved"
    assert live_prompt.exists()
    assert "{period}" in live_prompt.read_text(encoding="utf-8")
    assert [event.type for event in saved.audit_events][-1] == "create.prompt.saved"


def test_create_prompt_save_refuses_to_overwrite_existing_live_prompt(tmp_path):
    project_root = tmp_path / "project"
    live_prompt = project_root / "prompts" / "finance" / "monthly-review.md"
    live_prompt.parent.mkdir(parents=True)
    live_prompt.write_text("existing prompt", encoding="utf-8")
    orchestrator = _orchestrator(
        stream=_prompt_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )
    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个月度经营复盘 Prompt",
        kind="prompt",
    )

    saved = orchestrator.activate_artifact(run.id, confirmed_by="u_demo")

    assert saved.status == "failed"
    assert saved.error_code == "prompt_already_exists"
    assert live_prompt.read_text(encoding="utf-8") == "existing prompt"


def test_create_python_tool_draft_runs_fixture_without_saving_live_tool(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    orchestrator = _orchestrator(
        stream=_python_tool_stream(),
        project_root=project_root,
        workspace_root=workspace_root,
    )

    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个逾期应收比例 Python 工具",
        kind="python_tool",
    )

    assert run.kind == "python_tool"
    assert run.status == "ready_for_review"
    assert run.artifact is not None
    assert run.artifact.kind == "python_tool"
    assert run.artifact.tool_id == "finance.calculate_overdue_ratio"
    assert run.artifact.path.startswith(str(workspace_root))
    assert Path(run.artifact.path).exists()
    assert run.sandbox_result is not None
    assert run.sandbox_result.passed is True
    assert run.activation_eligibility is not None
    assert run.activation_eligibility.activation_allowed is False
    assert run.activation_eligibility.safe_for_review is True
    assert run.activation_eligibility.blocking_reasons == [
        "hardened_sandbox_required",
        "python_tool_activation_review_required",
        "production_tool_registry_binding_required",
    ]
    assert run.activation_eligibility.evidence == [
        "fixture_passed",
        "ast_preflight_policy_recorded",
        "secret_boundary_enforced",
        "timeout_enforced",
        "output_cap_enforced",
    ]
    assert "0.25" in run.sandbox_result.stdout
    assert not (project_root / "tools" / "finance.calculate_overdue_ratio.py").exists()
    assert [event.type for event in run.audit_events] == [
        "create.python_tool.run.created",
        "model.call.started",
        "model.call.completed",
        "create.python_tool.generated",
        "create.python_tool.fixture_ran",
    ]


def test_create_python_tool_activation_is_blocked_until_hardened_sandbox_exists(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    orchestrator = _orchestrator(
        stream=_python_tool_stream(),
        project_root=project_root,
        workspace_root=workspace_root,
    )
    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个逾期应收比例 Python 工具",
        kind="python_tool",
    )

    activated = orchestrator.activate_artifact(run.id, confirmed_by="u_demo")

    assert activated.status == "failed"
    assert activated.error_code == "python_tool_activation_blocked"
    assert activated.activation_eligibility is not None
    assert activated.activation_eligibility.activation_allowed is False
    assert "hardened_sandbox_required" in activated.activation_eligibility.blocking_reasons
    assert not (project_root / "tools" / "finance.calculate_overdue_ratio.py").exists()
    assert [event.type for event in activated.audit_events][-1] == "create.failed"


def test_create_prompt_draft_rejects_symlinked_run_directory_escape(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    outside_root = tmp_path / "outside"
    outside_root.mkdir()
    symlink_path = workspace_root / "create_run_001" / "prompt"
    symlink_path.parent.mkdir(parents=True)
    symlink_path.symlink_to(outside_root, target_is_directory=True)
    orchestrator = _orchestrator(
        stream=_prompt_stream(),
        project_root=project_root,
        workspace_root=workspace_root,
    )

    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个月度经营复盘 Prompt",
        kind="prompt",
    )

    assert run.status == "failed"
    assert run.error_code == "prompt_draft_invalid"
    assert not any(outside_root.iterdir())


def test_create_python_tool_draft_rejects_symlinked_run_directory_escape(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    workspace_root = tmp_path / "create-runs"
    outside_root = tmp_path / "outside-python"
    outside_root.mkdir()
    symlink_path = workspace_root / "create_run_001" / "python_tool"
    symlink_path.parent.mkdir(parents=True)
    symlink_path.symlink_to(outside_root, target_is_directory=True)
    orchestrator = _orchestrator(
        stream=_python_tool_stream(),
        project_root=project_root,
        workspace_root=workspace_root,
    )

    run = orchestrator.create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建一个逾期应收比例 Python 工具",
        kind="python_tool",
    )

    assert run.status == "failed"
    assert run.error_code == "python_tool_draft_invalid"
    assert not any(outside_root.iterdir())
