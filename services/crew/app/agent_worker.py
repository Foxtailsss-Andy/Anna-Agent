from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from typing import Literal

from services.crew.app import lifecycle
from services.crew.app.schemas import CrewProject, CrewTask
from services.crew.app.store import SQLiteCrewStore
from services.memory.app.schemas import BusinessMemoryItem
from services.memory.app.store import BusinessMemoryStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.agent_loop import Outcome
from services.runtime.app.engine.capability import (
    CapabilityError,
    CapabilitySuspend,
    SUSPEND_REASON_AWAITING_INPUT,
    default_humanize_step,
)
from services.runtime.app.engine.delegate import (
    HandlerFactory,
    SubagentResult,
    run_subagent,
)
from services.runtime.app.engine.query_config import QueryConfig
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_deps import production_deps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.execution.models import (
    ExecutionSnapshot,
    LoopResult,
    PendingSignal,
)
from services.runtime.app.model_provider import ModelRequest, ModelToolCall

# The Worker Profile loop's ReAct budget for a Crew deliverable (matches the shared engine
# default). A worker that keeps calling tools without producing a deliverable
# exhausts and BLOCKS the task rather than spinning forever.
_SUBAGENT_MAX_TURNS = 8

# Grounding (R-B #3): how much of each upstream artifact to fold into the prompt.
# A Worker Profile summary is itself <=2000 chars (B2), so this bounds the injected
# context without clipping real deliverables; a longer body is clipped with a
# marker so the model knows it was truncated.
_UPSTREAM_ARTIFACT_CHARS = 4000
_ASK_HUMAN_TOOL_NAME = "crew.ask_human"
_CHECKPOINT_KIND_CREW_WORKER_AWAITING_INPUT = "crew.worker.awaiting_input.v1"

_ASK_HUMAN_TOOL = {
    "name": _ASK_HUMAN_TOOL_NAME,
    "description": (
        "Ask the responsible human for missing task information. "
        "Use only when the deliverable cannot be produced safely from the project context."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "The concise question the human must answer.",
            },
            "target": {
                "type": "string",
                "description": "The intended human recipient or actor, if known.",
            },
        },
        "required": ["question"],
        "additionalProperties": False,
    },
}


def _now() -> str:
    """ISO-8601 UTC instant. Matches the crew convention (lifecycle/service each
    keep their own ``_now``) so C1's ``run_started_at`` stamps read like every
    other crew timestamp (e.g. an ``ArtifactVersion.submitted_at``)."""
    return datetime.now(timezone.utc).isoformat()


class CrewRunSkipped(Exception):
    """A dispatched run found its task already past a runnable state (C2 良性竞态).

    Under auto-pilot a task can advance (another path submitted it, a sibling
    run produced it) between DISPATCH and this worker thread actually starting.
    When the task is now at a benign advanced state (submitted / in_review /
    done), the run is a QUIET no-op — no「执行受阻」channel event, no blocked
    notification, no state change — distinct from a true execution failure
    (``CrewAgentError``) which keeps the full alarm path. Carries the observed
    ``task_status`` so the durable execution trace can show a calm terminal."""

    def __init__(self, message: str, *, task_status: str) -> None:
        super().__init__(message)
        self.task_status = task_status


class CrewAgentError(Exception):
    """Raised when the agent worker cannot proceed with a task.

    Carries the Worker Profile's captured process frames (``frames``) so a background
    driver can journal the failed run's trace before recording the terminal
    error — a blocked run is still inspectable. ``memory_hits`` (B1b) records
    which 项目共识 items were injected into the failed run's prompt, so even a
    blocked run's audit stays traceable.
    """

    def __init__(
        self,
        message: str,
        *,
        error_code: str | None = None,
        retryable: bool = False,
        frames: list[dict] | None = None,
        memory_hits: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.retryable = retryable
        self.frames = frames or []
        self.memory_hits = memory_hits or []


@dataclass(frozen=True)
class WorkerRunResult:
    """The executor's terminal result: the Worker Profile outcome + crew provenance.

    Mirrors ``SubagentResult``'s read surface (status / summary / turns_used /
    audit_events / error_code) so every existing consumer keeps working, and
    adds ``memory_hits`` — the 项目共识 item ids injected into this run's
    prompt (B1b 命中审计; empty when the project has no consensus entries).
    """

    status: Literal["completed", "failed", "exhausted"]
    summary: str
    turns_used: int
    audit_events: list[dict] = field(default_factory=list)
    error_code: str | None = None
    memory_hits: list[str] = field(default_factory=list)

    @classmethod
    def from_subagent(
        cls, result: SubagentResult, memory_hits: list[str]
    ) -> "WorkerRunResult":
        return cls(
            status=result.status,
            summary=result.summary,
            turns_used=result.turns_used,
            audit_events=result.audit_events,
            error_code=result.error_code,
            memory_hits=list(memory_hits),
        )


@dataclass(frozen=True)
class CrewWorkerContext:
    prompt: str
    memory_hits: list[str] = field(default_factory=list)


class CrewWorkerContextAssembler:
    """Build the complete Worker Profile prompt and memory hit audit.

    This is the shared Crew worker context module. Both the legacy synchronous
    ``AgentWorkerExecutor`` and the durable ``QueryEngineLoopAdapter`` cross the
    same small interface, so project grounding and memory-hit accounting stay in
    one implementation.
    """

    def __init__(self, memory_store: BusinessMemoryStore | None = None) -> None:
        self._memory = memory_store

    def assemble(
        self,
        project: CrewProject,
        task: CrewTask,
        *,
        source_instruction: str | None = None,
        steer_instructions: list[str] | None = None,
    ) -> CrewWorkerContext:
        consensus = self._project_consensus(project)
        return CrewWorkerContext(
            prompt=self._build_prompt(
                project,
                task,
                consensus,
                source_instruction=source_instruction,
                steer_instructions=steer_instructions or [],
            ),
            memory_hits=[item.id for item in consensus],
        )

    def _project_consensus(self, project: CrewProject) -> list[BusinessMemoryItem]:
        """The project's 共识 entries, oldest first (stable 1..N numbering).

        The store lists newest-first with a deterministic insertion-order
        tiebreak, so reversing yields true insertion order — timestamps alone
        can collide within the clock's resolution.
        """
        if self._memory is None:
            return []
        items = self._memory.list_items(
            project.workspace_id, scope="project", project_id=project.id, limit=100
        )
        return list(reversed(items))

    @staticmethod
    def _build_prompt(
        project: CrewProject,
        task: CrewTask,
        consensus: list[BusinessMemoryItem],
        *,
        source_instruction: str | None = None,
        steer_instructions: list[str] | None = None,
    ) -> str:
        # ① 项目目标 pinned at the very top — the anti-「跑题」anchor (R-B #3).
        parts = [f"项目目标：{project.goal_text}", f"任务：{task.title}"]
        if task.description:
            parts.append(f"说明：{task.description}")
        if task.acceptance_criteria:
            parts.append(f"验收标准：{task.acceptance_criteria}")
        if source_instruction:
            parts.append(f"触发频道指令：\n{source_instruction}")
        # A rework re-run (「@Agent 再改改」/ 驳回重跑) carries the reviewer's note
        # (lifecycle stores it on ``blocker``) so the agent fixes the actual defect
        # instead of re-emitting the rejected version. A never-rejected task has no
        # blocker → no such line. (A run only reaches here from a runnable state, so
        # ``blocker`` here is a rejection note, never a stale failure reason.)
        if task.blocker:
            parts.append(f"返工要求（上一版被驳回，请针对性修正）：{task.blocker}")
        # ② the real artifact body of each upstream dependency, so the model
        # produces FOR this project's chain rather than inventing a generic one.
        for title, content in CrewWorkerContextAssembler._upstream_artifacts(project, task):
            parts.append(f"上游产物·{title}：\n{content}")
        if consensus:
            # ③ B1b: numbered 共识 block — [kind] text per line; the kind IS the
            # item's memory_type (约束/口径/决策). Absent entirely when empty.
            lines = "\n".join(
                f"{index}. [{item.memory_type}] {item.content}"
                for index, item in enumerate(consensus, start=1)
            )
            parts.append(f"项目共识：\n{lines}")
        if steer_instructions:
            lines = "\n\n".join(
                f"{index}. {text}" for index, text in enumerate(steer_instructions, start=1)
            )
            parts.append(f"运行中补充指令（按时间顺序）：\n{lines}")
        parts.append("请直接产出该任务的交付物（markdown 可用），不要前言。")
        return "\n\n".join(parts)

    @staticmethod
    def _upstream_artifacts(
        project: CrewProject, task: CrewTask
    ) -> list[tuple[str, str]]:
        """(title, clipped body) of each ``depends_on`` upstream that has produced.

        A REVIEW-GATE dependency (设计稿 depends on the PRD 评审 gate) carries no
        artifact of its own — it resolves to the task it reviewed
        (``reviews_task_id``), so the downstream producer is fed the approved
        upstream deliverable, not an empty gate. Each body is clipped to
        ``_UPSTREAM_ARTIFACT_CHARS`` with a marker; a dep with no artifact yet is
        skipped (零捏造 — no placeholder). De-duplicated by source task id.
        """
        by_id = {t.id: t for t in project.tasks}
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for dep_id in task.depends_on:
            dep = by_id.get(dep_id)
            if dep is None:
                continue
            source = dep
            if dep.is_gate and dep.reviews_task_id:
                reviewed = by_id.get(dep.reviews_task_id)
                if reviewed is not None:
                    source = reviewed
            if source.id in seen:
                continue
            content = source.artifact
            if not content and source.artifact_versions:
                content = source.artifact_versions[-1].content
            if not content:
                continue
            seen.add(source.id)
            if len(content) > _UPSTREAM_ARTIFACT_CHARS:
                content = content[:_UPSTREAM_ARTIFACT_CHARS] + "……（已截断）"
            out.append((source.title, content))
        return out


def _find_task(project: CrewProject, task_id: str) -> CrewTask:
    for t in project.tasks:
        if t.id == task_id:
            return t
    raise CrewAgentError(f"Task {task_id!r} not found in project {project.id!r}")


# ---------------------------------------------------------------------------
# Read-only Worker Profile handler (the "chat 家族" 只读构造)
# ---------------------------------------------------------------------------
#
# NOTE (B2 deviation, see 偏差登记): the plan named "chat capability 只读构造".
# The real ``ChatCapabilityHandler`` is NOT a clean read-only construct — its
# registry ALWAYS exposes write tools (chat.emit_page / chat.emit_document /
# plan.update) and it is bound to a mutable ``ChatRun`` + ``McpToolDispatcher`` +
# ``SkillLoader`` tree. Threading all of that into the Crew worker AND carrying
# write tools would contradict the readonly mandate (防审批嵌套). So the v1
# factory builds THIS minimal, self-contained read-only general-assistant handler
# instead: a system line + the prompt as the sole user turn, an EMPTY toolset
# (read-only by construction — no tool can write), and ``on_assistant_final``
# returning None (the engine's final text IS the deliverable). It is "chat-family"
# in spirit and trivially extensible — a later slice maps a role to a domain
# read-only handler in ``ROLE_HANDLER_BUILDERS`` below.


class _ReadonlyAssistantHandler:
    """A minimal, isolated, read-only general-assistant ``CapabilityHandler``."""

    def __init__(
        self,
        prompt: str,
        *,
        system: str,
        tools: list[dict] | None = None,
        resume_messages: list[dict[str, Any]] | None = None,
    ) -> None:
        self._prompt = prompt
        self._system = system
        self._tools = list(tools or [])
        self._resume_messages = (
            [dict(message) for message in resume_messages]
            if resume_messages is not None
            else None
        )

    def build_initial_request(self) -> ModelRequest:
        if self._resume_messages is not None:
            return ModelRequest(messages=list(self._resume_messages), tools=self._tools)
        return ModelRequest(
            messages=[
                {"role": "system", "content": self._system},
                {"role": "user", "content": self._prompt},
            ],
            tools=self._tools,
        )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        if tool_call.name == _ASK_HUMAN_TOOL_NAME:
            question = tool_call.arguments.get("question")
            if not isinstance(question, str) or not question.strip():
                raise CapabilityError(
                    "invalid_human_question",
                    "crew.ask_human requires a non-empty question",
                )
            target = tool_call.arguments.get("target")
            detail = {
                "tool": _ASK_HUMAN_TOOL_NAME,
                "tool_call_id": tool_call.id,
                "question": question.strip(),
            }
            if isinstance(target, str) and target.strip():
                detail["target"] = target.strip()
            raise CapabilitySuspend(SUSPEND_REASON_AWAITING_INPUT, detail=detail)
        # The controlled local ask-human tool is the only Worker Profile tool in
        # this handler; any other tool call is out of contract and blocks.
        raise CapabilityError(
            "tool_not_allowed",
            f"read-only Worker Profile has no tool {tool_call.name!r}",
        )

    def on_tool_batch(self, tool_calls: list[ModelToolCall]) -> None:
        ask_calls = [call for call in tool_calls if call.name == _ASK_HUMAN_TOOL_NAME]
        if ask_calls and len(tool_calls) != 1:
            raise CapabilityError(
                "ask_human_must_be_single",
                "crew.ask_human must be the only tool call in its model turn",
            )

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        return None

    def humanize_step(self, phase: str, tool_call: ModelToolCall | None = None) -> str:
        # Opt in to authoritative step frames so the Worker Profile trace reads like
        # any other Anna run in the LoopCard (F4). Always code-generated (ADR-002).
        return default_humanize_step(phase, tool_call)


def _readonly_assistant_builder(role: str) -> HandlerFactory:
    """Return a ``prompt -> handler`` factory for a role's read-only worker."""
    system = (
        f"You are an Anna Crew Worker Profile acting as the project's {role}. "
        "Produce the concrete deliverable for the task. "
        "Output only the deliverable content (markdown ok), no preamble."
    )

    def factory(
        prompt: str,
        resume_messages: list[dict[str, Any]] | None = None,
    ) -> _ReadonlyAssistantHandler:
        return _ReadonlyAssistantHandler(
            prompt,
            system=system,
            tools=[_ASK_HUMAN_TOOL],
            resume_messages=resume_messages,
        )

    return factory


# role_required -> (role) -> HandlerFactory. v1: every职能 uses the read-only
# general-assistant. Register a role here to route it to a专职 read-only domain
# handler later (e.g. "财务" -> a finance read-only builder) — this dict is the
# single extension point, no other code changes.
ROLE_HANDLER_BUILDERS: dict[str, Callable[[str], HandlerFactory]] = {}
_DEFAULT_HANDLER_BUILDER = _readonly_assistant_builder


def _handler_factory_for_role(role: str) -> HandlerFactory:
    builder = ROLE_HANDLER_BUILDERS.get(role, _DEFAULT_HANDLER_BUILDER)
    return builder(role)


class WorkerHandlerResolver:
    """Controlled Worker Profile seam: task role -> read-only handler factory."""

    def __init__(
        self,
        builders: dict[str, Callable[[str], HandlerFactory]] | None = None,
        default_builder: Callable[[str], HandlerFactory] = _DEFAULT_HANDLER_BUILDER,
    ) -> None:
        self._builders = dict(builders or ROLE_HANDLER_BUILDERS)
        self._default_builder = default_builder

    def resolve(self, role_required: str) -> HandlerFactory:
        builder = self._builders.get(role_required, self._default_builder)
        return builder(role_required)


_DEFAULT_HANDLER_RESOLVER = WorkerHandlerResolver()


class AgentWorkerExecutor:
    """Runs a Crew task's deliverable through the real ReAct engine (B2).

    The格子里 agent no longer does a single throwaway ``call_model``: it drives an
    isolated, read-only Worker Profile loop (``run_subagent``) whose final answer is the
    deliverable, submitted through the SAME lifecycle/gate as a human's output. A
    model failure / exhaustion BLOCKS the task (with a blocker reason) — never a
    fabricated completion.
    """

    def __init__(
        self,
        *,
        settings: RuntimeSettings | None = None,
        deps: QueryDeps | None = None,
        memory_store: BusinessMemoryStore | None = None,
        context_assembler: CrewWorkerContextAssembler | None = None,
        handler_resolver: WorkerHandlerResolver | None = None,
    ) -> None:
        self._settings = settings or RuntimeSettings.from_env()
        # None -> run_subagent wires the real governed streaming model; tests
        # inject a QueryDeps with a fake stream_model.
        self._deps = deps
        self._context_assembler = (
            context_assembler or CrewWorkerContextAssembler(memory_store)
        )
        self._handler_resolver = handler_resolver or _DEFAULT_HANDLER_RESOLVER

    def run_task(
        self,
        project: CrewProject,
        task_id: str,
        *,
        run_ref: str | None = None,
    ) -> tuple[CrewProject, WorkerRunResult]:
        """Execute a task on behalf of a Crew Worker Profile.

        1. Find the task; reject gate tasks (reviewed, not executed).
        2. Transition to running (assigned/rework -> running).
        3. Link the run (``run_ref``) so its trace is discoverable.
        4. Produce the deliverable via an isolated read-only Worker Profile loop, with the
           project's 共识 entries folded into the prompt (B1b).
        5. On success submit through the lifecycle; on failure BLOCK the task
           with a blocker reason and raise ``CrewAgentError`` (never fake-complete).
        """
        task = _find_task(project, task_id)

        if task.is_gate:
            raise CrewAgentError("gate tasks are reviewed, not executed")

        if task.status in ("assigned", "rework"):
            lifecycle.start_task(project, task_id)
            # C1: stamp the in-flight instant right after the start transition
            # succeeds — the FE推进 elapsed from here.
            task.run_started_at = _now()
        elif task.status == "running":
            # Already running (e.g. a manual /start then run-agent): stamp only if
            # a prior worker did not already, so elapsed still has an anchor.
            if task.run_started_at is None:
                task.run_started_at = _now()
        elif task.status in ("submitted", "in_review", "done"):
            # C2 良性竞态:the task advanced past execution between dispatch and this
            # thread's start — skip QUIETLY (no alarm), never a fabricated failure.
            raise CrewRunSkipped(
                f"Task {task_id!r} already advanced to {task.status!r}; nothing to run",
                task_status=task.status,
            )
        else:
            raise CrewAgentError(
                f"Task {task_id!r} is not runnable by an agent: status is {task.status!r}"
            )

        if run_ref is not None:
            task.run_ref = run_ref

        context = self._context_assembler.assemble(project, task)
        memory_hits = list(context.memory_hits)
        result = self._produce(project, task, context)

        if result.status != "completed" or not result.summary.strip():
            reason = self._blocker_reason(result)
            task.status = "blocked"
            task.blocker = reason
            # C1: the run reached a terminal (blocked) outcome — clear the signal.
            task.run_started_at = None
            raise CrewAgentError(
                reason,
                error_code=result.error_code,
                retryable=result.status == "exhausted",
                frames=result.audit_events,
                memory_hits=memory_hits,
            )

        lifecycle.submit_task(project, task_id, result.summary)
        # C1: the run reached a terminal (submitted) outcome — clear the signal.
        task.run_started_at = None
        return project, WorkerRunResult.from_subagent(result, memory_hits)

    def _produce(
        self,
        project: CrewProject,
        task: CrewTask,
        context: CrewWorkerContext,
    ) -> SubagentResult:
        """Drive an isolated read-only Worker Profile loop to produce the deliverable."""
        return run_subagent(
            handler_factory=self._handler_resolver.resolve(task.role_required),
            prompt=context.prompt,
            settings=self._settings,
            max_turns=_SUBAGENT_MAX_TURNS,
            permission_mode="readonly",
            deps=self._deps,
            run_id=f"{project.id}:{task.id}",
        )

    def _project_consensus(self, project: CrewProject) -> list[BusinessMemoryItem]:
        return self._context_assembler._project_consensus(project)

    @staticmethod
    def _build_prompt(
        project: CrewProject,
        task: CrewTask,
        consensus: list[BusinessMemoryItem],
    ) -> str:
        return CrewWorkerContextAssembler._build_prompt(project, task, consensus)

    @staticmethod
    def _upstream_artifacts(
        project: CrewProject, task: CrewTask
    ) -> list[tuple[str, str]]:
        """(title, clipped body) of each ``depends_on`` upstream that has produced.

        A REVIEW-GATE dependency (设计稿 depends on the PRD 评审 gate) carries no
        artifact of its own — it resolves to the task it reviewed
        (``reviews_task_id``), so the downstream producer is fed the approved
        upstream deliverable, not an empty gate. Each body is clipped to
        ``_UPSTREAM_ARTIFACT_CHARS`` with a marker; a dep with no artifact yet is
        skipped (零捏造 — no placeholder). De-duplicated by source task id.
        """
        return CrewWorkerContextAssembler._upstream_artifacts(project, task)

    @staticmethod
    def _blocker_reason(result: SubagentResult) -> str:
        if result.status == "exhausted":
            return "Agent 多轮未产出交付物（达到轮次上限），已阻塞待处理。"
        if result.status == "failed":
            return result.summary.strip() or "Agent 执行失败，已阻塞待处理。"
        return "Agent 返回空交付物，已阻塞待处理。"


class QueryEngineLoopAdapter:
    """Durable AgentExecution adapter for Crew Worker Profile runs.

    The adapter is intentionally small at the seam: ``run(snapshot, signals)``.
    Inside it loads Crew state, validates provenance and assignee, assembles the
    shared worker context, then drives ``QueryEngine`` asynchronously. It never
    calls the synchronous ``run_subagent`` bridge and never mutates Crew storage;
    CrewProject JSON is updated later by the execution outbox projector.

    It supports the P3 ask-human loop: ``crew.ask_human`` suspends with a
    durable checkpoint, and a later ``answer`` signal resumes the exact model
    conversation by appending the matching tool observation. ``approval`` remains
    unsupported here and is deliberately left pending for the later approval
    workflow.
    """

    def __init__(
        self,
        *,
        crew_store: SQLiteCrewStore,
        settings: RuntimeSettings | None = None,
        deps: QueryDeps | None = None,
        memory_store: BusinessMemoryStore | None = None,
        context_assembler: CrewWorkerContextAssembler | None = None,
        handler_resolver: WorkerHandlerResolver | None = None,
    ) -> None:
        self._crew_store = crew_store
        self._settings = settings or RuntimeSettings.from_env()
        self._deps = deps
        self._context_assembler = (
            context_assembler or CrewWorkerContextAssembler(memory_store)
        )
        self._handler_resolver = handler_resolver or _DEFAULT_HANDLER_RESOLVER

    async def run(
        self,
        snapshot: ExecutionSnapshot,
        signals: list[PendingSignal],
    ) -> LoopResult:
        resume_messages: list[dict[str, Any]] | None = None
        answer_signal: PendingSignal | None = None
        awaiting_input = _awaiting_input_checkpoint(snapshot.checkpoint)
        supported_signal_kinds = ["steer"]
        if awaiting_input is not None:
            supported_signal_kinds = ["answer", "steer"]
            answer_signals = [signal for signal in signals if signal.kind == "answer"]
            unsupported = [signal for signal in signals if signal.kind == "approval"]
            if unsupported:
                return _awaiting_signal_result(
                    reason="unsupported_signal",
                    unsupported_signal_ids=[signal.signal_id for signal in unsupported],
                    supported_signal_kinds=supported_signal_kinds,
                )
            if not answer_signals:
                return _awaiting_human_answer_result(awaiting_input, signals)
            answer_signal = answer_signals[0]
            answer_text = _signal_text(answer_signal)
            if not answer_text:
                return _awaiting_signal_result(
                    reason="empty_answer_signal",
                    signal_id=answer_signal.signal_id,
                    supported_signal_kinds=supported_signal_kinds,
                )
            for signal in signals:
                if signal.kind == "steer" and not _signal_text(signal):
                    return _awaiting_signal_result(
                        reason="empty_steer_signal",
                        signal_id=signal.signal_id,
                        supported_signal_kinds=supported_signal_kinds,
                    )
            resume_messages = _resume_messages_from_answer(
                awaiting_input,
                answer_signal=answer_signal,
                answer_text=answer_text,
                steer_signals=[signal for signal in signals if signal.kind == "steer"],
            )
        else:
            unsupported = [signal for signal in signals if signal.kind != "steer"]
            if unsupported:
                return _awaiting_signal_result(
                    reason="unsupported_signal",
                    unsupported_signal_ids=[signal.signal_id for signal in unsupported],
                    supported_signal_kinds=supported_signal_kinds,
                )

        steer_instructions: list[str] = []
        for signal in signals:
            if signal.kind != "steer" or resume_messages is not None:
                continue
            text = _signal_text(signal)
            if not text:
                return _awaiting_signal_result(
                    reason="empty_steer_signal",
                    signal_id=signal.signal_id,
                    supported_signal_kinds=supported_signal_kinds,
                )
            steer_instructions.append(text)

        ref = _crew_ref_from_snapshot(snapshot)
        if ref is None:
            return _blocked_loop_result(
                project_id=None,
                task_id=None,
                reason="Crew execution input is missing project_id/task_id provenance.",
                error_code="invalid_provenance",
            )
        project_id, task_id = ref
        project = self._crew_store.get_project(project_id)
        if project is None:
            return _blocked_loop_result(
                project_id=project_id,
                task_id=task_id,
                reason=f"Crew project {project_id!r} not found.",
                error_code="project_not_found",
            )
        task = next((t for t in project.tasks if t.id == task_id), None)
        if task is None:
            return _blocked_loop_result(
                project_id=project_id,
                task_id=task_id,
                reason=f"Crew task {task_id!r} not found in project {project_id!r}.",
                error_code="task_not_found",
            )

        provenance_error = _validate_snapshot_provenance(snapshot, project, task)
        if provenance_error is not None:
            return _blocked_loop_result(
                project_id=project.id,
                task_id=task.id,
                reason=provenance_error,
                error_code="invalid_provenance",
            )
        assignee_error = _validate_worker_assignee(snapshot, task)
        if assignee_error is not None:
            return _blocked_loop_result(
                project_id=project.id,
                task_id=task.id,
                reason=assignee_error,
                error_code="invalid_assignee",
            )
        if task.is_gate:
            return _blocked_loop_result(
                project_id=project.id,
                task_id=task.id,
                reason="Gate tasks are reviewed, not executed.",
                error_code="gate_task_not_executable",
            )
        if task.status in ("submitted", "in_review", "done"):
            if signals:
                return LoopResult(
                    status="awaiting_signal",
                    events=[
                        (
                            "execution.frame",
                            {
                                "type": "awaiting_signal",
                                "reason": "signal_not_applicable",
                                "detail": "task_already_advanced",
                                "project_id": project.id,
                                "task_id": task.id,
                                "task_status": task.status,
                                "signal_ids": [signal.signal_id for signal in signals],
                            },
                        )
                    ],
                )
            return LoopResult(
                status="succeeded",
                state={
                    "crew": {
                        "project_id": project.id,
                        "task_id": task.id,
                        "skipped": True,
                        "task_status": task.status,
                    }
                },
                events=[
                    (
                        "execution.frame",
                        {
                            "type": "done",
                            "status": "skipped",
                            "reason": "task_already_advanced",
                            "project_id": project.id,
                            "task_id": task.id,
                            "task_status": task.status,
                        },
                    )
                ],
            )
        if task.status not in ("assigned", "running", "rework"):
            return _blocked_loop_result(
                project_id=project.id,
                task_id=task.id,
                reason=(
                    f"Task {task.id!r} is not runnable by a Worker Profile: "
                    f"status is {task.status!r}."
                ),
                error_code="task_not_runnable",
            )

        context = self._context_assembler.assemble(
            project,
            task,
            source_instruction=_source_instruction(snapshot),
            steer_instructions=steer_instructions,
        )
        handler = _build_worker_handler(
            self._handler_resolver.resolve(task.role_required),
            context.prompt,
            resume_messages=resume_messages,
        )
        engine = QueryEngine(self._settings, self._deps or production_deps())
        config = QueryConfig(
            run_id=snapshot.execution_id,
            skill_id=f"crew.worker.{task.role_required}",
            tools=handler.build_initial_request().tools,
            max_turns=_SUBAGENT_MAX_TURNS,
            config_error_message=(
                "model endpoint and API key are required before running an Anna Crew worker"
            ),
            carry_messages_on_suspend=True,
            carry_messages_on_complete=resume_messages is not None,
        )
        audit_events: list = []
        outcome_holder = Outcome()
        frames: list[dict[str, Any]] = []

        try:
            async for event in engine.run(
                config,
                handler,
                snapshot.execution_id,
                audit_events,
                outcome_holder,
            ):
                frames.append(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - adapter failures become Crew-visible blocks
            return _blocked_loop_result(
                project_id=project.id,
                task_id=task.id,
                reason=str(exc) or "Crew QueryEngine adapter failed.",
                error_code="crew_adapter_error",
                frames=frames,
                memory_hits=context.memory_hits,
                applied_signal_ids=_applied_signal_ids(
                    signals,
                    answer_signal=answer_signal,
                    include_steer=resume_messages is not None,
                ),
            )

        outcome = outcome_holder.value
        if outcome is None:
            return _blocked_loop_result(
                project_id=project.id,
                task_id=task.id,
                reason="QueryEngine finished without a terminal outcome.",
                error_code="missing_loop_outcome",
                frames=frames,
                memory_hits=context.memory_hits,
            )

        return _loop_result_from_outcome(
            snapshot,
            project,
            task,
            outcome=outcome,
            frames=frames,
            memory_hits=context.memory_hits,
            applied_signal_ids=_applied_signal_ids(
                signals,
                answer_signal=answer_signal,
                include_steer=resume_messages is not None,
            ),
        )


def _loop_result_from_outcome(
    snapshot: ExecutionSnapshot,
    project: CrewProject,
    task: CrewTask,
    *,
    outcome: Any,
    frames: list[dict[str, Any]],
    memory_hits: list[str],
    applied_signal_ids: list[str],
) -> LoopResult:
    frame_events = _execution_frame_events(project.id, task.id, frames)
    base_payload = {
        "project_id": project.id,
        "task_id": task.id,
        "execution_id": snapshot.execution_id,
        "memory_hits": list(memory_hits),
    }
    if outcome.status == "completed":
        artifact = (outcome.final_message or "").strip()
        if artifact:
            return LoopResult(
                status="succeeded",
                state={"crew": {**base_payload, "artifact_chars": len(artifact)}},
                checkpoint={
                    "kind": "crew.worker.completed.v1",
                    "turns": outcome.turns,
                },
                events=[
                    *frame_events,
                    (
                        "crew.task.artifact_produced",
                        {**base_payload, "artifact": artifact},
                    ),
                ],
                applied_signal_ids=applied_signal_ids,
            )
        return _blocked_loop_result(
            project_id=project.id,
            task_id=task.id,
            reason="Worker Profile returned an empty deliverable.",
            error_code="empty_artifact",
            frames=frames,
            memory_hits=memory_hits,
            applied_signal_ids=applied_signal_ids,
        )
    if outcome.status == "exhausted":
        return _blocked_loop_result(
            project_id=project.id,
            task_id=task.id,
            reason="Worker Profile hit the turn limit without producing a deliverable.",
            error_code="agent_exhausted",
            frames=frames,
            memory_hits=memory_hits,
            applied_signal_ids=applied_signal_ids,
        )
    if outcome.status == "suspended":
        checkpoint = _checkpoint_from_suspend_outcome(outcome)
        question = checkpoint.get("question") if checkpoint else None
        target = checkpoint.get("target") if checkpoint else None
        reason = outcome.message or "loop_suspended"
        question_payload = {
            **base_payload,
            "reason": reason,
            "question": question,
            "target": target,
            "tool": checkpoint.get("tool") if checkpoint else None,
            "tool_call_id": checkpoint.get("tool_call_id") if checkpoint else None,
        }
        return LoopResult(
            status="awaiting_signal",
            checkpoint=checkpoint or {"turns": outcome.turns},
            events=[
                *frame_events,
                ("crew.worker.question", question_payload),
                (
                    "execution.frame",
                    {
                        **base_payload,
                        "type": "awaiting_signal",
                        "reason": reason,
                        "question": question,
                        "target": target,
                    },
                ),
            ],
            applied_signal_ids=applied_signal_ids,
        )
    return _blocked_loop_result(
        project_id=project.id,
        task_id=task.id,
        reason=outcome.message or outcome.error_code or "Worker Profile execution failed.",
        error_code=outcome.error_code or "agent_failed",
        frames=frames,
        memory_hits=memory_hits,
        applied_signal_ids=applied_signal_ids,
    )


def _build_worker_handler(
    factory: HandlerFactory,
    prompt: str,
    *,
    resume_messages: list[dict[str, Any]] | None,
):
    if resume_messages is None:
        return factory(prompt)
    try:
        return factory(prompt, resume_messages=resume_messages)  # type: ignore[call-arg]
    except TypeError as exc:
        raise RuntimeError("Worker handler does not support durable answer resume") from exc


def _awaiting_signal_result(
    *,
    reason: str,
    supported_signal_kinds: list[str],
    unsupported_signal_ids: list[str] | None = None,
    signal_id: str | None = None,
) -> LoopResult:
    frame: dict[str, Any] = {
        "type": "awaiting_signal",
        "reason": reason,
        "supported_signal_kinds": list(supported_signal_kinds),
    }
    if unsupported_signal_ids is not None:
        frame["unsupported_signal_ids"] = list(unsupported_signal_ids)
    if signal_id is not None:
        frame["signal_id"] = signal_id
    return LoopResult(status="awaiting_signal", events=[("execution.frame", frame)])


def _awaiting_human_answer_result(
    checkpoint: dict[str, Any],
    signals: list[PendingSignal],
) -> LoopResult:
    frame: dict[str, Any] = {
        "type": "awaiting_signal",
        "reason": "awaiting_input",
        "question": checkpoint.get("question"),
        "target": checkpoint.get("target"),
        "supported_signal_kinds": ["answer", "steer"],
    }
    if signals:
        frame["pending_signal_ids"] = [signal.signal_id for signal in signals]
    return LoopResult(
        status="awaiting_signal",
        checkpoint={"kind": _CHECKPOINT_KIND_CREW_WORKER_AWAITING_INPUT},
        events=[
            (
                "crew.worker.question",
                {
                    "reason": "awaiting_input",
                    "question": checkpoint.get("question"),
                    "target": checkpoint.get("target"),
                    "tool": checkpoint.get("tool"),
                    "tool_call_id": checkpoint.get("tool_call_id"),
                },
            ),
            ("execution.frame", frame),
        ],
    )


def _checkpoint_from_suspend_outcome(outcome: Any) -> dict[str, Any] | None:
    messages = getattr(outcome, "messages", None)
    if not isinstance(messages, list):
        return None
    detail = getattr(outcome, "message", None)
    if detail != SUSPEND_REASON_AWAITING_INPUT:
        return {
            "kind": "crew.worker.suspended.v1",
            "turns": getattr(outcome, "turns", 0),
            "messages": messages,
        }
    pending = _pending_ask_from_messages(messages)
    if pending is None:
        return {
            "kind": "crew.worker.suspended.v1",
            "turns": getattr(outcome, "turns", 0),
            "messages": messages,
        }
    return {
        "kind": _CHECKPOINT_KIND_CREW_WORKER_AWAITING_INPUT,
        "turns": getattr(outcome, "turns", 0),
        "messages": messages,
        **pending,
    }


def _pending_ask_from_messages(messages: list[dict[str, Any]]) -> dict[str, Any] | None:
    for message in reversed(messages):
        tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
        if not isinstance(tool_calls, list):
            continue
        for tool_call in reversed(tool_calls):
            function = tool_call.get("function") if isinstance(tool_call, dict) else None
            if not isinstance(function, dict) or function.get("name") != _ASK_HUMAN_TOOL_NAME:
                continue
            raw_args = function.get("arguments")
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else {}
            except json.JSONDecodeError:
                args = {}
            question = args.get("question")
            if not isinstance(question, str) or not question.strip():
                question = "需要人工补充信息。"
            target = args.get("target")
            pending = {
                "tool": _ASK_HUMAN_TOOL_NAME,
                "tool_call_id": tool_call.get("id"),
                "question": question.strip(),
            }
            if isinstance(target, str) and target.strip():
                pending["target"] = target.strip()
            return pending
    return None


def _awaiting_input_checkpoint(checkpoint: dict[str, Any]) -> dict[str, Any] | None:
    if checkpoint.get("kind") != _CHECKPOINT_KIND_CREW_WORKER_AWAITING_INPUT:
        return None
    messages = checkpoint.get("messages")
    tool_call_id = checkpoint.get("tool_call_id")
    if not isinstance(messages, list) or not isinstance(tool_call_id, str) or not tool_call_id:
        return None
    return dict(checkpoint)


def _resume_messages_from_answer(
    checkpoint: dict[str, Any],
    *,
    answer_signal: PendingSignal,
    answer_text: str,
    steer_signals: list[PendingSignal],
) -> list[dict[str, Any]]:
    messages = [dict(message) for message in checkpoint["messages"]]
    answer_payload = {
        "answer": answer_text,
        "signal_id": answer_signal.signal_id,
    }
    actor = answer_signal.payload.get("actor")
    if isinstance(actor, str) and actor.strip():
        answer_payload["answered_by"] = actor.strip()
    messages.append(
        {
            "role": "tool",
            "tool_call_id": checkpoint["tool_call_id"],
            "name": _ASK_HUMAN_TOOL_NAME,
            "content": json.dumps(answer_payload, ensure_ascii=False, sort_keys=True),
        }
    )
    for signal in steer_signals:
        text = _signal_text(signal)
        if text:
            messages.append({"role": "user", "content": text})
    return messages


def _applied_signal_ids(
    signals: list[PendingSignal],
    *,
    answer_signal: PendingSignal | None,
    include_steer: bool,
) -> list[str]:
    if answer_signal is None and not include_steer:
        return [signal.signal_id for signal in signals]
    ids: list[str] = []
    if answer_signal is not None:
        ids.append(answer_signal.signal_id)
    if include_steer:
        ids.extend(signal.signal_id for signal in signals if signal.kind == "steer")
    return ids


def _blocked_loop_result(
    *,
    project_id: str | None,
    task_id: str | None,
    reason: str,
    error_code: str,
    frames: list[dict[str, Any]] | None = None,
    memory_hits: list[str] | None = None,
    applied_signal_ids: list[str] | None = None,
) -> LoopResult:
    payload: dict[str, Any] = {
        "reason": reason,
        "error_code": error_code,
        "memory_hits": list(memory_hits or []),
    }
    if project_id is not None:
        payload["project_id"] = project_id
    if task_id is not None:
        payload["task_id"] = task_id
    return LoopResult(
        status="failed",
        events=[
            *_execution_frame_events(project_id, task_id, frames or []),
            ("crew.task.agent_blocked", payload),
        ],
        applied_signal_ids=list(applied_signal_ids or []),
        last_error_code=error_code,
        error_message=reason,
    )


def _execution_frame_events(
    project_id: str | None,
    task_id: str | None,
    frames: list[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    terminal_frame_types = {"done", "error", "exhausted", "awaiting_approval", "awaiting_input"}
    events: list[tuple[str, dict[str, Any]]] = []
    for frame in frames:
        if frame.get("type") in terminal_frame_types:
            continue
        payload: dict[str, Any] = {"frame": frame}
        if project_id is not None:
            payload["project_id"] = project_id
        if task_id is not None:
            payload["task_id"] = task_id
        events.append(("execution.frame", payload))
    return events


def _crew_ref_from_snapshot(snapshot: ExecutionSnapshot) -> tuple[str, str] | None:
    project_id = snapshot.input.get("project_id") or snapshot.input.get("crew_project_id")
    task_id = snapshot.input.get("task_id") or snapshot.input.get("crew_task_id")
    if isinstance(project_id, str) and isinstance(task_id, str):
        return project_id, task_id
    subject_ref = _crew_ref_from_subject(snapshot.subject_ref, snapshot.input)
    if subject_ref is not None:
        return subject_ref
    return None


def _crew_ref_from_subject(
    subject_ref: object,
    execution_input: dict[str, Any],
) -> tuple[str, str] | None:
    if not isinstance(subject_ref, str):
        return None
    parts = subject_ref.split(":")
    if len(parts) >= 3 and parts[0] in {"crew_task", "crew-task", "crew", "task"}:
        return parts[1], ":".join(parts[2:])
    if len(parts) == 2 and parts[0] == "task":
        project_id = execution_input.get("project_id") or execution_input.get("crew_project_id")
        if isinstance(project_id, str):
            return project_id, parts[1]
    return None


def _validate_snapshot_provenance(
    snapshot: ExecutionSnapshot,
    project: CrewProject,
    task: CrewTask,
) -> str | None:
    if snapshot.workspace_id != project.workspace_id:
        return (
            f"Execution workspace {snapshot.workspace_id!r} does not match "
            f"Crew project workspace {project.workspace_id!r}."
        )
    input_project = snapshot.input.get("project_id") or snapshot.input.get("crew_project_id")
    input_task = snapshot.input.get("task_id") or snapshot.input.get("crew_task_id")
    if input_project != project.id or input_task != task.id:
        return "Execution input project_id/task_id does not match the Crew task."
    subject_ref = _crew_ref_from_subject(snapshot.subject_ref, snapshot.input)
    if subject_ref is not None and subject_ref != (project.id, task.id):
        return "Execution subject_ref does not match the Crew task."
    source_message_id = snapshot.input.get("source_message_id")
    if isinstance(source_message_id, str) and source_message_id:
        trigger_ref = str(snapshot.trigger_ref)
        if source_message_id not in trigger_ref:
            return "Execution trigger_ref does not include the source_message_id."
    return None


def _validate_worker_assignee(
    snapshot: ExecutionSnapshot,
    task: CrewTask,
) -> str | None:
    if not task.assignee_member_id:
        return f"Task {task.id!r} has no Worker Profile assignee."
    assignee = _member_id_from_worker_profile_ref(snapshot.worker_profile_ref)
    if assignee is None:
        return (
            f"Execution worker_profile_ref {snapshot.worker_profile_ref!r} must use "
            "canonical 'member:<assignee_member_id>' form for Crew workers."
        )
    if assignee != task.assignee_member_id:
        return (
            f"Execution worker_profile_ref {snapshot.worker_profile_ref!r} does not "
            f"match task assignee {task.assignee_member_id!r}."
        )
    return None


def _member_id_from_worker_profile_ref(worker_profile_ref: str) -> str | None:
    if worker_profile_ref.startswith("member:"):
        member_id = worker_profile_ref.removeprefix("member:")
        return member_id or None
    if ":" in worker_profile_ref:
        return None
    return worker_profile_ref or None


def _source_instruction(snapshot: ExecutionSnapshot) -> str | None:
    value = snapshot.input.get("source_instruction")
    return value if isinstance(value, str) and value.strip() else None


def _signal_text(signal: PendingSignal) -> str:
    for key in ("text", "body", "message", "content"):
        value = signal.payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if signal.payload:
        return json.dumps(signal.payload, ensure_ascii=False, sort_keys=True)
    return ""
