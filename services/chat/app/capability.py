"""Chat ``CapabilityHandler`` for the platform streaming engine (R1-T4b).

``ChatCapabilityHandler`` plugs Anna Chat into
``services.runtime.app.engine`` (``QueryEngine.run`` + ``AgentLoop``). Chat is
the general-assistant surface: the final assistant TEXT is the product — chat
folds NO domain-result object (contrast hiker's ``answer``).

Preserved chat behaviors (unchanged by the engine migration):

* the terminal ``chat.response.generated`` audit event + payload,
* the ``generating → ready`` status transition (``chat_response_empty`` fail
  when the model stops with no text),
* ``associate_goal_text`` set iff ``template_id == "associate_goal"``.

Preflight (model) and the ``skill.loaded`` audit stay in the
orchestrator, BEFORE the engine runs. Chat never suspends. It nudges in exactly
one case — J1 PlanGate: when the model tries to finish while its own
``run.plan`` still has unfinished items, ``on_assistant_final`` returns a
continuation nudge (bounded, honest fall-through) instead of ``None``; a run
with no plan is unaffected (the gate returns ``None`` with zero audit).
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from services.chat.app.schemas import ChatRun
from services.reimbursement.app.audit import AuditService
from services.runtime.app.chat_tool_registry import ChatToolRegistry
from services.runtime.app.engine.capability import (
    CapabilityError,
    default_humanize_step,
)
from services.runtime.app.engine.plan_tool import (
    PLAN_UPDATE_TOOL_NAME,
    PlanUpdateError,
    apply_plan_update,
)
from services.runtime.app.interjections import (
    drain_interjections as _drain_run_interjections,
)
from services.runtime.app.interjections import (
    pop_interjection as _pop_run_interjection,
)
from services.runtime.app.mcp_dispatcher import tool_observation_message
from services.runtime.app.model_provider import ModelRequest, ModelToolCall
from services.runtime.app.skill_loader import LoadedSkill


# B2 工作空间只读工具:per-run 内建(仅当 run 挂了有效 workdir 时注册,见
# build_initial_request),不进 ChatToolRegistry 的共享 allow-list——可用性门
# 是 handler 的 workdir_root,不是注册表。
WORKDIR_READ_FILE_TOOL_NAME = "workdir.read_file"
WORKDIR_READ_FILE_MAX_BYTES = 64 * 1024
_WORKDIR_READ_FILE_TOOL = {
    "name": WORKDIR_READ_FILE_TOOL_NAME,
    "description": "读取当前工作空间内的文本文件（相对路径，≤64KB）。",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "相对工作空间根目录的文件路径，如 src/main.py。",
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    },
    "schema_source": "registry",
}


# P4/W1.T2 观察性:chat emit 交付工具的「正在…」step 标签。与
# chatTrace.CHAT_TRACE_CONFIG.toolLabels 同源,但用 now-doing 措辞(前端 later 消费)。
_CHAT_TOOL_STEP_LABELS = {
    "chat.emit_page": "正在生成网页产物",
    "chat.emit_document": "正在整理文档产物",
    PLAN_UPDATE_TOOL_NAME: "正在更新任务计划",
    WORKDIR_READ_FILE_TOOL_NAME: "正在读取工作空间文件",
}


# J1 PlanGate:计划守门常量。一次 nudge 最多列举的 pending 标题数(超出用「等N项」
# 概括,N = 未完项总数),以及同一 run(段)内最多守门次数——达上限即诚实放行
# (fall-through),永不死循环。
_PLAN_GATE_MAX_TITLES = 3
_PLAN_GATE_MAX_FIRES = 2


# F1 工具错误回喂:模型自己能改的错误(产物字段没填)作为**错误观察**回喂,
# 不是升格成致命 CapabilityError。错误上死循环由 ``max_turns`` 天然兜底。
_TOOL_ERROR_RETRY_HINT = "请修正参数后重试；若该数据确实不可得，请如实说明，不要编造。"
_ARTIFACT_INVALID_HINT = "请补齐 title 与正文内容后重新调用。"


def _tool_error_observation(
    tool_call: ModelToolCall, error_code: str, message: str, hint: str
) -> dict:
    """F1:把一次失败的工具调用折成模型可读的错误观察(形状同成功观察)。"""
    return tool_observation_message(
        tool_call, {"error": error_code, "message": message, "hint": hint}
    )


def current_time_fact(now: datetime | None = None) -> str:
    """F2 日期注入:代码生成的当前时间事实,让模型能换算相对时间(ADR-002)。

    评测 v0 的 G2 证据:用户问「上个月」,模型答 2025-11 —— 真实当日是 2026-08-06。
    提示词里没有时间,模型只能拿训练期猜,于是编出一个月份再据此下经营结论。

    分钟粒度的真实本机时间(诚实规则:注入的是真时钟,不是常量);时区写 UTC 偏移
    而非 ``tzname()`` —— 后者在 Windows 上返回本地化字符串(「中国标准时间」),
    对模型不可靠。
    """
    stamp = now or datetime.now().astimezone()
    offset = stamp.strftime("%z") or "+0000"
    return (
        f"现在是 {stamp.strftime('%Y-%m-%d %H:%M')}"
        f"（本机时区 UTC{offset[:3]}:{offset[3:5]}）。"
        "所有相对时间（上个月、今年、本季度、最近）一律以此换算，不要凭记忆猜测年份。"
    )


def _plan_gate_nudge_text(pending: list[dict]) -> str:
    """J1 PlanGate 的中文续办 nudge —— 纯代码生成(ADR-002,绝不用模型原话)。

    列举未完项标题,最多 ``_PLAN_GATE_MAX_TITLES`` 个;超出用「等N项」概括
    (N = 未完项总数)。标点沿用既有续办文案 ``CHAT_CONTINUE_NUDGE`` 的风格:
    ASCII 冒号/分号/逗号 + 句号(。)。
    """
    total = len(pending)
    titles = [str(item.get("title") or "") for item in pending[:_PLAN_GATE_MAX_TITLES]]
    listed = "、".join(titles)
    if total > _PLAN_GATE_MAX_TITLES:
        listed = f"{listed}等{total}项"
    return (
        f"计划中还有未完成项：{listed}。请继续完成并用 plan.update 更新状态；"
        "若某项实际无法完成，请把它改为说明并更新计划。"
    )


class ChatCapabilityHandler:
    """Per-run chat capability handler bound to a single chat run.

    Constructed by ``ChatOrchestrator`` for each engine run with the
    already-loaded ``skill``, the ``run`` it mutates, and the domain deps.
    """

    def __init__(
        self,
        *,
        skill: LoadedSkill,
        run: ChatRun,
        tool_registry: ChatToolRegistry,
        audit: AuditService,
        hash_payload,
        chat_skill_id: str,
        template_label: str,
        template_instruction: str,
        boss_directive: str | None = None,
        workdir_context_text: str | None = None,
        workdir_root: str | None = None,
        history_messages: list[dict[str, Any]] | None = None,
        resume_messages: list[dict[str, Any]] | None = None,
    ) -> None:
        self.skill = skill
        self.run = run
        self.tool_registry = tool_registry
        self.audit = audit
        self._hash_payload = hash_payload
        self.chat_skill_id = chat_skill_id
        self.template_label = template_label
        self.template_instruction = template_instruction
        # P3 refinement - Boss directive (Agent center), appended to the system
        # prompt when set. None -> prompt unchanged.
        self.boss_directive = boss_directive
        # B2 工作空间:orchestrator 解析 run.workdir_id 得到的 [工作空间] 段与
        # 根目录。两者同生同灭:非 None 时 system 注入上下文 + 注册只读工具;
        # None(未挂/失效)时提示词与工具集与从前 byte-identical。
        self.workdir_context_text = workdir_context_text
        self.workdir_root = workdir_root
        # L1 会话连续性:同 thread 的既往轮(user/assistant 对),由 orchestrator 组装
        # 好传入。注入在 system 之后、当前 user 之前(见 _chat_messages)。None/空 →
        # 消息序列与单轮 byte-identical(单轮与未续聊路径不受影响)。
        self.history_messages = history_messages or []
        # L4a 续办:非 None 时,build_initial_request 直接从这份快照(含 system + 已
        # 完成轮次 + 续办提示)起跑,跳过从头组装 —— 续跑复用已完成的上下文,不重来。
        self.resume_messages = resume_messages
        self._initial_request: ModelRequest | None = None
        # J1 PlanGate:per-run 计划守门计数器。handler 每 run(每续办段)由 orchestrator
        # 新建 → 计数天然随段重置(per-segment 上限)——L4a awaiting_continue 续跑走
        # _prepare_resume 造新 handler,计数归零;可接受且更简单,因为 continue 续跑段
        # 本就不守门(见 _plan_gate_nudge 的 L4a 互锁),守门只发生在首段。
        self._plan_gate_fires = 0
        self._plan_gate_exhausted_logged = False

    # --- CapabilityHandler protocol ----------------------------------------

    def build_initial_request(self) -> ModelRequest:
        """Return the initial chat ``ModelRequest``.

        Memoized: the orchestrator calls this once to populate
        ``QueryConfig.tools`` and the engine calls it again at loop entry, so
        building once keeps both call sites on a single build.
        """
        if self._initial_request is None:
            tools = self.tool_registry.model_visible_tools(
                self.skill,
                discovered_tools=self._discovered_tools(),
            )
            if self.workdir_root:
                # B2:workdir 只读工具仅在 run 挂了有效工作空间时对模型可见。
                tools = [*tools, dict(_WORKDIR_READ_FILE_TOOL)]
            # L4a 续办:续跑从快照起,否则从头组装(system + 历史 + 当前 user)。
            messages = (
                list(self.resume_messages)
                if self.resume_messages is not None
                else self._chat_messages()
            )
            self._initial_request = ModelRequest(messages=messages, tools=tools)
        return self._initial_request

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        """Run one chat tool call, return the observation (no domain fold).

        Governance check → internal tool dispatch → ``tool_observation_message``.
        Governance denial (the model has no right to self-correct a permission
        boundary) surfaces as ``CapabilityError`` so the engine terminates the
        run as failed (the orchestrator maps that to ``chat.run.failed`` +
        error code).
        """
        if tool_call.name == WORKDIR_READ_FILE_TOOL_NAME and self.workdir_root:
            # B2 内建只读工具:per-run 可用性门 = workdir_root(工具只在挂了
            # 有效工作空间时注册,故先于共享注册表检查分发);未挂 workdir 时
            # 落到下方 assert_allowed,按未知工具 fail-closed。
            return self._read_workdir_file(tool_call)
        try:
            self.tool_registry.assert_allowed(tool_call.name)
        except PermissionError as exc:
            raise CapabilityError("tool_not_allowed", str(exc))
        if tool_call.name in ("chat.emit_page", "chat.emit_document"):
            return self._emit_artifact(tool_call)
        if tool_call.name == PLAN_UPDATE_TOOL_NAME:
            return self._apply_plan(tool_call)
        raise CapabilityError(
            "tool_not_allowed",
            f"tool is not available in chat runtime: {tool_call.name}",
        )

    def _emit_artifact(self, tool_call: ModelToolCall) -> dict:
        """P4 交付闭环:emit 工具 → 校验 → run.artifacts 落库 → 审计 → 观察消息。"""
        kind = "page" if tool_call.name == "chat.emit_page" else "doc"
        content_key = "html" if kind == "page" else "markdown"
        title = str(tool_call.arguments.get("title") or "").strip()
        content = str(tool_call.arguments.get(content_key) or "").strip()
        if not title or not content:
            # F1 同族:空 title/正文是模型自己能补的输入错误,不该杀 run。
            return _tool_error_observation(
                tool_call,
                "artifact_invalid",
                f"{tool_call.name} requires non-empty title and {content_key}",
                _ARTIFACT_INVALID_HINT,
            )
        artifact = {
            "id": f"art_{len(self.run.artifacts) + 1}",
            "kind": kind,
            "title": title[:60],
            "content": content,
        }
        self.run.artifacts.append(artifact)
        self.audit.append(
            self.run.audit_events,
            "chat.artifact.emitted",
            self.run.id,
            {
                "artifact_id": artifact["id"],
                "kind": kind,
                "title": artifact["title"],
                "content_hash": self._hash_payload({"content": content}),
            },
        )
        return tool_observation_message(
            tool_call,
            {"ok": True, "artifact_id": artifact["id"], "message": "产物已提交，用户可在画布查看与下载"},
        )

    def _apply_plan(self, tool_call: ModelToolCall) -> dict:
        """W1.T3 计划清单:plan.update → 代码门校验 → 写 run.plan → 审计 → 观察。

        校验失败(ADR-002 代码门)返回工具错误观察——模型读到即可自我纠正重试——
        run.plan 不变、不落审计,run 不失败(F1 起 emit 与 MCP 失败同此语义;
        真正致死的只剩 assert_allowed 的 tool_not_allowed)。
        成功则整表替换 run.plan(幂等)并审计
        ``plan.updated {count, done_count, items}``。``items`` 是刚校验归一化的整表
        (已受代码门约束:≤20 项、title ≤60 字),前端 plan rail 据此渲染 LIVE 清单
        ——``count/done_count`` 无法还原逐项状态,故 W1.T4a 起随审计一并携带。
        """
        try:
            plan = apply_plan_update(self.run.plan, tool_call.arguments.get("items"))
        except PlanUpdateError as exc:
            return tool_observation_message(tool_call, {"ok": False, "error": str(exc)})
        self.run.plan = plan
        done_count = sum(1 for item in plan if item["status"] == "done")
        self.audit.append(
            self.run.audit_events,
            "plan.updated",
            self.run.id,
            {"count": len(plan), "done_count": done_count, "items": plan},
        )
        return tool_observation_message(
            tool_call,
            {"ok": True, "message": f"计划已更新（{len(plan)} 项，{done_count} 完成）"},
        )

    def _read_workdir_file(self, tool_call: ModelToolCall) -> dict:
        """B2 只读工具:工作空间根内相对路径 → 文本内容(≤64KB)。

        一切可预期失败(空参/越界/不存在/是目录/超限/IO)返回说明性错误观察
        ——模型读到即可自我纠正重试——run 不失败(plan.update 校验失败同款
        回执通道)。审计沿现有工具审计机制(model.call.completed 的
        requested_tool_names + 引擎 step/tool_start 帧),不新增事件类型。
        """
        rel = str(tool_call.arguments.get("path") or "").strip()
        if not rel:
            return tool_observation_message(
                tool_call, {"ok": False, "error": "path 不能为空（相对工作空间根目录的文件路径）"}
            )
        root = Path(self.workdir_root).resolve()
        try:
            target = (root / rel).resolve()
            target.relative_to(root)
        except (OSError, ValueError):
            return tool_observation_message(
                tool_call,
                {"ok": False, "error": f"路径越界：{rel} 不在工作空间根目录内，只能读工作空间内的文件"},
            )
        try:
            if not target.exists():
                return tool_observation_message(
                    tool_call, {"ok": False, "error": f"文件不存在：{rel}"}
                )
            if target.is_dir():
                return tool_observation_message(
                    tool_call, {"ok": False, "error": f"{rel} 是目录不是文件，请给出具体文件路径"}
                )
            size = target.stat().st_size
            if size > WORKDIR_READ_FILE_MAX_BYTES:
                return tool_observation_message(
                    tool_call,
                    {
                        "ok": False,
                        "error": (
                            f"文件过大：{rel} 为 {size} 字节，"
                            f"超过 {WORKDIR_READ_FILE_MAX_BYTES} 字节上限"
                        ),
                    },
                )
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return tool_observation_message(
                tool_call, {"ok": False, "error": f"读取失败：{rel}（{exc}）"}
            )
        return tool_observation_message(
            tool_call, {"ok": True, "path": rel, "content": content}
        )

    def _plan_gate_nudge(self) -> str | None:
        """J1 PlanGate:计划仍有未完项时阻止收尾(确定性 in-loop 门,零引擎改动)。

        引擎既有的 ``on_assistant_final`` 钩子——模型不再调工具想收尾时先过此门:

        * ``run.plan`` 尚有 pending/in_progress 项且本段守门次数 < 上限 → 计数 +
          审计 ``plan.gate.fired {pending_count, fire_index}`` + 返回中文续办 nudge,
          引擎据此再跑一轮(nudge 轮照计入 ``max_turns``,顶到即转 L4a
          ``awaiting_continue``,不会死循环);
        * 未完项仍在但次数耗尽 → 审计一次 ``plan.gate.exhausted {pending_count}``
          后返回 None(诚实 fall-through,由 ``on_assistant_final`` 正常收尾);
        * 无 plan 或全部完成 → 返回 None 且**零审计**(空闲零噪声——对没有计划的 run
          此调用无任何副作用,与从前字节等价);
        * L4a continue 续跑段(``resume_messages`` 非 None)→ 不守门:续跑段开场
          已带 ``CHAT_CONTINUE_NUDGE``,且 L4a gate(tests/gates/test_gate_continue.py)
          钉死「continue 一次 → 模型按续办提示收尾 → ready」——本段再守门会把用户
          手动续跑的 run 二次顶回 awaiting_continue(双重 nudge 打架);续跑后的
          完成判断由 J2 Evaluator 接管。
        """
        if self.resume_messages is not None:
            # L4a 互锁:continue 续跑段休眠(理由见上)。首段照常守门。
            return None
        pending = [
            item
            for item in self.run.plan
            if item.get("status") in ("pending", "in_progress")
        ]
        if not pending:
            return None
        pending_count = len(pending)
        if self._plan_gate_fires < _PLAN_GATE_MAX_FIRES:
            self._plan_gate_fires += 1
            self.audit.append(
                self.run.audit_events,
                "plan.gate.fired",
                self.run.id,
                {"pending_count": pending_count, "fire_index": self._plan_gate_fires},
            )
            return _plan_gate_nudge_text(pending)
        if not self._plan_gate_exhausted_logged:
            self._plan_gate_exhausted_logged = True
            self.audit.append(
                self.run.audit_events,
                "plan.gate.exhausted",
                self.run.id,
                {"pending_count": pending_count},
            )
        return None

    def drain_interjections(self) -> list[str]:
        """J3 插话:取走用户在本 run 运行期间说的话(引擎每轮开头调用)。

        引擎的 ``drain_interjections`` opt-in 钩子(getattr 模式)。队列由
        ``BackgroundRunManager.interject`` 经 run_id 投递,这里按 run_id 取走——
        取走即清空(exactly-once),所以同一句插话只会进一次对话,不会在后续轮里重放。
        没人插话时返回空列表,引擎据此完全不改 state(与 J3 之前字节等价)。
        """
        return _drain_run_interjections(self.run.id)

    def _interjection_nudge(self) -> str | None:
        """J3 插话的迟到守卫:最后一轮才收到的插话不许被静默丢掉。

        每轮开头的 ``drain_interjections`` 只能喂到「还有下一轮」的插话。用户在模型
        产出**最后一轮**时才按下发送的那句,没有下一轮可进 —— run 直接 ready、队列随
        清理丢弃,而用户明明看到「已收到补充指示」。那就是本轮要消灭的那种静默谎言。

        所以收尾前再排一次队:还有待办插话 → 取**队首那一条**作为 nudge 返回,引擎在
        既有 nudge 站点把它拼成一条 user 消息再跑一轮(与轮首注入同一形状、同一语义)。

        只取一条(``pop_interjection``)而不是整批 join:J3 契约是**逐条独立**——
        用户说的两件事就是两条 user 消息,合并成一条会抹掉它们之间的边界(压缩与
        journal 回放都依赖这个边界)。剩下的仍在队里,由下一轮轮首的 ``drain`` 各自
        独立注入。取走即出队,所以同一句不会兑现两次,也不会死循环(轮数照样受
        ``max_turns`` 约束)。无插话时返回 None 且零副作用。
        """
        return _pop_run_interjection(self.run.id)

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        """Finalize the run when the model stops calling tools — unless a gate fires.

        J3 插话优先:用户刚说的话排在任何守门之前 —— 若有迟到插话,直接续一轮把它
        交给模型(见 ``_interjection_nudge``),PlanGate 留到下一次收尾再判。

        Then runs J1 PlanGate (``_plan_gate_nudge``): if the model tries to end
        while ``run.plan`` still has unfinished items (and the per-segment fire
        budget is not spent), returns a continuation nudge WITHOUT finalizing —
        no ``ready`` transition, no ``chat.response.generated`` — so the engine
        loops another round. When the gate passes (no plan, all done, or fires
        exhausted) this proceeds exactly as before:

        Sets ``run.assistant_message`` (+ ``associate_goal_text`` iff the
        template is ``associate_goal``), transitions ``generating → ready``,
        and emits ``chat.response.generated`` — byte-identical to the pre-engine
        ``_advance_run`` tail. When the model stops with NO text, fails the run
        ``chat_response_empty`` (the loud no-answer guard). Returns ``None`` when
        the run finalizes; a non-``None`` nudge continues it (PlanGate only).
        """
        steer = self._interjection_nudge()
        if steer is not None:
            return steer
        nudge = self._plan_gate_nudge()
        if nudge is not None:
            return nudge
        message = (assistant_message or "").strip()
        if not message:
            self.run.status = "failed"
            self.run.error_code = "chat_response_empty"
            self.run.error_message = "model response must include assistant content"
            self.audit.append(
                self.run.audit_events,
                "chat.run.failed",
                self.run.id,
                {"error_code": "chat_response_empty"},
            )
            return None
        self.run.assistant_message = message
        self.run.associate_goal_text = (
            message if self.run.template_id == "associate_goal" else None
        )
        self.run.status = "ready"
        self.audit.append(
            self.run.audit_events,
            "chat.response.generated",
            self.run.id,
            {"response_hash": self._hash_payload({"assistant_message": message})},
        )
        return None

    def humanize_step(self, phase: str, tool_call: ModelToolCall | None = None) -> str:
        """Authoritative Chinese ``StepEvent`` label for chat (W1.T2 opt-in).

        Defining this method OPTS chat in to the engine's ``step`` frames. Tool
        phases map to chat's emit deliverables with the "正在…" now-doing
        phrasing (chatTrace-consistent wording); every other
        phase (``analyze`` → 正在思考, ``deliver`` → 正在组织回答) and any unmapped
        tool delegate to ``default_humanize_step``. Always code-generated —
        ADR-002: no model prose ever becomes a status label.
        """
        if phase == "tool" and tool_call is not None:
            label = _CHAT_TOOL_STEP_LABELS.get(tool_call.name)
            if label is not None:
                return label
        return default_humanize_step(phase, tool_call)

    # --- request assembly (moved from the orchestrator's _build_model_request)

    def _discovered_tools(self) -> list[dict]:
        return []

    def _chat_messages(self) -> list[dict[str, Any]]:
        system_content = (
            f"Skill ID: {self.chat_skill_id}\n"
            f"Skill:\n{self.skill.content}\n\n"
            "You are Anna's general assistant. Use only the provided tools. "
            "Do not claim access to live business-system data unless the user "
            "provided that data in the prompt."
        )
        system_content += (
            "\n\nDeliverables: when the user asks for a webpage, CALL chat.emit_page; "
            "for a document/report, CALL chat.emit_document. Submit the COMPLETE content "
            "through the tool (that is the formal deliverable the user sees in the canvas); "
            "in your text answer just summarize briefly - do NOT paste the full content again."
        )
        system_content += (
            "\n\n多步任务：先调用 plan.update 建立任务计划清单，每完成一步立即再次调用 "
            "plan.update 更新对应步骤的状态。"
        )
        if self.workdir_context_text:
            # B2:工作空间是背景材料,先于 Boss 指令(指令保持压轴)。
            system_content += (
                "\n\n" + self.workdir_context_text
                + "\n\n需要查看上述清单中某个文件的内容时，调用 workdir.read_file"
                "（参数 path = 相对根目录路径）。"
            )
        if self.boss_directive:
            system_content += "\n\n[Boss 附加指令]\n" + self.boss_directive
        # F2:时间事实压在最末 —— 它是提示词里唯一每分钟都变的内容,放在最后
        # 意味着它前面的整段前缀(Skill/工具须知/工作空间/Boss 指令)对 KV-cache
        # 仍是稳定的,只有尾巴重算。
        system_content += "\n\n" + current_time_fact()
        user_content = (
            f"Prompt template: {self.template_label}\n"
            f"Template instruction: {self.template_instruction}\n"
            f"User message: {self.run.message}"
        )
        return [
            {"role": "system", "content": system_content},
            # L1:同 thread 历史轮先入,当前 user 压轴 —— 模型按会话顺序看到上下文。
            *self.history_messages,
            {"role": "user", "content": user_content},
        ]
