from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from threading import Lock
from typing import Any

from services.chat.app.capability import ChatCapabilityHandler
from services.chat.app.evaluator import (
    EVALUATOR_SYSTEM_PROMPT,
    CONFIDENCE_ACT_THRESHOLD,
    Judge,
    build_judge_user_content,
    evaluator_nudge_text,
    parse_verdict,
    should_evaluate,
    total_tool_calls,
)
from services.chat.app.schemas import ChatPromptTemplate, ChatRun
from services.memory.app.store import BusinessMemoryStore
from services.reimbursement.app.audit import AuditService
from services.runtime.app.base_orchestrator import BaseOrchestrator
from services.runtime.app.chat_tool_registry import ChatToolRegistry
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import Outcome
from services.runtime.app.engine.capability import LoopOutcome
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_engine import (
    SWALLOWED_ENGINE_TERMINALS,
    QueryEngine,
)
from services.runtime.app.event_stream import AuditFrameWatermark
from services.runtime.app.interjections import pop_interjection
from services.runtime.app.model_provider import ModelRequest, OpenAICompatibleModelProvider
from services.runtime.app.run_store import RunStore
from services.runtime.app.skill_loader import LoadedSkill, SkillLoader, SkillLoaderError
from services.runtime.app.workdir_store import (
    resolve_valid_workdir,
    workdir_system_context,
)


# Chat uses the shared platform engine; bound the model↔tool loop so
# a model that keeps calling tools without answering can never spin forever.
# Budget must cover W1 plan.update bookkeeping rounds (one create + one per step)
# on top of the real ERP tool rounds; 8 aligns with the shared engine default
# max_turns (services/runtime/app/engine/query_config.py).
MAX_CHAT_MODEL_TOOL_ROUNDS = 8


# L1 会话连续性:同 thread 历史回看窗口 —— 最近 N 轮 user/assistant 对拼进下一轮
# 模型请求。窗口取粗界即可:更早的历史由模型请求前既有的便宜压缩兜底(overflow),
# LLM 摘要层的深度续办留待 L4。
THREAD_HISTORY_TURNS = 6


CHAT_PROMPT_TEMPLATES = (
    ChatPromptTemplate(
        id="summarize",
        label="总结",
        description="把材料整理成摘要、重点和下一步。",
        prompt="请提炼内容摘要、关键事实和下一步建议。",
    ),
    ChatPromptTemplate(
        id="analyze",
        label="分析",
        description="分析业务问题、原因和风险。",
        prompt="请基于输入分析问题、可能原因、风险和可执行建议。",
    ),
    ChatPromptTemplate(
        id="task_plan",
        label="生成任务计划",
        description="把目标拆成任务、依赖和交付物。",
        prompt="请把目标拆成任务计划，列出步骤、依赖、负责人建议和产出。",
    ),
    ChatPromptTemplate(
        id="associate_goal",
        label="转为 Associate 目标",
        description="把复杂目标整理成可交给 Associate 推进的目标描述。",
        prompt="请把输入整理成一个清晰的 Associate 目标，包含目标、约束、时间和成功指标。",
    ),
)


_CONFIG_ERROR_MESSAGE = "model endpoint and API key are required before running Anna Chat"
# L4a 续办:续跑时作为一条 user 消息注入,提示模型接着做、别重做已完成的部分。
CHAT_CONTINUE_NUDGE = "继续完成剩余任务；已完成的部分不要重做。"

logger = logging.getLogger(__name__)

# L2:chat run 落库的 surface 维度键(run_store 一张表按 surface 区分)。
_CHAT_SURFACE = "chat"


def _run_creation_order_key(run: ChatRun) -> tuple[str, str]:
    """Stable creation-order key: first audit event timestamp, then run id.

    A run's first audit event is ``chat.run.created`` — appended once at creation
    and never mutated — so its monotonic ``created_at`` is the run's creation
    instant; the run id breaks a same-microsecond tie. Orders merged
    registry+store lists deterministically without a dedicated column.
    """
    created_at = run.audit_events[0].created_at if run.audit_events else ""
    return (created_at, run.id)


def _rehydrate_run(payload: dict[str, Any]) -> ChatRun | None:
    """Validate one persisted payload into a ChatRun, or ``None`` if corrupt.

    A store row whose JSON no longer matches the current ``ChatRun`` schema (a
    forward/backward-incompatible payload, or a truncated write) must NOT sink an
    otherwise-recoverable lookup, list, or thread history — mirrors
    ``run_store.list_frames``' per-row skip. Logged, skipped: a get treats the
    corrupt row as absent, a list/history keeps every healthy sibling.
    """
    try:
        return ChatRun.model_validate(payload)
    except Exception:  # noqa: BLE001 — one corrupt row must never sink the rest
        run_id = payload.get("id") if isinstance(payload, dict) else None
        logger.warning("skipping corrupt chat run payload id=%s", run_id, exc_info=True)
        return None


class ChatRunNotFoundError(Exception):
    pass


@dataclass
class _EvaluationCarry:
    """Mutable carry-out from the evaluation rounds to the steering tail (J2/J3).

    ``_evaluation_rounds`` streams frames, so it is an async generator and cannot
    ``return`` a value — the same reason the engine hands its ``LoopOutcome`` back
    through a mutable ``Outcome`` holder. ``last_messages`` is the conversation
    the last clean segment ended on (what any further segment resumes from);
    ``rounds_started`` records whether a judge round actually opened, which is
    exactly the window during which an interjection could have been accepted.
    """

    last_messages: list[dict[str, Any]] | None = None
    rounds_started: bool = False


@dataclass(frozen=True)
class ChatHostInputs:
    """Resolved, model-free Chat inputs handed to the Node Host."""

    request: ModelRequest
    skill: LoadedSkill
    skill_id: str
    agent_directive: str | None
    workdir_root: str | None


class ChatOrchestrator(BaseOrchestrator):
    _fail_event_type = "chat.run.failed"
    _fail_payload_includes_message = False
    _hash_payload_ensure_ascii = False
    _run_id_prefix = "chat_run_"

    def __init__(
        self,
        model_provider: OpenAICompatibleModelProvider | None = None,
        skill_loader: SkillLoader | None = None,
        memory_store: BusinessMemoryStore | None = None,
        audit: AuditService | None = None,
        settings: RuntimeSettings | None = None,
        tool_registry: ChatToolRegistry | None = None,
        engine: QueryEngine | None = None,
        engine_factory: Callable[[RuntimeSettings], QueryEngine] | None = None,
        run_store: RunStore | None = None,
        evaluator_judge: Judge | None = None,
    ) -> None:
        self.settings = settings or RuntimeSettings.from_env()
        self.model_provider = model_provider or OpenAICompatibleModelProvider(self.settings)
        self.audit = audit or AuditService()
        self.tool_registry = tool_registry or ChatToolRegistry()
        # Chat's ReAct loop now runs on the shared platform engine. Default
        # wires the real governed streaming model (production_deps); tests
        # inject a fake stream_model via QueryEngine(deps=...).
        self.engine = engine or QueryEngine(self.settings)
        # P3 refinement — per-profile engines, built lazily from settings
        # variants (resolve_model_profile). Factory injectable so tests wire
        # fake stream models for non-default profiles too.
        self._engine_factory = engine_factory or (
            lambda settings: QueryEngine(settings)
        )
        self._profile_engines: dict[str, QueryEngine] = {}
        self.skill_loader = skill_loader or SkillLoader()
        self.memory_store = memory_store
        # L2 Run 持久化 (P2 状态外置):可选 run store。None → 纯内存(既有单测/
        # 注入编排器行为不变);有值 → 创建即写、终态即写,list/get 内存 miss 落库。
        self._run_store = run_store
        # Seed the run-id counter from the store so ids keep climbing across a
        # restart (a cold counter would re-mint chat_run_001 and collide with a
        # persisted run — breaking same-thread continuation and overwriting it).
        self._run_counter = (
            run_store.max_run_sequence(_CHAT_SURFACE, self._run_id_prefix)
            if run_store is not None
            else 0
        )
        self._runs: dict[str, ChatRun] = {}
        self._save_lock = Lock()
        # J2 判断力轮 Evaluator:独立上下文法官(injectable seam,同 run_store 的默认
        # 关闭纪律)。None → 判断层惰性无操作(零评估事件、字节等价 —— 既有单测/编排
        # 器不受影响);生产工厂显式注入 evaluator.build_judge(settings) 开启评估;测试
        # 注入 fake judge。判断层实际是否运行 = evaluation_enabled 且 judge 已装配。
        self._evaluator_judge = evaluator_judge
        if not self.settings.evaluation_enabled:
            # Off is a legitimate configuration; being SILENT about it is not.
            # With evaluation disabled a run declares itself done with no
            # verification and emits ZERO evaluation events — a trail that reads
            # exactly like "nothing was worth judging". One warning at
            # construction is what lets an operator tell the two apart. Audit is
            # deliberately untouched (zero events when disabled is the spec).
            logger.warning(
                "chat judgment layer is disabled by config (evaluation.enabled=false)"
                " — runs will be declared done with no completion verification"
            )

    def prompt_templates(self) -> list[ChatPromptTemplate]:
        return list(CHAT_PROMPT_TEMPLATES)

    def start_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        message: str,
        template_id: str | None = None,
        model_profile_id: str | None = None,
        skill_id: str | None = None,
        agent_id: str | None = None,
        workdir_id: str | None = None,
        thread_id: str | None = None,
    ) -> ChatRun:
        run = self._begin_run(
            workspace_id, actor_user_id, message, template_id, model_profile_id, skill_id,
            agent_id=agent_id, workdir_id=workdir_id, thread_id=thread_id,
        )
        return self._advance_run(run)

    def create_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        message: str,
        template_id: str | None = None,
        model_profile_id: str | None = None,
        skill_id: str | None = None,
        agent_id: str | None = None,
        workdir_id: str | None = None,
        thread_id: str | None = None,
    ) -> ChatRun:
        """Create + register a run WITHOUT advancing it (L3a background submit).

        The synchronous first half of ``stream_run``: allocate the run id, append
        ``chat.run.created``, write-through persist. The L3a background runner
        calls this to get an immediate run id (returned to the client), then
        drives ``stream_existing_run`` on the run in an ``asyncio.create_task`` so
        the run is decoupled from any request/subscription (pillar P3 恢复力).
        """
        return self._begin_run(
            workspace_id, actor_user_id, message, template_id, model_profile_id, skill_id,
            agent_id=agent_id, workdir_id=workdir_id, thread_id=thread_id,
        )

    async def stream_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        message: str,
        template_id: str | None = None,
        model_profile_id: str | None = None,
        skill_id: str | None = None,
        agent_id: str | None = None,
        workdir_id: str | None = None,
        thread_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream a Chat turn on the platform engine, yielding wire frames.

        The streaming twin of ``start_run`` — same semantics (run.created audit
        → skill load + preflight → engine → outcome mapping) but driven with
        ``async for`` in THIS task so engine process events reach the client
        live. Frame contract — now IDENTICAL to finance/hiker/reimbursement (the
        R2 ``text_delta`` uniformity cleanup; the frontend's consumeAgentStream
        consumes every frame):

        * ``{"type": "text_delta", "text": ...}`` — one streamed assistant token
          (the engine's native token frame; chat's R1 remap to ``delta`` is
          gone — the frontend normalizes both into the answer bubble);
        * ``{"type": "done", "run": <run>}`` — exactly one terminal, carrying
          the final run (the engine's run-less terminals are swallowed and
          mapped onto the run);
        * ``{"type": "error", "run": <run>}`` — chat's error shape (the
          frontend reads ``run.error_code`` / ``run.error_message``); emitted
          for a preflight/skill failure OR an unexpected raise;
        * ``{"type": "tool_start"/"tool_done", "name": ...}`` and
          ``{"type": "event", "event": <AuditEvent>}`` process/audit frames the
          Stage/Step trace folds;
        * ``{"type": "step", "phase": ..., "intent": ..., "tool": ..., "turn": ...}``
          authoritative process markers (W1.T2). The engine emits them because
          ``ChatCapabilityHandler`` defines ``humanize_step``; they ride the same
          channel as ``tool_start`` and are forwarded as-is by the pass-through
          below (they are not in ``SWALLOWED_ENGINE_TERMINALS``). FE consumption
          is a later task — this surface is the authority, not the FE guess.

        Client disconnect / stop button closes this generator; an in-flight
        run is finalized as ``failed`` / ``client_disconnected`` (chat runs are
        read-only and NOT resumable — fresh run per request, no route
        re-advances an existing run).

        L3a split: run creation + the streaming body were extracted into
        ``create_run`` + ``stream_existing_run`` so the L3a background runner can
        pre-create the run then drive the SAME body in a task. This legacy path
        delegates to both and — critically — propagates a GeneratorExit into the
        inner generator via ``finally: await inner.aclose()``, so the
        client_disconnected finalization still fires for THIS request-bound route
        (an ``async for`` alone would not close the inner generator).
        """
        run = self.create_run(
            workspace_id, actor_user_id, message, template_id, model_profile_id, skill_id,
            agent_id=agent_id, workdir_id=workdir_id, thread_id=thread_id,
        )
        inner = self.stream_existing_run(run)
        try:
            async for frame in inner:
                yield frame
        finally:
            # Propagate a close (client disconnect / stop) into the inner
            # generator so ITS GeneratorExit handler runs synchronously within
            # this aclose — preserving the legacy client_disconnected finalize.
            await inner.aclose()

    async def stream_existing_run(
        self, run: ChatRun, *, skip_history: bool = False
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream an ALREADY-CREATED run on the engine (the ``stream_run`` body).

        Extracted verbatim from ``stream_run`` (everything after run creation).
        Two drivers share it: the legacy ``stream_run`` (creates the run, then
        delegates here) and the L3a background runner (pre-creates via
        ``create_run``, then drives this in a task, journaling every frame). The
        frame contract and the GeneratorExit → client_disconnected finalization
        are unchanged. In the background path the client_disconnected guard is
        never reachable: a subscriber disconnect closes only its subscription
        (never this generator), and an explicit stop finalizes the run terminal
        BEFORE cancelling — so this guard sees an already-terminal run and no-ops.

        ``skip_history=True`` (L5) starts the audit watermark past the events
        already on the run when streaming begins: the background manager
        journals the pre-drive trail itself (``chat.run.created``, and
        ``run.queued`` when the workspace gate parks the run) so those frames
        are visible BEFORE the engine starts — the watermark must not re-emit
        them. The legacy request-bound path keeps the default (flush history).
        """
        # Propagate a close (client disconnect / stop) into the shared body so ITS
        # GeneratorExit handler runs synchronously within this aclose — an
        # ``async for`` alone would leave the inner generator un-closed and skip
        # the client_disconnected finalize.
        inner = self._stream_run_body(run, self._prepare_advance, skip_history=skip_history)
        try:
            async for frame in inner:
                yield frame
        finally:
            await inner.aclose()

    async def stream_resumed_run(self, run: ChatRun) -> AsyncIterator[dict[str, Any]]:
        """Resume an ``awaiting_continue`` run on the engine (L4a 续办).

        The continuation twin of ``stream_existing_run``: it restarts the engine
        from ``run.suspended_messages`` + a continuation nudge (via
        ``_prepare_resume``) with a FRESH ``max_turns`` budget, rather than
        re-assembling the turn from scratch. The run flips back to ``generating``
        and only the NEW audit events are streamed (``skip_history`` so the resumed
        subscription never re-emits the suspended segment's trail). The
        ``BackgroundRunManager`` drives this in a new task on a continuation
        journal whose ``seq`` continues past the suspended segment.
        """
        run.status = "generating"
        inner = self._stream_run_body(run, self._prepare_resume, skip_history=True)
        try:
            async for frame in inner:
                yield frame
        finally:
            await inner.aclose()

    async def _stream_run_body(
        self,
        run: ChatRun,
        prepare: Callable[
            [ChatRun],
            tuple[
                ChatCapabilityHandler | None,
                QueryConfig | None,
                QueryEngine | None,
                ChatRun | None,
            ],
        ],
        *,
        skip_history: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        """Shared streaming body for a fresh advance OR a resume (L4a).

        ``prepare`` resolves the handler/config/engine (``_prepare_advance`` for a
        fresh turn, ``_prepare_resume`` for a continuation); ``skip_history`` starts
        the audit watermark past the events already on the run so a resume streams
        only its NEW trail. Frame contract and the GeneratorExit →
        client_disconnected finalization are unchanged; a ``max_turns`` suspension
        (``awaiting_continue``) yields NO ``done``/``error`` terminal — its
        ``run.suspended`` audit-event frame already carried the rest and the
        journal closes cleanly.
        """
        watermark = AuditFrameWatermark(run.audit_events, skip_history=skip_history)
        try:
            handler, config, engine, failed_run = prepare(run)
            if failed_run is not None:
                for frame in watermark.new_frames():
                    yield frame
                yield {"type": "error", "run": failed_run}
                return
            # Flush run.created + skill.loaded before the first (slow) model call.
            for frame in watermark.new_frames():
                yield frame

            outcome = Outcome()
            async for event in engine.run(
                config, handler, run.id, run.audit_events, outcome
            ):
                for frame in watermark.new_frames():
                    yield frame
                event_type = event.get("type")
                if event_type in SWALLOWED_ENGINE_TERMINALS:
                    continue
                # text_delta / tool_start / tool_done / step forwarded as-is. Chat
                # now emits the engine's native text_delta token frame (identical to
                # finance/hiker/reimbursement) — the R1 delta remap is gone. Zero
                # user-facing change: the frontend's consumeAgentStream normalizes
                # both delta and text_delta into onTextDelta → the answer bubble.
                # W1.T2 step frames flow through this same pass-through.
                yield event
            assert outcome.value is not None  # a fully-drained stream always sets it
            final_run = self._resolve_outcome(run, outcome.value)
            for frame in watermark.new_frames():
                yield frame

            # J2 判断力轮 Evaluator:仅在本段正常完成 (completed→ready) 时,宣布办妥前
            # 先过判断层 —— 便宜规则触发 → 独立法官 → 至多一次自动补办 → 诚实标注。
            # 评估自身恒 fail-open;续跑的模型/工具/审计帧与判断层审计帧都走本生成器
            # (同一 _drive/journal),seq 天然跨续跑连续。惰性无操作(judge 未装配或
            # 配置关)时零评估事件,字节等价 —— 既有 surface/测试不受影响。
            if outcome.value.status == "completed" and final_run.status == "ready":
                async for frame in self._evaluate_and_continue(
                    run, watermark, outcome.value.messages
                ):
                    yield frame
                # The run was mutated in place to its post-evaluation terminal.
                final_run = run
                self._persist_run(run)

            if final_run.status == "failed":
                yield {"type": "error", "run": final_run}
            elif final_run.status == "awaiting_continue":
                # A resumable pause, not a terminal. The run.suspended audit-event
                # frame was just flushed; the background journal closes cleanly on
                # return, and POST .../continue restarts the engine. No done/error.
                return
            else:
                yield {"type": "done", "run": final_run}
        except GeneratorExit:
            # Client disconnect / stop button: the route closes this generator
            # mid-stream. Finalize an in-flight run as failed/client_disconnected;
            # a close after a terminal (ready/failed/saved) OR a healthy pause
            # (awaiting_continue) must not overwrite it. Mutate only — never yield
            # after GeneratorExit.
            if run.status not in ("ready", "failed", "saved", "awaiting_continue"):
                self._fail_run(
                    run,
                    "client_disconnected",
                    "client disconnected before the chat run finished",
                )
            raise
        except Exception as exc:  # noqa: BLE001 — surface as a chat error frame
            for frame in watermark.new_frames():
                yield frame
            yield {
                "type": "error",
                "run": self._fail_run(run, "chat_run_failed", str(exc)),
            }

    def get_run(self, run_id: str) -> ChatRun:
        # L2 read fallback: in-memory registry first (live, authoritative), then
        # the run store on a miss (survives a restart). Registry wins on match.
        run = self._runs.get(run_id)
        if run is not None:
            return run
        if self._run_store is not None:
            payload = self._run_store.get_run(_CHAT_SURFACE, run_id)
            if payload is not None:
                run = _rehydrate_run(payload)
                if run is not None:
                    return run  # a corrupt row falls through to not-found
        raise ChatRunNotFoundError(run_id)

    def list_runs(self, workspace_id: str, actor_user_id: str) -> list[ChatRun]:
        registry_runs = [
            run
            for run in reversed(list(self._runs.values()))
            if run.workspace_id == workspace_id and run.actor_user_id == actor_user_id
        ]
        if self._run_store is None:
            return registry_runs
        # L2 read fallback: merge store rows in, de-duped by run_id with the
        # in-memory version winning; newest-first (creation order, descending).
        seen = {run.id for run in registry_runs}
        merged = list(registry_runs)
        for payload in self._run_store.list_runs(
            _CHAT_SURFACE, workspace_id, actor_user_id
        ):
            if payload.get("id") in seen:
                continue
            seen.add(payload.get("id"))
            run = _rehydrate_run(payload)
            if run is not None:
                merged.append(run)  # skip a corrupt row, keep the rest
        merged.sort(key=_run_creation_order_key, reverse=True)
        return merged

    def save_result(self, run_id: str, saved_by: str) -> ChatRun:
        with self._save_lock:
            run = self.get_run(run_id)
            if run.status not in {"ready", "saved"} or not run.assistant_message:
                return self._fail_run(
                    run,
                    "chat_result_not_ready",
                    "chat result must be ready before saving",
                )
            if run.saved_memory_id:
                return run
            if self.memory_store is None:
                return self._fail_run(
                    run,
                    "memory_store_not_configured",
                    "Business Memory store is required before saving chat results",
                )
            memory = self.memory_store.add(
                workspace_id=run.workspace_id,
                memory_type="chat_result",
                title=f"Chat: {run.template_id or 'general'}",
                content=run.assistant_message,
                source=f"chat:{saved_by}",
                confidence=1.0,
            )
            run.saved_memory_id = memory.id
            run.status = "saved"
            self.audit.append(
                run.audit_events,
                "chat.result.saved",
                run.id,
                {"memory_id": memory.id, "saved_by": saved_by},
            )
            # L2 write-through: "saved" is a terminal transition set directly here.
            self._persist_run(run)
            return run

    # --- engine wiring -----------------------------------------------------

    def _fail_run(self, run: Any, error_code: str, message: str) -> Any:
        """Fail the run (shared bookkeeping) then write-through the terminal.

        Overrides ``BaseOrchestrator._fail_run`` so EVERY failure path — preflight,
        skill/profile, exhaustion, client-disconnect, unexpected raise, save
        guards — persists its terminal ``failed`` state without a call site at
        each spot. The success terminals (ready / saved) persist explicitly.
        """
        result = super()._fail_run(run, error_code, message)
        self._persist_run(result)
        return result

    def _persist_run(self, run: ChatRun) -> None:
        """Write-through one run to the store; a store failure never breaks it.

        Honest degradation: if persistence raises, the run still lives in the
        in-memory registry and its response is already returned to the caller —
        we log and swallow rather than turn a healthy run into an error.
        """
        if self._run_store is None:
            return
        try:
            self._run_store.save_run(
                surface=_CHAT_SURFACE,
                run_id=run.id,
                thread_id=run.thread_id,
                workspace_id=run.workspace_id,
                actor_user_id=run.actor_user_id,
                status=run.status,
                created_at=(
                    run.audit_events[0].created_at if run.audit_events else ""
                ),
                payload=run.model_dump(mode="json"),
            )
        except Exception:  # noqa: BLE001 — persistence must not break a live run
            logger.warning("chat run %s failed to persist", run.id, exc_info=True)

    def _begin_run(
        self,
        workspace_id: str,
        actor_user_id: str,
        message: str,
        template_id: str | None,
        model_profile_id: str | None = None,
        skill_id: str | None = None,
        agent_id: str | None = None,
        workdir_id: str | None = None,
        thread_id: str | None = None,
    ) -> ChatRun:
        """Create + register a run and emit ``chat.run.created`` (shared)."""
        run_id = self._next_run_id()
        run = ChatRun(
            id=run_id,
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            message=message,
            # L1:首轮自指(thread_id = 自身 run_id),续聊沿用调用方传入的线程 id。
            thread_id=thread_id or run_id,
            template_id=template_id,
            model_profile_id=model_profile_id,
            skill_id=skill_id,
            agent_id=agent_id,
            workdir_id=workdir_id,
            status="generating",
        )
        self._runs[run.id] = run
        self.audit.append(
            run.audit_events,
            "chat.run.created",
            run.id,
            {
                "message_hash": self._hash_payload({"message": message}),
                "template_id": template_id,
                "model_profile_id": model_profile_id,
                "skill_id": skill_id,
                "agent_id": agent_id,
                "workdir_id": workdir_id,
            },
        )
        # L2 write-through: persist at creation (status "generating") so a run
        # whose process dies mid-flight is recorded — the startup sweep will heal
        # it to "interrupted" rather than losing it silently.
        self._persist_run(run)
        return run

    def _advance_run(self, run: ChatRun) -> ChatRun:
        # The legacy SYNC entry (POST /api/chat/runs). J2 note: the judgment layer
        # lives on the STREAMING body (the production submit/background path drives
        # it); this non-streaming drain deliberately does NOT evaluate — it stays a
        # simple synchronous advance. (The judge is an async, off-loop call; wiring
        # it here would mean a sync↔async bridge for a legacy path the FE no longer
        # uses.)
        handler, config, engine, failed_run = self._prepare_advance(run)
        if failed_run is not None:
            return failed_run
        outcome = engine.run_to_outcome(config, handler, run.id, run.audit_events)
        return self._resolve_outcome(run, outcome)

    def _engine_for(self, profile_id: str | None, resolved: RuntimeSettings) -> QueryEngine:
        """Default profile → the shared engine; others → lazily-built variants."""
        if not profile_id or profile_id == "default" or resolved is self.settings:
            return self.engine
        if profile_id not in self._profile_engines:
            self._profile_engines[profile_id] = self._engine_factory(resolved)
        return self._profile_engines[profile_id]

    def _prepare_advance(
        self, run: ChatRun
    ) -> tuple[
        ChatCapabilityHandler | None, QueryConfig | None, QueryEngine | None, ChatRun | None
    ]:
        """Resolve profile, load the skill, preflight, and build engine inputs.

        Returns ``(handler, config, engine, None)`` when the run may advance,
        or ``(None, None, None, failed_run)`` when profile resolution / skill
        load / preflight already failed it. Preflight (model + connector) and
        the ``skill.loaded`` audit stay here, BEFORE the engine runs — the
        engine loop has no preflight step. Preflight checks the RESOLVED
        profile's settings, so a fully-configured non-default profile works
        even when the global default model is unconfigured.
        """
        # L1 会话连续性:先组装同 thread 历史(近 N 轮 user/assistant 对)。真的拼进
        # 历史时,紧接 run 创建事件补一条 chat.thread.continued 审计(prior_turns =
        # 纳入的对数)。空历史(首轮 / 未知 thread / 无同身份匹配轮)→ 不注入、不审计
        # (幂等友好)。历史随 build_initial_request 进模型请求,长度由请求前既有的便宜
        # 压缩兜底 —— 不新增压缩逻辑(L4)。
        history_messages = self._thread_history_messages(run)
        if history_messages:
            self.audit.append(
                run.audit_events,
                "chat.thread.continued",
                run.id,
                {"thread_id": run.thread_id, "prior_turns": len(history_messages) // 2},
            )
        try:
            resolved_settings = self.settings.resolve_model_profile(run.model_profile_id)
        except KeyError:
            return None, None, None, self._fail_run(
                run,
                "model_profile_not_found",
                f"model profile '{run.model_profile_id}' is not configured",
            )

        effective_skill_id = run.skill_id or self.settings.chat_skill_id
        skill, failed_run = self._load_skill_and_record(run, effective_skill_id)
        if skill is None:
            return None, None, None, failed_run

        if not (resolved_settings.model_api_key and resolved_settings.model_endpoint):
            return None, None, None, self._fail_run(
                run, "model_not_configured", _CONFIG_ERROR_MESSAGE
            )

        template = self._template(run.template_id)
        workdir_context_text, workdir_root = self._workdir_injection(run)
        handler = ChatCapabilityHandler(
            skill=skill,
            run=run,
            tool_registry=self.tool_registry,
            audit=self.audit,
            hash_payload=self._hash_payload,
            chat_skill_id=effective_skill_id,
            template_label=template.label if template else "通用对话",
            template_instruction=template.prompt if template else "直接回答用户问题。",
            # per-run 专家选择(M2):选了 Agent 用其附加指令,否则域默认 "chat"。
            boss_directive=self.settings.agent_directive(run.agent_id or "chat"),
            # B2 工作空间:有效则 [工作空间] 段入 system + 挂 workdir.read_file。
            workdir_context_text=workdir_context_text,
            workdir_root=workdir_root,
            # L1:同 thread 历史轮,注入在 system 之后、当前 user 之前。
            history_messages=history_messages,
        )
        config = QueryConfig(
            run_id=run.id,
            skill_id=skill.id,
            tools=handler.build_initial_request().tools,
            max_turns=MAX_CHAT_MODEL_TOOL_ROUNDS,
            config_error_message=_CONFIG_ERROR_MESSAGE,
            # L4a 续办:顶到 max_turns 不判死,转可续办暂停态(awaiting_continue)。
            suspend_on_exhaust=True,
            # J2 判断力轮:completed outcome 携带最终消息,供判断层的自动补办续跑复用
            # (默认关字节等价;仅 chat 开启)。
            carry_messages_on_complete=True,
        )
        engine = self._engine_for(run.model_profile_id, resolved_settings)
        return handler, config, engine, None

    def _prepare_resume(
        self, run: ChatRun
    ) -> tuple[
        ChatCapabilityHandler | None, QueryConfig | None, QueryEngine | None, ChatRun | None
    ]:
        """Build engine inputs to RESUME an ``awaiting_continue`` run (L4a 续办).

        Mirrors ``_prepare_advance`` (profile resolve → skill load + audit →
        preflight → workdir), but the handler starts from the SUSPENDED messages
        plus a continuation nudge instead of a from-scratch assembly, and the
        engine gets a FRESH ``max_turns`` budget (it may suspend again). No thread
        history is assembled — the suspended snapshot already carries the full
        conversation.
        """
        try:
            resolved_settings = self.settings.resolve_model_profile(run.model_profile_id)
        except KeyError:
            return None, None, None, self._fail_run(
                run,
                "model_profile_not_found",
                f"model profile '{run.model_profile_id}' is not configured",
            )

        effective_skill_id = run.skill_id or self.settings.chat_skill_id
        skill, failed_run = self._load_skill_and_record(run, effective_skill_id)
        if skill is None:
            return None, None, None, failed_run

        if not (resolved_settings.model_api_key and resolved_settings.model_endpoint):
            return None, None, None, self._fail_run(
                run, "model_not_configured", _CONFIG_ERROR_MESSAGE
            )

        template = self._template(run.template_id)
        workdir_context_text, workdir_root = self._workdir_injection(run)
        resume_messages = [
            *(run.suspended_messages or []),
            {"role": "user", "content": CHAT_CONTINUE_NUDGE},
        ]
        handler = ChatCapabilityHandler(
            skill=skill,
            run=run,
            tool_registry=self.tool_registry,
            audit=self.audit,
            hash_payload=self._hash_payload,
            chat_skill_id=effective_skill_id,
            template_label=template.label if template else "通用对话",
            template_instruction=template.prompt if template else "直接回答用户问题。",
            boss_directive=self.settings.agent_directive(run.agent_id or "chat"),
            workdir_context_text=workdir_context_text,
            workdir_root=workdir_root,
            resume_messages=resume_messages,
        )
        config = QueryConfig(
            run_id=run.id,
            skill_id=skill.id,
            tools=handler.build_initial_request().tools,
            max_turns=MAX_CHAT_MODEL_TOOL_ROUNDS,
            config_error_message=_CONFIG_ERROR_MESSAGE,
            suspend_on_exhaust=True,
            carry_messages_on_complete=True,
        )
        engine = self._engine_for(run.model_profile_id, resolved_settings)
        return handler, config, engine, None

    def _prepare_evaluator_resume(
        self, run: ChatRun, resume_messages: list[dict[str, Any]]
    ) -> tuple[ChatCapabilityHandler, QueryConfig, QueryEngine] | None:
        """Build engine inputs for an INTERNAL evaluator continuation (J2 补办).

        Mirrors ``_prepare_resume`` (profile → skill → preflight → workdir →
        handler from ``resume_messages``) but with three J2-specific twists:

        * ``resume_messages`` already carries the evaluator补办 nudge as its last
          user turn (so J1 PlanGate is DORMANT — a handler with ``resume_messages``
          set never守门; J2's judge owns the post-continuation completion call);
        * ``carry_messages_on_complete`` is set so the补办 segment can itself be
          re-judged;
        * it NEVER fails the run — on ANY prep problem it returns ``None`` and the
          evaluator falls open (the first answer is already delivered; a prep
          hiccup must not turn a ready run into a failure). Unlike
          ``_prepare_resume`` it does NOT re-audit ``skill.loaded`` (the skill
          loaded on the first segment; the continuation reuses it silently).
        """
        try:
            resolved_settings = self.settings.resolve_model_profile(run.model_profile_id)
        except KeyError:
            return None
        effective_skill_id = run.skill_id or self.settings.chat_skill_id
        try:
            skill = self.skill_loader.load(effective_skill_id)
        except SkillLoaderError:
            return None
        if not (resolved_settings.model_api_key and resolved_settings.model_endpoint):
            return None
        template = self._template(run.template_id)
        workdir_context_text, workdir_root = self._workdir_injection(run)
        handler = ChatCapabilityHandler(
            skill=skill,
            run=run,
            tool_registry=self.tool_registry,
            audit=self.audit,
            hash_payload=self._hash_payload,
            chat_skill_id=effective_skill_id,
            template_label=template.label if template else "通用对话",
            template_instruction=template.prompt if template else "直接回答用户问题。",
            boss_directive=self.settings.agent_directive(run.agent_id or "chat"),
            workdir_context_text=workdir_context_text,
            workdir_root=workdir_root,
            resume_messages=resume_messages,
        )
        config = QueryConfig(
            run_id=run.id,
            skill_id=skill.id,
            tools=handler.build_initial_request().tools,
            max_turns=MAX_CHAT_MODEL_TOOL_ROUNDS,
            config_error_message=_CONFIG_ERROR_MESSAGE,
            suspend_on_exhaust=True,
            carry_messages_on_complete=True,
        )
        engine = self._engine_for(run.model_profile_id, resolved_settings)
        return handler, config, engine

    def build_host_inputs(self, run: ChatRun) -> ChatHostInputs:
        """Resolve Chat context/tools for a model-free Product Host task.

        This reuses the normal Chat capability constructor but deliberately
        stops before model preflight or the Python engine loop. The Node Host
        remains the sole model/tool-loop authority in product mode.
        """
        handler = self.build_host_capability(run)
        return ChatHostInputs(
            request=handler.build_initial_request(),
            skill=handler.skill,
            skill_id=handler.chat_skill_id,
            agent_directive=handler.boss_directive,
            workdir_root=handler.workdir_root,
        )

    def build_host_capability(self, run: ChatRun) -> ChatCapabilityHandler:
        """Build the resolved Chat capability without starting the Python loop."""
        skill_id = run.skill_id or self.settings.chat_skill_id
        skill = self.skill_loader.load(skill_id)
        if not any(event.type == "skill.loaded" for event in run.audit_events):
            self._record_skill_loaded(run, skill)
        template = self._template(run.template_id)
        workdir_context_text, workdir_root = self._workdir_injection(run)
        directive = self.settings.agent_directive(run.agent_id or "chat")
        handler = ChatCapabilityHandler(
            skill=skill,
            run=run,
            tool_registry=self.tool_registry,
            audit=self.audit,
            hash_payload=self._hash_payload,
            chat_skill_id=skill_id,
            template_label=template.label if template else "通用对话",
            template_instruction=template.prompt if template else "直接回答用户问题。",
            boss_directive=directive,
            workdir_context_text=workdir_context_text,
            workdir_root=workdir_root,
            history_messages=self._thread_history_messages(run),
        )
        return handler

    def _workdir_injection(self, run: ChatRun) -> tuple[str | None, str | None]:
        """B2:解析 run.workdir_id → ``(system 上下文文本, 根目录)``。

        注册表 miss 或路径失踪 → ``(None, None)`` 并审计 ``workdir.missing``
        (诚实降级:不注入、不挂读工具,run 照常进行,绝不 fail)。
        """
        if not run.workdir_id:
            return None, None
        workdir = resolve_valid_workdir(run.workdir_id)
        if workdir is None:
            self.audit.append(
                run.audit_events,
                "workdir.missing",
                run.id,
                {"workdir_id": run.workdir_id},
            )
            return None, None
        return workdir_system_context(workdir), workdir["path"]

    def _thread_prior_runs(self, run: ChatRun) -> list[ChatRun]:
        """The ONE data-source seam for thread history — registry + store (L2).

        Returns this thread's PRIOR runs (excluding ``run`` itself), in creation
        order. The in-memory registry (``self._runs``, dict insertion order ==
        creation order) is the live source; L2 merges in the run store so a
        thread survives a restart (registry cold, history from disk). De-duped by
        run id with the in-memory version winning, then re-sorted into creation
        order — so a partial split across the two sources still reads in order.

        Cross-identity guard mirrors ``_assert_run_access`` (security.py): a run
        is included only when BOTH ``workspace_id`` and ``actor_user_id`` match
        the current request, so a thread never leaks another workspace's or
        another user's turns even if a caller supplies someone else's thread_id.
        The store query applies the SAME guard (surface+thread+workspace+actor).
        """
        registry_runs = [
            other
            for other in self._runs.values()
            if other.id != run.id
            and other.thread_id == run.thread_id
            and other.workspace_id == run.workspace_id
            and other.actor_user_id == run.actor_user_id
        ]
        if self._run_store is None:
            return registry_runs
        seen = {other.id for other in registry_runs}
        seen.add(run.id)  # never let the current run re-enter via the store
        merged = list(registry_runs)
        for payload in self._run_store.list_thread_runs(
            _CHAT_SURFACE, run.thread_id, run.workspace_id, run.actor_user_id
        ):
            if payload.get("id") in seen:
                continue
            seen.add(payload.get("id"))
            run = _rehydrate_run(payload)
            if run is not None:
                merged.append(run)  # skip a corrupt row, keep the rest
        merged.sort(key=_run_creation_order_key)
        return merged

    def _thread_history_messages(self, run: ChatRun) -> list[dict[str, Any]]:
        """Assemble prior-turn user/assistant messages for this thread (L1).

        Successful prior turns only: a run with no ``assistant_message`` (a failed
        or still-generating turn) is not a conversational turn and never enters
        history — failed turns must not poison the thread. Keeps the most recent
        ``THREAD_HISTORY_TURNS`` such turns (oldest-first) as alternating
        ``user`` (``run.message``) / ``assistant`` (``run.assistant_message``)
        pairs. The capability drops these BEFORE the current user message, so the
        model sees the conversation in order; overflow is handled by the existing
        cheap compaction at the model chokepoint (no new compaction here — L4).
        """
        prior_turns = [
            other
            for other in self._thread_prior_runs(run)
            if (other.assistant_message or "").strip()
        ]
        messages: list[dict[str, Any]] = []
        for turn in prior_turns[-THREAD_HISTORY_TURNS:]:
            messages.append({"role": "user", "content": turn.message})
            messages.append({"role": "assistant", "content": turn.assistant_message})
        return messages

    def _resolve_outcome(self, run: ChatRun, outcome: LoopOutcome) -> ChatRun:
        """Map the engine's terminal ``LoopOutcome`` onto the chat run."""
        if outcome.status == "completed":
            # on_assistant_final already set run.status (ready + response
            # generated, or failed + chat_response_empty). L2 write-through: this
            # is the terminal for BOTH — the handler set status directly (not via
            # _fail_run), so persist it here. Return as-is.
            self._persist_run(run)
            return run
        if outcome.status == "exhausted_suspended":
            # L4a 续办:顶到 max_turns 但任务未完 —— 存快照、转 awaiting_continue、
            # 审计 run.suspended,等 POST .../continue 续跑(非失败、可续办)。
            run.status = "awaiting_continue"
            run.suspended_messages = outcome.messages
            self.audit.append(
                run.audit_events,
                "run.suspended",
                run.id,
                {"reason": outcome.message or "max_turns", "turns_used": outcome.turns},
            )
            self._persist_run(run)
            return run
        if outcome.status == "exhausted":
            return self._fail_run(
                run,
                "tool_loop_exhausted",
                "chat model tool loop exceeded the maximum number of rounds",
            )
        if outcome.status == "suspended":
            # Chat handlers never suspend (ChatCapabilityHandler raises no
            # CapabilitySuspend); falling through would mislabel a healthy
            # paused run as failed and drop the suspend reason. Fail loudly.
            raise RuntimeError(
                "chat outcome mapping does not support 'suspended'"
                " — add explicit handling before introducing CapabilitySuspend"
                " to a chat handler"
            )
        return self._fail_run(
            run,
            outcome.error_code or "model_call_failed",
            outcome.message or "",
        )

    # --- J2 判断力轮 Evaluator ---------------------------------------------

    def _get_judge(self) -> Judge | None:
        """The wired judge, or ``None`` (→ judgment layer inert, fail-open).

        No lazy build of a real judge: an unwired orchestrator MUST NOT make a
        network call (that would break hermetic tests and existing surfaces).
        Production wires ``evaluator.build_judge(settings)`` explicitly.
        """
        return self._evaluator_judge

    def _segment_had_tools(self, run: ChatRun) -> bool:
        """Did the run dispatch ANY tool so far (from the audit trail)?

        The claim-with-no-tools rule half: a completion claim is only suspicious
        when the segment ran zero tools. Derived from ``model.call.completed``
        governance evidence — the agent cannot understate it.
        """
        return total_tool_calls(run) > 0

    async def _evaluate_and_continue(
        self,
        run: ChatRun,
        watermark: AuditFrameWatermark,
        completed_messages: list[dict] | None,
    ) -> AsyncIterator[dict[str, Any]]:
        """The judgment layer: verify the claim,补办 once at most, flag honestly.

        Runs AFTER a chat run first completes to ``ready``. Yields the audit-event
        frames it appends (started / verdict / flagged / skipped) plus any
        continuation segment's live frames — all on THIS generator, so the frame
        ``seq`` stays contiguous. ALWAYS fail-open: any error, judge outage, or
        malformed verdict leaves the run ``ready`` (the work is delivered) and
        emits ``run.evaluation.skipped``. The run is NEVER failed or blocked here.

        Two phases: the judge rounds, then — only if a round actually opened, i.e.
        only if there WAS a window in which the user could interject — one
        steering-delivery segment for anything they said during it
        (``_deliver_pending_interjections``).
        """
        judge = self._get_judge()
        if not self.settings.evaluation_enabled or judge is None:
            return  # judgment layer inert — zero evaluation events, byte-identical
        carry = _EvaluationCarry(last_messages=completed_messages)
        async for frame in self._evaluation_rounds(run, watermark, judge, carry):
            yield frame
        if carry.rounds_started:
            async for frame in self._deliver_pending_interjections(run, watermark, carry):
                yield frame

    async def _evaluation_rounds(
        self,
        run: ChatRun,
        watermark: AuditFrameWatermark,
        judge: Judge,
        carry: _EvaluationCarry,
    ) -> AsyncIterator[dict[str, Any]]:
        """The judge rounds themselves: judge →(补办 → re-judge)* → honest terminal.

        Split out of ``_evaluate_and_continue`` so the steering tail can run after
        EVERY terminal here (each one ``return``s) without repeating itself at
        seven call sites. Behavior is unchanged from the single-method version
        apart from the two fixes it carries: the delivered answer is restored if
        a补办 segment fails it, and the补办 delta is stitched onto the answer it
        continues rather than replacing it.
        """
        first = True
        try:
            while True:
                # The cheap rule prefilter gates ONLY the first evaluation; after a
                # continuation the re-judgment is unconditional (we continued
                # BECAUSE a gap was found — we must check it closed).
                if first:
                    trigger = should_evaluate(
                        run, segment_had_tool_done=self._segment_had_tools(run)
                    )
                    if trigger is None:
                        return  # clean path — zero cost, zero noise, status untouched
                else:
                    trigger = "post_continuation"
                # From here a judge round is OPEN: the run flips to "generating"
                # below, which is exactly when ``interject`` starts accepting.
                carry.rounds_started = True
                # This round WILL judge: flip ready→generating so a user stop can
                # INTERRUPT the run (else stop sees the transient "ready" and treats
                # it as terminal — a no-op). The run is restored to ready at every
                # evaluation terminal via ``_finish_evaluation_ready`` (which no-ops
                # if a stop already finalized it — stop wins).
                run.status = "generating"
                self.audit.append(
                    run.audit_events, "run.evaluation.started", run.id, {"trigger": trigger}
                )
                for frame in watermark.new_frames():
                    yield frame

                verdict = await self._judge_run(run, judge)
                if run.status != "generating":
                    # A user stop finalized the run while we judged — stop wins; do
                    # not record a verdict and do not spawn a continuation.
                    return
                if verdict is None:
                    # Code gate rejected / judge outage → fail-open skip.
                    self._finish_evaluation_ready(run)
                    self.audit.append(
                        run.audit_events,
                        "run.evaluation.skipped",
                        run.id,
                        {"reason": "judge_unavailable_or_malformed"},
                    )
                    for frame in watermark.new_frames():
                        yield frame
                    return

                index = run.evaluation_continuations
                if verdict.category == "achieved":
                    self._finish_evaluation_ready(run)
                    self._append_verdict(run, verdict, index)
                    for frame in watermark.new_frames():
                        yield frame
                    return
                if verdict.category == "needs_user":
                    self._finish_evaluation_ready(run)
                    self._append_flagged(run, verdict)
                    for frame in watermark.new_frames():
                        yield frame
                    return

                # false_completion | partial.
                act = verdict.confidence >= CONFIDENCE_ACT_THRESHOLD
                can_continue = (
                    run.evaluation_continuations < self.settings.evaluation_max_continuations
                )
                if act and can_continue:
                    # Record the continuation-triggering verdict, then补办.
                    self._append_verdict(run, verdict, index)
                    for frame in watermark.new_frames():
                        yield frame
                    if run.status != "generating":
                        # Race: a user stop finalized the run — stop wins, no补办.
                        return
                    run.evaluation_continuations += 1
                    resume_messages = [
                        *(carry.last_messages or []),
                        {"role": "user", "content": evaluator_nudge_text(verdict.gaps)},
                    ]
                    # Freeze the DELIVERED terminal before the补办 can overwrite it.
                    snapshot = self._terminal_snapshot(run)
                    cont_outcome = Outcome()
                    async for frame in self._drive_continuation(
                        run, resume_messages, watermark, cont_outcome
                    ):
                        yield frame
                    restored = self._restore_failed_continuation(run, snapshot)
                    # Only re-evaluate a CLEAN completion (the continuation's
                    # on_assistant_final set ready); anything else falls open.
                    if (
                        not restored
                        and cont_outcome.value is not None
                        and cont_outcome.value.status == "completed"
                        and run.status == "ready"
                    ):
                        self._stitch_answer(run, snapshot["assistant_message"])
                        carry.last_messages = (
                            cont_outcome.value.messages or carry.last_messages
                        )
                        first = False
                        continue
                    self._finish_evaluation_ready(run)
                    self.audit.append(
                        run.audit_events,
                        "run.evaluation.skipped",
                        run.id,
                        {"reason": self._continuation_skip_reason(cont_outcome)},
                    )
                    for frame in watermark.new_frames():
                        yield frame
                    return
                if act:
                    # High-confidence gap but the continuation budget is spent →
                    # honest flag (still ready; the flag is metadata, not failure).
                    self._finish_evaluation_ready(run)
                    self._append_flagged(run, verdict)
                    for frame in watermark.new_frames():
                        yield frame
                    return
                # Below the act threshold → record the verdict, don't act.
                self._finish_evaluation_ready(run)
                self._append_verdict(run, verdict, index)
                for frame in watermark.new_frames():
                    yield frame
                return
        except Exception:  # noqa: BLE001 — evaluation must NEVER fail a live run
            logger.warning("chat run %s evaluation error", run.id, exc_info=True)
            self._finish_evaluation_ready(run)
            self.audit.append(
                run.audit_events,
                "run.evaluation.skipped",
                run.id,
                {"reason": "evaluator_error"},
            )
            for frame in watermark.new_frames():
                yield frame

    async def _deliver_pending_interjections(
        self,
        run: ChatRun,
        watermark: AuditFrameWatermark,
        carry: _EvaluationCarry,
    ) -> AsyncIterator[dict[str, Any]]:
        """J3 × J2:判断层窗口期收到的插话必须兑现,不能默默丢掉。

        评估期间 run 骑在 ``generating`` 上 —— 那正是 ``interject`` **接受并审计**
        它的状态。可除「续办」外的每条判决路径(achieved / needs_user / 低于阈值 /
        预算用尽后的 flagged / skipped)都不会再跑任何一轮引擎,队列在终态清理时被
        丢弃:用户看到「已收到补充指示」,那句话从没到过模型。

        所以判断层收尾前(且**确实起过判断轮**时 —— 没起过就没有窗口,零成本路径
        字节等价)再排一次队:还有待办插话 → 用既有续办机器跑**一段投递段**。队首那
        句作为该段开场的 user 消息,其余由段内轮首 ``drain`` 各自独立注入 —— 逐条
        独立,与轮首注入同形。

        **边界(写死在此)**:投递段跑完**直接收尾 ready,不再复判**。插话是用户新说
        的话,不是判断层的补办诉求;再判一次就开出「判断→续办→插话→判断」的套娃,
        而这一轮的全部纪律就是有界。因此每次终态判定最多一段投递。

        Stop 恒胜:run 已不是 ready(被停/被判失败)就什么都不做;投递段本身走
        ``_drive_continuation``(期间骑 ``generating``,可被 stop 打断),并过与续办
        同一条 failed 还原守卫。恒 fail-open —— 投递出任何问题都绝不推翻已交付答案。
        """
        if run.status != "ready":
            return  # a stop (or any other terminal) already won — never resurrect
        first_text = pop_interjection(run.id)
        if first_text is None:
            return  # nobody steered — zero cost, zero events
        try:
            snapshot = self._terminal_snapshot(run)
            resume_messages = [
                *(carry.last_messages or []),
                {"role": "user", "content": first_text},
            ]
            outcome = Outcome()
            async for frame in self._drive_continuation(
                run, resume_messages, watermark, outcome
            ):
                yield frame
            restored = self._restore_failed_continuation(run, snapshot)
            delivered = (
                not restored
                and outcome.value is not None
                and outcome.value.status == "completed"
                and run.status == "ready"
            )
            if delivered:
                self._stitch_answer(run, snapshot["assistant_message"])
            else:
                self.audit.append(
                    run.audit_events,
                    "run.evaluation.skipped",
                    run.id,
                    {"reason": self._continuation_skip_reason(outcome)},
                )
            self._finish_evaluation_ready(run)
            for frame in watermark.new_frames():
                yield frame
        except Exception:  # noqa: BLE001 — delivering a steer must NEVER fail a run
            logger.warning(
                "chat run %s interjection delivery failed", run.id, exc_info=True
            )
            self._finish_evaluation_ready(run)
            self.audit.append(
                run.audit_events,
                "run.evaluation.skipped",
                run.id,
                {"reason": "evaluator_error"},
            )
            for frame in watermark.new_frames():
                yield frame

    def _terminal_snapshot(self, run: ChatRun) -> dict[str, Any]:
        """Freeze the run's DELIVERED terminal before an internal segment runs."""
        return {
            "status": run.status,
            "error_code": run.error_code,
            "error_message": run.error_message,
            "assistant_message": run.assistant_message,
        }

    def _restore_failed_continuation(
        self, run: ChatRun, snapshot: dict[str, Any]
    ) -> bool:
        """Undo an internal segment that FAILED an already-delivered run.

        Fail-open is the judgment layer's binding contract, and that must hold
        against the layer ITSELF. The first answer is already on the wire, so a
        segment the layer spawned must never convert it into a terminal ``error``
        frame that HIDES it. The sharpest case: the model returns empty text, the
        segment's ``on_assistant_final`` fails the run ``chat_response_empty``,
        and ``_finish_evaluation_ready`` only heals ``generating`` — so the
        invented failure rode all the way out to the client.

        One failure still wins: ``stopped_by_user``. A stop is the user's own
        decision and outranks everything here, including this restore.
        """
        if run.status != "failed" or run.error_code == "stopped_by_user":
            return False
        run.status = snapshot["status"]
        run.error_code = snapshot["error_code"]
        run.error_message = snapshot["error_message"]
        run.assistant_message = snapshot["assistant_message"]
        return True

    def _stitch_answer(self, run: ChatRun, first_answer: str | None) -> None:
        """Join an internal segment's delta onto the answer it continues.

        Both nudges ask for a DELTA (``已完成部分不要重做``), but the segment's
        ``on_assistant_final`` OVERWRITES ``run.assistant_message``. Unstitched,
        the answer area, the thread history AND the next judge read would all see
        the delta alone — the delivered work looks lost, and the re-judge scores a
        fragment nobody asked it to score. Skips when there is nothing to join
        (no first answer, empty delta, or a delta identical to it).
        """
        head = (first_answer or "").strip()
        delta = (run.assistant_message or "").strip()
        if not head or not delta or delta == head:
            return
        stitched = f"{head}\n\n{delta}"
        run.assistant_message = stitched
        if run.template_id == "associate_goal":
            # Mirrors on_assistant_final — the two are the same text by contract.
            run.associate_goal_text = stitched

    def _continuation_skip_reason(self, outcome: Outcome) -> str:
        """Why an internal segment produced no re-judgeable completion.

        ``continuation_exhausted`` when it spent its own turn budget (the补办 ran
        out of rounds); ``continuation_incomplete`` for everything else (engine
        error, empty answer, a prep problem that yielded no segment at all).
        Semantics are unchanged either way — fail-open, the first answer stands,
        no suspend and no ``run.suspended`` for an INTERNAL segment — but the
        trail now names the cause instead of one silent catch-all.
        """
        value = outcome.value
        if value is not None and value.status in ("exhausted", "exhausted_suspended"):
            return "continuation_exhausted"
        return "continuation_incomplete"

    async def _judge_run(self, run: ChatRun, judge: Judge) -> Any:
        """Run the LLM judge OFF the event loop, then the code gate. ``None`` on
        any failure (fail-open). The verdict is DATA through ``parse_verdict``,
        never an instruction (ADR-002)."""
        user_content = build_judge_user_content(
            run, continuation_index=run.evaluation_continuations
        )
        try:
            raw = await asyncio.to_thread(judge, EVALUATOR_SYSTEM_PROMPT, user_content)
        except Exception:  # noqa: BLE001 — a judge outage is never fatal
            logger.warning("chat run %s judge call failed", run.id, exc_info=True)
            return None
        return parse_verdict(raw)

    async def _drive_continuation(
        self,
        run: ChatRun,
        resume_messages: list[dict[str, Any]],
        watermark: AuditFrameWatermark,
        outcome: Outcome,
    ) -> AsyncIterator[dict[str, Any]]:
        """Drive ONE internal evaluator continuation segment (reuses L4a machinery).

        No HTTP round trip — the补办 segment runs on THIS generator so its frames
        share the run's journal/seq space. ``_prepare_evaluator_resume`` set
        ``resume_messages`` → J1 PlanGate is dormant here BY DESIGN. Fail-open: a
        prep problem yields nothing and leaves the run untouched. Deliberately does
        NOT call ``_resolve_outcome`` (which would FAIL the run on an engine error
        and clobber the already-delivered answer); the caller inspects ``outcome``
        + ``run.status`` to decide re-evaluation vs. fall-open.
        """
        prepared = self._prepare_evaluator_resume(run, resume_messages)
        if prepared is None:
            return
        handler, config, engine = prepared
        run.status = "generating"  # transient: honest while the补办 round runs
        async for event in engine.run(config, handler, run.id, run.audit_events, outcome):
            for frame in watermark.new_frames():
                yield frame
            if event.get("type") in SWALLOWED_ENGINE_TERMINALS:
                continue
            yield event
        for frame in watermark.new_frames():
            yield frame

    def _append_verdict(self, run: ChatRun, verdict: Any, continuation_index: int) -> None:
        self.audit.append(
            run.audit_events,
            "run.evaluation.verdict",
            run.id,
            {
                "category": verdict.category,
                "confidence": verdict.confidence,
                "continuation_index": continuation_index,
            },
        )

    def _append_flagged(self, run: ChatRun, verdict: Any) -> None:
        # gaps were code-clamped by parse_verdict (≤5 items, each ≤120 chars).
        self.audit.append(
            run.audit_events,
            "run.evaluation.flagged",
            run.id,
            {"gaps": list(verdict.gaps)},
        )

    def _finish_evaluation_ready(self, run: ChatRun) -> None:
        """Restore the run to ready at an evaluation terminal — UNLESS a user stop
        finalized it mid-evaluation (a stopped run stays stopped; stop wins).

        During evaluation the run rides ``generating`` (so a stop can interrupt).
        Every evaluation terminal is ``ready`` (the work is delivered — the judge
        never fails a run), so this flips generating→ready and clears any stale
        error. If a stop already set the run failed, the guard leaves it failed.
        """
        if run.status == "generating":
            run.status = "ready"
            run.error_code = None
            run.error_message = None

    def _template(self, template_id: str | None) -> ChatPromptTemplate | None:
        if template_id is None:
            return None
        for template in CHAT_PROMPT_TEMPLATES:
            if template.id == template_id:
                return template
        return None
