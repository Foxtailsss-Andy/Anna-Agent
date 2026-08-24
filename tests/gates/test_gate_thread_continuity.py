"""L1 · thread-continuity smoke gate (eval-first, the RED).

A minutes-level, code-judged gate for the Harness Runtime long-running round,
slice L1 (multi-turn Chat via ``thread_id``). It is the executable acceptance
criterion the implementation must turn green — written and committed BEFORE any
production change.

Scenario (single task, single run, deterministic fake model):

* start run A in a NEW thread with 「记住这个数字:47」;
* start run B carrying ``thread_id`` = A's thread;
* assert (a) B's model request contains A's user message AND A's assistant reply
  as proper user/assistant messages, both BEFORE B's own user message;
* assert (b) B reaches terminal status ``ready``;
* assert (c) audit event ``chat.thread.continued`` with payload
  ``{thread_id, prior_turns}`` appears on B and NOT on A.

The fake ``stream_model`` (``tests.support.engine_fakes.FakeStreamModel``)
captures every governed request on ``.requests``, so the assembled prompt is
inspectable without any network. This gate must stay green in every later slice.
"""
from pathlib import Path

from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)


class _ConnectedErpGateway:
    """A connected ERP gateway so chat preflight passes (no tool is called here)."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused in this gate
        raise AssertionError("this gate never dispatches a tool")


def _text_answer(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


def _orchestrator(fake: FakeStreamModel) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )


def test_gate_thread_continuity_carries_prior_turn_into_next_request():
    a_answer = "记住了，这个数字是 47。"
    fake = FakeStreamModel([_text_answer(a_answer), _text_answer("47 加 3 等于 50。")])
    orchestrator = _orchestrator(fake)

    run_a = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="记住这个数字:47",
    )
    run_b = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="它加 3 是多少？",
        thread_id=run_a.thread_id,
    )

    # (b) B reached the terminal ready state.
    assert run_b.status == "ready"
    assert run_a.status == "ready"

    # (a) B's model request carries A's user message AND A's assistant reply as
    #     proper user/assistant messages, both BEFORE B's own user message.
    assert len(fake.requests) == 2  # one governed call per run
    messages_b = fake.requests[1].messages
    contents = [(m["role"], m.get("content")) for m in messages_b]

    a_user_index = contents.index(("user", "记住这个数字:47"))
    a_assistant_index = contents.index(("assistant", a_answer))
    b_user_index = next(
        i
        for i, (role, content) in enumerate(contents)
        if role == "user" and content is not None and "它加 3 是多少？" in content
    )
    assert a_user_index < a_assistant_index < b_user_index

    # (c) chat.thread.continued {thread_id, prior_turns} appears on B, not on A.
    assert "chat.thread.continued" not in [event.type for event in run_a.audit_events]
    continued = [
        event for event in run_b.audit_events if event.type == "chat.thread.continued"
    ]
    assert len(continued) == 1
    assert continued[0].payload == {"thread_id": run_a.thread_id, "prior_turns": 1}
