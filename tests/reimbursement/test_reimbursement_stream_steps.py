"""B0 — reimbursement emits AUTHORITATIVE ``step`` frames over the SSE stream.

``ReimbursementCapabilityHandler.humanize_step`` OPTS reimbursement in to the
engine's ``{"type": "step", ...}`` process frames (W1.T2 gating). This test
drives the stepwise fake-provider flow (validate → create → submit_intent →
approval suspend) and asserts the forwarded step subsequence carries
code-generated Chinese 单据/校验/提交 intents (ADR-002) naming the REAL
reimbursement tools, plus a totality guard: ``humanize_step`` never raises on
unknown tool/phase (deferred W1.T2 finding, now binding).

The domain fakes + stream builder are reused from the agent-flow / stream tests
— no second copy.
"""
from __future__ import annotations

import asyncio

from services.reimbursement.app.capability import ReimbursementCapabilityHandler
from services.runtime.app.model_provider import ModelToolCall
from tests.reimbursement.test_reimbursement_agent_flow import (
    FakeReimbursementMcpGateway,
    StepwiseFakeModelProvider,
)
from tests.reimbursement.test_reimbursement_stream import INPUT_TEXT, _orchestrator


def _steps(frames) -> list[tuple]:
    return [
        (f["phase"], f["turn"], f["tool"], f["intent"])
        for f in frames
        if f["type"] == "step"
    ]


def test_reimbursement_stream_forwards_authoritative_step_frames():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = _orchestrator(gateway, StepwiseFakeModelProvider())
    run = orchestrator.begin_run("demo", "u_demo", INPUT_TEXT)

    async def _drive():
        return [frame async for frame in orchestrator.stream_created_advance(run, INPUT_TEXT)]

    frames = asyncio.run(_drive())

    # analyze -> tool per turn across the write flow; the run SUSPENDS on
    # submit_intent (approval gate), so there is no deliver step. Each intent is
    # code-generated 单据/校验/提交 vocabulary naming the REAL tools.
    assert _steps(frames) == [
        ("analyze", 1, None, "正在理解报销诉求"),
        ("tool", 1, "reimbursement.validate_draft", "正在校验报销单据"),
        ("analyze", 2, None, "正在理解报销诉求"),
        ("tool", 2, "reimbursement.create_draft", "正在创建报销单据"),
        ("analyze", 3, None, "正在理解报销诉求"),
        ("tool", 3, "reimbursement.submit_intent", "正在提交报销审批"),
    ]

    # Step frames are purely additive — the run still suspends on approval.
    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"].status == "waiting_confirmation"


def test_reimbursement_humanize_step_is_total_and_names_real_tools():
    # humanize_step is pure w.r.t. instance state, so exercise it without the
    # heavy handler __init__. It must never raise (binding W1.T2 finding).
    handler = object.__new__(ReimbursementCapabilityHandler)

    assert handler.humanize_step("deliver") == "正在整理回答"
    assert handler.humanize_step("analyze") == "正在理解报销诉求"
    policy_tool = ModelToolCall(id="c", name="reimbursement.get_policy", arguments={})
    assert handler.humanize_step("tool", policy_tool) == "正在核对报销政策"

    # Totality: unmapped tool names itself; unmapped phase is generic.
    unknown_tool = ModelToolCall(id="c", name="reimbursement.mystery", arguments={})
    assert handler.humanize_step("tool", unknown_tool) == "正在调用 reimbursement.mystery"
    assert handler.humanize_step("wat") == "正在处理"
