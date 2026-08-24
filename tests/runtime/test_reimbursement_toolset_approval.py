from services.runtime.app.toolset import (
    REIMBURSEMENT_ALLOWED_TOOLS,
    assert_model_visible_tool_allowed,
)


def test_read_and_intent_tools_are_model_visible():
    for name in [
        "reimbursement.list_approvals",
        "reimbursement.get_approval",
        "reimbursement.approve_intent",
        "reimbursement.reject_intent",
    ]:
        assert name in REIMBURSEMENT_ALLOWED_TOOLS
        assert_model_visible_tool_allowed(name)  # no raise


def test_backend_only_writes_are_not_model_visible():
    assert "reimbursement.approve" not in REIMBURSEMENT_ALLOWED_TOOLS
    assert "reimbursement.reject" not in REIMBURSEMENT_ALLOWED_TOOLS
