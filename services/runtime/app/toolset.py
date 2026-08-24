REIMBURSEMENT_ALLOWED_TOOLS = frozenset(
    {
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit_intent",
        "reimbursement.get_status",
        "reimbursement.list_approvals",
        "reimbursement.get_approval",
        "reimbursement.approve_intent",
        "reimbursement.reject_intent",
    }
)


def assert_model_visible_tool_allowed(tool_name: str) -> None:
    if tool_name not in REIMBURSEMENT_ALLOWED_TOOLS:
        raise PermissionError(f"tool is not available in reimbursement runtime: {tool_name}")
