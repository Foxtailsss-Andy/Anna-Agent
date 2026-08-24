from __future__ import annotations

import sqlite3
from pathlib import Path

from services.crew.app.execution_projection import CrewExecutionProjector
from services.crew.app.lifecycle import instantiate_project
from services.crew.app.schemas import CrewProject, CrewTask
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.execution.clock import ManualClock
from services.runtime.app.execution.models import CancelExecution, LoopResult, StartExecution
from services.runtime.app.execution.store import SQLiteExecutionStore


def _crew_project(project_id: str = "proj_exec") -> CrewProject:
    counter = {"n": 0}

    def task_id(key: str) -> str:
        counter["n"] += 1
        return f"{project_id}_task_{counter['n']}_{key}"

    project = instantiate_project(
        project_id=project_id,
        workspace_id="ws-1",
        owner_user_id="owner-1",
        goal_text="Ship the feature",
        template=get_template("feature_iteration"),
        task_id=task_id,
    )
    for task in project.tasks[:2]:
        task.assignee_member_id = "worker:scribe"
        task.status = "assigned"
    return project


def _start(project_id: str, task_id: str, request_id: str = "req-start") -> StartExecution:
    return StartExecution(
        request_id=request_id,
        workspace_id="ws-1",
        conversation_id=f"crew:{project_id}",
        channel_id=f"crew:{project_id}",
        subject_ref=f"crew_task:{project_id}:{task_id}",
        trigger_ref="message:m-1",
        worker_profile_ref="worker:scribe",
        run_profile_ref="run:crew-default",
        input={"project_id": project_id, "task_id": task_id},
    )


def _non_crew_start(request_id: str = "req-non-crew") -> StartExecution:
    return StartExecution(
        request_id=request_id,
        workspace_id="ws-1",
        conversation_id="chat:c-1",
        channel_id="chat",
        subject_ref="chat:thread-1",
        trigger_ref="message:m-1",
        worker_profile_ref="worker:general",
        run_profile_ref="run:chat-default",
        input={"prompt": "hello"},
    )


def _stores(tmp_path: Path) -> tuple[SQLiteCrewStore, SQLiteExecutionStore]:
    return (
        SQLiteCrewStore(tmp_path / "crew.sqlite3"),
        SQLiteExecutionStore(tmp_path / "executions.sqlite3", clock=ManualClock()),
    )


def _projector(
    crew_store: SQLiteCrewStore,
    execution_store: SQLiteExecutionStore,
) -> CrewExecutionProjector:
    return CrewExecutionProjector(
        crew_store=crew_store,
        execution_store=execution_store,
    )


def _drain_successful_projection(projector: CrewExecutionProjector) -> None:
    for _ in range(20):
        result = projector.run_once(owner_id="projector", limit=20)
        assert result.failed == 0
        if result.claimed == 0:
            return
    raise AssertionError("projection did not drain")


def test_started_only_links_run_ref_and_claimed_moves_task_to_running(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    assert execution_store.claim_next(owner_id="worker-a") is not None
    projector = _projector(crew_store, execution_store)

    result = projector.run_once(owner_id="projector")

    assert result.failed == 0
    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "assigned"
    assert projected.run_ref == started.execution_id
    assert projected.run_started_at is None

    result = projector.run_once(owner_id="projector")

    assert result.failed == 0
    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "running"
    assert projected.run_started_at is not None


def test_crew_projector_does_not_claim_or_ack_non_crew_execution_events(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    non_crew = execution_store.dispatch(_non_crew_start(), max_queue_depth=10)

    result = _projector(crew_store, execution_store).run_once(owner_id="crew-projector")

    assert result.claimed == 0
    claimed = execution_store.claim_outbox_events(owner_id="generic-projector")
    assert [(event.execution_id, event.seq) for event in claimed] == [
        (non_crew.execution_id, 1)
    ]


def test_claimed_projection_rejects_todo_task_without_promoting_to_running(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    task.status = "todo"
    task.assignee_member_id = None
    crew_store.save_project(project)
    execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    assert execution_store.claim_next(owner_id="worker-a") is not None
    projector = _projector(crew_store, execution_store)

    assert projector.run_once(owner_id="projector").failed == 0
    result = projector.run_once(owner_id="projector")

    assert result.failed == 1
    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "todo"
    assert projected.run_started_at is None


def test_projection_receipt_makes_same_execution_seq_idempotent(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    event = execution_store.claim_outbox_events(owner_id="projector", limit=1)[0]
    projector = CrewExecutionProjector(
        crew_store=crew_store,
        execution_store=execution_store,
    )

    assert projector.project_event(event)
    assert not projector.project_event(event)

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    assert "execution_event_cursors" not in loaded.model_dump(mode="json")
    assert len(next(t for t in loaded.tasks if t.id == task.id).artifact_versions) == 0
    with sqlite3.connect(tmp_path / "crew.sqlite3") as conn:
        row = conn.execute(
            """
            SELECT COUNT(*)
            FROM crew_execution_projection_receipts
            WHERE execution_id = ? AND seq = ?
            """,
            (started.execution_id, event.seq),
        ).fetchone()
    assert row is not None
    assert row[0] == 1


def test_projection_failure_does_not_ack_outbox(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="succeeded",
            events=[("artifact_produced", {"task_id": task.id})],
        ),
    )

    projector = _projector(crew_store, execution_store)
    assert projector.run_once(owner_id="projector").failed == 0
    assert projector.run_once(owner_id="projector").failed == 0
    result = projector.run_once(owner_id="projector")

    assert result.failed >= 1
    with sqlite3.connect(tmp_path / "executions.sqlite3") as conn:
        row = conn.execute(
            """
            SELECT delivered_at
            FROM execution_outbox
            WHERE execution_id = ? AND event_type = 'artifact_produced'
            """,
            (started.execution_id,),
        ).fetchone()
    assert row is not None
    assert row[0] is None


def test_worker_question_projects_visible_worker_say_and_notification(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    task.assignee_member_id = "worker:scribe"
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="awaiting_signal",
            checkpoint={
                "kind": "crew.worker.awaiting_input.v1",
                "question": "目标用户是哪一类?",
                "target": "owner-1",
            },
            events=[
                (
                    "crew.worker.question",
                    {
                        "project_id": project.id,
                        "task_id": task.id,
                        "reason": "awaiting_input",
                        "question": "目标用户是哪一类?",
                        "target": "owner-1",
                        "tool": "crew.ask_human",
                        "tool_call_id": "call_1",
                    },
                )
            ],
        ),
    )
    projector = _projector(crew_store, execution_store)

    for _ in range(2):
        result = projector.run_once(owner_id="projector")
        assert result.failed == 0
    event = execution_store.claim_outbox_events(owner_id="projector", limit=1)[0]
    assert event.type == "crew.worker.question"
    assert projector.project_event(event)

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "running"
    assert projected.run_ref == started.execution_id
    messages = crew_store.list_channel_messages(project.id)
    question = messages[-1]
    assert question.kind == "say"
    assert question.author_kind == "worker"
    assert question.worker_profile_ref == "worker:scribe"
    assert question.caused_by_execution_id == started.execution_id
    assert question.body == "目标用户是哪一类?"
    assert question.mentions == ["owner-1"]
    assert question.payload == {
        "question": "目标用户是哪一类?",
        "target": "owner-1",
        "reason": "awaiting_input",
    }
    notes = crew_store.list_notifications("ws-1", "owner-1")
    assert notes[0].kind == "mention"
    assert notes[0].task_id == task.id

    assert not projector.project_event(event)
    assert len(crew_store.list_channel_messages(project.id)) == len(messages)


def test_worker_question_with_unresolved_target_falls_back_to_project_owner(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="awaiting_signal",
            events=[
                (
                    "crew.worker.question",
                    {
                        "project_id": project.id,
                        "task_id": task.id,
                        "question": "缺少哪项口径?",
                        "target": "ghost",
                    },
                )
            ],
        ),
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    question = crew_store.list_channel_messages(project.id)[-1]
    assert question.mentions == ["owner-1"]
    assert question.payload is not None
    assert question.payload["target"] == "owner-1"


def test_retry_scheduled_projects_worker_progress_without_notification(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.schedule_retry_claimed(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        reason="model_error",
        error_code="upstream_500",
        message="model temporarily unavailable",
        not_before=10.0,
        max_attempts=3,
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "running"
    messages = crew_store.list_channel_messages(project.id)
    assert messages[-1].author_kind == "worker"
    assert messages[-1].kind == "event"
    assert "将重试" in messages[-1].body
    assert crew_store.list_notifications("ws-1", "owner-1") == []


def test_dead_lettered_execution_projects_blocked_task_and_owner_notification(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.dead_letter_claimed(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        reason="attempt_limit",
        error_code="agent_exhausted",
        message="too many failures",
        max_attempts=3,
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "blocked"
    assert projected.blocker == "too many failures"
    messages = crew_store.list_channel_messages(project.id)
    assert messages[-1].author_kind == "worker"
    assert "进入死信" in messages[-1].body
    notes = crew_store.list_notifications("ws-1", "owner-1")
    assert notes[0].kind == "blocked"
    assert notes[0].task_id == task.id


def test_recovery_blocked_execution_projects_manual_recovery_blocker(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="awaiting_signal",
            events=[
                (
                    "execution.recovery_blocked",
                    {
                        "reason": "effect_outcome_unknown",
                        "manual_recovery_required": True,
                    },
                )
            ],
        ),
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.status == "blocked"
    assert projected.blocker == "effect_outcome_unknown"
    messages = crew_store.list_channel_messages(project.id)
    assert messages[-1].author_kind == "worker"
    assert messages[-1].payload == {
        "reason": "effect_outcome_unknown",
        "manual_recovery_required": True,
    }
    notes = crew_store.list_notifications("ws-1", "owner-1")
    assert notes[0].kind == "blocked"


def test_parallel_task_artifact_projections_keep_both_results(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    task_a = CrewTask(
        id="task_a",
        project_id="proj_parallel_exec",
        key="a",
        title="A",
        role_required="产品",
        status="assigned",
        assignee_member_id="worker:scribe",
    )
    task_b = CrewTask(
        id="task_b",
        project_id="proj_parallel_exec",
        key="b",
        title="B",
        role_required="产品",
        status="assigned",
        assignee_member_id="worker:scribe",
    )
    project = CrewProject(
        id="proj_parallel_exec",
        workspace_id="ws-1",
        owner_user_id="owner-1",
        goal_text="Parallel work",
        sop_template_id="custom",
        tasks=[task_a, task_b],
    )
    crew_store.save_project(project)

    for idx, task in enumerate((task_a, task_b), start=1):
        started = execution_store.dispatch(
            _start(project.id, task.id, request_id=f"req-{idx}"),
            max_queue_depth=10,
        )
        lease = execution_store.claim_next(owner_id=f"worker-{idx}")
        assert lease is not None
        execution_store.commit_loop_result(
            started.execution_id,
            owner_id=f"worker-{idx}",
            lease_token=lease.lease_token,
            result=LoopResult(
                status="succeeded",
                events=[("artifact_produced", {"artifact": f"artifact {idx}"})],
            ),
        )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    by_id = {task.id: task for task in loaded.tasks}
    assert by_id[task_a.id].artifact == "artifact 1"
    assert by_id[task_b.id].artifact == "artifact 2"


def test_blocked_projection_sets_core_task_state(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="failed",
            events=[("agent_blocked", {"reason": "need human input"})],
            last_error_code="blocked",
            error_message="need human input",
        ),
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    blocked = next(t for t in loaded.tasks if t.id == task.id)
    assert blocked.status == "blocked"
    assert blocked.blocker == "need human input"
    assert blocked.run_ref == started.execution_id
    assert blocked.run_started_at is None


def test_artifact_projection_rejects_non_runnable_task_state(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[2]
    task.status = "todo"
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="succeeded",
            events=[("artifact_produced", {"artifact": "must not bypass start"})],
        ),
    )
    for _ in range(2):
        event = execution_store.claim_outbox_events(owner_id="manual-projector", limit=1)[0]
        assert execution_store.ack_outbox_events(
            [event],
            owner_id=event.claim_owner,
            claim_token=event.claim_token,
        ) == 1
    projector = _projector(crew_store, execution_store)
    result = projector.run_once(owner_id="projector")

    assert result.failed == 1
    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    unchanged = next(t for t in loaded.tasks if t.id == task.id)
    assert unchanged.status == "todo"
    assert unchanged.artifact is None


def test_blocked_projection_does_not_roll_back_advanced_task(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    task.status = "done"
    task.artifact = "already delivered"
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="failed",
            events=[("agent_blocked", {"reason": "late failure"})],
            error_message="late failure",
        ),
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    advanced = next(t for t in loaded.tasks if t.id == task.id)
    assert advanced.status == "done"
    assert advanced.artifact == "already delivered"
    assert advanced.blocker is None


def test_runtime_failed_terminal_blocks_running_task_without_domain_blocked_event(
    tmp_path: Path,
):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.fail_execution(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        error_code="loop_error",
        message="boom",
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    blocked = next(t for t in loaded.tasks if t.id == task.id)
    assert blocked.status == "blocked"
    assert blocked.blocker == "boom"
    assert blocked.run_started_at is None


def test_runtime_cancelled_terminal_blocks_open_task_with_visible_reason(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    execution_store.dispatch(
        CancelExecution(
            request_id="req-cancel",
            workspace_id="ws-1",
            execution_id=started.execution_id,
            reason="operator",
        ),
        max_queue_depth=10,
    )

    _drain_successful_projection(_projector(crew_store, execution_store))

    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    blocked = next(t for t in loaded.tasks if t.id == task.id)
    assert blocked.status == "blocked"
    assert blocked.blocker == "执行已取消: operator"


def test_artifact_projection_replay_does_not_duplicate_channel_or_notifications(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[1]
    project.tasks[0].status = "done"
    project.tasks[0].artifact = "brief"
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="succeeded",
            events=[("crew.task.artifact_produced", {"artifact": "artifact v1"})],
        ),
    )
    projector = _projector(crew_store, execution_store)

    _drain_successful_projection(projector)
    _drain_successful_projection(projector)

    artifact_rows = [
        message
        for message in crew_store.list_channel_messages(project.id)
        if message.kind == "artifact" and message.run_ref == started.execution_id
    ]
    assert len(artifact_rows) == 1
    assert artifact_rows[0].author_kind == "worker"
    assert artifact_rows[0].author_member_id is None
    assert artifact_rows[0].worker_profile_ref == "worker:scribe"
    assert artifact_rows[0].caused_by_execution_id == started.execution_id
    review_notes = [
        note
        for note in crew_store.list_notifications(project.workspace_id, project.owner_user_id)
        if note.kind == "review_due"
    ]
    assert len(review_notes) == 1


def test_blocked_projection_replay_does_not_duplicate_channel_or_notification(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[0]
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="failed",
            events=[("crew.task.agent_blocked", {"reason": "need input"})],
            error_message="need input",
        ),
    )
    projector = _projector(crew_store, execution_store)

    _drain_successful_projection(projector)
    _drain_successful_projection(projector)

    blocked_rows = [
        message
        for message in crew_store.list_channel_messages(project.id)
        if message.kind == "event" and message.run_ref == started.execution_id and "受阻" in message.body
    ]
    assert len(blocked_rows) == 1
    blocked_notes = [
        note
        for note in crew_store.list_notifications(project.workspace_id, project.owner_user_id)
        if note.kind == "blocked" and note.task_id == task.id
    ]
    assert len(blocked_notes) == 1


def test_projection_transaction_failure_leaves_no_half_artifact_state(tmp_path: Path):
    crew_store, execution_store = _stores(tmp_path)
    project = _crew_project()
    task = project.tasks[1]
    project.tasks[0].status = "done"
    project.tasks[0].artifact = "brief"
    crew_store.save_project(project)
    started = execution_store.dispatch(_start(project.id, task.id), max_queue_depth=10)
    lease = execution_store.claim_next(owner_id="worker-a")
    assert lease is not None
    execution_store.commit_loop_result(
        started.execution_id,
        owner_id="worker-a",
        lease_token=lease.lease_token,
        result=LoopResult(
            status="succeeded",
            events=[("crew.task.artifact_produced", {"artifact": "artifact v1"})],
        ),
    )
    projector = _projector(crew_store, execution_store)
    assert projector.run_once(owner_id="projector").failed == 0
    assert projector.run_once(owner_id="projector").failed == 0
    original_append = crew_store._append_notification_tx

    def fail_notification(*args, **kwargs):
        raise RuntimeError("notification insert fault")

    crew_store._append_notification_tx = fail_notification  # type: ignore[method-assign]
    try:
        result = projector.run_once(owner_id="projector")
    finally:
        crew_store._append_notification_tx = original_append  # type: ignore[method-assign]

    assert result.failed == 1
    loaded = crew_store.get_project(project.id)
    assert loaded is not None
    projected = next(t for t in loaded.tasks if t.id == task.id)
    assert projected.artifact is None
    assert not [
        message
        for message in crew_store.list_channel_messages(project.id)
        if message.kind == "artifact" and message.run_ref == started.execution_id
    ]
    assert not crew_store.list_notifications(project.workspace_id, project.owner_user_id)
    with sqlite3.connect(tmp_path / "crew.sqlite3") as conn:
        receipt_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM crew_execution_projection_receipts
            WHERE execution_id = ? AND seq = 3
            """,
            (started.execution_id,),
        ).fetchone()[0]
    assert receipt_count == 0
