from __future__ import annotations

import asyncio
import contextlib
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes import auth as auth_routes
from services.api.app.routes import crew as crew_routes
from services.crew.app.agent_worker import AgentWorkerExecutor, CrewAgentError, CrewRunSkipped
from services.crew.app.execution_projection import CrewExecutionProjector
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore
from services.memory.app.store import BusinessMemoryStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.execution.kernel import AgentExecutionKernel
from services.runtime.app.execution import TerminalStateError
from services.runtime.app.execution.models import ExecutionEvent, LoopResult, SignalExecution
from services.runtime.app.execution.runtime import AgentExecutionRuntime
from services.runtime.app.execution.store import SQLiteExecutionStore
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class _TextModel(FakeStreamModel):
    """Governed fake returning a fixed deliverable from the engine's final turn."""

    def __init__(self, text="# PRD\n- 目标\n- 范围"):
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text, tool_calls=[], finish_reason="stop"
        )


def _engine_executor(text="# PRD\n- 目标\n- 范围", *, settings=_CONFIGURED):
    return AgentWorkerExecutor(settings=settings, deps=QueryDeps(stream_model=_TextModel(text)))


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
                events=[
                    (
                        "execution.frame",
                        {
                            "type": "done",
                            "status": "skipped",
                            "task_id": task_id,
                            "task_status": exc.task_status,
                        },
                    )
                ],
            )
        except CrewAgentError as exc:
            return LoopResult(
                status="failed",
                events=[
                    (
                        "crew.task.agent_blocked",
                        {
                            "project_id": project_id,
                            "task_id": task_id,
                            "reason": str(exc),
                            "memory_hits": list(getattr(exc, "memory_hits", []) or []),
                        },
                    )
                ],
                last_error_code=getattr(exc, "error_code", None) or "crew_agent_error",
                error_message=str(exc),
            )
        return LoopResult(
            status="succeeded",
            events=[
                (
                    "crew.task.artifact_produced",
                    {
                        "project_id": project_id,
                        "task_id": task_id,
                        "artifact": result.summary,
                        "memory_hits": list(getattr(result, "memory_hits", []) or []),
                    },
                )
            ],
        )


class _QuestionAnswerLoopAdapter:
    async def run(self, snapshot, signals) -> LoopResult:
        project_id = snapshot.input["project_id"]
        task_id = snapshot.input["task_id"]
        answer = next((signal for signal in signals if signal.kind == "answer"), None)
        if answer is None:
            return LoopResult(
                status="awaiting_signal",
                checkpoint={
                    "kind": "crew.worker.awaiting_input.v1",
                    "question": "目标用户是哪一类?",
                    "target": "acc_boss",
                    "messages": [{"role": "assistant", "content": "need input"}],
                    "tool_call_id": "call_ask_1",
                },
                events=[
                    (
                        "crew.worker.question",
                        {
                            "project_id": project_id,
                            "task_id": task_id,
                            "reason": "awaiting_input",
                            "question": "目标用户是哪一类?",
                            "target": "acc_boss",
                            "tool": "crew.ask_human",
                            "tool_call_id": "call_ask_1",
                        },
                    )
                ],
            )
        text = answer.payload.get("text") or ""
        return LoopResult(
            status="succeeded",
            events=[
                (
                    "crew.task.artifact_produced",
                    {
                        "project_id": project_id,
                        "task_id": task_id,
                        "artifact": f"已按人工回答补充:{text}",
                    },
                )
            ],
            applied_signal_ids=[answer.signal_id],
        )


def _poll_task_status(client, auth, pid, task_id, *, deadline_s=3.0):
    """Poll GET project until the task leaves 'running'/'assigned' (drives the loop)."""
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
        status = _task_by_id(project, task_id)["status"]
        if status not in ("running", "assigned"):
            return project
        time.sleep(0.02)
    return client.get(f"/api/crew/projects/{pid}", headers=auth).json()


def _poll_run_frames(client, auth, run_ref, *, deadline_s=3.0):
    """Poll GET frames until the run has a terminal frame (drives the loop).

    The task's crew-store status settles INSIDE the worker thread, before the
    driver journals the terminal frame back on the loop — so a frames read must
    wait for the terminal, not just the task status."""
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        frames = client.get(f"/api/crew/runs/{run_ref}/frames", headers=auth).json()["frames"]
        if frames and frames[-1]["type"] in ("done", "error"):
            return frames
        time.sleep(0.02)
    return client.get(f"/api/crew/runs/{run_ref}/frames", headers=auth).json()["frames"]


def _task_by_id(project, task_id):
    return next(t for t in project["tasks"] if t["id"] == task_id)


def test_execution_result_deferred_maps_to_queued_frame():
    frames = crew_routes._events_to_frames(
        [
            ExecutionEvent(
                execution_id="exec_1",
                seq=7,
                type="execution.result_deferred",
                payload={"reason": "late_signal", "deferred_status": "succeeded"},
                created_at=1.0,
            )
        ]
    )

    assert frames == [
        {
            "type": "event",
            "event": {
                "type": "run.queued",
                "run_ref": "exec_1",
                "reason": "late_signal",
                "deferred_status": "succeeded",
            },
            "seq": 7,
        }
    ]


def test_retry_and_recovery_execution_events_map_to_legacy_frames():
    frames = crew_routes._events_to_frames(
        [
            ExecutionEvent(
                execution_id="exec_retry",
                seq=1,
                type="execution.retry_scheduled",
                payload={
                    "reason": "model_error",
                    "attempt": 1,
                    "max_attempts": 3,
                    "not_before": 123.0,
                },
                created_at=1.0,
            ),
            ExecutionEvent(
                execution_id="exec_dead",
                seq=2,
                type="execution.dead_lettered",
                payload={
                    "reason": "attempt_limit",
                    "message": "too many failures",
                    "attempt": 3,
                    "max_attempts": 3,
                },
                created_at=2.0,
            ),
            ExecutionEvent(
                execution_id="exec_recovery",
                seq=3,
                type="execution.recovery_blocked",
                payload={
                    "reason": "effect_outcome_unknown",
                    "manual_recovery_required": True,
                },
                created_at=3.0,
            ),
        ]
    )

    assert frames[0]["event"]["type"] == "run.queued"
    assert frames[0]["event"]["reason"] == "retry_scheduled"
    assert frames[1]["run"]["status"] == "dead_lettered"
    assert frames[1]["run"]["error"] == "too many failures"
    assert frames[2]["run"]["status"] == "recovery_blocked"
    assert frames[2]["run"]["manual_recovery_required"] is True


def _crew_app(
    tmp_path,
    executor=None,
    *,
    run_store=False,
    auto_pilot=False,
    loop_adapter=None,
):
    """A crew+auth app backed by durable AgentExecution runtime."""
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew_store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    crew = CrewService(crew_store)
    execution_store = SQLiteExecutionStore(tmp_path / "executions.sqlite3")
    adapter = loop_adapter or _ExecutorLoopAdapter(
        crew_store,
        executor or AgentWorkerExecutor(settings=RuntimeSettings()),
    )
    projector = CrewExecutionProjector(
        crew_store=crew_store,
        execution_store=execution_store,
    )
    runtime = AgentExecutionRuntime(
        store=execution_store,
        adapter=adapter,
        projector=projector,
        worker_count=1,
        lease_ttl_seconds=1.0,
        heartbeat_interval_seconds=0.1,
        idle_poll_seconds=0.02,
        projector_poll_seconds=0.02,
    )
    kernel = AgentExecutionKernel(execution_store)
    app = FastAPI()
    app.state.crew_service = crew
    app.state.crew_store = crew_store
    app.state.execution_store = execution_store
    app.state.execution_kernel = kernel
    app.state.execution_runtime = runtime
    app.include_router(auth_routes.build_router(identity))
    app.include_router(
        crew_routes.build_router(
            crew,
            identity,
            None,
            execution_kernel=kernel,
            execution_store=execution_store,
            execution_runtime=runtime,
            settings=_CONFIGURED,
            auto_pilot=auto_pilot,
        )
    )

    @app.on_event("startup")
    async def _startup() -> None:
        await runtime.start()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await runtime.stop()
        execution_store.close()

    return app


def _login(client):
    token = client.post(
        "/api/auth/login", json={"email": "boss@anna.demo", "password": "crew-demo"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _project_with_prd_assigned(client, auth):
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    brief, prd = _task(project, "brief"), _task(project, "prd")

    def post(path, **body):
        r = client.post(f"/api/crew/projects/{pid}/{path}", json=body or None, headers=auth)
        assert r.status_code == 200, r.text
        return r.json()

    post(f"tasks/{brief['id']}/assign", member_id="acc_boss")
    post(f"tasks/{brief['id']}/start")
    post(f"tasks/{brief['id']}/submit", artifact="需求")
    post(f"tasks/{prd['id']}/assign", member_id="acc_agent_scribe")
    return pid, prd["id"]


def _client(tmp_path):
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(crew, identity))
    client = TestClient(app)
    token = client.post("/api/auth/login",
                        json={"email": "boss@anna.demo", "password": "crew-demo"}).json()["token"]
    return client, {"Authorization": f"Bearer {token}"}


def _task(project, key):
    return next(t for t in project["tasks"] if t["key"] == key)


def test_templates_listed(tmp_path):
    client, auth = _client(tmp_path)
    ids = {t["id"] for t in client.get("/api/crew/templates").json()["templates"]}
    assert ids == {"feature_iteration", "marketing_collateral"}


def test_showcase_endpoint_requires_explicit_ensure_and_marks_demo_project(tmp_path):
    client, auth = _client(tmp_path)

    assert client.post("/api/crew/showcase", headers=auth).status_code == 404

    first = client.post("/api/crew/showcase/ensure", json={}, headers=auth)
    assert first.status_code == 200, first.text
    payload = first.json()
    project = payload["project"]
    assert payload["created"] is True
    assert payload["scenario_id"] == "weekly_action_closure_v1"
    assert payload["scenario_version"] == 3
    assert payload["migrated"] is False
    assert payload["warnings"] == []
    assert project["source"] == "showcase"
    assert project["showcase"]["scenario_id"] == "weekly_action_closure_v1"
    assert project["showcase"]["version"] == 3
    assert project["sop_template_id"] == "feature_iteration"
    assert any(t["title"] == "行动项清单" for t in project["tasks"])
    assert any(
        t["title"] == "纪要发布评审" and t["status"] == "todo"
        for t in project["tasks"]
    )
    assert any(
        t["title"] == "同步到看板与群公告" and t["status"] == "blocked"
        for t in project["tasks"]
    )

    second = client.post("/api/crew/showcase/ensure", json={}, headers=auth)
    assert second.status_code == 200, second.text
    assert second.json()["created"] is False
    assert second.json()["project"]["id"] == project["id"]

    channel = client.get(f"/api/crew/projects/{project['id']}/channel", headers=auth).json()
    assert len(channel["messages"]) == 10
    assert all(m["author_kind"] == "anna" for m in channel["messages"])
    assert all(m["run_ref"] is None for m in channel["messages"])
    assert all(m.get("worker_profile_ref") is None for m in channel["messages"])
    assert all(m.get("caused_by_execution_id") is None for m in channel["messages"])
    assert all(m["payload"]["source"] == "showcase" for m in channel["messages"])
    assert any("周会行动项闭环案例" in m["body"] for m in channel["messages"])
    assert client.get("/api/crew/notifications", headers=auth).json()["notifications"] == []
    assert client.post("/api/crew/showcase/reset", headers=auth).status_code == 404


def test_showcase_endpoint_rejects_unknown_scenario(tmp_path):
    client, auth = _client(tmp_path)

    r = client.post(
        "/api/crew/showcase/ensure",
        json={"scenario_id": "unknown"},
        headers=auth,
    )

    assert r.status_code == 400
    assert "unknown showcase scenario" in r.text
    assert client.get("/api/crew/projects", headers=auth).json()["projects"] == []


def test_decompose_endpoint_falls_back_to_template_without_model(tmp_path):
    client, auth = _client(tmp_path)  # default decomposer; no model configured -> fallback
    assert client.post("/api/crew/projects/decompose",
                       json={"goal_text": "g", "sop_template_id": "feature_iteration"}).status_code == 401
    r = client.post("/api/crew/projects/decompose",
                    json={"goal_text": "做个新功能", "sop_template_id": "feature_iteration"},
                    headers=auth)
    assert r.status_code == 200
    keys = {t["key"] for t in r.json()["tasks"]}
    assert keys == {
        "brief", "prd", "prd_review", "design", "tech_research",
        "design_review", "build", "code_review", "accept",
    }


def test_run_agent_backgrounds_and_blocks_when_model_unconfigured(tmp_path):
    # Default executor: no model configured -> the Worker Profile fails -> the task
    # BLOCKS (绝不假完成). run-agent now returns {run_ref} immediately (background).
    with TestClient(_crew_app(tmp_path, run_store=True)) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)
        r = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth)
        assert r.status_code == 200, r.text
        assert set(r.json()) == {"run_ref", "task_id", "status"}
        assert r.json()["status"] in {"queued", "running"}

        project = _poll_task_status(client, auth, pid, prd_id)
        prd = _task_by_id(project, prd_id)
        assert prd["status"] == "blocked"
        assert prd["blocker"]
        assert prd["artifact"] is None


def test_run_agent_success_with_injected_executor(tmp_path):
    with TestClient(_crew_app(tmp_path, _engine_executor(), run_store=True)) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)
        submitted = client.post(
            f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth
        )
        assert submitted.status_code == 200, submitted.text
        run_ref = submitted.json()["run_ref"]

        body = _poll_run_frames(client, auth, run_ref)
        assert body and body[-1]["type"] == "done"

        project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
        assert _task(project, "prd")["status"] == "submitted"  # 待审 (the run itself is done)
        assert _task(project, "prd")["artifact"] == "# PRD\n- 目标\n- 范围"
        assert _task(project, "prd")["run_ref"] == run_ref
        assert _task(project, "prd_review")["status"] == "todo"  # gate unblocked by agent's submit

        # Cross-workspace / unknown runs are 404.
        assert client.get("/api/crew/runs/crew_run_999/frames", headers=auth).status_code == 404


def test_get_project_annotates_run_inflight(tmp_path):
    """C1:GET project annotates each task with a transient ``run_inflight`` — false
    in steady state, true while an agent run is actually in flight (observed here by
    parking the worker between two polls). ``run_started_at`` rides the schema."""
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            from services.crew.app.agent_worker import CrewAgentError
            release.wait(timeout=5)
            raise CrewAgentError("parked then blocked", frames=[], memory_hits=[])

    with TestClient(_crew_app(tmp_path, _ParkingExecutor(), run_store=True)) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        # Steady state: annotation present, false; run_started_at present, null.
        project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
        assert _task_by_id(project, prd_id)["run_inflight"] is False
        assert _task_by_id(project, prd_id)["run_started_at"] is None

        r = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth)
        assert r.status_code == 200, r.text

        # The run parks in its worker thread → run_inflight flips true between polls.
        end = time.monotonic() + 3.0
        seen_inflight = False
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            if _task_by_id(project, prd_id)["run_inflight"]:
                seen_inflight = True
                break
            time.sleep(0.02)
        assert seen_inflight, "run_inflight should be true while the agent run is in flight"

        release.set()
        # After the terminal, the annotation settles back to false.
        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            if not _task_by_id(project, prd_id)["run_inflight"]:
                break
            time.sleep(0.02)
        assert _task_by_id(project, prd_id)["run_inflight"] is False


def test_assign_agent_auto_runs_under_auto_pilot(tmp_path):
    """R-B #1:auto_pilot 下把 agent 派给就绪任务 → 自动后台跑(无需点「执行」)。"""
    with TestClient(
        _crew_app(tmp_path, _engine_executor(), run_store=True, auto_pilot=True)
    ) as client:
        auth = _login(client)
        # The final step of the fixture assigns PRD to Agent·Scribe — with
        # auto-pilot that assign alone dispatches the run.
        pid, prd_id = _project_with_prd_assigned(client, auth)

        project = _poll_task_status(client, auth, pid, prd_id)
        prd = _task_by_id(project, prd_id)
        assert prd["status"] == "submitted"                 # produced + 待审
        assert prd["artifact"] == "# PRD\n- 目标\n- 范围"
        assert prd["run_ref"]                               # linked to its run


def test_approve_auto_advances_and_runs_agent_over_http(tmp_path):
    """R-B #3:评审门通过 → 下游按角色自动指派;agent 自动跑、人类只指派待办。"""
    with TestClient(
        _crew_app(tmp_path, _engine_executor("# 交付物"), run_store=True, auto_pilot=True)
    ) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)
        _poll_task_status(client, auth, pid, prd_id)         # prd auto-ran → submitted

        project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
        prd_review = _task(project, "prd_review")
        approved = client.post(
            f"/api/crew/projects/{pid}/tasks/{prd_review['id']}/review",
            json={"approved": True}, headers=auth,
        )
        assert approved.status_code == 200, approved.text

        # 设计稿(设计→Agent·Design)自动指派并自动跑;技术预研(工程→Andy 人类)只指派。
        advanced = approved.json()
        design = _task(advanced, "design")
        tech = _task(advanced, "tech_research")
        assert design["assignee_member_id"] == "acc_agent_design"
        assert tech["assignee_member_id"] == "acc_andy"
        assert tech["status"] == "assigned"                  # human waits (not auto-run)

        design_done = _task_by_id(
            _poll_task_status(client, auth, pid, design["id"]), design["id"]
        )
        assert design_done["status"] == "submitted"          # agent auto-ran
        assert design_done["run_ref"]


def test_run_agent_submit_dedupes_in_flight_run(tmp_path):
    """终审 #4:同一任务在飞时二次 submit → 同一 run_ref,executor 只跑一次。

    事件门控的 executor 把首个 run 停在飞行中;第二次 submit 必须返回既有 run_ref
    (幂等 200)而非再起一跑。"""
    release = threading.Event()
    calls = {"n": 0}

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            calls["n"] += 1
            release.wait(timeout=5)
            raise CrewAgentError("parked then blocked", frames=[], memory_hits=[])

    with TestClient(_crew_app(tmp_path, _ParkingExecutor(), run_store=True)) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)
        first = client.post(
            f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth
        )
        assert first.status_code == 200, first.text
        first_ref = first.json()["run_ref"]
        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            if _task_by_id(project, prd_id)["run_inflight"]:
                break
            time.sleep(0.02)
        second = client.post(
            f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth
        )
        assert second.status_code == 200, second.text
        assert second.json()["run_ref"] == first_ref
        release.set()
        _poll_task_status(client, auth, pid, prd_id)
    assert calls["n"] == 1  # single execution


def test_run_agent_task_not_found_is_404(tmp_path):
    client, auth = _client(tmp_path)
    pid, _ = _project_with_prd_assigned(client, auth)
    r = client.post(f"/api/crew/projects/{pid}/tasks/nope/run-agent", headers=auth)
    assert r.status_code == 404


# --- C2 · 友好守卫 (409 + machine-readable code, no misleading events) ---------


def _advance_prd_to_submitted_http(client, auth, pid, prd_id):
    assert client.post(
        f"/api/crew/projects/{pid}/tasks/{prd_id}/start", headers=auth
    ).status_code == 200
    assert client.post(
        f"/api/crew/projects/{pid}/tasks/{prd_id}/submit",
        json={"artifact": "PRD v1"}, headers=auth,
    ).status_code == 200


def test_start_conflict_returns_409_task_not_startable(tmp_path):
    """C2:clicking「开始」on a task Anna已推进到待审 → friendly 409, not a bare 400."""
    client, auth = _client(tmp_path)
    pid, prd_id = _project_with_prd_assigned(client, auth)
    _advance_prd_to_submitted_http(client, auth, pid, prd_id)

    r = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/start", headers=auth)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "task_not_startable"
    assert detail["task_status"] == "submitted"
    assert detail["detail"]  # a human sentence, not a bare lifecycle string


def test_run_agent_on_submitted_returns_409_and_emits_no_channel_event(tmp_path):
    """C2:run-agent on an已推进 task → sync 409 (task_not_runnable) with NO
    misleading「执行受阻」channel event (that alarm is for true failures only)."""
    client, auth = _client(tmp_path)
    pid, prd_id = _project_with_prd_assigned(client, auth)
    _advance_prd_to_submitted_http(client, auth, pid, prd_id)

    before = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]
    r = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "task_not_runnable"
    assert detail["task_status"] == "submitted"
    after = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]
    assert len(after) == len(before)  # no new channel row


def test_run_agent_on_human_assigned_task_is_409(tmp_path):
    """C2:run-agent only runs AGENT-assigned tasks — a human assignee → 409."""
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    brief = _task(project, "brief")
    client.post(f"/api/crew/projects/{pid}/tasks/{brief['id']}/assign",
                json={"member_id": "acc_boss"}, headers=auth)  # human

    r = client.post(f"/api/crew/projects/{pid}/tasks/{brief['id']}/run-agent", headers=auth)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "task_not_runnable"


def test_gate_start_and_submit_are_409_task_is_gate(tmp_path):
    """可用性收束:评审门永不「开始」也不「提交」——真机事故里门曾被
    认领→开始→撞英文提交守卫一路误导;现在两端点都给中文 409 task_is_gate。"""
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    gate = next(t for t in project["tasks"] if t["is_gate"])

    r_start = client.post(f"/api/crew/projects/{pid}/tasks/{gate['id']}/start", headers=auth)
    assert r_start.status_code == 409
    d = r_start.json()["detail"]
    assert d["code"] == "task_is_gate"
    assert "评审" in d["detail"]

    r_submit = client.post(
        f"/api/crew/projects/{pid}/tasks/{gate['id']}/submit",
        json={"artifact": "不该提交的东西"}, headers=auth,
    )
    assert r_submit.status_code == 409
    assert r_submit.json()["detail"]["code"] == "task_is_gate"


# --- 接管/改派 (reassign an unstarted task; friendly 409 once it is under way) --


def test_reassign_assigned_task_human_to_human_over_http(tmp_path):
    """认领一个已 assigned(未开工)的任务 → 接管成功 200:受派人被替换,频道留痕。

    真机事故的正解:Boss 点认领 Andy 已被自动指派的任务,不再撞英文 400。"""
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    brief = _task(project, "brief")
    assert client.post(f"/api/crew/projects/{pid}/tasks/{brief['id']}/assign",
                       json={"member_id": "acc_andy"}, headers=auth).status_code == 200

    r = client.post(f"/api/crew/projects/{pid}/tasks/{brief['id']}/assign",
                    json={"member_id": "acc_boss"}, headers=auth)   # 接管
    assert r.status_code == 200, r.text
    reassigned = _task(r.json(), "brief")
    assert reassigned["assignee_member_id"] == "acc_boss"
    assert reassigned["status"] == "assigned"               # 未开工,仍 assigned

    ch = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]
    assert any("改派给" in m["body"] and "原" in m["body"] for m in ch)


def test_assign_running_task_returns_409_not_assignable(tmp_path):
    """任务已在执行,再点认领 → 友好 409 task_not_assignable(引导频道协调),非静默夺权。"""
    client, auth = _client(tmp_path)
    pid, prd_id = _project_with_prd_assigned(client, auth)
    assert client.post(
        f"/api/crew/projects/{pid}/tasks/{prd_id}/start", headers=auth
    ).status_code == 200                                    # assigned → running

    r = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/assign",
                    json={"member_id": "acc_andy"}, headers=auth)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "task_not_assignable"
    assert detail["task_status"] == "running"
    assert detail["detail"]                                 # a human sentence, not bare 400


def test_assign_gate_task_returns_409_task_is_gate(tmp_path):
    """评审门永不指派——评审人固定为负责人;点认领门 → 409 task_is_gate。"""
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    gate = next(t for t in project["tasks"] if t["is_gate"])

    r = client.post(f"/api/crew/projects/{pid}/tasks/{gate['id']}/assign",
                    json={"member_id": "acc_boss"}, headers=auth)
    assert r.status_code == 409
    d = r.json()["detail"]
    assert d["code"] == "task_is_gate"
    assert "评审" in d["detail"]


def test_assign_missing_task_returns_404(tmp_path):
    """认领一个不存在的任务 → 404(pre-check 顺序:missing 先于 gate/status 判定)。"""
    client, auth = _client(tmp_path)
    pid, _ = _project_with_prd_assigned(client, auth)
    r = client.post(f"/api/crew/projects/{pid}/tasks/nope/assign",
                    json={"member_id": "acc_boss"}, headers=auth)
    assert r.status_code == 404


def test_run_agent_dedup_over_http_returns_200_same_ref(tmp_path):
    """C2:a second run-agent while the first is in flight → 200 with the existing
    run_ref (idempotent replay), NOT a 409 — the in-flight check precedes the
    runnable check even though a running task is not in (assigned, rework)."""
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            from services.crew.app.agent_worker import CrewAgentError
            release.wait(timeout=5)
            raise CrewAgentError("parked", frames=[], memory_hits=[])

    with TestClient(_crew_app(tmp_path, _ParkingExecutor(), run_store=True)) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        r1 = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth)
        assert r1.status_code == 200, r1.text
        ref1 = r1.json()["run_ref"]

        # Wait until the run is actually parked (in flight) so #2 hits dedup.
        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            if _task_by_id(project, prd_id)["run_inflight"]:
                break
            time.sleep(0.02)

        r2 = client.post(f"/api/crew/projects/{pid}/tasks/{prd_id}/run-agent", headers=auth)
        assert r2.status_code == 200, r2.text
        assert r2.json()["run_ref"] == ref1  # same run, idempotent

        release.set()


def test_channel_say_at_active_agent_sends_durable_steer_signal(tmp_path):
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            release.wait(timeout=5)
            raise CrewAgentError("parked", frames=[], memory_hits=[])

    app = _crew_app(tmp_path, _ParkingExecutor(), run_store=True, auto_pilot=True)
    with TestClient(app) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            active = app.state.execution_store.list_active(
                workspace_id=project["workspace_id"],
                subject_ref_prefix=f"crew_task:{pid}:{prd_id}",
            )
            if (
                active
                and _task_by_id(project, prd_id)["run_inflight"]
                and any(
                    event.get("type") == "crew.task.execution_claimed"
                    and event.get("payload", {}).get("task_id") == prd_id
                    and event.get("payload", {}).get("run_ref")
                    == active[0].execution_id
                    for event in project.get("audit_events", [])
                )
            ):
                break
            time.sleep(0.02)
        else:
            raise AssertionError("run did not become active")
        assert len(active) == 1
        run_ref = active[0].execution_id

        say = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={
                "body": "@Scribe 先补充失败态和重试策略",
                "mentions": ["acc_agent_scribe"],
            },
            headers=auth,
        )
        assert say.status_code == 200, say.text
        message = say.json()

        signals = app.state.execution_store.fetch_pending_signals(run_ref)
        assert len(signals) == 1
        assert signals[0].kind == "steer"
        assert signals[0].payload == {
            "text": "@Scribe 先补充失败态和重试策略",
            "source_message_id": message["id"],
            "actor": "acc_boss",
        }

        project = app.state.crew_store.get_project(pid)
        assert project is not None
        original_version = project.project_version
        app.state.crew_store.save_project(project)
        assert app.state.crew_store.get_project(pid).project_version > original_version

        app.state.crew_service._agent_dispatcher(
            pid,
            prd_id,
            project.workspace_id,
            "acc_boss",
            message["id"],
            message["body"],
        )
        assert len(app.state.execution_store.fetch_pending_signals(run_ref)) == 1
        release.set()


def test_channel_say_at_worker_waiting_for_input_sends_answer_and_resumes(tmp_path):
    app = _crew_app(
        tmp_path,
        run_store=True,
        auto_pilot=True,
        loop_adapter=_QuestionAnswerLoopAdapter(),
    )
    with TestClient(app) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        end = time.monotonic() + 3.0
        run_ref = None
        question = None
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            active = app.state.execution_store.list_active(
                workspace_id=project["workspace_id"],
                subject_ref_prefix=f"crew_task:{pid}:{prd_id}",
            )
            channel = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()
            worker_questions = [
                msg
                for msg in channel["messages"]
                if msg["author_kind"] == "worker" and msg["kind"] == "say"
            ]
            if active and active[0].status == "awaiting_signal" and worker_questions:
                run_ref = active[0].execution_id
                question = worker_questions[-1]
                break
            time.sleep(0.02)
        else:
            raise AssertionError("worker question did not become visible")

        assert run_ref is not None
        assert question is not None
        assert question["body"] == "目标用户是哪一类?"
        assert question["mentions"] == ["acc_boss"]
        assert question["worker_profile_ref"] == "member:acc_agent_scribe"
        assert question["caused_by_execution_id"] == run_ref
        running = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
        assert _task_by_id(running, prd_id)["status"] == "running"

        answer = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={
                "body": "@Scribe 面向新注册用户",
                "mentions": ["acc_agent_scribe"],
            },
            headers=auth,
        )
        assert answer.status_code == 200, answer.text
        answer_message = answer.json()
        assert answer_message["author_kind"] == "member"

        end = time.monotonic() + 3.0
        final_project = None
        while time.monotonic() < end:
            final_project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            if _task_by_id(final_project, prd_id)["status"] == "submitted":
                break
            time.sleep(0.02)
        else:
            raise AssertionError("answer signal did not resume worker")

        signals = app.state.execution_store.fetch_pending_signals(run_ref)
        assert signals == []
        task = _task_by_id(final_project, prd_id)
        assert task["artifact"] == "已按人工回答补充:@Scribe 面向新注册用户"


def test_channel_say_terminal_signal_race_keeps_message_and_does_not_500(
    tmp_path,
    monkeypatch,
):
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            release.wait(timeout=5)
            raise CrewAgentError("parked", frames=[], memory_hits=[])

    app = _crew_app(tmp_path, _ParkingExecutor(), run_store=True, auto_pilot=True)
    with TestClient(app) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        end = time.monotonic() + 3.0
        run_ref = None
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            active = app.state.execution_store.list_active(
                workspace_id=project["workspace_id"],
                subject_ref_prefix=f"crew_task:{pid}:{prd_id}",
            )
            if (
                active
                and _task_by_id(project, prd_id)["run_inflight"]
                and any(
                    event.get("type") == "crew.task.execution_claimed"
                    and event.get("payload", {}).get("task_id") == prd_id
                    and event.get("payload", {}).get("run_ref")
                    == active[0].execution_id
                    for event in project.get("audit_events", [])
                )
            ):
                run_ref = active[0].execution_id
                break
            time.sleep(0.02)
        else:
            raise AssertionError("run did not become active")

        original_dispatch = app.state.execution_store.dispatch

        def dispatch_with_terminal_signal_race(command, *, max_queue_depth=1000):
            if isinstance(command, SignalExecution):
                raise TerminalStateError(command.execution_id)
            return original_dispatch(command, max_queue_depth=max_queue_depth)

        monkeypatch.setattr(app.state.execution_store, "dispatch", dispatch_with_terminal_signal_race)

        say = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={
                "body": "@Scribe 这条消息落库后执行刚好结束",
                "mentions": ["acc_agent_scribe"],
            },
            headers=auth,
        )
        assert say.status_code == 200, say.text
        message = say.json()
        assert message["body"] == "@Scribe 这条消息落库后执行刚好结束"
        assert app.state.execution_store.fetch_pending_signals(run_ref) == []
        channel = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()
        assert channel["messages"][-1]["id"] == message["id"]
        release.set()


def test_source_message_start_execution_is_stable_across_project_versions(tmp_path):
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            release.wait(timeout=5)
            raise CrewAgentError("parked", frames=[], memory_hits=[])

    app = _crew_app(tmp_path, _ParkingExecutor(), run_store=True, auto_pilot=True)
    with TestClient(app) as client:
        auth = _login(client)
        pid = client.post(
            "/api/crew/projects",
            json={"goal_text": "g", "sop_template_id": "feature_iteration"},
            headers=auth,
        ).json()["id"]
        project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
        brief, prd = _task(project, "brief"), _task(project, "prd")

        def post(path, **body):
            r = client.post(
                f"/api/crew/projects/{pid}/{path}",
                json=body or None,
                headers=auth,
            )
            assert r.status_code == 200, r.text
            return r.json()

        post(f"tasks/{brief['id']}/assign", member_id="acc_boss")
        post(f"tasks/{brief['id']}/start")
        post(f"tasks/{brief['id']}/submit", artifact="需求")

        stored = app.state.crew_store.get_project(pid)
        assert stored is not None
        prd_task = next(task for task in stored.tasks if task.id == prd["id"])
        prd_task.assignee_member_id = "acc_agent_scribe"
        prd_task.status = "assigned"
        app.state.crew_store.save_project(stored)
        stored = app.state.crew_store.get_project(pid)
        assert stored is not None

        app.state.crew_service._agent_dispatcher(
            pid,
            prd["id"],
            stored.workspace_id,
            "acc_boss",
            "msg-source-1",
            "@Scribe 开始做 PRD",
        )
        active = app.state.execution_store.list_active(
            workspace_id=stored.workspace_id,
            subject_ref_prefix=f"crew_task:{pid}:{prd['id']}",
        )
        assert len(active) == 1
        run_ref = active[0].execution_id

        original_version = stored.project_version
        app.state.crew_store.save_project(stored)
        assert app.state.crew_store.get_project(pid).project_version > original_version

        app.state.crew_service._agent_dispatcher(
            pid,
            prd["id"],
            stored.workspace_id,
            "acc_boss",
            "msg-source-1",
            "@Scribe 开始做 PRD",
        )
        active_again = app.state.execution_store.list_active(
            workspace_id=stored.workspace_id,
            subject_ref_prefix=f"crew_task:{pid}:{prd['id']}",
        )
        assert [snapshot.execution_id for snapshot in active_again] == [run_ref]
        assert app.state.execution_store.fetch_pending_signals(run_ref) == []
        release.set()


def test_channel_say_at_human_does_not_signal_active_agent(tmp_path):
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            release.wait(timeout=5)
            raise CrewAgentError("parked", frames=[], memory_hits=[])

    app = _crew_app(tmp_path, _ParkingExecutor(), run_store=True, auto_pilot=True)
    with TestClient(app) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            active = app.state.execution_store.list_active(
                workspace_id=project["workspace_id"],
                subject_ref_prefix=f"crew_task:{pid}:{prd_id}",
            )
            if active and _task_by_id(project, prd_id)["run_inflight"]:
                break
            time.sleep(0.02)
        else:
            raise AssertionError("run did not become active")
        assert len(active) == 1
        run_ref = active[0].execution_id

        say = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={"body": "@Boss 看下", "mentions": ["acc_boss"]},
            headers=auth,
        )
        assert say.status_code == 200, say.text
        assert app.state.execution_store.fetch_pending_signals(run_ref) == []
        release.set()


def test_channel_say_at_anna_schedules_background_coordination_card(tmp_path):
    """C3 end-to-end:a human say @-mentioning Anna with a task-intent phrase
    yields (in the BACKGROUND, not blocking the say) an Anna-authored command card
    with origin=anna_coordination — and creates zero tasks (draft state only)."""
    from services.crew.app.command_drafting import CommandDraftingService

    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    # Deterministic, network-free drafter (unconfigured → fallback).
    crew_store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    crew = CrewService(
        crew_store,
        drafter=CommandDraftingService(settings=RuntimeSettings()),
    )
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(crew, identity, settings=_CONFIGURED))

    with TestClient(app) as client:
        auth = _login(client)
        pid = client.post(
            "/api/crew/projects",
            json={"goal_text": "登录页重设计", "sop_template_id": "feature_iteration"},
            headers=auth,
        ).json()["id"]
        tasks_before = len(client.get(f"/api/crew/projects/{pid}", headers=auth).json()["tasks"])

        say = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={"body": "@Anna 帮我加个任务:回归测试登录页三态", "mentions": ["anna"]},
            headers=auth,
        )
        assert say.status_code == 200, say.text
        say_id = say.json()["id"]

        # The card lands in the background — poll the channel until it appears.
        end = time.monotonic() + 3.0
        card = None
        while time.monotonic() < end:
            msgs = client.get(
                f"/api/crew/projects/{pid}/channel", headers=auth
            ).json()["messages"]
            card = next(
                (m for m in msgs
                 if (
                     m["kind"] == "command"
                     and (m.get("payload") or {}).get("origin") == "anna_coordination"
                 )),
                None,
            )
            if card:
                break
            time.sleep(0.02)
        assert card is not None, "intent card should appear in the background"
        assert card["author_kind"] == "anna"
        assert card["payload"]["origin_message_id"] == say_id
        assert card["payload"]["coordination_actor_id"] == "anna"
        assert card["payload"]["caused_by"]["message_id"] == say_id
        assert card["payload"]["suggested_assignee"] is None

        notes = crew_store.list_notifications("ws_demo", "anna")
        assert notes == []

        # Draft state only — no task created by the intent card.
        tasks_after = len(client.get(f"/api/crew/projects/{pid}", headers=auth).json()["tasks"])
        assert tasks_after == tasks_before


def test_agent_author_at_anna_does_not_create_coordination_card_without_autopilot(tmp_path):
    from services.crew.app.command_drafting import CommandDraftingService

    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew = CrewService(
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        drafter=CommandDraftingService(settings=RuntimeSettings()),
    )
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(crew, identity, settings=_CONFIGURED))

    with TestClient(app) as client:
        boss = _login(client)
        agent = {
            "Authorization": "Bearer "
            + client.post(
                "/api/auth/login",
                json={"email": "scribe@anna.demo", "password": "crew-demo"},
            ).json()["token"]
        }
        pid = client.post(
            "/api/crew/projects",
            json={"goal_text": "登录页重设计", "sop_template_id": "feature_iteration"},
            headers=boss,
        ).json()["id"]

        say = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={"body": "@Anna 帮我加个任务:回归测试登录页三态", "mentions": ["anna"]},
            headers=agent,
        )
        assert say.status_code == 200, say.text

        end = time.monotonic() + 0.5
        while time.monotonic() < end:
            msgs = client.get(f"/api/crew/projects/{pid}/channel", headers=boss).json()["messages"]
            assert not any(
                m["kind"] == "command"
                and (m.get("payload") or {}).get("origin") == "anna_coordination"
                for m in msgs
            )
            time.sleep(0.02)


def test_channel_say_ghost_mention_dropped_over_http(tmp_path):
    """DEV-8 over HTTP:a bogus mention id earns no notification; a real one does."""
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    client.post(f"/api/crew/projects/{pid}/channel",
                json={"body": "看下 @Andy 与 @Ghost", "mentions": ["acc_andy", "acc_ghost"]},
                headers=auth)

    # acc_andy (real member) is notified; acc_ghost (not a member) is not.
    andy = client.post("/api/auth/login",
                       json={"email": "andy@anna.demo", "password": "crew-demo"}).json()["token"]
    andy_notifs = client.get(
        "/api/crew/notifications", headers={"Authorization": f"Bearer {andy}"}
    ).json()["notifications"]
    assert any(n["kind"] == "mention" for n in andy_notifs)


def test_channel_say_at_worker_with_intent_does_not_create_coordination_card(tmp_path):
    release = threading.Event()

    class _ParkingExecutor:
        def run_task(self, proj, task_id, run_ref=None):
            release.wait(timeout=5)
            raise CrewAgentError("parked", frames=[], memory_hits=[])

    app = _crew_app(tmp_path, _ParkingExecutor(), run_store=True, auto_pilot=True)
    with TestClient(app) as client:
        auth = _login(client)
        pid, prd_id = _project_with_prd_assigned(client, auth)

        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
            active = app.state.execution_store.list_active(
                workspace_id=project["workspace_id"],
                subject_ref_prefix=f"crew_task:{pid}:{prd_id}",
            )
            if active and _task_by_id(project, prd_id)["run_inflight"]:
                break
            time.sleep(0.02)
        else:
            raise AssertionError("run did not become active")

        say = client.post(
            f"/api/crew/projects/{pid}/channel",
            json={
                "body": "@Scribe 帮我补充失败态和重试策略",
                "mentions": ["acc_agent_scribe"],
            },
            headers=auth,
        )
        assert say.status_code == 200, say.text

        msgs = client.get(f"/api/crew/projects/{pid}/channel", headers=auth).json()["messages"]
        assert not any(
            m["kind"] == "command"
            and (m.get("payload") or {}).get("origin") == "anna_coordination"
            for m in msgs
        )
        release.set()


def test_crew_routes_require_auth(tmp_path):
    client, _ = _client(tmp_path)
    assert client.get("/api/crew/projects").status_code == 401
    assert client.post("/api/crew/projects",
                       json={"goal_text": "x", "sop_template_id": "feature_iteration"}).status_code == 401


def test_local_session_fallback_makes_crew_usable_without_token(tmp_path):
    """No-login desktop: when a local_session is wired, token-less requests
    resolve to that local identity (usable Crew) instead of 401 — while a
    different workspace's data stays invisible (isolation intact)."""
    from services.identity.app.schemas import SessionIdentity

    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    local = lambda: SessionIdentity(  # noqa: E731  — desktop user IS Boss of the demo ws
        workspace_id="ws_crew_demo", workspace_name="Crew Demo Team",
        user_id="acc_boss", user_display_name="Boss", role="产品",
    )
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity, local_session=local))
    app.include_router(crew_routes.build_router(
        crew, identity, None, settings=_CONFIGURED, local_session=local,
    ))
    client = TestClient(app)

    # Token-less → 200, scoped to the local (demo) workspace, roster visible.
    assert client.get("/api/crew/projects").status_code == 200
    assert client.get("/api/auth/team").json()["members"], "local user sees its roster"
    created = client.post("/api/crew/projects",
                          json={"goal_text": "登录页重设计", "sop_template_id": "feature_iteration"})
    assert created.status_code == 200
    pid = created.json()["id"]
    assert any(p["id"] == pid for p in client.get("/api/crew/projects").json()["projects"])

    # Isolation: a token scoped to a DIFFERENT workspace cannot see it.
    istore.create_workspace("ws_other", "Other")
    istore.create_account(
        Account(id="acc_other", workspace_id="ws_other", email="o@x.test",
                display_name="O", role="产品", kind="human"),
        hash_password("pw"),
    )
    other = client.post("/api/auth/login", json={"email": "o@x.test", "password": "pw"}).json()
    other_auth = {"Authorization": f"Bearer {other['token']}"}
    assert client.get(f"/api/crew/projects/{pid}", headers=other_auth).status_code == 404
    assert not client.get("/api/crew/projects", headers=other_auth).json()["projects"]


def test_create_project_and_list_and_get(tmp_path):
    client, auth = _client(tmp_path)
    created = client.post("/api/crew/projects",
                          json={"goal_text": "做一个新功能", "sop_template_id": "feature_iteration"},
                          headers=auth)
    assert created.status_code == 200
    project = created.json()
    assert project["sop_template_id"] == "feature_iteration"
    assert _task(project, "brief")["status"] == "todo"
    assert _task(project, "prd")["status"] == "blocked"
    pid = project["id"]
    assert any(p["id"] == pid for p in client.get("/api/crew/projects", headers=auth).json()["projects"])
    assert client.get(f"/api/crew/projects/{pid}", headers=auth).json()["id"] == pid


def test_unknown_template_is_400(tmp_path):
    client, auth = _client(tmp_path)
    r = client.post("/api/crew/projects",
                    json={"goal_text": "x", "sop_template_id": "nope"}, headers=auth)
    assert r.status_code == 400


def test_full_lifecycle_over_http(tmp_path):
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]

    def act(path, **body):
        r = client.post(f"/api/crew/projects/{pid}/{path}", json=body or None, headers=auth)
        assert r.status_code == 200, r.text
        return r.json()

    project = client.get(f"/api/crew/projects/{pid}", headers=auth).json()
    brief, prd, review = (_task(project, k) for k in ("brief", "prd", "prd_review"))
    act(f"tasks/{brief['id']}/assign", member_id="acc_boss")
    act(f"tasks/{brief['id']}/start")
    act(f"tasks/{brief['id']}/submit", artifact="需求")
    act(f"tasks/{prd['id']}/assign", member_id="acc_agent_scribe")
    act(f"tasks/{prd['id']}/start")
    act(f"tasks/{prd['id']}/submit", artifact="PRD v1")
    # a gate is never assigned (reviewer is fixed as the owner) — review directly
    rejected = act(f"tasks/{review['id']}/review", approved=False, comment="目标不清")
    assert _task(rejected, "prd")["status"] == "rework"
    act(f"tasks/{prd['id']}/start")
    act(f"tasks/{prd['id']}/submit", artifact="PRD v2")
    approved = act(f"tasks/{review['id']}/review", approved=True)
    assert _task(approved, "design")["status"] == "todo"


def test_cross_workspace_project_is_404(tmp_path):
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    # a different login (mate) is same workspace; simulate other workspace by unknown id
    assert client.get("/api/crew/projects/crew_project_999", headers=auth).status_code == 404


def test_true_cross_workspace_isolation(tmp_path):
    """
    Verifies that _guard_project's workspace_id != session.workspace_id branch
    returns 404, not just the unknown-id branch.
    Creates a real project under workspace B, then asserts workspace A boss gets 404.
    """
    # --- shared stores (both workspaces share the same DB files) ---
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    cstore = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    seed_demo_workspace(istore)  # workspace A: ws_demo, boss@anna.demo / crew-demo
    identity = IdentityService(istore)
    crew = CrewService(cstore)

    # --- build workspace B ---
    istore.create_workspace("ws_other", "Other Corp")
    istore.create_team("team_other", "ws_other", "Other Team")
    other_account = Account(
        id="acc_other_boss",
        workspace_id="ws_other",
        email="other@example.com",
        display_name="Other Boss",
        role="boss",
        kind="human",
    )
    istore.create_account(other_account, hash_password("other-pass"))

    # --- build shared FastAPI app ---
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(crew, identity))
    client = TestClient(app)

    # --- workspace A token ---
    token_a = client.post(
        "/api/auth/login",
        json={"email": "boss@anna.demo", "password": "crew-demo"},
    ).json()["token"]
    auth_a = {"Authorization": f"Bearer {token_a}"}

    # --- workspace B token + create a real project in workspace B ---
    token_b = client.post(
        "/api/auth/login",
        json={"email": "other@example.com", "password": "other-pass"},
    ).json()["token"]
    auth_b = {"Authorization": f"Bearer {token_b}"}

    r = client.post(
        "/api/crew/projects",
        json={"goal_text": "workspace B project", "sop_template_id": "feature_iteration"},
        headers=auth_b,
    )
    assert r.status_code == 200, r.text
    workspace_b_project_id = r.json()["id"]

    # --- workspace A must NOT see workspace B's project ---
    assert client.get(
        f"/api/crew/projects/{workspace_b_project_id}", headers=auth_a
    ).status_code == 404

    # --- workspace A must also get 404 on assign to workspace B's project ---
    first_task_id = r.json()["tasks"][0]["id"]
    assert client.post(
        f"/api/crew/projects/{workspace_b_project_id}/tasks/{first_task_id}/assign",
        json={"member_id": "acc_boss"},
        headers=auth_a,
    ).status_code == 404


def test_crew_mounted_in_create_app(tmp_path):
    from services.api.app.main import create_app
    from services.identity.app.service import IdentityService
    from services.identity.app.store import SQLiteIdentityStore
    from services.identity.app.seed import seed_demo_workspace
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    app = create_app(identity_service=IdentityService(istore),
                     crew_service=CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3")))
    client = TestClient(app)
    assert client.get("/api/crew/templates").status_code == 200
    token = client.post("/api/auth/login",
                        json={"email": "boss@anna.demo", "password": "crew-demo"}).json()["token"]
    r = client.post("/api/crew/projects",
                    json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_suggest_assignments_requires_auth(tmp_path):
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "g", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    # No auth header → 401
    r = client.post(f"/api/crew/projects/{pid}/suggest-assignments")
    assert r.status_code == 401


# --- B1b · project consensus memory (GET/PUT/DELETE .../memory) ---------------


def _memory_client(tmp_path):
    """A crew+auth app with a business-memory store wired into the crew router."""
    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    memory = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(crew, identity, memory_store=memory))
    client = TestClient(app)

    def login(email):
        token = client.post(
            "/api/auth/login", json={"email": email, "password": "crew-demo"}
        ).json()["token"]
        return {"Authorization": f"Bearer {token}"}

    return client, login("boss@anna.demo"), login("andy@anna.demo"), memory


def test_project_memory_crud_is_boss_only_write(tmp_path):
    client, boss, andy, _memory = _memory_client(tmp_path)
    pid = client.post(
        "/api/crew/projects",
        json={"goal_text": "登录页重设计", "sop_template_id": "feature_iteration"},
        headers=boss,
    ).json()["id"]

    # Empty to start; ANY workspace member can read.
    assert client.get(f"/api/crew/projects/{pid}/memory", headers=andy).json()["items"] == []

    # A non-owner write is 403 (Boss-only = project owner).
    assert client.put(
        f"/api/crew/projects/{pid}/memory",
        json={"kind": "口径", "text": "登录页只在远程 4xx 形态出现"},
        headers=andy,
    ).status_code == 403

    created = client.put(
        f"/api/crew/projects/{pid}/memory",
        json={"kind": "口径", "text": "登录页只在远程 4xx 形态出现"},
        headers=boss,
    )
    assert created.status_code == 200, created.text
    entry = created.json()
    assert entry["kind"] == "口径"
    assert entry["text"] == "登录页只在远程 4xx 形态出现"
    assert entry["scope"] == "project" and entry["project_id"] == pid

    # Upsert with id edits in place (kind + text).
    updated = client.put(
        f"/api/crew/projects/{pid}/memory",
        json={"id": entry["id"], "kind": "决策", "text": "登录页只在远程 4xx;桌面默认免登录"},
        headers=boss,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["id"] == entry["id"]
    assert updated.json()["kind"] == "决策"

    listed = client.get(f"/api/crew/projects/{pid}/memory", headers=boss).json()["items"]
    assert [e["id"] for e in listed] == [entry["id"]]
    assert listed[0]["kind"] == "决策"

    # Blank text is rejected.
    assert client.put(
        f"/api/crew/projects/{pid}/memory",
        json={"kind": "约束", "text": "   "}, headers=boss,
    ).status_code == 400

    # A non-owner delete is 403; the owner's delete lands; a ghost delete is 404.
    assert client.delete(
        f"/api/crew/projects/{pid}/memory/{entry['id']}", headers=andy
    ).status_code == 403
    assert client.delete(
        f"/api/crew/projects/{pid}/memory/{entry['id']}", headers=boss
    ).status_code == 200
    assert client.get(f"/api/crew/projects/{pid}/memory", headers=boss).json()["items"] == []
    assert client.delete(
        f"/api/crew/projects/{pid}/memory/{entry['id']}", headers=boss
    ).status_code == 404


def test_project_memory_isolated_between_projects_and_requires_auth(tmp_path):
    client, boss, _andy, _memory = _memory_client(tmp_path)

    def make():
        return client.post(
            "/api/crew/projects",
            json={"goal_text": "g", "sop_template_id": "feature_iteration"},
            headers=boss,
        ).json()["id"]

    pa, pb = make(), make()
    ia = client.put(
        f"/api/crew/projects/{pa}/memory",
        json={"kind": "约束", "text": "A 的约束"}, headers=boss,
    ).json()

    # Project B never sees A's entries; A's item id is 404 under B's paths.
    assert client.get(f"/api/crew/projects/{pb}/memory", headers=boss).json()["items"] == []
    assert client.put(
        f"/api/crew/projects/{pb}/memory",
        json={"id": ia["id"], "kind": "约束", "text": "x"}, headers=boss,
    ).status_code == 404
    assert client.delete(
        f"/api/crew/projects/{pb}/memory/{ia['id']}", headers=boss
    ).status_code == 404

    # No bearer -> 401 (same discipline as every crew route).
    assert client.get(f"/api/crew/projects/{pa}/memory").status_code == 401


# --- B3 · channel command + inbox + approvals (over HTTP) --------------------


def _b3_client(tmp_path, *, seed_awaiting_approval=False):
    """A crew+auth app with memory + a reimbursement orchestrator wired in.

    When ``seed_awaiting_approval`` is set, one reimbursement run is persisted in
    the demo workspace in ``waiting_confirmation`` (pending approval) so the
    projection has an actionable card + fires a Boss notification."""
    from services.identity.app.seed import DEMO_WORKSPACE_ID
    from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
    from services.reimbursement.app.schemas import (
        ApprovalRequest,
        ReimbursementDraft,
        ReimbursementRun,
    )
    from services.reimbursement.app.state_store import SQLiteReimbursementStateStore

    istore = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(istore)
    identity = IdentityService(istore)
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    memory = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    rstore = SQLiteReimbursementStateStore(tmp_path / "reimb.sqlite3")
    reimb = ReimbursementOrchestrator(settings=RuntimeSettings(), state_store=rstore)
    if seed_awaiting_approval:
        rstore.save_run(ReimbursementRun(
            id="run_1", workspace_id=DEMO_WORKSPACE_ID, actor_user_id="acc_andy",
            input_text="打车 88", status="waiting_confirmation",
            draft=ReimbursementDraft(amount=88.0, currency="CNY",
                                     external_reimbursement_id="EXT-1"),
            approval=ApprovalRequest(id="ap_1", run_id="run_1",
                                     action_type="reimbursement.submit",
                                     risk_level="medium", status="pending", payload={}),
        ))

    app = FastAPI()
    app.include_router(auth_routes.build_router(identity))
    app.include_router(crew_routes.build_router(
        crew, identity, memory_store=memory, reimbursement=reimb
    ))
    client = TestClient(app)

    def login(email):
        token = client.post(
            "/api/auth/login", json={"email": email, "password": "crew-demo"}
        ).json()["token"]
        return {"Authorization": f"Bearer {token}"}

    return client, login("boss@anna.demo"), login("andy@anna.demo")


def test_showcase_is_excluded_from_inbox_and_approval_boss_routing(tmp_path):
    client, boss, _andy = _b3_client(tmp_path, seed_awaiting_approval=True)
    ensured = client.post("/api/crew/showcase/ensure", json={}, headers=boss)
    assert ensured.status_code == 200, ensured.text
    showcase_project_id = ensured.json()["project"]["id"]

    def card_project_ids(cards):
        return {card.get("project_id") for card in cards if card.get("project_id")}

    inbox = client.get("/api/crew/inbox", headers=boss)
    assert inbox.status_code == 200, inbox.text
    body = inbox.json()
    assert showcase_project_id not in card_project_ids(body["todo"])
    assert showcase_project_id not in card_project_ids(body["review"])
    assert showcase_project_id not in card_project_ids(body["mentions"])
    assert not any(card.get("card_kind") == "reimbursement" for card in body["review"])

    approvals = client.get("/api/crew/approvals", headers=boss)
    assert approvals.status_code == 200, approvals.text
    assert approvals.json()["approvals"]

    client.get("/api/crew/inbox", headers=boss)
    client.get("/api/crew/approvals", headers=boss)
    assert client.get("/api/crew/notifications", headers=boss).json()["notifications"] == []


def _make_project(client, auth, goal="登录页重设计"):
    return client.post(
        "/api/crew/projects",
        json={"goal_text": goal, "sop_template_id": "feature_iteration"},
        headers=auth,
    ).json()["id"]


def test_channel_command_two_phase_and_confirm_is_boss_only(tmp_path):
    client, boss, andy = _b3_client(tmp_path)
    pid = _make_project(client, boss)

    # Phase 1: any member drafts (fallback → one task).
    drafted = client.post(
        f"/api/crew/projects/{pid}/channel/command",
        json={"text": "补一个登录页无障碍检查任务"}, headers=boss,
    )
    assert drafted.status_code == 200, drafted.text
    body = drafted.json()
    assert body["message_id"] and len(body["drafts"]) == 1

    # Phase 2: a non-owner confirm is 403 (Boss-only).
    assert client.post(
        f"/api/crew/projects/{pid}/channel/command/confirm",
        json={"message_id": body["message_id"]}, headers=andy,
    ).status_code == 403

    # The owner confirms → a channel-origin task joins the graph.
    confirmed = client.post(
        f"/api/crew/projects/{pid}/channel/command/confirm",
        json={"message_id": body["message_id"]}, headers=boss,
    )
    assert confirmed.status_code == 200, confirmed.text
    grown = [t for t in confirmed.json()["tasks"] if t["origin"] == "channel"]
    assert len(grown) == 1
    assert grown[0]["created_from_message_id"] == body["message_id"]


def test_inbox_three_lanes_and_reimbursement_review_card(tmp_path):
    client, boss, andy = _b3_client(tmp_path, seed_awaiting_approval=True)
    pid = _make_project(client, boss)

    # Assign brief to andy → shows in andy's todo; @andy mention → mentions lane.
    project = client.get(f"/api/crew/projects/{pid}", headers=boss).json()
    brief = _task(project, "brief")
    client.post(f"/api/crew/projects/{pid}/tasks/{brief['id']}/assign",
                json={"member_id": "acc_andy"}, headers=boss)
    client.post(f"/api/crew/projects/{pid}/channel",
                json={"body": "看下这个 @acc_andy", "mentions": ["acc_andy"]}, headers=boss)

    andy_inbox = client.get("/api/crew/inbox", headers=andy).json()
    assert set(andy_inbox) == {"todo", "review", "mentions"}
    assert any(c["task_id"] == brief["id"] for c in andy_inbox["todo"])
    assert any(c["author_member_id"] == "acc_boss" for c in andy_inbox["mentions"])

    # The Boss (project owner) sees the awaiting-approval reimbursement card in review.
    boss_inbox = client.get("/api/crew/inbox", headers=boss).json()
    reimb_cards = [c for c in boss_inbox["review"] if c.get("card_kind") == "reimbursement"]
    assert reimb_cards and reimb_cards[0]["step"] == "awaiting_approval"
    assert reimb_cards[0]["run_id"] == "run_1"

    # The projection also raised an idempotent Boss approval notification.
    notifs = client.get("/api/crew/notifications", headers=boss).json()["notifications"]
    approval = [n for n in notifs if n["kind"] == "approval"]
    assert len(approval) == 1
    # A second inbox read must NOT duplicate it (idempotent).
    client.get("/api/crew/inbox", headers=boss)
    notifs2 = client.get("/api/crew/notifications", headers=boss).json()["notifications"]
    assert len([n for n in notifs2 if n["kind"] == "approval"]) == 1


def test_approvals_endpoint_projects_reimbursement(tmp_path):
    client, boss, _andy = _b3_client(tmp_path, seed_awaiting_approval=True)
    r = client.get("/api/crew/approvals", headers=boss)
    assert r.status_code == 200, r.text
    approvals = r.json()["approvals"]
    assert len(approvals) == 1
    card = approvals[0]
    assert card["run_id"] == "run_1"
    assert card["step"] == "awaiting_approval"
    assert card["applicant"] == "acc_andy"
    assert card["amount"] == 88.0 and card["currency"] == "CNY"
    assert card["approval_id"] == "ap_1"
    # Auth is required.
    assert client.get("/api/crew/approvals").status_code == 401


def test_suggest_assignments_returns_proposals_and_source(tmp_path):
    client, auth = _client(tmp_path)
    pid = client.post("/api/crew/projects",
                      json={"goal_text": "新功能上线", "sop_template_id": "feature_iteration"},
                      headers=auth).json()["id"]
    r = client.post(f"/api/crew/projects/{pid}/suggest-assignments", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    # Must have proposals and source fields
    assert "proposals" in body
    assert "source" in body
    # Test env has no model configured → source is "fallback"
    assert body["source"] == "fallback"
    proposals = body["proposals"]
    # All unassigned tasks in a fresh project should have a proposal
    assert len(proposals) > 0
    # Every proposal has required fields
    for p in proposals:
        assert "task_id" in p
        assert "task_key" in p
        assert "task_title" in p
        assert "role_required" in p
        assert "rationale" in p
        assert "member_id" in p
