"""Crew worker execution through durable AgentExecution runtime."""
from __future__ import annotations

import asyncio
import threading
import time

import pytest

from services.crew.app.agent_worker import AgentWorkerExecutor, CrewAgentError, CrewRunSkipped
from services.crew.app.execution_projection import CrewExecutionProjector
from services.crew.app.lifecycle import assign_task, instantiate_project, start_task, submit_task
from services.crew.app.service import CrewService
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.execution.kernel import AgentExecutionKernel
from services.runtime.app.execution.models import LoopResult, StartExecution
from services.runtime.app.execution.runtime import AgentExecutionRuntime
from services.runtime.app.execution.store import SQLiteExecutionStore
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class _TextModel(FakeStreamModel):
    def __init__(self, text: str = "# PRD\n- 目标\n- 范围") -> None:
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text, tool_calls=[], finish_reason="stop"
        )


def _executor(*, text: str = "# PRD\n- 目标\n- 范围", settings=_CONFIGURED) -> AgentWorkerExecutor:
    return AgentWorkerExecutor(settings=settings, deps=QueryDeps(stream_model=_TextModel(text)))


def _project_with_prd_ready():
    seq = {"n": 0}

    def task_id(key):
        seq["n"] += 1
        return f"t{seq['n']}_{key}"

    project = instantiate_project(
        project_id="p1",
        workspace_id="ws1",
        owner_user_id="acc_boss",
        goal_text="做一个新功能",
        template=get_template("feature_iteration"),
        task_id=task_id,
    )
    brief = next(t for t in project.tasks if t.key == "brief")
    assign_task(project, brief.id, "acc_boss")
    start_task(project, brief.id)
    submit_task(project, brief.id, "需求")
    prd = next(t for t in project.tasks if t.key == "prd")
    assign_task(project, prd.id, "acc_agent_scribe")
    return project, prd


def _service_project(tmp_path):
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    project = crew.create_project("ws1", "acc_boss", "做一个新功能", "feature_iteration")
    brief = next(t for t in project.tasks if t.key == "brief")
    crew.assign(project.id, brief.id, "acc_boss")
    crew.start(project.id, brief.id)
    crew.submit(project.id, brief.id, "需求")
    prd = next(t for t in crew.get_project(project.id).tasks if t.key == "prd")
    crew.assign(project.id, prd.id, "acc_agent_scribe")
    return crew, project.id, prd.id


def _start(project_id: str, task_id: str) -> StartExecution:
    return StartExecution(
        request_id=f"req:{project_id}:{task_id}",
        workspace_id="ws1",
        conversation_id=f"crew_project:{project_id}",
        channel_id=f"crew_channel:{project_id}",
        subject_ref=f"crew_task:{project_id}:{task_id}",
        trigger_ref="manual:test",
        worker_profile_ref="member:acc_agent_scribe",
        run_profile_ref="crew.query_engine.v1",
        input={
            "project_id": project_id,
            "task_id": task_id,
            "actor": "acc_boss",
            "source_message_id": None,
            "source_instruction": None,
        },
    )


class _ExecutorLoopAdapter:
    def __init__(self, crew_store: SQLiteCrewStore, executor) -> None:
        self._crew_store = crew_store
        self._executor = executor

    async def run(self, snapshot, signals) -> LoopResult:
        project_id = snapshot.input["project_id"]
        task_id = snapshot.input["task_id"]
        project = self._crew_store.get_project(project_id)
        assert project is not None
        try:
            _updated, result = await asyncio.to_thread(
                self._executor.run_task,
                project,
                task_id,
                run_ref=snapshot.execution_id,
            )
        except CrewRunSkipped as exc:
            return LoopResult(
                status="succeeded",
                events=[("execution.frame", {
                    "type": "done",
                    "status": "skipped",
                    "task_id": task_id,
                    "task_status": exc.task_status,
                })],
            )
        except CrewAgentError as exc:
            return LoopResult(
                status="failed",
                events=[("crew.task.agent_blocked", {
                    "project_id": project_id,
                    "task_id": task_id,
                    "reason": str(exc),
                    "memory_hits": list(getattr(exc, "memory_hits", []) or []),
                })],
                last_error_code=getattr(exc, "error_code", None) or "crew_agent_error",
                error_message=str(exc),
            )
        return LoopResult(
            status="succeeded",
            events=[("crew.task.artifact_produced", {
                "project_id": project_id,
                "task_id": task_id,
                "artifact": result.summary,
                "memory_hits": list(getattr(result, "memory_hits", []) or []),
            })],
        )


def _runtime(crew_store: SQLiteCrewStore, execution_store, executor):
    return AgentExecutionRuntime(
        store=execution_store,
        adapter=_ExecutorLoopAdapter(crew_store, executor),
        projector=CrewExecutionProjector(
            crew_store=crew_store,
            execution_store=execution_store,
        ),
        worker_count=1,
        lease_ttl_seconds=1.0,
        heartbeat_interval_seconds=0.1,
        idle_poll_seconds=0.02,
        projector_poll_seconds=0.02,
    )


async def _until(predicate, *, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("predicate did not become true")


def test_run_task_produces_from_engine_final_and_writes_run_ref():
    project, prd = _project_with_prd_ready()
    updated, result = _executor().run_task(project, prd.id, run_ref="exec_007")

    submitted = next(t for t in updated.tasks if t.id == prd.id)
    assert submitted.status == "submitted"
    assert submitted.artifact == "# PRD\n- 目标\n- 范围"
    assert submitted.run_ref == "exec_007"
    assert result.status == "completed"
    assert next(t for t in updated.tasks if t.key == "prd_review").status == "todo"


def test_run_task_rejects_gate_task():
    project, _ = _project_with_prd_ready()
    review = next(t for t in project.tasks if t.key == "prd_review")
    with pytest.raises(CrewAgentError):
        _executor().run_task(project, review.id)


def test_run_task_blocks_task_on_model_failure_never_fakes_completion():
    project, prd = _project_with_prd_ready()
    with pytest.raises(CrewAgentError):
        _executor(settings=RuntimeSettings()).run_task(project, prd.id, run_ref="exec_009")
    blocked = next(t for t in project.tasks if t.id == prd.id)
    assert blocked.status == "blocked"
    assert blocked.blocker
    assert blocked.artifact is None


def test_run_task_blocks_on_empty_deliverable():
    project, prd = _project_with_prd_ready()
    with pytest.raises(CrewAgentError):
        _executor(text="   ").run_task(project, prd.id)
    assert next(t for t in project.tasks if t.id == prd.id).status == "blocked"


class _CapturingExecutor(AgentWorkerExecutor):
    started_at_during_run: str | None = "UNSET"

    def _produce(self, project, task, consensus):
        self.started_at_during_run = task.run_started_at
        return super()._produce(project, task, consensus)


def test_run_started_at_set_while_running_and_cleared_on_submit():
    project, prd = _project_with_prd_ready()
    ex = _CapturingExecutor(settings=_CONFIGURED, deps=QueryDeps(stream_model=_TextModel()))

    updated, _result = ex.run_task(project, prd.id, run_ref="exec_007")

    assert ex.started_at_during_run and ex.started_at_during_run != "UNSET"
    submitted = next(t for t in updated.tasks if t.id == prd.id)
    assert submitted.status == "submitted"
    assert submitted.run_started_at is None


def test_run_started_at_cleared_when_run_blocks():
    project, prd = _project_with_prd_ready()
    ex = _CapturingExecutor(settings=RuntimeSettings())

    with pytest.raises(CrewAgentError):
        ex.run_task(project, prd.id, run_ref="exec_009")

    assert ex.started_at_during_run and ex.started_at_during_run != "UNSET"
    blocked = next(t for t in project.tasks if t.id == prd.id)
    assert blocked.status == "blocked"
    assert blocked.run_started_at is None


def test_runtime_active_execution_drives_run_inflight_source(tmp_path):
    crew, project_id, prd_id = _service_project(tmp_path)
    execution_store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            release.wait(timeout=5)
            raise CrewAgentError("parked then blocked", frames=[], memory_hits=[])

    asyncio.run(AgentExecutionKernel(execution_store).dispatch(_start(project_id, prd_id)))
    runtime = _runtime(crew._store, execution_store, _ParkingExecutor())

    async def _run():
        await runtime.start()
        try:
            await _until(lambda: bool(execution_store.list_active(workspace_id="ws1")))
            active = execution_store.list_active(workspace_id="ws1")
            assert active[0].subject_ref.endswith(prd_id)
            release.set()
            await _until(lambda: not execution_store.list_active(workspace_id="ws1"))
        finally:
            await runtime.stop()

    asyncio.run(_run())


def test_runtime_projector_emits_artifact_channel_row(tmp_path):
    crew, project_id, prd_id = _service_project(tmp_path)
    execution_store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    started = asyncio.run(AgentExecutionKernel(execution_store).dispatch(_start(project_id, prd_id)))
    runtime = _runtime(crew._store, execution_store, _executor())

    async def _run():
        await runtime.start()
        try:
            await _until(lambda: next(
                t for t in crew.get_project(project_id).tasks if t.id == prd_id
            ).status == "submitted")
        finally:
            await runtime.stop()

    asyncio.run(_run())
    prd = next(t for t in crew.get_project(project_id).tasks if t.id == prd_id)
    assert prd.artifact == "# PRD\n- 目标\n- 范围"
    assert prd.run_ref == started.execution_id
    assert any(
        message.kind == "artifact" and message.run_ref == started.execution_id
        for message in crew.list_channel(project_id)
    )


def test_runtime_failure_blocks_task_and_emits_channel_block_row(tmp_path):
    crew, project_id, prd_id = _service_project(tmp_path)
    execution_store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    started = asyncio.run(AgentExecutionKernel(execution_store).dispatch(_start(project_id, prd_id)))
    runtime = _runtime(crew._store, execution_store, _executor(settings=RuntimeSettings()))

    async def _run():
        await runtime.start()
        try:
            await _until(lambda: next(
                t for t in crew.get_project(project_id).tasks if t.id == prd_id
            ).status == "blocked")
        finally:
            await runtime.stop()

    asyncio.run(_run())
    prd = next(t for t in crew.get_project(project_id).tasks if t.id == prd_id)
    assert prd.status == "blocked"
    assert prd.blocker
    assert prd.artifact is None
    assert any(
        message.kind == "event" and "受阻" in message.body and message.run_ref == started.execution_id
        for message in crew.list_channel(project_id)
    )
