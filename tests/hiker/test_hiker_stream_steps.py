"""B0 — hiker emits AUTHORITATIVE ``step`` frames over the SSE stream.

``HikerCapabilityHandler.humanize_step`` OPTS hiker in to the engine's
``{"type": "step", ...}`` process frames (W1.T2 gating). This test drives a
fake-provider assistant stream and asserts the forwarded step subsequence
carries code-generated Chinese intents (ADR-002) naming the REAL hiker tools
(``hiker.report.get_dashboard_summary``), plus a totality guard: ``humanize_step``
never raises on unknown tool/phase (deferred W1.T2 finding, now binding).

The domain fakes + stream builder are reused from the hiker stream test — no
second copy.
"""
from __future__ import annotations

from services.hiker.app.capability import HikerCapabilityHandler
from services.runtime.app.model_provider import ModelToolCall
from tests.hiker.test_hiker_assistant_stream import (
    QUESTION,
    _assistant_stream,
    _collect_frames,
    _orchestrator,
)
from tests.hiker.hiker_fakes import FakeGateway


def _steps(frames) -> list[tuple]:
    return [
        (f["phase"], f["turn"], f["tool"], f["intent"])
        for f in frames
        if f["type"] == "step"
    ]


def test_hiker_assistant_stream_forwards_authoritative_step_frames():
    orchestrator = _orchestrator(FakeGateway(), _assistant_stream())
    run = orchestrator.begin_assistant_run("ws_demo", "admin", QUESTION)

    frames = _collect_frames(orchestrator, run)

    # analyze(1) -> tool(1, hiker.report.get_dashboard_summary) ->
    # analyze(2) -> deliver(2), each carrying hiker's code-generated intent.
    assert _steps(frames) == [
        ("analyze", 1, None, "正在理解客户与合同问题"),
        ("tool", 1, "hiker.report.get_dashboard_summary", "正在读取经营摘要"),
        ("analyze", 2, None, "正在理解客户与合同问题"),
        ("deliver", 2, None, "正在整理回答"),
    ]

    # Step frames are purely additive — the terminal is still the ready run.
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"].status == "ready"


def test_hiker_humanize_step_is_total_and_names_real_tools():
    # humanize_step is pure w.r.t. instance state, so exercise it without the
    # heavy handler __init__. It must never raise (binding W1.T2 finding).
    handler = object.__new__(HikerCapabilityHandler)

    contract_tool = ModelToolCall(
        id="c", name="hiker.contract.list_contracts", arguments={}
    )
    assert handler.humanize_step("tool", contract_tool) == "正在查询合同列表"
    assert handler.humanize_step("analyze") == "正在理解客户与合同问题"
    assert handler.humanize_step("deliver") == "正在整理回答"

    # Totality: unmapped tool names itself; unmapped phase is generic.
    unknown_tool = ModelToolCall(id="c", name="hiker.mystery.probe", arguments={})
    assert handler.humanize_step("tool", unknown_tool) == "正在调用 hiker.mystery.probe"
    assert handler.humanize_step("wat") == "正在处理"
