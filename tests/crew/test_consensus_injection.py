"""B1b · 项目共识注入 + 命中审计 (RED).

The Crew worker's prompt assembly folds the project's ``scope="project"`` 共识
entries in as a numbered「项目共识」block, and the run's audit payload records
exactly which items were injected (``memory_hits``). No 共识 → no such prompt
section AND an empty ``memory_hits`` list — never a fabricated block.

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

import pytest

from services.crew.app.agent_worker import AgentWorkerExecutor, CrewAgentError
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.memory.app.store import BusinessMemoryStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class _TextModel(FakeStreamModel):
    """Governed fake returning a fixed deliverable; requests are captured on
    ``self.requests`` by the base class (prompt-assembly assertions)."""

    def __init__(self, text: str = "# PRD\n- 目标\n- 范围") -> None:
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text, tool_calls=[], finish_reason="stop"
        )


def _service_with_prd_ready(tmp_path):
    """A crew project (via the service) with the PRD task assigned to an agent."""
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    project = crew.create_project("ws1", "acc_boss", "登录页重设计", "feature_iteration")
    brief = next(t for t in project.tasks if t.key == "brief")
    crew.assign(project.id, brief.id, "acc_boss")
    crew.start(project.id, brief.id)
    crew.submit(project.id, brief.id, "需求简报")
    prd = next(t for t in crew.get_project(project.id).tasks if t.key == "prd")
    crew.assign(project.id, prd.id, "acc_agent_scribe")
    return crew, project.id, prd.id


def _memory_with_consensus(tmp_path, project_id):
    memory = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    first = memory.add(
        workspace_id="ws1", memory_type="口径",
        title="登录页只在远程 4xx 形态出现",
        content="登录页只在远程 4xx 形态出现", source="crew",
        scope="project", project_id=project_id,
    )
    second = memory.add(
        workspace_id="ws1", memory_type="决策",
        title="主色只用 iris", content="主色只用 iris #575BC4,不引入新主色",
        source="crew", scope="project", project_id=project_id,
    )
    return memory, first, second


def _user_prompt(model: FakeStreamModel) -> str:
    assert model.requests, "the Worker Profile never reached the model"
    return next(
        m["content"] for m in model.requests[0].messages if m["role"] == "user"
    )


def test_worker_prompt_contains_consensus_and_audits_hits(tmp_path):
    crew, project_id, prd_id = _service_with_prd_ready(tmp_path)
    memory, first, second = _memory_with_consensus(tmp_path, project_id)
    model = _TextModel()
    executor = AgentWorkerExecutor(
        settings=_CONFIGURED, deps=QueryDeps(stream_model=model), memory_store=memory,
    )

    updated, result = crew.run_agent(project_id, prd_id, executor, run_ref="crew_run_101")

    # The numbered 共识 block is in the Worker Profile's user prompt, oldest first.
    prompt = _user_prompt(model)
    assert (
        "项目共识：\n"
        "1. [口径] 登录页只在远程 4xx 形态出现\n"
        "2. [决策] 主色只用 iris #575BC4,不引入新主色"
    ) in prompt

    # 命中审计:the executor reports exactly the injected item ids …
    assert result.memory_hits == [first.id, second.id]
    # … the run's audit payload carries them …
    event = updated.audit_events[-1]
    assert event["type"] == "crew.task.agent_run"
    assert event["payload"]["memory_hits"] == [first.id, second.id]
    assert event["payload"]["run_ref"] == "crew_run_101"
    # … and the fact is readable through the persisted project audit trail
    # (the same data GET /api/crew/projects/{id} serves to F4).
    persisted = crew.get_project(project_id)
    agent_runs = [
        e["payload"] for e in persisted.audit_events
        if e["type"] == "crew.task.agent_run"
    ]
    assert agent_runs and agent_runs[-1]["memory_hits"] == [first.id, second.id]


def test_no_project_consensus_no_prompt_section_and_empty_hits(tmp_path):
    """Workspace-scoped knowledge is NOT 共识: no block is injected for it."""
    crew, project_id, prd_id = _service_with_prd_ready(tmp_path)
    memory = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    memory.add(  # workspace item only — must not leak into the project prompt
        workspace_id="ws1", memory_type="business_rule",
        title="全局规则", content="全局规则内容。", source="admin",
    )
    model = _TextModel()
    executor = AgentWorkerExecutor(
        settings=_CONFIGURED, deps=QueryDeps(stream_model=model), memory_store=memory,
    )

    updated, result = crew.run_agent(project_id, prd_id, executor)

    assert "项目共识" not in _user_prompt(model)
    assert result.memory_hits == []
    event = updated.audit_events[-1]
    assert event["type"] == "crew.task.agent_run"
    assert event["payload"]["memory_hits"] == []


def test_blocked_run_audit_still_carries_memory_hits(tmp_path):
    """A failed run is still a run: its 阻塞 audit records what was injected."""
    crew, project_id, prd_id = _service_with_prd_ready(tmp_path)
    memory, first, second = _memory_with_consensus(tmp_path, project_id)
    executor = AgentWorkerExecutor(
        # Model unconfigured -> the Worker Profile fails -> the task BLOCKS (绝不假完成).
        settings=RuntimeSettings(),
        deps=QueryDeps(stream_model=_TextModel()),
        memory_store=memory,
    )

    with pytest.raises(CrewAgentError) as excinfo:
        crew.run_agent(project_id, prd_id, executor, run_ref="crew_run_102")

    assert excinfo.value.memory_hits == [first.id, second.id]
    persisted = crew.get_project(project_id)
    event = persisted.audit_events[-1]
    assert event["type"] == "crew.task.agent_blocked"
    assert event["payload"]["memory_hits"] == [first.id, second.id]


def test_executor_without_memory_store_stays_green(tmp_path):
    """Legacy construction (no memory store wired) keeps working: no injection,
    empty hits — the consensus feature degrades to absence, never to a crash."""
    crew, project_id, prd_id = _service_with_prd_ready(tmp_path)
    model = _TextModel()
    executor = AgentWorkerExecutor(settings=_CONFIGURED, deps=QueryDeps(stream_model=model))

    updated, result = crew.run_agent(project_id, prd_id, executor)

    assert "项目共识" not in _user_prompt(model)
    assert result.memory_hits == []
    assert updated.audit_events[-1]["payload"]["memory_hits"] == []
