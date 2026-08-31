"""Hiker ``CapabilityHandler`` for the platform streaming engine.

``HikerCapabilityHandler`` plugs the hiker assistant into
``services.runtime.app.engine`` (``QueryEngine.run`` + ``AgentLoop``),
reproducing the byte-for-byte behavior of the hiker orchestrator's old
hand-rolled ReAct loop (``_build_assistant_request`` /
``_apply_assistant_response`` / no-tool exit), which is now deleted. The
deterministic dashboard path (no model) stays on the orchestrator untouched.

Hiker is finance's read-only twin: no writes, no approvals — the handler
never raises ``CapabilitySuspend`` and never nudges (``on_assistant_final``
always returns ``None``). Preflight (connector when the model is configured)
and the ``skill.loaded`` audit stay in the orchestrator, BEFORE the engine
runs — the engine loop has no preflight step.
"""
from __future__ import annotations

from typing import Any

from services.hiker.app.schemas import HikerAssistantRun
from services.mcp_gateway.app.hiker_adapter import HikerMcpError
from services.reimbursement.app.audit import AuditService
from services.runtime.app.engine.capability import (
    CapabilityError,
    default_humanize_step,
)
from services.runtime.app.hiker_tool_registry import HikerToolRegistry
from services.runtime.app.mcp_dispatcher import (
    McpToolDispatcher,
    tool_observation_message,
)
from services.runtime.app.model_provider import ModelRequest, ModelToolCall
from services.runtime.app.skill_loader import LoadedSkill


# B0 观察性:hiker emit 交付工具的「正在…」step 标签。代码生成中文(ADR-002,非模型
# 文本),覆盖 11 个真实 hiker.* 工具的客户与合同语汇;analyze/deliver 用领域措辞。
_HIKER_TOOL_STEP_LABELS = {
    "hiker.system.list_capabilities": "正在确认 Hiker 可用能力",
    "hiker.system.get_current_user_context": "正在确认当前用户与权限",
    "hiker.master_data.search": "正在检索客户主数据",
    "hiker.master_data.get_detail": "正在查询客户主数据详情",
    "hiker.contract.list_contracts": "正在查询合同列表",
    "hiker.contract.get_contract_detail": "正在查询合同详情",
    "hiker.contract.get_business_chain": "正在梳理合同业务链",
    "hiker.report.get_dashboard_summary": "正在读取经营摘要",
    "hiker.report.get_collection_summary": "正在核对回款与账龄",
    "hiker.report.get_invoice_summary": "正在核对开票与核销",
    "hiker.report.get_po_receivable_summary": "正在核对订单与应收",
}
_HIKER_PHASE_STEP_LABELS = {
    "analyze": "正在理解客户与合同问题",
    "deliver": "正在整理回答",
}


class HikerCapabilityHandler:
    """Per-run hiker capability handler bound to a single assistant run.

    Constructed by ``HikerOrchestrator`` for each engine run with the
    already-loaded ``skill``, the ``run`` it mutates, the domain deps
    (``tool_registry``, ``mcp_dispatcher``, ``audit``) and ``base_args`` —
    the pre-built Hiker MCP argument base (``request_id`` + the configured
    Hiker default actor; Anna's session user is never forwarded to Hiker,
    see ``HikerOrchestrator._base_args``).
    """

    def __init__(
        self,
        *,
        skill: LoadedSkill,
        run: HikerAssistantRun,
        tool_registry: HikerToolRegistry,
        mcp_dispatcher: McpToolDispatcher,
        audit: AuditService,
        boss_directive: str | None = None,
        base_args: dict[str, Any],
    ) -> None:
        self.skill = skill
        self.boss_directive = boss_directive
        self.run = run
        self.tool_registry = tool_registry
        self.mcp_dispatcher = mcp_dispatcher
        self.audit = audit
        self.base_args = base_args
        self._initial_request: ModelRequest | None = None

    # --- CapabilityHandler protocol ----------------------------------------

    def build_initial_request(self) -> ModelRequest:
        """Return the initial hiker ``ModelRequest`` (moved verbatim from the
        orchestrator's old ``_build_assistant_request``).

        Memoized: the orchestrator calls this once to populate
        ``QueryConfig.tools`` and the engine calls it again at loop entry, so
        building once keeps both call sites on a single build.
        """
        if self._initial_request is None:
            tools = self.tool_registry.model_visible_tools(
                self.skill, discovered_tools=[]
            )
            self._initial_request = ModelRequest(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are Anna's Hiker assistant. Hiker is a global customer & contract platform. "
                            "Answer ONLY from Hiker MCP read-only tools, cite the data as coming from Hiker MCP, "
                            "and do not rewrite Hiker's business definitions. Use only the provided tools."
                        
                        + directive_suffix(self.boss_directive)
                    ),
                    },
                    {
                        "role": "user",
                        "content": f"Skill:\n{self.skill.content}\n\nHiker 问题：{self.run.question}",
                    },
                ],
                tools=tools,
            )
        return self._initial_request

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        """Run one hiker tool call, track ``tools_used``, return the observation.

        Mirrors the old ``_apply_assistant_response`` per-tool body: governance
        check → audited MCP call (model arguments merged over ``base_args``)
        → ``tools_used`` dedupe → ``tool_observation_message``. Governance
        denial and MCP failure surface as ``CapabilityError`` so the engine
        terminates the run as failed (the orchestrator maps that back to the
        ``hiker.assistant.failed`` audit event + error code).
        """
        try:
            self.tool_registry.assert_allowed(tool_call.name)
        except PermissionError as exc:
            raise CapabilityError("tool_not_allowed", str(exc))
        try:
            tool_result = self.mcp_dispatcher.call_tool_audited(
                self.run.audit_events,
                self.run.id,
                tool_call.name,
                tool_call.arguments,
                # Remote actor/request identity comes from server configuration;
                # model arguments must never be able to replace it.
                {**tool_call.arguments, **self.base_args},
            )
        except HikerMcpError as exc:
            raise CapabilityError(exc.error_code, exc.message)
        if tool_call.name not in self.run.tools_used:
            self.run.tools_used.append(tool_call.name)
        return tool_observation_message(tool_call, tool_result)

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        """Finalize the run when the model stops calling tools.

        Sets ``run.agent_message`` / ``run.answer`` / ``run.status`` and emits
        ``hiker.assistant.answered`` exactly as the old loop's no-tool exit
        did, then returns ``None`` — hiker never nudges.
        """
        self.run.agent_message = assistant_message
        self.run.answer = assistant_message
        self.run.status = "ready"
        self.audit.append(
            self.run.audit_events,
            "hiker.assistant.answered",
            self.run.id,
            {"tools_used": self.run.tools_used},
        )
        return None

    def humanize_step(self, phase: str, tool_call: ModelToolCall | None = None) -> str:
        """Authoritative Chinese ``StepEvent`` label for hiker (B0 opt-in).

        Defining this method OPTS hiker in to the engine's ``step`` frames. The
        tool phase maps the 11 real ``hiker.*`` read-only tools to now-doing
        labels (客户/合同/回款 vocabulary); ``analyze`` / ``deliver`` carry
        domain phrasing. ALWAYS code-generated (ADR-002). TOTAL — never raises:
        an unmapped tool or phase falls through to ``default_humanize_step``.
        """
        if phase == "tool" and tool_call is not None:
            label = _HIKER_TOOL_STEP_LABELS.get(tool_call.name)
            if label is not None:
                return label
        phase_label = _HIKER_PHASE_STEP_LABELS.get(phase)
        if phase_label is not None:
            return phase_label
        return default_humanize_step(phase, tool_call)


def directive_suffix(directive: str | None) -> str:
    """P3 refinement — Boss 附加指令 (Agent 中心) appended to system prompts."""
    return "\n\n[Boss 附加指令]\n" + directive if directive else ""
