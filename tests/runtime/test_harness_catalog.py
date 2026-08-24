import json

from services.runtime.app.config import RuntimeSettings
from services.runtime.app.harness_catalog import build_harness_catalog


def test_harness_catalog_declares_domain_skills_tools_and_write_boundaries():
    catalog = build_harness_catalog(RuntimeSettings())

    assert catalog["summary"] == {
        "domain_count": 5,
        "model_backed_domain_count": 5,
        "mcp_dependent_domain_count": 3,
        "backend_write_tool_count": 2,
        "approval_required_write_count": 2,
    }
    assert [domain["id"] for domain in catalog["domains"]] == [
        "chat.general_assistant",
        "cowork.reimbursement",
        "cowork.hiker",
        "cowork.associate_receivables",
        "create.capability_draft",
    ]

    reimbursement = next(
        domain for domain in catalog["domains"] if domain["id"] == "cowork.reimbursement"
    )
    assert reimbursement["skill_id"] == "reimbursement/travel-expense"
    assert reimbursement["mcp_dependencies"] == ["reimbursement_mcp"]
    assert reimbursement["model_visible_tools"] == [
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit_intent",
        "reimbursement.get_status",
    ]
    assert reimbursement["backend_write_tools"] == ["reimbursement.submit"]
    assert reimbursement["approval_required_for_writes"] is True

    associate = next(
        domain for domain in catalog["domains"] if domain["id"] == "cowork.associate_receivables"
    )
    assert associate["backend_write_tools"] == ["erp.collection_task.create_draft"]
    assert associate["mcp_dependencies"] == ["erp_mcp"]

    hiker = next(domain for domain in catalog["domains"] if domain["id"] == "cowork.hiker")
    assert hiker["mcp_dependencies"] == ["hiker_mcp"]
    assert hiker["backend_write_tools"] == []

    chat = next(domain for domain in catalog["domains"] if domain["id"] == "chat.general_assistant")
    assert chat["model_visible_tools"] == []
    assert chat["writes_external_data"] is False


def test_harness_catalog_never_returns_configured_secrets_or_endpoint_values():
    catalog = build_harness_catalog(
        RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="model-secret",
            reimbursement_mcp_server="https://reimbursement.example/mcp?token=secret",
            reimbursement_mcp_api_key="reimbursement-secret",
            erp_mcp_server="https://erp.example/mcp?access_token=secret",
            erp_mcp_api_key="erp-secret",
        )
    )

    dumped = json.dumps(catalog, ensure_ascii=False)
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "model.example" not in dumped
    assert "reimbursement.example" not in dumped
    assert "erp.example" not in dumped
    assert catalog["connectors"] == [
        {
            "id": "model",
            "type": "model_provider",
            "configured": True,
            "secret_configured": True,
        },
        {
            "id": "reimbursement_mcp",
            "type": "mcp_connector",
            "configured": True,
            "secret_configured": True,
        },
        {
            "id": "erp_mcp",
            "type": "mcp_connector",
            "configured": True,
            "secret_configured": True,
        },
        {
            "id": "hiker_mcp",
            "type": "mcp_connector",
            "configured": False,
            "secret_configured": False,
        },
    ]
