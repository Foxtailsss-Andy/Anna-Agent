"""L1 · thread_id multi-turn assembly (unit tests beyond the smoke gate).

Drives ``ChatOrchestrator`` through the shared fake ``stream_model`` seam
(``tests.support.engine_fakes.FakeStreamModel``, which captures every governed
request on ``.requests``) to pin the history-assembly rules that the minutes-level
gate (``tests/gates/test_gate_thread_continuity.py``) does not exhaustively cover:

* first turn self-references its own run_id (fresh thread, no history, no event);
* an unknown thread_id proceeds as a fresh thread (idempotent-friendly, no event);
* a failed turn is skipped and never poisons the thread;
* the N=6 window keeps only the latest six prior turns;
* the cross-identity guard excludes other users' / other workspaces' turns;
* the stream path honors thread_id identically to start_run.
"""
import asyncio
from pathlib import Path

from services.chat.app.orchestrator import (
    THREAD_HISTORY_TURNS,
    ChatOrchestrator,
)
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
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")

    def status(self):
        return {
            "status": "connected",
            "tool_names": ["erp.finance.query"],
            "tools": [{"name": "erp.finance.query"}],
        }

    def call_tool(self, tool_name, arguments):  # pragma: no cover - unused here
        raise AssertionError("these tests never dispatch a tool")


def _answer_chunks(text: str) -> list[ModelChunk]:
    return [ModelChunk("text_delta", text=text), ModelChunk("final", finish_reason="stop")]


def _answers(texts: list[str]) -> FakeStreamModel:
    """One direct-text model turn per text — each start_run consumes one script."""
    return FakeStreamModel([_answer_chunks(text) for text in texts])


def _orchestrator(fake: FakeStreamModel) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(
            settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=fake)
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
    )


def _continued(run) -> object:
    (event,) = [e for e in run.audit_events if e.type == "chat.thread.continued"]
    return event


def _has_continued(run) -> bool:
    return any(e.type == "chat.thread.continued" for e in run.audit_events)


def _user_contents(request) -> list[str]:
    return [m["content"] for m in request.messages if m["role"] == "user"]


def _pairs(request) -> list[tuple[str, object]]:
    return [(m["role"], m.get("content")) for m in request.messages]


# --- first turn / unknown thread: fresh, no history, no event ------------------


def test_first_turn_thread_id_self_references_run_id_with_no_history():
    fake = _answers(["答一。"])
    orchestrator = _orchestrator(fake)

    run = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="第一句"
    )

    # First turn self-references: thread_id == its own run id.
    assert run.thread_id == run.id
    assert not _has_continued(run)
    # No history injected — the request is exactly [system, user] as before L1.
    assert [m["role"] for m in fake.requests[0].messages] == ["system", "user"]


def test_unknown_thread_id_proceeds_as_fresh_thread_without_event():
    fake = _answers(["答。"])
    orchestrator = _orchestrator(fake)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="你好",
        thread_id="chat_run_does_not_exist",
    )

    # Idempotent-friendly: the id is honored (not overwritten), the run succeeds,
    # and with no prior runs found there is no history and no continuation event.
    assert run.status == "ready"
    assert run.thread_id == "chat_run_does_not_exist"
    assert not _has_continued(run)
    assert [m["role"] for m in fake.requests[0].messages] == ["system", "user"]


# --- failed turns never poison the thread --------------------------------------


def test_failed_turn_is_skipped_and_never_enters_history():
    fake = FakeStreamModel(
        [
            _answer_chunks("A 的回答。"),
            [ModelChunk("final", finish_reason="stop")],  # B: empty response → fails
            _answer_chunks("C 的回答。"),
        ]
    )
    orchestrator = _orchestrator(fake)

    run_a = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="A 问"
    )
    run_b = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="B 问", thread_id=run_a.thread_id
    )
    run_c = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="C 问", thread_id=run_a.thread_id
    )

    assert run_b.status == "failed"
    assert run_b.error_code == "chat_response_empty"

    # C's request carries A's completed pair but NOT the failed B turn.
    c_pairs = _pairs(fake.requests[2])
    assert ("user", "A 问") in c_pairs
    assert ("assistant", "A 的回答。") in c_pairs
    assert ("user", "B 问") not in c_pairs
    # prior_turns counts only the one successful prior turn (A).
    assert _continued(run_c).payload == {"thread_id": run_a.thread_id, "prior_turns": 1}


# --- N=6 window ----------------------------------------------------------------


def test_history_window_keeps_only_the_latest_six_prior_turns():
    assert THREAD_HISTORY_TURNS == 6
    fake = _answers([f"答{i}" for i in range(1, 9)])  # 8 direct answers
    orchestrator = _orchestrator(fake)

    first = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="第1轮"
    )
    runs = [first]
    for i in range(2, 9):
        runs.append(
            orchestrator.start_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message=f"第{i}轮",
                thread_id=first.thread_id,
            )
        )

    # The 8th run has 7 prior turns; only the latest 6 (turns 2..7) are included,
    # oldest-first. The trailing user message is the CURRENT (templated) turn 8.
    eighth_users = _user_contents(fake.requests[7])
    assert eighth_users[:-1] == ["第2轮", "第3轮", "第4轮", "第5轮", "第6轮", "第7轮"]
    assert "第1轮" not in eighth_users[:-1]
    assert "第8轮" in eighth_users[-1]  # current turn, templated
    assert _continued(runs[-1]).payload == {
        "thread_id": first.thread_id,
        "prior_turns": 6,
    }


# --- cross-identity guard ------------------------------------------------------


def test_history_excludes_other_user_and_other_workspace_turns():
    fake = _answers(["答A。", "答B。", "答C。"])
    orchestrator = _orchestrator(fake)

    run_a = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_alice", message="alice 机密"
    )
    # Another user supplies Alice's thread_id — her turn must not leak.
    run_b = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_bob",
        message="bob 问",
        thread_id=run_a.thread_id,
    )
    # Same user, different workspace, same thread_id — also excluded.
    run_c = orchestrator.start_run(
        workspace_id="other_ws",
        actor_user_id="u_alice",
        message="别的空间",
        thread_id=run_a.thread_id,
    )

    assert ("user", "alice 机密") not in _pairs(fake.requests[1])
    assert not _has_continued(run_b)
    assert ("user", "alice 机密") not in _pairs(fake.requests[2])
    assert not _has_continued(run_c)


# --- stream path parity --------------------------------------------------------


def test_stream_run_honors_thread_id_like_start_run():
    fake = FakeStreamModel([_answer_chunks("答A。"), _answer_chunks("答B。")])
    orchestrator = _orchestrator(fake)

    run_a = orchestrator.start_run(
        workspace_id="demo", actor_user_id="u_demo", message="记住 X"
    )

    async def _drive():
        return [
            frame
            async for frame in orchestrator.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="X 是什么",
                thread_id=run_a.thread_id,
            )
        ]

    frames = asyncio.run(_drive())

    # The streamed turn's model request carries A's pair — identical assembly to
    # start_run (both flow through _prepare_advance).
    b_pairs = _pairs(fake.requests[1])
    assert ("user", "记住 X") in b_pairs
    assert ("assistant", "答A。") in b_pairs
    # The continuation event is streamed as an {"type":"event"} frame, and the
    # terminal is the ready run.
    streamed_event_types = [f["event"].type for f in frames if f["type"] == "event"]
    assert "chat.thread.continued" in streamed_event_types
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"].status == "ready"
