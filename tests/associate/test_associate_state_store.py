from pathlib import Path

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.associate.app.state_store import SQLiteAssociateStateStore
from services.runtime.app.skill_loader import SkillLoader
from tests.associate.test_receivables_recovery_agent import (
    ExecutableAssociateGateway,
    ReceivablesRecoveryModelProvider,
)


def test_associate_state_store_restores_pending_node_approval(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=ExecutableAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        state_store=SQLiteAssociateStateStore(store_path),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")
    approval_id = pending.plan.nodes[1].approval.id

    restarted = AssociateReceivablesOrchestrator(
        adapter=ExecutableAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        state_store=SQLiteAssociateStateStore(store_path),
    )

    restored = restarted.get_run(run.id)
    assert restored is not None
    assert restored.plan.nodes[1].approval.id == approval_id
    assert restarted.get_run_by_approval_id(approval_id) == restored


def test_restarted_associate_orchestrator_can_approve_and_persist_write_action(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=ExecutableAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        state_store=SQLiteAssociateStateStore(store_path),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")
    approval = pending.plan.nodes[1].approval

    gateway_after_restart = ExecutableAssociateGateway()
    restarted = AssociateReceivablesOrchestrator(
        adapter=gateway_after_restart,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        state_store=SQLiteAssociateStateStore(store_path),
    )

    approved = restarted.approve_node_execution(approval.id, approved_by="u_demo")

    node = approved.plan.nodes[1]
    assert node.write_action is not None
    assert node.write_action.approval_payload_hash == approval.payload_hash
    assert node.write_action.node_snapshot_hash == approval.node_snapshot_hash
    assert [call[0] for call in gateway_after_restart.calls] == [
        "erp.collection_task.create_draft",
    ]
    restored_action = SQLiteAssociateStateStore(store_path).get_write_action(
        node.write_action.id
    )
    assert restored_action == node.write_action


def test_associate_state_store_allocates_unique_ids_for_overlapping_orchestrators(tmp_path):
    store_path = tmp_path / "anna-state.sqlite3"
    first_orchestrator = AssociateReceivablesOrchestrator(
        adapter=ExecutableAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        state_store=SQLiteAssociateStateStore(store_path),
    )
    second_orchestrator = AssociateReceivablesOrchestrator(
        adapter=ExecutableAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        state_store=SQLiteAssociateStateStore(store_path),
    )

    first_run = first_orchestrator.start_run("demo", "u_demo", "2026-06", "第一轮")
    second_run = second_orchestrator.start_run("demo", "u_demo", "2026-06", "第二轮")

    assert first_run.id == "associate_run_001"
    assert second_run.id == "associate_run_002"
