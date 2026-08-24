"""J3 · Mid-run 插话 (steering) smoke gate (eval-first, the RED).

A code-judged gate for the Judgment round, slice J3: a long-running chat run
must be **steerable while it runs** — the user can say something mid-flight and
the model sees it on its very next turn, as a real user turn, without starting a
new run and without losing the work already done. It is the executable
acceptance criterion the implementation must turn green — written and committed
BEFORE any production change.

Scenario (deterministic EVENT-GATED fake model — the model parks at the end of
its first turn instead of sleeping, so the interjection lands mid-run without a
timing race), driven through the background path like
``tests.gates.test_gate_p3_disconnect``:

* Scenario A — the interjection reaches the NEXT turn as an independent user
  message: submit a 3-turn task; park after turn 1; interject; resume. The turn-2
  model request must carry the interjection as its own ``{"role": "user"}``
  message (NOT folded into a tool observation — compaction and replay must be
  able to treat it as a genuine user turn), positioned after turn 1's
  observations and before any turn-2 work. The run still reaches terminal
  ``ready``, and a ``run.interjected`` event frame is journaled with the seq
  space staying strictly contiguous.
* Scenario B — interjecting into an already-terminal run is a friendly,
  idempotent no-op: it reports the run's current status, accepts nothing, and
  never mutates the finished run (mirrors ``stop`` / ``continue``'s race
  handling rather than a 409 for what is almost always a UI race).
* Scenario C — zero-cost when idle: a run nobody interjects into produces the
  exact same turn count and carries ZERO ``run.interjected`` events.

This gate must stay green in every later slice.
"""
from pathlib import Path

import asyncio

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import ChatOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.interjections import reset_interjections
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
)

_INTERJECTION = "补充一下：报告只要中文版，英文版不用做了。"


class _ConnectedErpGateway:
    """A connected ERP gateway so chat preflight passes (plan.update is native)."""

    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused in this gate
        raise AssertionError("this gate never dispatches an ERP tool")


class _GatedStreamModel(FakeStreamModel):
    """Governed fake that PARKS at the end of the N-th model call.

    Wraps the governed ``FakeStreamModel`` generator (so ``model.call.started`` /
    ``model.call.completed`` audit stays byte-identical) and, after the call
    indexed ``pause_after_call`` has yielded its last chunk, blocks on
    ``resume``. The loop is then provably between turns — the interjection is
    pushed while the run is mid-flight, never as a pre-run or post-run race.
    """

    def __init__(self, scripts, *, resume: asyncio.Event, pause_after_call: int):
        super().__init__(scripts)
        self._resume = resume
        self._pause_after_call = pause_after_call
        self._call_index = -1

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        base = super().__call__(
            run_id,
            audit_events,
            request,
            settings=settings,
            config_error_message=config_error_message,
        )
        self._call_index += 1
        should_park = self._call_index == self._pause_after_call
        resume = self._resume

        async def _gated():
            async for chunk in base:
                yield chunk
            if should_park:
                await resume.wait()

        return _gated()


def _orchestrator(fake: FakeStreamModel, run_store: SQLiteRunStore) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=run_store,
    )


def _plan_call(call_id: str, items: list[dict]) -> list[ModelChunk]:
    return [
        ModelChunk(
            "final",
            tool_calls=(
                ModelToolCall(id=call_id, name="plan.update", arguments={"items": items}),
            ),
            finish_reason="tool_calls",
        )
    ]


def _text_final(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


_PLAN_PENDING = [
    {"id": "1", "title": "取上月数据", "status": "done"},
    {"id": "2", "title": "撰写报告", "status": "pending"},
]
_PLAN_DONE = [
    {"id": "1", "title": "取上月数据", "status": "done"},
    {"id": "2", "title": "撰写报告", "status": "done"},
]


def _user_contents(messages: list[dict]) -> list[str]:
    return [
        str(m.get("content") or "")
        for m in messages
        if m.get("role") == "user"
    ]


async def _run_scenario_a(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    resume = asyncio.Event()
    fake = _GatedStreamModel(
        [
            _plan_call("call_plan_1", _PLAN_PENDING),  # turn 1 — then PARK
            _plan_call("call_plan_2", _PLAN_DONE),  # turn 2 — must see the interjection
            _text_final("报告已完成，只出了中文版。"),  # turn 3 — final answer
        ],
        resume=resume,
        pause_after_call=0,
    )
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我做上月费用分析并交付报告。",
    )
    run_id = run.id
    task = manager.get_task(run_id)
    assert task is not None

    # Wait until the model has actually been called once and parked — the run is
    # now provably mid-flight, between turn 1 and turn 2.
    while len(fake.requests) < 1:
        await asyncio.sleep(0)

    # (1) Interject WHILE the run is generating — accepted, not a new run.
    accepted = await manager.interject(run_id, _INTERJECTION)
    assert accepted["accepted"] is True
    assert accepted["status"] == "generating"
    assert accepted["run_id"] == run_id

    resume.set()
    await task

    # (2) The run finished normally — steering does not derail it.
    finished = chat.get_run(run_id)
    assert finished.status == "ready"
    assert finished.assistant_message == "报告已完成，只出了中文版。"
    assert len(fake.requests) == 3

    # (3) The interjection reached the very next turn as an INDEPENDENT user
    #     message — not folded into a tool observation.
    turn_two = fake.requests[1].messages
    assert _INTERJECTION in _user_contents(turn_two)
    interjection_index = next(
        i
        for i, m in enumerate(turn_two)
        if m.get("role") == "user" and m.get("content") == _INTERJECTION
    )
    # It is a user turn in its own right ...
    assert turn_two[interjection_index].get("role") == "user"
    assert "tool_call_id" not in turn_two[interjection_index]
    # ... spliced AFTER turn 1's tool observation (the work already done is kept,
    # never rewritten) and it is the LAST message the model reads this turn.
    observation_indexes = [
        i for i, m in enumerate(turn_two) if m.get("role") == "tool"
    ]
    assert observation_indexes
    assert interjection_index > max(observation_indexes)
    assert interjection_index == len(turn_two) - 1
    # No tool observation was mutated to carry it.
    assert all(
        _INTERJECTION not in str(turn_two[i].get("content") or "")
        for i in observation_indexes
    )

    # (4) Honest audit + journal: a run.interjected event frame is present and the
    #     journal seq space stays strictly contiguous across the injection.
    assert any(e.type == "run.interjected" for e in finished.audit_events)
    frames = store.list_frames("chat", run_id, 1)
    seqs = [f["seq"] for f in frames]
    assert seqs == list(range(1, len(frames) + 1))
    interjected_frames = [
        f
        for f in frames
        if f.get("type") == "event"
        and (f.get("event") or {}).get("type") == "run.interjected"
    ]
    assert len(interjected_frames) == 1

    # (5) The queue is drained, not replayed — a second turn never re-injects it.
    assert _user_contents(fake.requests[2].messages).count(_INTERJECTION) == 1


async def _run_scenario_b(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "anna-runs-b.sqlite3")
    fake = FakeStreamModel([_text_final("这是直接回答。")])
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="今天天气怎么样？",
    )
    await manager.get_task(run.id)
    finished = chat.get_run(run.id)
    assert finished.status == "ready"

    # Interjecting into a finished run is a friendly no-op reporting the status —
    # never an exception, never a mutation of the terminal run.
    result = await manager.interject(run.id, "再补一句。")
    assert result["accepted"] is False
    assert result["status"] == "ready"
    still = chat.get_run(run.id)
    assert still.status == "ready"
    assert still.assistant_message == "这是直接回答。"
    assert not any(e.type == "run.interjected" for e in still.audit_events)


async def _run_scenario_c(tmp_path) -> None:
    store = SQLiteRunStore(tmp_path / "anna-runs-c.sqlite3")
    fake = FakeStreamModel([_text_final("这是直接回答。")])
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="今天天气怎么样？",
    )
    await manager.get_task(run.id)

    finished = chat.get_run(run.id)
    assert finished.status == "ready"
    # Zero-cost when idle: one single pass, no interjection bookkeeping at all.
    assert len(fake.requests) == 1
    assert not any(e.type == "run.interjected" for e in finished.audit_events)


def test_gate_interjection_reaches_next_turn_as_user_message(tmp_path):
    reset_interjections()
    asyncio.run(_run_scenario_a(tmp_path))


def test_gate_interjection_into_terminal_run_is_idempotent_noop(tmp_path):
    reset_interjections()
    asyncio.run(_run_scenario_b(tmp_path))


def test_gate_interjection_is_zero_cost_when_nobody_interjects(tmp_path):
    reset_interjections()
    asyncio.run(_run_scenario_c(tmp_path))
