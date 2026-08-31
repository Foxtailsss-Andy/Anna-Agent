from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from services.chat.app.orchestrator import ChatOrchestrator, ChatRunNotFoundError
from services.chat.app.schemas import ChatRun
from services.business.harness_client import (
    HarnessHostClient,
    HarnessHostError,
    HarnessRun,
    ProductTask,
    native_todo_plan,
    result_payload,
)
from services.reimbursement.app.audit import AuditEvent
from services.runtime.app.autocompact import clear_autocompact_tracker
from services.runtime.app.concurrency import WorkspaceRunGate
from services.runtime.app.frame_journal import FrameJournal
from services.runtime.app.harness_runtime import _hash_payload
from services.runtime.app.interjections import (
    clear_interjections,
    push_interjection,
)
from services.runtime.app.trace_assembler import assemble_host_trace

from ..schemas import (
    CreateChatRunRequest,
    InterjectChatRunRequest,
    SaveChatRunRequest,
)
from ..security import _assert_identity, _assert_run_access, _assert_workspace_access

# L3a run_store surface key for chat frame journaling (one table per surface).
_CHAT_SURFACE = "chat"

# A chat run is non-terminal ONLY while "generating"; every other status is a
# reached terminal (ready / saved / failed / interrupted). Stopping a terminal
# run is an idempotent no-op.
_TERMINAL_CHAT_STATUSES = frozenset({"ready", "saved", "failed", "interrupted"})


def _jsonify_frame(frame: dict) -> dict:
    """Normalize one wire frame to a JSON-safe dict ONCE, before journaling.

    ``stream_existing_run`` yields frames whose ``run`` / ``event`` are pydantic
    models. Serializing them here (mode="json") keeps the in-memory ring, the
    SQLite write-through, and the SSE wire byte-identical — a live follower and a
    from-disk replay see the same shape. ``seq`` is added later by the journal;
    existing frame fields are untouched (additive-only R2 contract).
    """
    out = dict(frame)
    run = out.get("run")
    if run is not None and hasattr(run, "model_dump"):
        out["run"] = run.model_dump(mode="json")
    event = out.get("event")
    if event is not None and hasattr(event, "model_dump"):
        out["event"] = event.model_dump(mode="json")
    return out


async def _safe_aclose(agen: AsyncIterator) -> None:
    """Close an async generator, swallowing any error so a cancel is not masked."""
    try:
        await agen.aclose()
    except (Exception, asyncio.CancelledError):  # noqa: BLE001 — close is best-effort
        pass


class BackgroundRunManager:
    """Decouples a chat run from any SSE connection (L3a, pillar P3 恢复力).

    ``submit`` creates the run synchronously (immediate run id) then drives
    ``ChatOrchestrator.stream_existing_run`` to completion in an
    ``asyncio.create_task``, journaling every frame to a per-run ``FrameJournal``
    (in-memory ring + SQLite write-through). ``subscribe`` is a resumable reader:
    a live run replays the journal from ``from_seq`` then follows to the terminal;
    a finished run replays purely from SQLite. Dropping a subscriber closes only
    its own generator — the background task never sees it. ``stop`` finalizes the
    run ``stopped_by_user`` and cancels the task.

    Task/journal registries are plain per-manager dicts (one manager per router,
    so app instances stay isolated), cleaned up when the task reaches a terminal.
    No pub/sub, no threads — asyncio on the uvicorn loop only.

    L5 (P4 并行隔离): a per-workspace ``WorkspaceRunGate`` bounds how many runs a
    workspace drives at once — an OUTER guardrail at this manager, zero engine
    changes. A run over the limit QUEUES (honestly announced via a ``run.queued``
    audit/event frame journaled the moment queueing starts) and starts when a
    slot frees; workspaces never block each other. A resumed run (``continue``)
    re-competes for a slot like any submit.
    """

    def __init__(self, chat: ChatOrchestrator) -> None:
        self._chat = chat
        self._store = getattr(chat, "_run_store", None)
        self._tasks: dict[str, asyncio.Task] = {}
        self._journals: dict[str, FrameJournal] = {}
        self._telemetry: dict[str, dict] = {}
        self._gate = WorkspaceRunGate(chat.settings.concurrency_per_workspace_runs)

    def submit(
        self,
        *,
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
        """Create the run (sync, immediate id) and start its background driver."""
        run = self._chat.create_run(
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            message=message,
            template_id=template_id,
            model_profile_id=model_profile_id,
            skill_id=skill_id,
            agent_id=agent_id,
            workdir_id=workdir_id,
            thread_id=thread_id,
        )
        journal = FrameJournal()
        self._journals[run.id] = journal
        # skip_history=True + preflush_events=True (L5): the driver journals the
        # pre-drive audit trail itself so a queued run's created/queued frames
        # are visible BEFORE the engine starts, and the stream's watermark must
        # not re-emit them (exactly-once frames).
        self._tasks[run.id] = asyncio.create_task(
            self._drive(
                run,
                journal,
                self._chat.stream_existing_run(run, skip_history=True),
                preflush_events=True,
            )
        )
        return run

    async def continue_run(self, run_id: str) -> ChatRun:
        """Resume an ``awaiting_continue`` run in a NEW background task (L4a 续办).

        Idempotent: a run in any other status is returned unchanged (never a 409,
        matching ``stop``'s friendly race handling). The continuation journal
        starts at (max persisted seq)+1 so ``seq`` stays strictly contiguous
        across the suspend/resume boundary — a restart at 1 would be SILENTLY
        dropped by the frame table's INSERT OR IGNORE. The engine restarts from the
        suspended snapshot with a fresh ``max_turns`` budget (and a fresh
        autocompact breaker), so it may complete or suspend again. The resumed
        task passes through the workspace gate like any fresh submit (L5) — a
        continuation re-competes for a slot and may queue (``run.queued``); no
        pre-flush here, the first segment already journaled the run's history.
        """
        run = self._chat.get_run(run_id)
        if run.status != "awaiting_continue":
            return run
        clear_autocompact_tracker(run_id)
        start_seq = (
            self._store.max_frame_seq(_CHAT_SURFACE, run_id) + 1
            if self._store is not None
            else 1
        )
        journal = FrameJournal(start_seq=start_seq)
        self._journals[run_id] = journal
        agen = self._chat.stream_resumed_run(run)
        # Flip to generating synchronously (like submit's create_run) so the
        # immediate response and any GET during resume read "generating", not the
        # stale "awaiting_continue"; the driver then streams the resumed run.
        run.status = "generating"
        self._chat._persist_run(run)
        self._tasks[run_id] = asyncio.create_task(self._drive(run, journal, agen))
        return run

    def get_task(self, run_id: str) -> asyncio.Task | None:
        return self._tasks.get(run_id)

    def telemetry(self, run_id: str) -> dict:
        journal = self._journals.get(run_id)
        if journal is not None:
            return {"run_id": run_id, **journal.telemetry_snapshot()}
        return {"run_id": run_id, **self._telemetry.get(run_id, {
            "subscription_count": 0,
            "resume_subscription_count": 0,
            "frames_emitted": 0,
            "gap_recovery_count": 0,
            "persistence_failure_count": 0,
            "durable_seq": None,
            "pending_persistence_seqs": [],
            "durability_degraded": False,
            "last_seq": 0,
            "terminal": False,
        })}

    def trace(self, run_id: str, conversation_id: str | None = None) -> dict:
        """一次 run 的 OTel 形状 span 树(Trace 轮 T1;纯读,无 store 时回空树)。

        conversation_id 传 run 的 thread_id(Q6),无 thread 由装配器回落 run_id。
        """
        from services.runtime.app.trace_assembler import assemble_trace

        reader = getattr(self._store, "list_frames_with_meta", None)
        rows = reader(_CHAT_SURFACE, run_id) if reader is not None else []
        return assemble_trace(run_id, _CHAT_SURFACE, rows, conversation_id=conversation_id)

    async def _drive(
        self,
        run: ChatRun,
        journal: FrameJournal,
        agen: AsyncIterator[dict],
        *,
        preflush_events: bool = False,
    ) -> None:
        """Drive a run's engine stream to completion, journaling every frame.

        ``agen`` is the orchestrator stream to drive — ``stream_existing_run`` for
        a fresh submit or ``stream_resumed_run`` for a continuation; both share the
        frame contract, so this driver is agnostic. Exception-safe:
        ``stream_existing_run`` already finalizes the run and yields a terminal
        ``error`` frame on its own failures, so a raise reaching here is
        unexpected — finalize + journal a terminal error defensively. On cancel
        (explicit stop), the run is already finalized by ``stop`` and the terminal
        frame already journaled; close the engine generator (a guarded no-op for
        client_disconnected) and re-raise. A ``max_turns`` suspension ends the
        stream WITHOUT a done/error frame; the ``finally`` closes the journal so
        followers drain cleanly, and ``continue_run`` opens a fresh one.

        L5 workspace gate: the engine only starts once a workspace slot is
        acquired. When the run truly has to wait, a ``run.queued
        {workspace_id}`` audit event is appended AND journaled the moment
        queueing starts (before the semaphore wait), so a live subscriber sees
        the queue while it is happening; the run record keeps status
        ``generating`` — queued is visible via the event frame, avoiding a
        status-vocabulary ripple this slice. The slot is released on EVERY exit
        path (done / suspension / stop-cancel / crash); a wait cancelled before
        acquisition consumes no slot and releases nothing.

        ``preflush_events=True`` (fresh submits) journals the audit events
        already on the run (``chat.run.created``) before the gate, pairing with
        ``stream_existing_run(skip_history=True)`` so each pre-drive frame is
        journaled exactly once. Resumes pass False: their history is already in
        the journal from the previous segment.
        """
        writer = self._writer(run.id)
        acquired = False
        try:
            if preflush_events:
                for event in list(run.audit_events):
                    await journal.append(
                        _jsonify_frame({"type": "event", "event": event}), writer
                    )

            async def _journal_queued() -> None:
                event = self._chat.audit.append(
                    run.audit_events,
                    "run.queued",
                    run.id,
                    {"workspace_id": run.workspace_id},
                )
                await journal.append(
                    _jsonify_frame({"type": "event", "event": event}), writer
                )

            await self._gate.acquire(run.workspace_id, on_queued=_journal_queued)
            acquired = True
            async for frame in agen:
                await journal.append(_jsonify_frame(frame), writer)
        except asyncio.CancelledError:
            await _safe_aclose(agen)
            raise
        except Exception:  # noqa: BLE001 — defensive; the generator handles its own
            failed = self._chat._fail_run(
                run, "chat_run_failed", "background chat run crashed"
            )
            await journal.append(_jsonify_frame({"type": "error", "run": failed}), writer)
        finally:
            if acquired:
                self._gate.release(run.workspace_id)
            await journal.close(writer)
            telemetry = journal.telemetry_snapshot()
            if telemetry["durability_degraded"]:
                self._record_durability_gap(run, telemetry)
            self._telemetry[run.id] = telemetry
            self._tasks.pop(run.id, None)
            self._journals.pop(run.id, None)
            # J3: free the interjection queue when the run is truly OVER. A run
            # parked at ``awaiting_continue`` deliberately keeps its queue — the
            # user may steer a parked run, and ``continue_run``'s fresh segment
            # drains it on its first turn.
            if run.status in _TERMINAL_CHAT_STATUSES:
                clear_interjections(run.id)

    async def subscribe(self, run_id: str, from_seq: int = 0) -> AsyncIterator[dict]:
        """Resumable frame stream: live journal (replay+follow) OR disk replay."""
        journal = self._journals.get(run_id)
        if journal is not None:
            async for frame in journal.subscribe(from_seq, backfill=self._backfill(run_id)):
                yield frame
            return
        # Finished run (no live journal): pure replay from SQLite.
        self._record_disk_replay_start(run_id, from_seq)
        all_frames = self._read_frames(run_id, 1)
        terminal_seen = any(frame.get("type") in {"done", "error"} for frame in all_frames)
        for frame in all_frames:
            if frame.get("seq", 0) <= from_seq:
                continue
            self._record_disk_replay_frame(run_id, frame)
            yield frame
        if terminal_seen:
            return
        try:
            run = self._chat.get_run(run_id)
        except ChatRunNotFoundError:
            return
        gap_event = next(
            (event for event in run.audit_events if event.type == "run.durability_gap"),
            None,
        )
        if gap_event is None:
            return
        recovery_frames = self._recover_durability_gap(run, gap_event, all_frames)
        for frame in recovery_frames:
            if frame["seq"] <= from_seq:
                continue
            self._record_disk_replay_frame(run_id, frame)
            yield frame

    def _record_durability_gap(self, run: ChatRun, telemetry: dict) -> None:
        if any(event.type == "run.durability_gap" for event in run.audit_events):
            return
        self._chat.audit.append(
            run.audit_events,
            "run.durability_gap",
            run.id,
            {
                "durable_seq": telemetry["durable_seq"],
                "pending_persistence_seqs": telemetry["pending_persistence_seqs"],
                "persistence_failure_count": telemetry["persistence_failure_count"],
            },
        )
        # The run record is a separate durable projection from the frame journal;
        # it is the recovery marker when the frame table was unavailable.
        self._chat._persist_run(run)

    def _recover_durability_gap(
        self,
        run: ChatRun,
        gap_event,
        existing_frames: list[dict],
    ) -> list[dict]:
        start_seq = max((frame.get("seq", 0) for frame in existing_frames), default=0) + 1
        message = "Run output had a durable frame gap and must be retried."
        if run.status != "failed" or run.error_code != "durable_gap":
            # A missing frame is a terminal failure of the observable Run, even
            # when the engine had already projected it as ready. Persist the
            # same outcome returned in the recovery frame so GET and SSE agree.
            self._chat._fail_run(run, "durable_gap", message)
        event_frame = {
            "type": "event",
            "event": gap_event.model_dump(mode="json"),
            "seq": start_seq,
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        error_frame = {
            "type": "error",
            "error_code": "durable_gap",
            "message": message,
            "run": run.model_dump(mode="json"),
            "seq": start_seq + 1,
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
        }
        recovery_frames = [event_frame, error_frame]
        if self._store is not None:
            for frame in recovery_frames:
                try:
                    self._store.append_frame(
                        _CHAT_SURFACE, run.id, frame["seq"], frame
                    )
                except Exception:  # noqa: BLE001 — recovery remains honest if storage is still down
                    break
        return recovery_frames

    def _record_disk_replay_start(self, run_id: str, from_seq: int) -> None:
        metrics = self._telemetry.setdefault(run_id, {
            "subscription_count": 0,
            "resume_subscription_count": 0,
            "frames_emitted": 0,
            "gap_recovery_count": 0,
            "persistence_failure_count": 0,
            "durable_seq": None,
            "pending_persistence_seqs": [],
            "durability_degraded": False,
            "last_seq": 0,
            "terminal": True,
        })
        metrics["subscription_count"] += 1
        if from_seq > 0:
            metrics["resume_subscription_count"] += 1

    def _record_disk_replay_frame(self, run_id: str, frame: dict) -> None:
        metrics = self._telemetry[run_id]
        metrics["frames_emitted"] += 1
        metrics["last_seq"] = max(metrics["last_seq"], frame.get("seq", 0))

    async def interject(self, run_id: str, text: str) -> dict:
        """Deliver a mid-run interjection to a LIVE run (J3 steering).

        The user speaks to a run that is already running; the text is queued and
        the engine splices it in as a genuine user turn at the top of the next
        turn (``ChatCapabilityHandler.drain_interjections``). The run is never
        restarted and the work already done is never rewritten.

        Idempotent no-op on an already-terminal run — reported as
        ``accepted: False`` with the run's current status rather than a 409,
        matching ``stop`` / ``continue``'s friendly race handling (a user hitting
        send just as the answer lands is a race, not an error). Nothing is
        queued and NO audit event is written in that case, so a finished run's
        trail never gains a phantom interjection.

        A ``run.interjected`` audit event records the receipt. For a LIVE run the
        event is appended to the run's trail ONLY — unlike ``run.queued``, which
        must journal itself because it fires before the engine stream exists. Here
        the stream is live, so its ``AuditFrameWatermark`` picks the event up and
        emits the frame on the very next engine event (and every terminal path
        flushes the watermark one last time, so it can never be stranded).
        Journaling it there too would put the frame in the stream twice.

        A PARKED (``awaiting_continue``) run is the exception: it is steerable —
        the queue survives for ``continue_run``'s first turn — but its background
        task has already ended, so there is no live journal and no watermark that
        will ever run again. Its receipt frame is therefore appended straight to
        disk at the next seq, exactly as ``stop`` does for the same reason. Either
        way the run is persisted, so a restart before the user hits continue keeps
        the receipt it was already promised.

        The payload carries a hash, not the text — the text itself reaches the
        transcript as the user turn it becomes.
        """
        run = self._chat.get_run(run_id)
        if run.status in _TERMINAL_CHAT_STATUSES:
            return {"run_id": run.id, "status": run.status, "accepted": False}
        push_interjection(run_id, text)
        self._chat.audit.append(
            run.audit_events,
            "run.interjected",
            run.id,
            {"text_hash": _hash_payload({"text": text})},
        )
        # Write-through: the receipt must outlive a restart, not just this process.
        self._chat._persist_run(run)
        if self._journals.get(run_id) is None and self._store is not None:
            # Parked run — nothing else will ever emit this frame (see above).
            event_frame = _jsonify_frame(
                {"type": "event", "event": run.audit_events[-1]}
            )
            seq = self._store.max_frame_seq(_CHAT_SURFACE, run_id) + 1
            try:
                self._store.append_frame(
                    _CHAT_SURFACE, run_id, seq, {**event_frame, "seq": seq}
                )
            except Exception:  # noqa: BLE001 — frame persistence is best-effort
                pass
        return {"run_id": run.id, "status": run.status, "accepted": True}

    async def stop(self, run_id: str) -> ChatRun:
        """Finalize a live run ``stopped_by_user`` and cancel its background task.

        Idempotent no-op on an already-terminal run. Order matters: finalize the
        run terminal, journal the closing ``error`` frame (so followers see
        closure), THEN cancel — so ``stream_existing_run``'s GeneratorExit guard
        sees a terminal run and never records ``client_disconnected``, and the
        terminal frame is journaled before the cancel can flip the journal shut.
        """
        run = self._chat.get_run(run_id)
        if run.status in _TERMINAL_CHAT_STATUSES:
            return run
        task = self._tasks.get(run_id)
        journal = self._journals.get(run_id)
        failed = self._chat._fail_run(run, "stopped_by_user", "run stopped by the user")
        clear_autocompact_tracker(run_id)
        # A stopped run never takes another turn, so anything still queued for it
        # would sit in the process-global registry until 4096 other runs evict it.
        # Same reasoning as the tracker above.
        clear_interjections(run_id)
        if journal is not None:
            await journal.append(
                _jsonify_frame({"type": "error", "run": failed}), self._writer(run_id)
            )
        elif self._store is not None:
            # No live journal (e.g. stopping a parked awaiting_continue run, whose
            # background task already ended): append the closing terminal frame
            # straight to disk at the next seq so a reconnecting subscriber still
            # sees closure. Best-effort — journaling must never break a stop.
            seq = self._store.max_frame_seq(_CHAT_SURFACE, run_id) + 1
            stamped = {**_jsonify_frame({"type": "error", "run": failed}), "seq": seq}
            try:
                self._store.append_frame(_CHAT_SURFACE, run_id, seq, stamped)
            except Exception:  # noqa: BLE001 — closing-frame persistence is best-effort
                pass
        if task is not None:
            task.cancel()
        return failed

    # --- persistence wiring (None when the orchestrator has no run store) ------

    def _writer(self, run_id: str) -> Callable[[dict], None] | None:
        store = self._store
        if store is None:
            return None
        return lambda stamped: store.append_frame(
            _CHAT_SURFACE, run_id, stamped["seq"], stamped
        )

    def _backfill(self, run_id: str) -> Callable[[int], list[dict]] | None:
        store = self._store
        if store is None:
            return None
        return lambda from_seq: store.list_frames(_CHAT_SURFACE, run_id, from_seq)

    def _read_frames(self, run_id: str, from_seq: int) -> list[dict]:
        if self._store is None:
            return []
        return self._store.list_frames(_CHAT_SURFACE, run_id, from_seq)


def build_router(
    chat: ChatOrchestrator,
    *,
    harness_client: HarnessHostClient | None = None,
    product_mode: bool = False,
) -> APIRouter:
    router = APIRouter()
    manager = BackgroundRunManager(chat)
    host_run_ids: dict[str, str] = {}

    def _require_host() -> HarnessHostClient:
        if not product_mode or harness_client is None:
            raise HTTPException(status_code=503, detail="Harness Host is not configured")
        return harness_client

    def _task_for_run(run: ChatRun) -> ProductTask:
        resolved = chat.build_host_inputs(run)
        messages = resolved.request.messages
        system_prompt = next(
            (
                message.get("content")
                for message in messages
                if message.get("role") == "system" and isinstance(message.get("content"), str)
            ),
            "",
        )
        user_messages = [
            message
            for message in messages
            if message.get("role") == "user" and isinstance(message.get("content"), str)
        ]
        prompt = str(user_messages[-1]["content"]) if user_messages else run.message
        conversation_history = [
            {
                "role": message["role"],
                "content": message["content"],
            }
            for message in messages
            if message.get("role") in {"user", "assistant"}
            and isinstance(message.get("content"), str)
        ][:-1]
        # plan.update is a Python-era bookkeeping tool. Product OMP owns the
        # equivalent native TodoTool; only formal Chat deliverables and the
        # scoped workdir reader cross the business callback boundary.
        tool_catalog = [
            dict(tool)
            for tool in resolved.request.tools
            if tool.get("name") in {"chat.emit_page", "chat.emit_document", "workdir.read_file"}
        ]
        return ProductTask(
            run_id=run.id,
            workspace_id=run.workspace_id,
            actor_user_id=run.actor_user_id,
            surface="chat",
            prompt=prompt,
            channel_id=f"chat_channel:{run.workspace_id}",
            conversation_id=run.thread_id,
            system_prompt=system_prompt,
            context={
                "template_id": run.template_id,
                "skill_id": resolved.skill_id,
                "agent_id": run.agent_id,
                "workdir_id": run.workdir_id,
                "model_profile_id": run.model_profile_id,
                "tool_catalog": tool_catalog,
                "conversation_history": conversation_history,
                "skill_provenance": {
                    "source": "anna-python-skill-loader",
                    "uri": resolved.skill.path.as_uri(),
                    "skill_id": resolved.skill_id,
                    "version": resolved.skill.version,
                    "content_hash": resolved.skill.content_hash,
                },
                "agent_directive": resolved.agent_directive,
                "source": "home.chat",
            },
            workdir_path=resolved.workdir_root,
            permission_mode="readonly",
            model_profile_id=run.model_profile_id,
            source_event_id=run.id,
        )

    @router.get("/api/chat/prompt-templates")
    def get_chat_prompt_templates(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
        return {"templates": [template.model_dump() for template in chat.prompt_templates()]}

    @router.get("/api/chat/model-profiles")
    def get_chat_model_profiles(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        """Sanitized model profiles for the composer selector (no secrets)."""
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
        return {
            "profiles": chat.settings.list_model_profiles(),
            "default_profile_id": "default",
        }

    @router.post("/api/chat/runs")
    def create_chat_run(
        request: CreateChatRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        if product_mode:
            run = chat.create_run(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                message=request.message,
                template_id=request.template_id,
                model_profile_id=request.model_profile_id,
                skill_id=request.skill_id,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                thread_id=request.thread_id,
            )
            try:
                host_run = _require_host().submit_and_wait(_task_for_run(run))
                host_run_ids[run.id] = host_run.run_id
            except HarnessHostError as exc:
                _apply_chat_host_failure(chat, run, exc.code or "harness_request_failed")
            else:
                _apply_chat_host_run(chat, run, host_run)
        else:
            run = chat.start_run(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                message=request.message,
                template_id=request.template_id,
                model_profile_id=request.model_profile_id,
                skill_id=request.skill_id,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                thread_id=request.thread_id,
            )
        return run.model_dump()

    @router.get("/api/chat/runs")
    def list_chat_runs(
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> list[dict]:
        _assert_workspace_access(anna_workspace_id, anna_workspace_id, anna_user_id)
        if product_mode:
            # Host history is the runtime fact source. The local registry still
            # contributes compatibility metadata for runs created by this
            # process; terminal fields are refreshed on GET/stream.
            return [
                run.model_dump(mode="json")
                for run in chat.list_runs(anna_workspace_id, anna_user_id)
            ]
        return [
            run.model_dump(mode="json")
            for run in chat.list_runs(anna_workspace_id, anna_user_id)
        ]

    # GET /api/chat/runs/{run_id} 与 POST /api/chat/runs/stream 方法不同、
    # 路径段数也不同(前者取代 {run_id}="stream" 仅当方法为 GET),彼此不冲突。
    @router.get("/api/chat/runs/{run_id}")
    def get_chat_run(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if product_mode and run.status == "generating":
            try:
                _apply_chat_host_run(chat, run, _require_host().get(host_run_ids.get(run.id, run.id)))
            except HarnessHostError:
                pass
        return run.model_dump(mode="json")

    # 路径段比 {run_id} 更长("trace" 是第三段),与上面的详情路由不冲突。
    @router.get("/api/chat/runs/{run_id}/trace")
    def get_chat_run_trace(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        """执行过程 Trace(§4 TraceDoc)—— journal+audit 装配,纯读。"""
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if product_mode:
            try:
                host_id = host_run_ids.get(run_id, run_id)
                host = _require_host()
                host_run = host.get(host_id)
                host_events = list(host_run.events)
                if not host_events:
                    host_events = host.events(host_id)
            except HarnessHostError as exc:
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            return assemble_host_trace(
                run_id,
                _CHAT_SURFACE,
                host_events,
                conversation_id=getattr(run, "thread_id", None),
            )
        return manager.trace(run_id, conversation_id=getattr(run, "thread_id", None))

    @router.post("/api/chat/runs/stream")
    async def stream_chat_run(
        request: CreateChatRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )

        async def event_stream():
            if product_mode:
                try:
                    run = chat.create_run(
                        workspace_id=request.workspace_id,
                        actor_user_id=request.actor_user_id,
                        message=request.message,
                        template_id=request.template_id,
                        model_profile_id=request.model_profile_id,
                        skill_id=request.skill_id,
                        agent_id=request.agent_id,
                        workdir_id=request.workdir_id,
                        thread_id=request.thread_id,
                    )
                    host = _require_host()
                    submitted = await asyncio.to_thread(host.submit, _task_for_run(run))
                    host_run_ids[run.id] = submitted.run_id
                    yield _json_sse({"type": "event", "event": _host_audit_event(run.id, "harness.task.submitted", {"surface": "chat"})})
                    after_seq = -1
                    tool_names: dict[str, str] = {}
                    while True:
                        events = await asyncio.to_thread(host.events, submitted.run_id, after_seq=after_seq)
                        for event in events:
                            after_seq = max(after_seq, _event_seq(event))
                            for frame in _host_event_frame(event, tool_names):
                                yield _json_sse(frame)
                        current = await asyncio.to_thread(host.get, submitted.run_id)
                        if current.terminal:
                            _apply_chat_host_run(chat, run, current)
                            terminal_type = "done" if run.status == "ready" else "error"
                            yield _json_sse({"type": terminal_type, "run": run.model_dump(mode="json")})
                            return
                        await asyncio.sleep(0.05)
                except HarnessHostError as exc:
                    if "run" in locals():
                        _apply_chat_host_failure(chat, run, exc.code or "harness_request_failed")
                        yield _json_sse({"type": "error", "run": run.model_dump(mode="json")})
                    else:
                        yield _json_sse({"type": "error", "message": exc.code or "harness_request_failed"})
                return
            async for event in chat.stream_run(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                message=request.message,
                template_id=request.template_id,
                model_profile_id=request.model_profile_id,
                skill_id=request.skill_id,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                thread_id=request.thread_id,
            ):
                payload = dict(event)
                run = payload.get("run")
                if run is not None and hasattr(run, "model_dump"):
                    payload["run"] = run.model_dump()
                inner = payload.get("event")
                if inner is not None and hasattr(inner, "model_dump"):
                    # Additive audit-trail frame (R1-T4b): serialize the
                    # AuditEvent so json.dumps can render it. Today's frontend
                    # ignores {"type": "event"} frames; R2 will consume them.
                    payload["event"] = inner.model_dump(mode="json")
                yield _json_sse(payload)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # --- L3a background runs: submit / resumable subscribe / stop --------------
    # /submit decouples the run from the request; /{run_id}/stream is a resumable
    # subscription (replay from ?from_seq= then follow); /{run_id}/stop cancels.
    # Legacy /runs and /runs/stream stay untouched for compatibility (FE migrates
    # next slice). Literal segments (submit) never collide with the {run_id}
    # param routes — they differ by method/depth.

    @router.post("/api/chat/runs/submit")
    async def submit_chat_run(
        request: CreateChatRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_identity(
            request.workspace_id,
            request.actor_user_id,
            anna_workspace_id,
            anna_user_id,
        )
        if product_mode:
            run = chat.create_run(
                workspace_id=request.workspace_id,
                actor_user_id=request.actor_user_id,
                message=request.message,
                template_id=request.template_id,
                model_profile_id=request.model_profile_id,
                skill_id=request.skill_id,
                agent_id=request.agent_id,
                workdir_id=request.workdir_id,
                thread_id=request.thread_id,
            )
            try:
                submitted = _require_host().submit(_task_for_run(run))
                host_run_ids[run.id] = submitted.run_id
            except HarnessHostError as exc:
                _apply_chat_host_failure(chat, run, exc.code or "harness_request_failed")
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            return {"run_id": run.id, "thread_id": run.thread_id, "status": run.status, "host_run_id": submitted.run_id}
        run = manager.submit(
            workspace_id=request.workspace_id,
            actor_user_id=request.actor_user_id,
            message=request.message,
            template_id=request.template_id,
            model_profile_id=request.model_profile_id,
            skill_id=request.skill_id,
            agent_id=request.agent_id,
            workdir_id=request.workdir_id,
            thread_id=request.thread_id,
        )
        return {"run_id": run.id, "thread_id": run.thread_id, "status": run.status}

    @router.get("/api/chat/runs/{run_id}/stream")
    async def stream_chat_run_resumable(
        run_id: str,
        from_seq: int = Query(0, ge=0),
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> StreamingResponse:
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(
            run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id
        )

        async def event_stream():
            # Frames are already JSON-safe dicts (jsonified before journaling /
            # parsed from SQLite), so they serialize directly. A dropped consumer
            # closes ONLY this generator — the background run is untouched.
            if product_mode:
                after_seq = from_seq
                tool_names: dict[str, str] = {}
                while True:
                    try:
                        host_id = host_run_ids.get(run_id, run_id)
                        host_run = await asyncio.to_thread(_require_host().get, host_id)
                        events = await asyncio.to_thread(_require_host().events, host_id, after_seq=after_seq)
                    except HarnessHostError as exc:
                        yield _json_sse({"type": "error", "message": exc.code or "harness_request_failed"})
                        return
                    for event in events:
                        after_seq = max(after_seq, _event_seq(event))
                        for frame in _host_event_frame(event, tool_names):
                            yield _json_sse(frame)
                    if host_run.terminal:
                        _apply_chat_host_run(chat, run, host_run)
                        yield _json_sse({"type": "done" if run.status == "ready" else "error", "run": run.model_dump(mode="json")})
                        return
                    await asyncio.sleep(0.05)
                return
            async for frame in manager.subscribe(run_id, from_seq=from_seq):
                yield _json_sse(frame)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.get("/api/chat/runs/{run_id}/telemetry")
    def get_chat_run_telemetry(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(
            run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id
        )
        return manager.telemetry(run_id)

    @router.post("/api/chat/runs/{run_id}/stop")
    async def stop_chat_run(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(
            run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id
        )
        # Idempotent: stopping an already-terminal run is a no-op returning its
        # status (friendlier than 409 for a stop-button race).
        if product_mode:
            try:
                stopped = await asyncio.to_thread(_require_host().stop, host_run_ids.get(run_id, run_id), reason="user_stop")
            except HarnessHostError as exc:
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            _apply_chat_host_run(chat, run, stopped)
            return {"run_id": run.id, "status": run.status}
        stopped = await manager.stop(run_id)
        return {"run_id": stopped.id, "status": stopped.status}

    @router.post("/api/chat/runs/{run_id}/interject")
    async def interject_chat_run(
        run_id: str,
        request: InterjectChatRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        """Speak to a run that is already running (J3 插话 / steering).

        Identity-checked like ``stop`` / ``continue``. The text is queued and the
        engine splices it into the conversation as a genuine user turn at the top
        of the run's next turn — no new run, no restart, no lost work. An empty
        or whitespace-only text is rejected (422) rather than injected as a blank
        user turn. Interjecting into a terminal run is an idempotent no-op
        reporting ``accepted: false`` with the run's current status.
        """
        text = request.text.strip()
        if not text:
            raise HTTPException(status_code=422, detail="interjection text is required")
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(
            run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id
        )
        if product_mode:
            try:
                accepted = await asyncio.to_thread(
                    _require_host().signal,
                    host_run_ids.get(run_id, run_id),
                    kind="steer",
                    payload={"text": text},
                )
            except HarnessHostError as exc:
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            return {"run_id": run_id, "accepted": not accepted.terminal, "status": accepted.status}
        return await manager.interject(run_id, text)

    @router.post("/api/chat/runs/{run_id}/continue")
    async def continue_chat_run(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        """Resume a run parked at ``max_turns`` (L4a 续办).

        Identity-checked like ``stop``. Only an ``awaiting_continue`` run actually
        resumes; any other status is an idempotent no-op returning its current
        status (friendlier than 409 for a double-click race). The resumed run
        streams on the SAME ``run_id`` / journal seq space via
        ``GET /runs/{run_id}/stream?from_seq=``.
        """
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(
            run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id
        )
        if product_mode:
            try:
                resumed = await asyncio.to_thread(_require_host().continue_run, host_run_ids.get(run_id, run_id))
            except HarnessHostError as exc:
                raise HTTPException(status_code=502, detail=exc.code or "harness_request_failed") from exc
            _apply_chat_host_run(chat, run, resumed)
            return {"run_id": run_id, "status": run.status}
        resumed = await manager.continue_run(run_id)
        return {"run_id": resumed.id, "status": resumed.status}

    @router.post("/api/chat/runs/{run_id}/save")
    def save_chat_run(
        run_id: str,
        request: SaveChatRunRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        if request.saved_by != anna_user_id:
            raise HTTPException(status_code=403, detail="request identity mismatch")
        return chat.save_result(run_id, saved_by=request.saved_by).model_dump()

    return router


def _apply_chat_host_failure(
    chat: ChatOrchestrator, run: ChatRun, error_code: str, message: str | None = None
) -> None:
    run.status = "failed"
    run.error_code = error_code
    run.error_message = message or "Harness Host did not complete the Chat task"
    _append_host_audit(chat, run, "harness.task.failed", {"error_code": error_code})
    chat._persist_run(run)


def _apply_chat_host_run(
    chat: ChatOrchestrator, run: ChatRun, host_run: HarnessRun
) -> None:
    result = result_payload(host_run)
    if host_run.status in {"completed", "succeeded"}:
        run.status = "ready"
        answer = result.get("assistant_message")
        if answer is None:
            answer = result.get("answer")
        if isinstance(answer, str):
            run.assistant_message = answer
        artifacts = result.get("artifacts")
        if isinstance(artifacts, list) and all(isinstance(item, dict) for item in artifacts):
            run.artifacts = [dict(item) for item in artifacts]
        plan = result.get("plan")
        if isinstance(plan, list) and all(isinstance(item, dict) for item in plan):
            run.plan = [dict(item) for item in plan]
        _append_host_audit(chat, run, "harness.task.completed", {"surface": "chat"})
    elif host_run.status in {"queued", "running", "resumed"}:
        # A status response is also the progress source for GET/stream races.
        # Never turn a still-live Host run into a local terminal failure.
        run.status = "generating"
    elif host_run.status in {"awaiting_input", "awaiting_approval"}:
        # Chat has one resumable parked state for Host input/approval waits.
        run.status = "awaiting_continue"
        run.error_code = None
        run.error_message = None
        _append_host_audit(
            chat,
            run,
            "harness.task.awaiting_input",
            {"surface": "chat", "host_status": host_run.status},
        )
    elif host_run.status == "cancelled":
        run.status = "interrupted"
        run.error_code = "harness_task_cancelled"
        run.error_message = _host_error_message(host_run) or "Harness Host task was cancelled"
        _append_host_audit(
            chat,
            run,
            "harness.task.cancelled",
            {"surface": "chat"},
        )
    elif host_run.status in {"failed", "timed_out", "exhausted"}:
        _apply_chat_host_failure(
            chat,
            run,
            _host_error_code(host_run) or "harness_task_failed",
            _host_error_message(host_run),
        )
        return
    else:
        _apply_chat_host_failure(
            chat,
            run,
            "harness_unknown_status",
            f"Harness Host returned unsupported Chat status: {host_run.status}",
        )
        return
    chat._persist_run(run)


def _append_host_audit(
    chat: ChatOrchestrator, run: ChatRun, event_type: str, payload: dict
) -> None:
    if any(event.type == event_type for event in run.audit_events):
        return
    chat.audit.append(run.audit_events, event_type, run.id, payload)


def _host_error_code(run: HarnessRun) -> str | None:
    result = run.result or {}
    for key in ("error_code", "code", "error"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _host_error_message(run: HarnessRun) -> str | None:
    result = run.result or {}
    for key in ("error_message", "message", "error"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _host_audit_event(run_id: str, event_type: str, payload: dict) -> dict:
    return AuditEvent(type=event_type, run_id=run_id, payload=payload).model_dump(mode="json")


def _host_event_frame(
    event: dict, tool_names: dict[str, str] | None = None
) -> list[dict]:
    event_type = event.get("type")
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    if event_type in {"run.text.delta", "assistant.text.delta", "text_delta"}:
        text = payload.get("text") or event.get("text")
        if isinstance(text, str):
            return [{"type": "text_delta", "text": text}]
    if event_type in {"omp.tool.dispatch", "run.tool.started", "tool_start"}:
        name = payload.get("tool") or payload.get("name") or event.get("name")
        canonical_name = _host_tool_name(name)
        call_id = payload.get("toolCallId") or payload.get("tool_call_id")
        if canonical_name is not None:
            if tool_names is not None and isinstance(call_id, str) and call_id:
                tool_names[call_id] = canonical_name
            return [{"type": "tool_start", "name": canonical_name}]
    if event_type in {"omp.tool.response", "run.tool.completed", "tool_done"}:
        name = payload.get("tool") or payload.get("name") or event.get("name")
        call_id = payload.get("toolCallId") or payload.get("tool_call_id")
        if not isinstance(name, str) and tool_names is not None and isinstance(call_id, str):
            name = tool_names.get(call_id)
        canonical_name = _host_tool_name(name)
        if canonical_name is not None:
            result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
            status = result.get("status")
            ok = status == "succeeded" if event_type == "omp.tool.response" else True
            frames: list[dict] = []
            if event_type == "omp.tool.response":
                frames.append(
                    {
                        "type": "event",
                        "event": {
                            "type": "mcp.tool.called",
                            "run_id": _host_event_run_id(event),
                            "created_at": _host_event_timestamp(event),
                            "payload": {
                                "tool_name": canonical_name,
                                "status": "success" if ok else "error",
                                "result_status": status or "unknown",
                            },
                        },
                    }
                )
            frames.append({"type": "tool_done", "name": canonical_name, "ok": ok})
            return frames
    if event_type == "omp.transcript.message":
        plan = native_todo_plan([event])
        if plan is not None:
            return [
                {
                    "type": "event",
                    "event": {
                        "type": "plan.updated",
                        "run_id": _host_event_run_id(event),
                        "created_at": _host_event_timestamp(event),
                        "payload": {
                            "count": len(plan),
                            "done_count": sum(item["status"] == "done" for item in plan),
                            "items": plan,
                        },
                    },
                }
            ]
    return [{"type": "event", "event": event}]


def _host_tool_name(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.replace("__", ".")


def _host_event_timestamp(event: dict) -> str | None:
    for key in ("timestamp", "created_at", "ts"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _host_event_run_id(event: dict) -> str:
    for key in ("run_id", "streamId", "stream_id"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _event_seq(event: dict) -> int:
    value = event.get("seq")
    return value if isinstance(value, int) else -1


def _json_sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
