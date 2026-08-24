import json
from pathlib import Path

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.mcp_gateway.app.erp_adapter import ErpMcpError
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from services.runtime.app.skill_loader import SkillLoader


class ReceivablesRecoveryModelProvider:
    def __init__(self):
        self.settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="model-key",
            erp_mcp_server="https://erp.example/mcp",
        )
        self.requests = []

    async def create_response(self, request):
        self.requests.append(request)
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_aging",
                        name="erp.finance.get_receivables_aging",
                        arguments={"period": "2026-06", "overdue_days": 30},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_plan",
                    name="associate.emit_goal_plan",
                    arguments={
                        "goal": "逾期 30 天以上应收金额降低 20%",
                        "summary": "优先处理华东客户 A 的高额逾期应收。",
                        "nodes": [
                            {
                                "id": "n1",
                                "title": "核对逾期应收清单",
                                "status": "ready",
                                "owner": "finance_agent",
                                "depends_on": [],
                                "evidence": ["ERP_AR_AGING"],
                            },
                            {
                                "id": "n2",
                                "title": "生成客户跟进任务草案",
                                "status": "blocked",
                                "owner": "finance_user",
                                "depends_on": ["n1"],
                                "blocker": "需要用户确认催收口径",
                                "write_intent": {
                                    "action_type": "erp.collection_task.create_draft",
                                    "risk_level": "medium",
                                    "summary": "为华东客户 A 创建催收跟进任务草案。",
                                },
                            },
                        ],
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class ConnectedAssociateGateway:
    def __init__(self):
        self.settings = RuntimeSettings(erp_mcp_server="https://erp.example/mcp")
        self.calls = []

    def status(self):
        return {
            "status": "connected",
            "tool_names": [
                "erp.finance.get_receivables_aging",
            ],
            "tools": [
                {"name": "erp.finance.get_receivables_aging"},
            ],
        }

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        assert tool_name == "erp.finance.get_receivables_aging"
        return {
            "period": arguments["period"],
            "overdue_days": arguments["overdue_days"],
            "items": [
                {
                    "customer": "华东客户 A",
                    "amount": 180000,
                    "currency": "CNY",
                    "overdue_days": 42,
                    "owner": "销售一部",
                }
            ],
            "sources": ["ERP_AR_AGING"],
        }


class ExecutableAssociateGateway(ConnectedAssociateGateway):
    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "erp.collection_task.create_draft":
            return {
                "external_task_id": "collection-task-001",
                "external_status": "draft_created",
                "summary": arguments["summary"],
            }
        assert tool_name == "erp.finance.get_receivables_aging"
        return {
            "period": arguments["period"],
            "overdue_days": arguments["overdue_days"],
            "items": [
                {
                    "customer": "华东客户 A",
                    "amount": 180000,
                    "currency": "CNY",
                    "overdue_days": 42,
                    "owner": "销售一部",
                }
            ],
            "sources": ["ERP_AR_AGING"],
        }


class VerifyingAssociateGateway(ExecutableAssociateGateway):
    def status(self):
        status = super().status()
        status["tool_names"].append("erp.collection_task.get_status")
        status["tools"].append({"name": "erp.collection_task.get_status"})
        return status

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "erp.collection_task.create_draft":
            return {
                "external_task_id": "collection-task-001",
                "external_status": "draft_created",
                "summary": arguments["summary"],
            }
        if tool_name == "erp.collection_task.get_status":
            return {
                "external_task_id": arguments["external_task_id"],
                "external_status": "draft_created",
            }
        assert tool_name == "erp.finance.get_receivables_aging"
        return {
            "period": arguments["period"],
            "overdue_days": arguments["overdue_days"],
            "items": [
                {
                    "customer": "华东客户 A",
                    "amount": 180000,
                    "currency": "CNY",
                    "overdue_days": 42,
                    "owner": "销售一部",
                }
            ],
            "sources": ["ERP_AR_AGING"],
        }


class InconclusiveReadbackAssociateGateway(VerifyingAssociateGateway):
    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "erp.collection_task.create_draft":
            return {"external_task_id": "collection-task-001"}
        if tool_name == "erp.collection_task.get_status":
            return {"external_task_id": arguments["external_task_id"]}
        assert tool_name == "erp.finance.get_receivables_aging"
        return {
            "period": arguments["period"],
            "overdue_days": arguments["overdue_days"],
            "items": [],
            "sources": ["ERP_AR_AGING"],
        }


class FailingReadbackAssociateGateway(VerifyingAssociateGateway):
    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "erp.collection_task.get_status":
            raise ErpMcpError(
                "mcp_call_failed",
                "华东客户 A 应收 180000 读回失败",
                retryable=True,
            )
        return super().call_tool(tool_name, arguments)


def test_associate_receivables_recovery_uses_skill_model_erp_mcp_and_structured_plan():
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=ConnectedAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        period="2026-06",
        goal_text="把逾期 30 天以上应收金额降低 20%",
    )

    assert run.status == "ready"
    assert run.plan is not None
    assert run.plan.nodes[0].title == "核对逾期应收清单"
    assert run.plan.nodes[1].blocker == "需要用户确认催收口径"
    assert run.plan.nodes[1].write_intent is not None
    assert [event.type for event in run.audit_events] == [
        "associate.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "model.call.started",
        "model.call.completed",
        "associate.plan.emitted",
    ]
    completed_events = [
        event for event in run.audit_events if event.type == "model.call.completed"
    ]
    assert completed_events[0].payload["finish_reason"] == "tool_calls"
    assert completed_events[0].payload["tool_call_count"] == 1
    assert completed_events[0].payload["requested_tool_names"] == [
        "erp.finance.get_receivables_aging"
    ]
    assert completed_events[1].payload["finish_reason"] == "tool_calls"
    assert completed_events[1].payload["tool_call_count"] == 1
    assert completed_events[1].payload["requested_tool_names"] == [
        "associate.emit_goal_plan"
    ]


def test_associate_receivables_recovery_fails_clearly_without_model_config():
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=ConnectedAssociateGateway(),
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    orchestrator.model_provider.settings = RuntimeSettings()

    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")

    assert run.status == "failed"
    assert run.error_code == "model_not_configured"
    assert run.plan is None


def test_associate_node_execution_requires_approval_before_mcp_write():
    gateway = ExecutableAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")

    pending = orchestrator.request_node_execution(
        run.id,
        "n2",
        requested_by="u_demo",
    )

    node = pending.plan.nodes[1]
    assert node.approval is not None
    assert node.approval.status == "pending"
    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]

    approved = orchestrator.approve_node_execution(
        node.approval.id,
        approved_by="u_demo",
    )

    executed_node = approved.plan.nodes[1]
    assert executed_node.status == "verify_pending"
    assert executed_node.approval.status == "approved"
    assert executed_node.write_action is not None
    assert executed_node.write_action.status == "success"
    assert executed_node.write_action.verify_status == "verify_pending"
    assert executed_node.write_action.external_task_id == "collection-task-001"
    assert [call[0] for call in gateway.calls] == [
        "erp.finance.get_receivables_aging",
        "erp.collection_task.create_draft",
    ]
    write_arguments = gateway.calls[1][1]
    assert write_arguments["workspace_id"] == "demo"
    assert write_arguments["actor_user_id"] == "u_demo"
    assert write_arguments["node_id"] == "n2"
    assert write_arguments["summary"] == "为华东客户 A 创建催收跟进任务草案。"
    event_types = [event.type for event in approved.audit_events]
    assert "associate.node.approval.requested" in event_types
    assert "associate.node.approval.approved" in event_types
    assert "associate.node.verify_pending" in event_types


def test_associate_node_execution_reads_back_status_when_tool_is_available():
    gateway = VerifyingAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")

    approved = orchestrator.approve_node_execution(
        pending.plan.nodes[1].approval.id,
        approved_by="u_demo",
    )

    node = approved.plan.nodes[1]
    assert node.status == "completed"
    assert node.write_action.verify_status == "verified"
    assert [call[0] for call in gateway.calls] == [
        "erp.finance.get_receivables_aging",
        "erp.collection_task.create_draft",
        "erp.collection_task.get_status",
    ]
    readback_arguments = gateway.calls[2][1]
    assert readback_arguments["workspace_id"] == "demo"
    assert readback_arguments["actor_user_id"] == "u_demo"
    assert readback_arguments["external_task_id"] == "collection-task-001"
    event_types = [event.type for event in approved.audit_events]
    assert "associate.node.verified" in event_types


def test_associate_node_readback_requires_non_empty_status_match_before_completion():
    gateway = InconclusiveReadbackAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")

    approved = orchestrator.approve_node_execution(
        pending.plan.nodes[1].approval.id,
        approved_by="u_demo",
    )

    node = approved.plan.nodes[1]
    assert node.status == "verify_pending"
    assert node.write_action.verify_status == "verify_pending"
    event_types = [event.type for event in approved.audit_events]
    assert "associate.node.verified" not in event_types
    assert "associate.node.verify_pending" in event_types


def test_associate_readback_failure_audit_redacts_raw_erp_error_message():
    gateway = FailingReadbackAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")

    approved = orchestrator.approve_node_execution(
        pending.plan.nodes[1].approval.id,
        approved_by="u_demo",
    )

    audit_json = json.dumps(
        [event.model_dump(mode="json") for event in approved.audit_events],
        ensure_ascii=False,
    )
    assert "华东客户 A" not in audit_json
    assert "180000" not in audit_json
    failed_readback = [
        event
        for event in approved.audit_events
        if event.type == "mcp.tool.called"
        and event.payload.get("tool_name") == "erp.collection_task.get_status"
        and event.payload.get("status") == "failed"
    ][0]
    assert failed_readback.payload["error"] == {
        "error_code": "mcp_call_failed",
        "message": "ERP MCP tool call failed",
        "retryable": True,
    }


def test_associate_node_execution_duplicate_approval_does_not_write_twice():
    gateway = ExecutableAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")
    approval_id = pending.plan.nodes[1].approval.id

    first = orchestrator.approve_node_execution(approval_id, approved_by="u_demo")
    second = orchestrator.approve_node_execution(approval_id, approved_by="u_demo")

    assert first.plan.nodes[1].write_action.id == second.plan.nodes[1].write_action.id
    assert [call[0] for call in gateway.calls] == [
        "erp.finance.get_receivables_aging",
        "erp.collection_task.create_draft",
    ]


def test_associate_node_execution_rejects_node_snapshot_drift_before_write():
    gateway = ExecutableAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")
    node = pending.plan.nodes[1]
    approval_id = node.approval.id
    node.write_intent.summary = "被篡改的催收任务草案。"

    try:
        orchestrator.approve_node_execution(approval_id, approved_by="u_demo")
    except ValueError as exc:
        assert str(exc) == "approval node snapshot mismatch"
    else:
        raise AssertionError("approval should reject changed node snapshot")

    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]


def test_associate_node_execution_rejects_approval_action_drift_before_write():
    gateway = ExecutableAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")
    approval = pending.plan.nodes[1].approval
    approval.action_type = "erp.finance.query"

    try:
        orchestrator.approve_node_execution(approval.id, approved_by="u_demo")
    except ValueError as exc:
        assert str(exc) == "approval action mismatch"
    else:
        raise AssertionError("approval should reject changed action type")

    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]


def test_associate_node_execution_reject_does_not_call_mcp_write():
    gateway = ExecutableAssociateGateway()
    orchestrator = AssociateReceivablesOrchestrator(
        adapter=gateway,
        model_provider=ReceivablesRecoveryModelProvider(),
        skill_loader=SkillLoader(project_root=Path.cwd()),
    )
    run = orchestrator.start_run("demo", "u_demo", "2026-06", "降低逾期应收")
    pending = orchestrator.request_node_execution(run.id, "n2", requested_by="u_demo")
    approval_id = pending.plan.nodes[1].approval.id

    rejected = orchestrator.reject_node_execution(
        approval_id,
        rejected_by="u_demo",
    )

    node = rejected.plan.nodes[1]
    assert node.status == "blocked"
    assert node.approval.status == "rejected"
    assert node.write_action is None
    assert [call[0] for call in gateway.calls] == ["erp.finance.get_receivables_aging"]
