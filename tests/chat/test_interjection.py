"""J3 插话 unit coverage — the queue seam and the late-arrival guarantee.

``tests/gates/test_gate_interjection.py`` pins the headline behavior (an
interjection reaches the NEXT turn as an independent user message). This module
covers the queue primitive itself plus the case the happy path cannot reach:

**Late arrival.** The drain runs at the top of each turn, so an interjection
that lands while the model is producing its FINAL turn has no next turn to be
drained into — the run would reach ``ready`` and the queue would be dropped on
cleanup. The user watched their message be accepted and then it vanished. That
is exactly the kind of silent lie this round exists to remove, so the finish
path re-checks the queue: a pending interjection turns the finish into one more
turn (via the engine's existing ``on_assistant_final`` nudge seam), and the
model answers what the user actually said last.
"""
from pathlib import Path

import asyncio

from services.api.app.routes.chat import BackgroundRunManager
from services.chat.app.orchestrator import (
    MAX_CHAT_MODEL_TOOL_ROUNDS,
    ChatOrchestrator,
)
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.interjections import (
    clear_interjections,
    drain_interjections,
    peek_interjections,
    push_interjection,
    reset_interjections,
)
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

_LATE = "等一下，把结论压缩成三句话就行。"


class _ConnectedErpGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused here
        raise AssertionError("this module never dispatches a tool")


class _ParkAtEndOfCall(FakeStreamModel):
    """Governed fake that parks after the N-th call has yielded everything."""

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


def _text_final(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


def _orchestrator(fake, run_store: SQLiteRunStore) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=run_store,
    )


# --- the queue primitive ----------------------------------------------------


def test_drain_is_exactly_once_and_empty_for_an_unsteered_run():
    reset_interjections()
    assert drain_interjections("chat_run_nobody") == []
    push_interjection("run_a", "第一句")
    push_interjection("run_a", "第二句")
    push_interjection("run_b", "别的 run")
    assert peek_interjections("run_a") == 2

    assert drain_interjections("run_a") == ["第一句", "第二句"]
    # Drained means gone — a later turn never replays it.
    assert drain_interjections("run_a") == []
    assert peek_interjections("run_a") == 0
    # Queues are per-run: draining one never touches another.
    assert drain_interjections("run_b") == ["别的 run"]


def test_clear_drops_only_the_named_run():
    reset_interjections()
    push_interjection("run_a", "留着")
    push_interjection("run_b", "清掉")
    clear_interjections("run_b")
    assert peek_interjections("run_b") == 0
    assert drain_interjections("run_a") == ["留着"]


# --- steering a PARKED (awaiting_continue) run -------------------------------


class _AlwaysToolModel(FakeStreamModel):
    """Never finishes — the engine spends its ``max_turns`` budget and parks."""

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=None,
            tool_calls=[
                ModelToolCall(
                    id=f"call_plan_{len(self.requests)}",
                    name="plan.update",
                    arguments={
                        "items": [{"id": "1", "title": "推进任务", "status": "in_progress"}]
                    },
                )
            ],
            finish_reason="tool_calls",
        )


async def _park_a_run(
    tmp_path, filename: str = "anna-runs.sqlite3"
) -> tuple[SQLiteRunStore, ChatOrchestrator, BackgroundRunManager, str]:
    store = SQLiteRunStore(tmp_path / filename)
    chat = _orchestrator(_AlwaysToolModel(), store)
    manager = BackgroundRunManager(chat)
    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="推进一个多步任务。",
    )
    task = manager.get_task(run.id)
    assert task is not None
    await task
    assert chat.get_run(run.id).status == "awaiting_continue"
    return store, chat, manager, run.id


def test_interjecting_a_parked_run_persists_and_journals_the_receipt(tmp_path):
    """A parked run has no live journal and no watermark that will ever run again.

    The live path relies on ``AuditFrameWatermark`` picking the ``run.interjected``
    event up on the next engine event — but an ``awaiting_continue`` run's
    background task has already ended. Without an explicit disk write the receipt
    exists ONLY in memory: the frame never reaches a subscriber and a restart
    before the user hits continue loses the audit event entirely, while the user
    was told ``accepted: True``.
    """

    async def _drive() -> None:
        store, chat, manager, run_id = await _park_a_run(tmp_path)
        before = [frame["seq"] for frame in store.list_frames("chat", run_id, 1)]

        accepted = await manager.interject(run_id, _LATE)
        assert accepted["accepted"] is True

        # (a) the receipt frame reached DISK, at the next contiguous seq.
        frames = store.list_frames("chat", run_id, 1)
        interjected = [
            frame
            for frame in frames
            if frame.get("type") == "event"
            and (frame.get("event") or {}).get("type") == "run.interjected"
        ]
        assert len(interjected) == 1
        assert interjected[0]["seq"] == before[-1] + 1
        assert [frame["seq"] for frame in frames] == list(range(1, len(frames) + 1))

        # (b) the receipt survives a restart: a FRESH orchestrator over the same
        #     store rehydrates the run with the audit event on its trail.
        revived = _orchestrator(_AlwaysToolModel(), store)
        assert any(
            event.type == "run.interjected"
            for event in revived.get_run(run_id).audit_events
        )

    asyncio.run(_drive())


def test_stop_clears_the_interjection_queue(tmp_path):
    """A stopped run will never take another turn — its queue must not be orphaned.

    ``stop`` already clears the autocompact tracker for exactly this reason. A
    left-behind queue sits in the process-global registry until 4096 other runs
    evict it, and it would be delivered verbatim if the run id were ever reused.
    """

    async def _drive() -> None:
        _store, _chat, manager, run_id = await _park_a_run(
            tmp_path, "anna-runs-stop.sqlite3"
        )
        assert (await manager.interject(run_id, _LATE))["accepted"] is True
        assert peek_interjections(run_id) == 1

        stopped = await manager.stop(run_id)
        assert stopped.status == "failed"
        assert peek_interjections(run_id) == 0

    asyncio.run(_drive())


# --- cross-test isolation (the conftest autouse reset) -----------------------

_LEAK_RUN_ID = "chat_run_leak_probe"


def test_a_test_may_leave_an_interjection_queued():
    """Deliberately leaves residue in the process-global queue registry.

    Paired with the test BELOW it (pytest runs a module in definition order):
    together they pin that queue state cannot leak from one test into the next.
    """
    push_interjection(_LEAK_RUN_ID, "上一个测试残留的插话")
    assert peek_interjections(_LEAK_RUN_ID) == 1


def test_interjection_queues_are_reset_between_tests():
    """The autouse conftest fixture must clear the previous test's residue.

    ``_queues`` is module-level process-global state (like ``autocompact``'s
    tracker cache), so without a per-test reset a queue left behind by one test
    can splice a phantom user turn into an unrelated run's model request. The
    reset lives in ``tests/conftest.py`` beside the autocompact one.
    """
    assert peek_interjections(_LEAK_RUN_ID) == 0


# --- the late-arrival guarantee ---------------------------------------------


async def _late_arrival(tmp_path) -> tuple[ChatOrchestrator, str, FakeStreamModel]:
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    resume = asyncio.Event()
    fake = _ParkAtEndOfCall(
        [
            # The model's FINAL turn — no tool calls, it intends to end here.
            _text_final("这是一份很长的分析结论……"),
            # Only reached if the late interjection buys another turn.
            _text_final("好的，压缩成三句：一、二、三。"),
        ],
        resume=resume,
        pause_after_call=0,
    )
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我分析上月费用。",
    )
    task = manager.get_task(run.id)
    while len(fake.requests) < 1:
        await asyncio.sleep(0)

    # The interjection lands while the model is finishing its LAST turn.
    accepted = await manager.interject(run.id, _LATE)
    assert accepted["accepted"] is True

    resume.set()
    await task
    return chat, run.id, fake


def test_late_interjection_is_not_silently_dropped(tmp_path):
    reset_interjections()
    chat, run_id, fake = asyncio.run(_late_arrival(tmp_path))

    finished = chat.get_run(run_id)
    # The run did NOT end on the turn the user interrupted — it answered them.
    assert len(fake.requests) == 2
    assert finished.status == "ready"
    assert finished.assistant_message == "好的，压缩成三句：一、二、三。"

    # The interjection reached the extra turn as a real user message ...
    last_turn_users = [
        m.get("content")
        for m in fake.requests[1].messages
        if m.get("role") == "user"
    ]
    assert _LATE in last_turn_users
    # ... exactly once, and the queue is empty afterwards (no replay, no leak).
    assert last_turn_users.count(_LATE) == 1
    assert peek_interjections(run_id) == 0


# --- two late arrivals stay two user turns -----------------------------------

_STEER_ONE = "第一件事：只保留中文版。"
_STEER_TWO = "第二件事：结论压缩成三句。"


async def _two_late_arrivals(tmp_path) -> tuple[ChatOrchestrator, str, FakeStreamModel]:
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    resume = asyncio.Event()
    fake = _ParkAtEndOfCall(
        [
            _text_final("这是一份很长的分析结论……"),
            _text_final("好的，两件事都照办。"),
        ],
        resume=resume,
        pause_after_call=0,
    )
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我分析上月费用。",
    )
    task = manager.get_task(run.id)
    while len(fake.requests) < 1:
        await asyncio.sleep(0)

    # TWO interjections land while the model is finishing its LAST turn.
    assert (await manager.interject(run.id, _STEER_ONE))["accepted"] is True
    assert (await manager.interject(run.id, _STEER_TWO))["accepted"] is True

    resume.set()
    await task
    return chat, run.id, fake


def test_two_late_interjections_stay_independent_user_turns(tmp_path):
    """逐条独立 (the J3 contract): N interjections are N user turns, never one.

    The loop-top drain already delivers each queued item as its own ``user``
    message. The late-arrival guard must not be the one place that violates that
    — merging them into a single turn erases the boundary between two separate
    things the user said, which compaction and journal replay both depend on.
    """
    chat, run_id, fake = asyncio.run(_two_late_arrivals(tmp_path))

    finished = chat.get_run(run_id)
    assert finished.status == "ready"
    assert len(fake.requests) == 2

    turn_two_users = [
        str(m.get("content") or "")
        for m in fake.requests[1].messages
        if m.get("role") == "user"
    ]
    # Each is a user message in its own right, in the order the user said them.
    assert _STEER_ONE in turn_two_users
    assert _STEER_TWO in turn_two_users
    assert turn_two_users.index(_STEER_ONE) < turn_two_users.index(_STEER_TWO)
    # No single message carries both (the "\n\n".join merge is the defect).
    assert not any(
        _STEER_ONE in content and _STEER_TWO in content for content in turn_two_users
    )
    assert peek_interjections(run_id) == 0


# --- the late arrival that lands on the LAST budgeted turn -------------------


class _ToolUntilLastBudgetedTurn(FakeStreamModel):
    """Tool-loops until the LAST budgeted turn, then answers — and parks there.

    ``MAX_CHAT_MODEL_TOOL_ROUNDS`` turns are budgeted, so turns 1..N-1 spend the
    budget on tool rounds and turn N returns a text final: ``on_assistant_final``
    fires at the exact boundary where the engine has NO turn left to give a
    nudge. Parking at the end of that call's stream puts the interjection there
    deterministically. After the resume the budget is fresh, so the model
    answers immediately.
    """

    def __init__(self, *, resume: asyncio.Event, pause_after_call: int):
        super().__init__()
        self._resume = resume
        self._pause_after_call = pause_after_call
        self._call_index = -1

    def respond(self, request: ModelRequest) -> ModelResponse:
        if len(self.requests) < MAX_CHAT_MODEL_TOOL_ROUNDS:
            return ModelResponse(
                assistant_message=None,
                tool_calls=[
                    ModelToolCall(
                        id=f"call_plan_{len(self.requests)}",
                        name="plan.update",
                        arguments={
                            "items": [
                                {"id": "1", "title": "推进任务", "status": "done"}
                            ]
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="这是最终答案。", tool_calls=[], finish_reason="stop"
        )

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


async def _late_at_the_turn_budget(tmp_path) -> tuple[ChatOrchestrator, str, FakeStreamModel]:
    store = SQLiteRunStore(tmp_path / "anna-runs.sqlite3")
    resume = asyncio.Event()
    fake = _ToolUntilLastBudgetedTurn(
        resume=resume, pause_after_call=MAX_CHAT_MODEL_TOOL_ROUNDS - 1
    )
    chat = _orchestrator(fake, store)
    manager = BackgroundRunManager(chat)

    run = manager.submit(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="推进一个多步任务。",
    )
    task = manager.get_task(run.id)
    for _ in range(100_000):
        if len(fake.requests) >= MAX_CHAT_MODEL_TOOL_ROUNDS:
            break
        await asyncio.sleep(0)
    assert len(fake.requests) == MAX_CHAT_MODEL_TOOL_ROUNDS

    # The interjection lands on the LAST turn the engine had budget for.
    accepted = await manager.interject(run.id, _LATE)
    assert accepted["accepted"] is True

    resume.set()
    await task
    return chat, run.id, fake


def test_interjection_at_the_turn_budget_survives_into_the_resume(tmp_path):
    async def _drive():
        chat, run_id, fake = await _late_at_the_turn_budget(tmp_path)
        store_backed = BackgroundRunManager(chat)

        parked = chat.get_run(run_id)
        # No turn was left, so the run parks instead of answering — the honest
        # L4a pause. What must NOT happen is the nudge being destroyed here: the
        # queue was already drained (exactly-once), so a dropped nudge is a
        # message the user watched be accepted and that no one will ever deliver.
        assert parked.status == "awaiting_continue"
        assert parked.suspended_messages[-1] == {"role": "user", "content": _LATE}

        # And it reaches the model on the resumed segment.
        await store_backed.continue_run(run_id)
        resume_task = store_backed.get_task(run_id)
        assert resume_task is not None
        await resume_task

        resumed_request = fake.requests[MAX_CHAT_MODEL_TOOL_ROUNDS]
        resumed_users = [
            m.get("content")
            for m in resumed_request.messages
            if m.get("role") == "user"
        ]
        assert _LATE in resumed_users
        assert chat.get_run(run_id).status == "ready"

    asyncio.run(_drive())
