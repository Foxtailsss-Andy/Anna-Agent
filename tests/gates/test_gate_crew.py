"""Crew · full-chain service gate (B3).

A fast, model-free smoke of the whole Crew collaboration loop, asserted at the
service layer (single source of truth for channel rows + notifications). It must
stay green in every later slice.

Chain:
1. build a project from the「功能迭代与设计」template via AI decompose that FALLS
   BACK deterministically (no model) → the 8-node / 3-gate DAG;
2. assign a task → a channel event row + an assigned notification;
3. drive brief to done → PRD becomes ready;
4. run an Agent worker on PRD via a FAKE engine → deliverable produced + submitted
   → an artifact channel row → the PRD gate becomes ready + a review_due to Boss;
5. PRE-assign the downstream design task (blocked) → it queues under its assignee;
6. reject the PRD gate with a comment → PRD → rework (+ rejected notification);
7. re-run the Agent on the rework → PRD done again;
8. approve the PRD gate → the pre-assigned design task activates + an unlocked
   notification fans to its assignee + a「解锁」event row lands;
9.「+任务」drafts from a channel message (fallback path) → Boss confirms → a new
   task enters the graph with ``origin="channel"`` + its provenance message id.
"""
from __future__ import annotations

from services.crew.app.agent_worker import AgentWorkerExecutor
from services.crew.app.command_drafting import CommandDraftingService
from services.crew.app.decomposition import CrewDecompositionService
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)
_DELIVERABLE = "# PRD\n- 目标\n- 范围\n- 验收标准"


class _TextModel(FakeStreamModel):
    """Governed fake: the engine's final answer IS the Agent deliverable."""

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=_DELIVERABLE, tool_calls=[], finish_reason="stop"
        )


class _DeadProvider:
    """Unconfigured harness provider → decompose / draft fall back deterministically."""

    def __init__(self):
        self.settings = RuntimeSettings()

    async def create_response(self, request):  # pragma: no cover - never called
        raise AssertionError("model must not be called when unconfigured")


def _executor() -> AgentWorkerExecutor:
    return AgentWorkerExecutor(
        settings=_CONFIGURED, deps=QueryDeps(stream_model=_TextModel())
    )


def test_gate_crew_full_chain(tmp_path):
    crew = CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        drafter=CommandDraftingService(AnnaHarnessRuntime(_DeadProvider())),
    )
    executor = _executor()

    def T(key):
        return next(t for t in crew.get_project(pid).tasks if t.key == key)

    def notes(member):
        return crew.list_notifications("ws1", member)

    # (1) build via AI decompose that falls back to the deterministic template.
    project = crew.create_project_ai(
        "ws1", "acc_boss", "登录页重设计", "feature_iteration",
        decomposition=CrewDecompositionService(AnnaHarnessRuntime(_DeadProvider())),
    )
    pid = project.id
    assert {t.key for t in project.tasks} == {
        "brief", "prd", "prd_review", "design", "tech_research",
        "design_review", "build", "code_review", "accept",
    }
    assert sum(1 for t in project.tasks if t.is_gate) == 3

    # (2) assign brief → channel event row + assigned notification.
    crew.assign(pid, T("brief").id, "acc_boss")
    assert any(m.kind == "event" for m in crew.list_channel(pid))
    assert any(n.kind == "assigned" and n.task_id == T("brief").id for n in notes("acc_boss"))

    # (3) brief done (human) → PRD ready.
    crew.start(pid, T("brief").id)
    crew.submit(pid, T("brief").id, "需求简报 v1")
    assert T("prd").status == "todo"

    # (4) run the Agent on PRD (fake engine) → produced + submitted.
    crew.assign(pid, T("prd").id, "acc_agent_scribe")
    _project, result = crew.run_agent(pid, T("prd").id, executor, run_ref="crew_run_001")
    assert result.status == "completed"
    assert T("prd").status == "submitted" and T("prd").artifact == _DELIVERABLE  # 待审
    assert any(m.kind == "artifact" and m.run_ref == "crew_run_001" for m in crew.list_channel(pid))
    assert T("prd_review").status == "todo"  # gate unblocked by the agent's submit
    assert any(n.kind == "review_due" and n.task_id == T("prd_review").id for n in notes("acc_boss"))

    # (5) PRE-assign the downstream design task while still blocked (queued).
    crew.assign(pid, T("design").id, "acc_agent_design")
    assert T("design").status == "blocked" and T("design").assignee_member_id == "acc_agent_design"

    # (6) reject the PRD gate with a comment → PRD to rework + rejected notification.
    crew.review(pid, T("prd_review").id, approved=False, comment="目标不清,请补充竞品对比")
    assert T("prd").status == "rework" and T("prd").blocker == "目标不清,请补充竞品对比"
    assert any(n.kind == "rejected" and n.task_id == T("prd").id for n in notes("acc_agent_scribe"))

    # (7) re-run the Agent on the rework → PRD submitted again (待审, v2).
    crew.run_agent(pid, T("prd").id, executor, run_ref="crew_run_002")
    assert T("prd").status == "submitted"

    # (8) approve the PRD gate → PRD done + pre-assigned design activates + unlocked fan-out.
    crew.review(pid, T("prd_review").id, approved=True)
    assert T("prd").status == "done"  # producer completes at approve moment
    assert T("prd_review").status == "done"
    assert T("design").status == "assigned"  # pre-assigned → activated on unlock
    assert any(n.kind == "unlocked" and n.task_id == T("design").id for n in notes("acc_agent_design"))
    assert any(m.kind == "event" and "解锁" in m.body for m in crew.list_channel(pid))

    # (9)「+任务」draft (fallback) → confirm → a channel-origin task joins the graph.
    command, drafts = crew.draft_tasks_from_message(pid, "补一个登录页无障碍检查任务", "acc_boss")
    assert command.kind == "command" and len(drafts) == 1
    updated = crew.confirm_drafts(
        pid, drafts, confirmed_by="acc_boss", source_message_id=command.id
    )
    grown = [t for t in updated.tasks if t.origin == "channel"]
    assert len(grown) == 1
    assert grown[0].created_from_message_id == command.id
    assert any(m.kind == "event" and "已确认下推" in m.body for m in crew.list_channel(pid))
    assert any(n.kind == "grown" for n in notes("acc_boss"))
    assert any(e["type"] == "crew.channel.tasks_confirmed" for e in updated.audit_events)
