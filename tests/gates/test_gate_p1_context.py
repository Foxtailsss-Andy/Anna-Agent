"""L4 · autocompact context-governance gate (P1 上下文治理, the RED).

A minutes-level, code-judged gate for the Harness Runtime long-running round,
slice L4a — the LLM-summary compaction layer (autocompact). Written and committed
BEFORE the production wiring it must turn green.

Both scenarios drive a REAL chat run through the REAL streaming model
(``services.runtime.app.engine.streaming_model.stream_model``) with an
``httpx.MockTransport`` that plays BOTH roles at one endpoint, branching on the
request's ``stream`` flag:

* ``stream: true``  → the MAIN generation call (SSE) — the "fake model";
* ``stream: false`` → the single-shot SUMMARY call — the "fake summarizer".

The context window is forced tiny (``model_context_window=34_000`` → autocompact
threshold 1_000 tokens) and a long prior-turn history is seeded directly into the
run store so the FIRST assembled request already exceeds the threshold with a
real middle segment to summarize.

Scenario A — summary success:

1. seed 6 prior ready turns in one thread (the earliest carries a known early
   fact ``_SENTINEL``);
2. run a new turn in that thread → assembled messages exceed the low threshold;
3. autocompact summarizes the middle (the fake summarizer echoes ``_SENTINEL``),
   rebuilds it as a single ``<conversation_summary>`` message, and the run
   completes ``ready``;
4. assert: ``context.autocompact.applied`` audit present with
   ``{before_tokens, after_tokens, model}`` and before > after; the MAIN request
   the model received AFTER compaction carries the summary (``_SENTINEL`` inside
   a ``<conversation_summary>`` block) while the raw earliest turn is gone — a
   middle-only marker (never echoed by the summarizer) is absent, pinning the
   middle was replaced rather than appended-to.

Scenario B — circuit breaker:

1. seed history so every turn has a middle over threshold;
2. the fake summarizer ALWAYS fails (HTTP 400, non-retryable);
3. the run tool-loops (``plan.update``) then finishes → still completes ``ready``
   via the cheap-truncation fallback, with NO ``context.autocompact.applied``
   event and no crash; the summarizer is attempted at most
   ``MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`` times (the breaker then stops trying).

This gate must stay green in every later slice.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx

from services.chat.app.orchestrator import ChatOrchestrator
from services.chat.app.schemas import ChatRun
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.context_compaction import (
    MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
)
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.engine.streaming_model import stream_model
from services.runtime.app.run_store import SQLiteRunStore
from services.runtime.app.skill_loader import SkillLoader

# Tiny window so the autocompact threshold is low (34_000 → effective 14_000 →
# threshold 1_000 tokens), letting a modest seeded history breach it.
_WINDOW = 34_000
_SENTINEL = "锚点事实A47"
# A marker planted ONLY in the earliest (middle) turn. Unlike _SENTINEL it is never
# echoed by the fake summarizer, so it must be absent from the post-compaction
# request — pinning that the raw middle turn was replaced by the summary, not kept
# alongside it (an append-only regression the before>after token proxy can miss).
_MIDDLE_MARKER = "中段独有标记M91"
_SUMMARY_TAG_OPEN = "<conversation_summary>"

_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
    erp_mcp_server="https://erp.example/mcp",
    model_context_window=_WINDOW,
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
        raise AssertionError("this gate never dispatches an ERP tool")


def _sse(*events: str) -> bytes:
    return ("\n\n".join([*events, "data: [DONE]"]) + "\n\n").encode("utf-8")


def _content_event(text: str) -> str:
    return "data: " + json.dumps(
        {"choices": [{"delta": {"content": text}, "finish_reason": None}]},
        ensure_ascii=False,
    )


def _finish_event(reason: str) -> str:
    return "data: " + json.dumps(
        {"choices": [{"delta": {}, "finish_reason": reason}]}, ensure_ascii=False
    )


def _plan_tool_event() -> str:
    return "data: " + json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_plan",
                                "function": {
                                    "name": "plan__update",
                                    "arguments": json.dumps(
                                        {
                                            "items": [
                                                {
                                                    "id": "1",
                                                    "title": "继续处理",
                                                    "status": "in_progress",
                                                }
                                            ]
                                        }
                                    ),
                                },
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
        ensure_ascii=False,
    )


def _summary_completion(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
            ]
        },
    )


def _orchestrator(deps: QueryDeps, store: SQLiteRunStore) -> ChatOrchestrator:
    return ChatOrchestrator(
        engine=QueryEngine(settings=_CONFIGURED_SETTINGS, deps=deps),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=_CONFIGURED_SETTINGS,
        run_store=store,
    )


def _wrapped_deps(transport: httpx.MockTransport) -> QueryDeps:
    """Real ``stream_model`` with the gate's ``transport`` threaded in.

    The engine calls ``deps.stream_model(run_id, audit_events, request, *,
    settings, config_error_message)``; the wrapper forwards those and injects the
    mock transport so BOTH the main streaming call and the summary single-shot hit
    the gate's handler.
    """

    def _stream(run_id, audit_events, request, *, settings, config_error_message):
        return stream_model(
            run_id,
            audit_events,
            request,
            settings=settings,
            config_error_message=config_error_message,
            transport=transport,
        )

    return QueryDeps(stream_model=_stream)


def _seed_history(store: SQLiteRunStore, thread_id: str, *, sentinel_in_first: bool) -> None:
    """Seed 6 prior ready turns so a new turn's assembled request has a middle.

    Each turn is padded so 12 history messages comfortably exceed the 1_000-token
    threshold; the earliest optionally carries the known early fact.
    """
    filler = "历史对话内容占位。" * 12
    for index in range(1, 7):
        early = _SENTINEL if (index == 1 and sentinel_in_first) else ""
        # The earliest turn (index 1) lands in the summarized MIDDLE segment; plant
        # a marker there that the summarizer never echoes so its post-compaction
        # absence pins that the middle turn was dropped, not appended-to.
        marker = _MIDDLE_MARKER if (index == 1 and sentinel_in_first) else ""
        run = ChatRun(
            id=f"{thread_id}_seed_{index:02d}",
            workspace_id="demo",
            actor_user_id="u_demo",
            message=f"第 {index} 轮提问 {early} {marker} {filler}",
            thread_id=thread_id,
            status="ready",
            assistant_message=f"第 {index} 轮回答 {early} {filler}",
        )
        store.save_run(
            surface="chat",
            run_id=run.id,
            thread_id=thread_id,
            workspace_id="demo",
            actor_user_id="u_demo",
            status="ready",
            created_at=f"2026-01-01T00:00:{index:02d}+00:00",
            payload=run.model_dump(mode="json"),
        )


def _autocompact_events(run: ChatRun) -> list:
    return [e for e in run.audit_events if e.type == "context.autocompact.applied"]


def test_gate_p1_autocompact_summary_and_breaker(tmp_path):
    async def _run() -> None:
        store = SQLiteRunStore(tmp_path / "runs.sqlite3")

        # --- Scenario A: summary success --------------------------------------
        captured_main: list[dict] = []

        def _handler_success(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            if body.get("stream"):
                captured_main.append(body)
                return httpx.Response(
                    200,
                    content=_sse(_content_event("已根据历史回答。"), _finish_event("stop")),
                    headers={"content-type": "text/event-stream"},
                )
            # Summary single-shot: echo the early fact iff it reached the summarizer.
            payload = json.dumps(body, ensure_ascii=False)
            echoed = _SENTINEL if _SENTINEL in payload else "无"
            return _summary_completion(
                f"对话摘要:用户此前多轮沟通;关键实体保留 {echoed}。"
                "以上任务中已完成的部分不要重新执行。"
            )

        _seed_history(store, "thread_ok", sentinel_in_first=True)
        chat_ok = _orchestrator(
            _wrapped_deps(httpx.MockTransport(_handler_success)), store
        )
        run_ok = await _drain(
            chat_ok.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="综合上文,给我结论。",
                thread_id="thread_ok",
            )
        )
        assert run_ok.status == "ready", run_ok.error_code

        applied = _autocompact_events(run_ok)
        assert len(applied) == 1, "exactly one autocompact should have fired"
        payload = applied[0].payload
        assert set(payload) >= {"before_tokens", "after_tokens", "model"}
        assert payload["before_tokens"] > payload["after_tokens"]  # tokens dropped

        # The MAIN request the model received AFTER compaction carries the summary
        # (with the early fact) while the raw earliest seeded turn is gone.
        assert captured_main, "the main streaming call must have run"
        final_main = json.dumps(captured_main[-1], ensure_ascii=False)
        assert _SUMMARY_TAG_OPEN in final_main
        assert _SENTINEL in final_main
        # ...while the RAW earliest turn is GONE: the middle-only marker (never
        # echoed by the summarizer) is absent from the post-compaction request, so
        # the middle was replaced by the summary rather than appended-to.
        assert _MIDDLE_MARKER not in final_main
        summary_msgs = [
            m
            for m in captured_main[-1]["messages"]
            if _SUMMARY_TAG_OPEN in str(m.get("content", ""))
        ]
        assert len(summary_msgs) == 1  # a single summary message, never stacked

        # --- Scenario B: circuit breaker (summarizer always fails) -------------
        summary_calls = {"count": 0}

        def _handler_breaker(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            if body.get("stream"):
                # Tool-loop three rounds, then finish so the run still completes.
                if summary_calls.get("main", 0) < 3:
                    summary_calls["main"] = summary_calls.get("main", 0) + 1
                    return httpx.Response(
                        200,
                        content=_sse(_plan_tool_event()),
                        headers={"content-type": "text/event-stream"},
                    )
                return httpx.Response(
                    200,
                    content=_sse(_content_event("尽力回答。"), _finish_event("stop")),
                    headers={"content-type": "text/event-stream"},
                )
            # Summary single-shot ALWAYS fails, fast (400 is non-retryable).
            summary_calls["count"] += 1
            return httpx.Response(400, json={"error": "bad request"})

        _seed_history(store, "thread_breaker", sentinel_in_first=False)
        chat_breaker = _orchestrator(
            _wrapped_deps(httpx.MockTransport(_handler_breaker)), store
        )
        run_breaker = await _drain(
            chat_breaker.stream_run(
                workspace_id="demo",
                actor_user_id="u_demo",
                message="综合上文,给我结论。",
                thread_id="thread_breaker",
            )
        )
        # Still completes ready via the cheap fallback; NO autocompact event; the
        # breaker capped the doomed summary attempts.
        assert run_breaker.status == "ready", run_breaker.error_code
        assert _autocompact_events(run_breaker) == []
        assert 1 <= summary_calls["count"] <= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
        assert "chat_run_failed" not in [
            e.payload.get("error_code") for e in run_breaker.audit_events
        ]

    asyncio.run(_run())


async def _drain(agen) -> ChatRun:
    """Drain a chat stream generator and return the terminal run."""
    final_run = None
    async for frame in agen:
        run = frame.get("run")
        if run is not None:
            final_run = run
    assert final_run is not None
    return final_run
