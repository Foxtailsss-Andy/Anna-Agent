from services.runtime.app.reimbursement_tool_registry import ReimbursementToolRegistry


def test_dispatch_kinds():
    reg = ReimbursementToolRegistry()
    assert reg.dispatch_kind("reimbursement.list_approvals") == "mcp_tool"
    assert reg.dispatch_kind("reimbursement.get_approval") == "mcp_tool"
    assert reg.dispatch_kind("reimbursement.approve_intent") == "approval_action_intent"
    assert reg.dispatch_kind("reimbursement.reject_intent") == "approval_action_intent"
    assert reg.dispatch_kind("reimbursement.submit_intent") == "approval_intent"


def test_model_visible_tools_include_approval_reads_with_schemas():
    reg = ReimbursementToolRegistry()
    tools = {t["name"]: t for t in reg.model_visible_tools()}
    assert "reimbursement.list_approvals" in tools
    assert tools["reimbursement.approve_intent"]["input_schema"]["required"] == ["approval_id"]
    assert "reason" in tools["reimbursement.reject_intent"]["input_schema"]["required"]
