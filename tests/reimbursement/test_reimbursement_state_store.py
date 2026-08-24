from services.mcp_gateway.app.reimbursement_adapter import ReimbursementMcpError
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.reimbursement.app.state_store import SQLiteReimbursementStateStore
from tests.reimbursement.test_reimbursement_agent_flow import (
    CONFIGURED_SETTINGS,
    FakeReimbursementMcpGateway,
    stepwise_engine,
)


class SubmitFailsOnceGateway(FakeReimbursementMcpGateway):
    def __init__(self) -> None:
        super().__init__()
        self.submit_arguments = []

    def submit(self, **kwargs):
        self.submit_call_count += 1
        self.submit_arguments.append(kwargs)
        if self.submit_call_count == 1:
            raise ReimbursementMcpError(
                "mcp_call_failed",
                "temporary submit outage",
                retryable=True,
            )
        return {
            "external_reimbursement_id": kwargs["external_reimbursement_id"],
            "external_status": "submitted",
            "submitted": True,
        }


class SubmitFailsPermanentlyGateway(FakeReimbursementMcpGateway):
    def __init__(self) -> None:
        super().__init__()
        self.submit_arguments = []

    def submit(self, **kwargs):
        self.submit_call_count += 1
        self.submit_arguments.append(kwargs)
        raise ReimbursementMcpError(
            "draft_not_found",
            "external reimbursement draft was not found",
            retryable=False,
        )


def test_orchestrator_restores_waiting_approval_run_from_state_store(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    restarted = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )

    restored = restarted.get_run(run.id)
    assert restored is not None
    assert restored.status == "waiting_confirmation"
    assert restored.approval is not None
    assert restored.approval.draft_snapshot == run.approval.draft_snapshot
    assert restored.approval.payload_hash == run.approval.payload_hash
    assert restored.approval.draft_snapshot_hash == run.approval.draft_snapshot_hash
    assert restarted.get_run_by_approval_id(restored.approval.id) == restored


def test_restarted_orchestrator_can_approve_and_persist_write_action(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )
    assert run.approval is not None

    gateway_after_restart = FakeReimbursementMcpGateway()
    restarted = ReimbursementOrchestrator(
        adapter=gateway_after_restart,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )

    submitted = restarted.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )

    assert submitted.status == "completed"
    assert submitted.write_action is not None
    assert submitted.write_action.approval_payload_hash == run.approval.payload_hash
    assert submitted.write_action.draft_snapshot_hash == run.approval.draft_snapshot_hash
    assert gateway_after_restart.submit_call_count == 1
    restored_action = SQLiteReimbursementStateStore(store_path).get_write_action(
        submitted.write_action.id
    )
    assert restored_action == submitted.write_action


def test_approved_submit_can_retry_after_retryable_mcp_failure_with_same_idempotency(
    tmp_path,
):
    store_path = tmp_path / "anna-state.sqlite3"
    gateway = SubmitFailsOnceGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )
    assert run.approval is not None

    failed_submit = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )
    assert failed_submit.status == "failed"
    assert failed_submit.error_code == "mcp_call_failed"
    assert failed_submit.approval is not None
    assert failed_submit.approval.status == "approved"
    assert failed_submit.write_action is None

    retried_submit = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )

    assert retried_submit.status == "completed"
    assert retried_submit.write_action is not None
    assert gateway.submit_call_count == 2
    assert gateway.submit_arguments[0]["idempotency_key"] == (
        gateway.submit_arguments[1]["idempotency_key"]
    )
    assert gateway.submit_arguments[0]["external_reimbursement_id"] == (
        gateway.submit_arguments[1]["external_reimbursement_id"]
    )
    approval_events = [
        event for event in retried_submit.audit_events if event.type == "approval.approved"
    ]
    assert len(approval_events) == 1


def test_approved_submit_does_not_retry_non_retryable_mcp_failure(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    gateway = SubmitFailsPermanentlyGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )
    assert run.approval is not None

    failed_submit = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )
    assert failed_submit.status == "failed"
    assert failed_submit.error_code == "draft_not_found"

    try:
        orchestrator.approve_submit(
            approval_id=run.approval.id,
            approved_by="u_demo",
        )
    except ValueError as exc:
        assert str(exc) == "submit failure is not retryable"
    else:
        raise AssertionError("non-retryable submit failure should not retry")

    assert gateway.submit_call_count == 1


def test_restarted_orchestrator_resumes_run_and_approval_counters(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    first_run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )
    assert first_run.id == "run_001"
    assert first_run.approval is not None
    assert first_run.approval.id == "approval_001"

    restarted = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    second_run = restarted.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请再帮我报销一次 ACME 项目交通费。",
    )

    assert second_run.id == "run_002"
    assert second_run.approval is not None
    assert second_run.approval.id == "approval_002"
    assert SQLiteReimbursementStateStore(store_path).get_run(first_run.id) == first_run


def test_state_store_allocates_unique_ids_for_overlapping_orchestrators(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    first_orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )
    second_orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
        state_store=SQLiteReimbursementStateStore(store_path),
    )

    first_run = first_orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )
    second_run = second_orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请再帮我报销一次 ACME 项目交通费。",
    )

    assert first_run.id == "run_001"
    assert second_run.id == "run_002"
    assert first_run.approval is not None
    assert second_run.approval is not None
    assert first_run.approval.id == "approval_001"
    assert second_run.approval.id == "approval_002"


def test_state_store_lists_runs_for_workspace_user_newest_first(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"

    def start_run(workspace_id: str, actor_user_id: str, input_text: str):
        orchestrator = ReimbursementOrchestrator(
            adapter=FakeReimbursementMcpGateway(),
            engine=stepwise_engine(),
            settings=CONFIGURED_SETTINGS,
            state_store=SQLiteReimbursementStateStore(store_path),
        )
        return orchestrator.start_run(
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            input_text=input_text,
        )

    first_run = start_run(
        "workspace_a",
        "user_a",
        "请帮我报销 ACME 项目交通费。",
    )
    other_user_run = start_run(
        "workspace_a",
        "user_b",
        "请帮另一个用户报销 ACME 项目交通费。",
    )
    second_run = start_run(
        "workspace_a",
        "user_a",
        "请再帮我报销 ACME 项目交通费。",
    )

    listed = SQLiteReimbursementStateStore(store_path).list_runs(
        workspace_id="workspace_a",
        actor_user_id="user_a",
    )

    assert [run.id for run in listed] == [second_run.id, first_run.id]
    assert other_user_run.id not in [run.id for run in listed]
