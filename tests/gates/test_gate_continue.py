"""L4 · long-task continuation gate (P1 上下文治理 / 续办, the RED).

A minutes-level, code-judged gate for the Harness Runtime long-running round,
slice L4a — ``max_turns`` exhaustion becomes a RESUMABLE suspension
(``awaiting_continue``) instead of a ``tool_loop_exhausted`` failure. Written and
committed BEFORE the production change it must turn green.

Scenario (deterministic; a fake model that ALWAYS calls a tool until it sees the
continuation nudge, then finishes):

1. submit a chat run via the background path → the model tool-loops until the
   engine's ``max_turns`` budget is spent;
2. instead of failing ``tool_loop_exhausted``, the run reaches status
   ``awaiting_continue`` and the frame journal carries a
   ``run.suspended {reason: "max_turns", turns_used}`` audit-event frame; the
   subscription then closes cleanly;
3. an ``awaiting_continue`` run is NOT healed to ``interrupted`` by the L2
   startup sweep (``mark_stale_interrupted``);
4. ``BackgroundRunManager.continue_run`` (the endpoint's core) resumes the run in
   a NEW background task; the fake now sees the nudge and finishes → terminal
   ``ready``;
5. the frame ``seq`` is STRICTLY contiguous across the suspend/resume boundary —
   the resumed journal starts at (max persisted seq)+1, never restarting at 1 and
   never leaving a gap.

This gate must stay green in every later slice.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import (
    ModelRequest,
    ModelResponse,
    ModelToolCall,
)
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)

# Substring of the continuation nudge the resume path injects as a user turn.
_CONTINUE_MARKER = "继续完成剩余任务"


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused
        raise AssertionError("this gate never dispatches an ERP tool")


class _ToolUntilContinueModel(FakeStreamModel):
    """Calls ``plan.update`` every turn UNTIL the resume nudge appears, then ends.

    Before ``continue``: never finishes → the engine spends its ``max_turns``
    budget and suspends. After ``continue``: the resume nudge is the last user
    message → the model returns a final answer → the run reaches ``ready``.
    """

    def respond(self, request: ModelRequest) -> ModelResponse:
        last_user = ""
        for message in request.messages:
            if message.get("role") == "user":
                last_user = str(message.get("content") or "")
        if _CONTINUE_MARKER in last_user:
            return ModelResponse(
                assistant_message="剩余任务已完成。", tool_calls=[], finish_reason="stop"
            )
        return ModelResponse(
            assistant_message=None,
            tool_calls=[
                ModelToolCall(
                    id="call_plan",
                    name="plan.update",
                    arguments={
                        "items": [{"id": "1", "title": "推进任务", "status": "in_progress"}]
                    },
                )
            ],
            finish_reason="tool_calls",
        )


def _orchestrator(store: SQLiteRunStore) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS,
            deps=QueryDeps(stream_model=_ToolUntilContinueModel()),
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=store,
    )


async def _replay(manager: BackgroundRunManager, run_id: str, from_seq: int) -> list[dict]:
    return [frame async for frame in manager.subscribe(run_id, from_seq=from_seq)]


async def _run_gate(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    chat = _orchestrator(store)
    manager = BackgroundRunManager(chat)

    # (1) submit — the model tool-loops until the engine's max_turns is spent.
    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="推进一个多步任务。",
    )
    run_id = run.id
    task = manager.get_task(run_id)
    assert task is not None
    await task  # drives the run to the max_turns suspension

    # (2) suspended, NOT failed — no tool_loop_exhausted failure was recorded.
    suspended = chat.get_run(run_id)
    assert suspended.status == "awaiting_continue"
    audit_types = [event.type for event in suspended.audit_events]
    assert "chat.run.failed" not in audit_types
    assert "tool_loop_exhausted" not in [
        event.payload.get("error_code") for event in suspended.audit_events
    ]

    # The journal carries a run.suspended {reason, turns_used} event frame, and the
    # subscription drains to a clean close (disk replay of the finished segment).
    first_frames = await _replay(manager, run_id, from_seq=0)
    suspended_frames = [
        frame
        for frame in first_frames
        if frame.get("type") == "event"
        and frame.get("event", {}).get("type") == "run.suspended"
    ]
    assert len(suspended_frames) == 1
    suspend_payload = suspended_frames[0]["event"]["payload"]
    assert suspend_payload["reason"] == "max_turns"
    assert suspend_payload["turns_used"] >= 1
    last_seq = first_frames[-1]["seq"]
    assert [frame["seq"] for frame in first_frames] == list(range(1, last_seq + 1))

    # (3) the L2 sweep must NOT heal an awaiting_continue run to interrupted.
    swept = store.mark_stale_interrupted("chat")
    assert swept == 0
    assert chat.get_run(run_id).status == "awaiting_continue"

    # (4) continue → a NEW background task resumes the run; the fake now finishes.
    await manager.continue_run(run_id)
    resume_task = manager.get_task(run_id)
    assert resume_task is not None
    await resume_task
    finished = chat.get_run(run_id)
    assert finished.status == "ready"
    assert finished.assistant_message == "剩余任务已完成。"

    # (5) seq strictly contiguous across suspend/resume: resumed frames start at
    #     last_seq+1, no restart at 1 and no gap.
    resume_frames = await _replay(manager, run_id, from_seq=last_seq)
    resume_seqs = [frame["seq"] for frame in resume_frames]
    assert resume_seqs == list(range(last_seq + 1, last_seq + 1 + len(resume_frames)))
    assert resume_frames[-1]["type"] == "done"
    assert resume_frames[-1]["run"]["status"] == "ready"

    # The union of both segments covers every seq exactly once — no gap, no dup.
    all_seqs = [frame["seq"] for frame in first_frames] + resume_seqs
    assert all_seqs == list(range(1, all_seqs[-1] + 1))


def test_gate_continue_max_turns_becomes_resumable(tmp_path):
    asyncio.run(_run_gate(tmp_path))
