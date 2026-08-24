from fastapi.testclient import TestClient

import json

from services.api.app.main import create_app
from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.create.app.schemas import CreateSandboxResult
from services.hiker.app.orchestrator import HikerOrchestrator
from services.memory.app.store import BusinessMemoryStore
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import ModelResponse


class ReadyHikerAdapter:
    settings = RuntimeSettings(
        hiker_mcp_server="https://hiker.example/rpc",
        hiker_mcp_api_key="hiker-secret",
    )

    def status(self):
        return {
            "status": "connected",
            "server": self.settings.hiker_mcp_server,
            "tool_count": 1,
            "tool_names": ["hiker.report.get_dashboard_summary"],
        }

    def call_tool(self, tool_name, arguments):
        raise AssertionError("governance readiness tests must not execute Hiker tools")


def test_admin_governance_status_reports_tool_memory_and_fixture_runner(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    memory_store.add(
        workspace_id="demo",
        memory_type="field_definition",
        title="应收逾期字段",
        content="overdue_days 表示客户应收账款已经逾期的自然日数。",
        source="admin",
    )
    client = TestClient(create_app(memory_store=memory_store))

    response = client.get("/api/admin/governance/status")

    assert response.status_code == 200
    body = response.json()
    registry_ids = [registry["id"] for registry in body["tool_registries"]]
    assert registry_ids == ["associate", "create", "reimbursement"]
    associate_registry = body["tool_registries"][0]
    assert associate_registry["read_write"] == "mixed"
    assert associate_registry["write_tools"] == ["erp.collection_task.create_draft"]
    assert body["memory"]["status"] == "available"
    assert body["memory"]["business_memory_count"] == 1
    assert body["fixture_runner"] == {
        "status": "available",
        "runner": "CreateToolSandbox",
        "workspace_root_configured": True,
        "production_secrets_injected": False,
        "secret_boundary": "subprocess_env_allowlist",
        "preflight_policy": "ast_import_and_side_effect_preflight",
        "timeout_enforced": True,
        "output_limited": True,
        "env_allowlist": ["PYTHONIOENCODING"],
        "timeout_seconds": 5,
        "max_output_bytes": 8192,
        "last_probe_status": "not_run",
        "hardened_sandbox": False,
        "network_isolated": False,
    }


def test_harness_v2_capabilities_and_unsupported_surface_are_explicit():
    client = TestClient(create_app())

    capabilities = client.get("/api/harness/v2/capabilities")

    assert capabilities.status_code == 200
    assert capabilities.json() == {
        "api_version": "harness-v2",
        "status": "partial",
        "review_gate": {
            "status": "blocked",
            "reason": "real_review_approval_bridge_not_implemented",
            "owner": "unverified",
            "provider": "unverified",
            "live_evidence": "unverified",
        },
        "completed_prerequisites": ["desktop_decision_to_resume"],
        "unsupported_capabilities": {
            "web_search": {
                "status": "unsupported",
                "reason": "provider_connector_not_implemented",
            },
        },
        "surfaces": [
            {
                "id": surface_id,
                "status": "unsupported",
                "legacy_status": "available",
                "reason": "v2_bridge_not_implemented",
                "required_before_enable": [
                    "production_runtime_consumer",
                    "real_provider_evidence",
                ],
            }
            for surface_id in ["create", "cowork", "hub"]
        ],
    }

    response = client.post("/api/harness/v2/surfaces/create/runs", json={"goal": "draft"})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "legacy_surface_not_migrated",
        "surface_id": "create",
        "status": "unsupported",
        "reason": "v2_bridge_not_implemented",
        "message": "The v2 Runtime bridge is not available for this surface.",
    }


def test_admin_business_memory_can_create_and_search(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    client = TestClient(create_app(memory_store=memory_store))

    create_response = client.post(
        "/api/admin/memory/business",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "demo",
            "memory_type": "business_rule",
            "title": "逾期应收催收规则",
            "content": "逾期超过 30 天且金额大于 10 万时进入高优先级催收。",
            "source": "finance-admin",
            "confidence": 0.95,
        },
    )

    assert create_response.status_code == 200
    created = create_response.json()
    assert created["title"] == "逾期应收催收规则"

    list_response = client.get(
        "/api/admin/memory/business",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        params={"workspace_id": "demo", "query": "高优先级催收"},
    )

    assert list_response.status_code == 200
    body = list_response.json()
    assert [item["id"] for item in body["items"]] == [created["id"]]
    assert body["count"] == 1


def test_admin_business_memory_rejects_cross_workspace_access(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    client = TestClient(create_app(memory_store=memory_store))

    create_response = client.post(
        "/api/admin/memory/business",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        json={
            "workspace_id": "other-workspace",
            "memory_type": "business_rule",
            "title": "越权规则",
            "content": "不应写入另一个 workspace。",
            "source": "test",
            "confidence": 1,
        },
    )

    assert create_response.status_code == 403

    list_response = client.get(
        "/api/admin/memory/business",
        headers={"X-Anna-Workspace-ID": "demo", "X-Anna-User-ID": "u_demo"},
        params={"workspace_id": "other-workspace"},
    )

    assert list_response.status_code == 403


def test_admin_tool_catalog_exposes_model_visible_and_backend_only_boundaries():
    client = TestClient(create_app())

    response = client.get("/api/admin/tool-registry/catalog")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"] == {
        "registry_count": 3,
        "model_visible_tool_count": 15,
        "backend_only_tool_count": 2,
        "confirmation_required_count": 3,
        "external_write_tool_count": 2,
    }

    reimbursement_submit = next(
        item for item in body["backend_only_tools"] if item["name"] == "reimbursement.submit"
    )
    assert reimbursement_submit == {
        "name": "reimbursement.submit",
        "registry_id": "reimbursement",
        "description": "Submit an approved external reimbursement draft.",
        "read_write": "write",
        "risk_level": "high",
        "requires_confirmation": True,
        "visibility": "backend_only",
    }
    associate_write = next(
        item
        for item in body["backend_only_tools"]
        if item["name"] == "erp.collection_task.create_draft"
    )
    assert associate_write["registry_id"] == "associate"
    assert associate_write["requires_confirmation"] is True

    create_skill = next(
        item for item in body["model_visible_tools"] if item["name"] == "create.emit_skill_draft"
    )
    assert create_skill["registry_id"] == "create"
    assert create_skill["read_write"] == "internal"
    assert create_skill["visibility"] == "model_visible"
    assert create_skill["requires_confirmation"] is False

    submit_intent = next(
        item for item in body["model_visible_tools"] if item["name"] == "reimbursement.submit_intent"
    )
    assert submit_intent["requires_confirmation"] is True
    assert submit_intent["risk_level"] == "medium"


def test_admin_harness_catalog_exposes_domain_contracts_without_secrets():
    orchestrator = ReimbursementOrchestrator(
        settings=RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="model-secret",
            reimbursement_mcp_server="https://reimbursement.example/mcp?token=secret",
            reimbursement_mcp_api_key="reimbursement-secret",
            erp_mcp_server="https://erp.example/mcp?access_token=secret",
            erp_mcp_api_key="erp-secret",
        )
    )
    client = TestClient(create_app(orchestrator=orchestrator))

    response = client.get("/api/admin/harness/catalog")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["domain_count"] == 5
    assert body["summary"]["backend_write_tool_count"] == 2
    assert [domain["id"] for domain in body["domains"]] == [
        "chat.general_assistant",
        "cowork.reimbursement",
        "cowork.hiker",
        "cowork.associate_receivables",
        "create.capability_draft",
    ]
    assert body["connectors"][0] == {
        "id": "model",
        "type": "model_provider",
        "configured": True,
        "secret_configured": True,
    }
    dumped = response.text
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "model.example" not in dumped
    assert "reimbursement.example" not in dumped
    assert "erp.example" not in dumped


def test_admin_domain_readiness_matrix_reports_default_blockers_without_secrets(
    monkeypatch,
    tmp_path,
):
    for key in [
        "ANNA_MODEL_ENDPOINT",
        "ANNA_MODEL_API_KEY",
        "ANNA_REIMBURSEMENT_MCP_SERVER",
        "ANNA_REIMBURSEMENT_MCP_API_KEY",
        "ANNA_ERP_MCP_SERVER",
        "ANNA_ERP_MCP_API_KEY",
        "ANNA_STATE_DB_PATH",
        "ANNA_RUNTIME_CONFIG_PATH",
    ]:
        monkeypatch.delenv(key, raising=False)
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                settings=RuntimeSettings(state_db_path=str(tmp_path / "empty-state.sqlite3")),
            )
        )
    )

    response = client.get("/api/admin/harness/domain-readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["writes_external_data"] is False
    assert body["summary"] == {
        "domain_count": 5,
        "ready_count": 0,
        "blocked_count": 5,
        "needs_validation_count": 0,
        "unknown_count": 0,
        "external_write_domain_count": 2,
        "approval_required_domain_count": 2,
    }
    assert [domain["domain_id"] for domain in body["domains"]] == [
        "chat.general_assistant",
        "cowork.reimbursement",
        "cowork.hiker",
        "cowork.associate_receivables",
        "create.capability_draft",
    ]
    chat = body["domains"][0]
    assert chat["readiness_status"] == "blocked"
    assert chat["model_status"] == "not_configured"
    assert "model_not_configured" in chat["blocking_reasons"]
    reimbursement = next(
        domain for domain in body["domains"] if domain["domain_id"] == "cowork.reimbursement"
    )
    assert reimbursement["connector_statuses"]["reimbursement_mcp"] == "not_configured"
    assert "reimbursement_mcp_not_configured" in reimbursement["blocking_reasons"]
    assert reimbursement["writes_external_data"] is True
    assert reimbursement["approval_required_for_writes"] is True
    dumped = response.text
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "model.example" not in dumped
    assert "reimbursement.example" not in dumped
    assert "erp.example" not in dumped


def test_admin_domain_readiness_matrix_projects_latest_runtime_validation(tmp_path):
    class ReadyModelProvider:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                model_endpoint="https://model.example/v1/chat/completions",
                model_api_key="model-secret",
                model_name="mimo-v2.5-pro",
                state_db_path=str(tmp_path / "domain-readiness.sqlite3"),
            )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ReadyReimbursementAdapter:
        settings = RuntimeSettings(
            reimbursement_mcp_server="https://reimbursement.example/rpc",
            reimbursement_mcp_api_key="reimbursement-secret",
        )

        def status(self):
            return {
                "status": "connected",
                "server": self.settings.reimbursement_mcp_server,
                "tool_count": 6,
                "tool_names": [
                    "reimbursement.get_capabilities",
                    "reimbursement.get_policy",
                    "reimbursement.validate_draft",
                    "reimbursement.create_draft",
                    "reimbursement.submit",
                    "reimbursement.get_status",
                ],
                "tools": _tools_with_submit_snapshot_contract(),
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {
                    "valid": True,
                    "missing_fields": [],
                    "policy_summary": "tenant-specific probe accepted",
                    "risk_level": "low",
                }
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class ReadyErpAdapter:
        settings = RuntimeSettings(
            erp_mcp_server="https://erp.example/rpc",
            erp_mcp_api_key="erp-secret",
        )

        def status(self):
            return {
                "status": "connected",
                "server": self.settings.erp_mcp_server,
                "tool_count": 3,
                "tool_names": [
                    "erp.finance.get_receivables_aging",
                    "erp.collection_task.create_draft",
                    "erp.collection_task.get_status",
                ],
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError("domain readiness must not execute ERP tools")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ReadyModelProvider(),
                adapter=ReadyReimbursementAdapter(),
                settings=RuntimeSettings(state_db_path=str(tmp_path / "domain-readiness.sqlite3")),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ReadyErpAdapter()),
            hiker_orchestrator=HikerOrchestrator(adapter=ReadyHikerAdapter()),
        )
    )

    validation_response = client.post("/api/admin/runtime/validate")
    response = client.get("/api/admin/harness/domain-readiness")

    assert validation_response.status_code == 200
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["ready_count"] == 5
    assert body["summary"]["blocked_count"] == 0
    assert {domain["readiness_status"] for domain in body["domains"]} == {"ready"}
    assert {domain["latest_validation_id"] for domain in body["domains"]} == {"validation_001"}
    assert {domain["evidence_source"] for domain in body["domains"]} == {
        "latest_runtime_validation"
    }
    reimbursement = next(
        domain for domain in body["domains"] if domain["domain_id"] == "cowork.reimbursement"
    )
    assert reimbursement["tool_contract_status"] == "passed"
    assert reimbursement["connector_statuses"]["reimbursement_mcp"] == "connected"
    associate = next(
        domain for domain in body["domains"] if domain["domain_id"] == "cowork.associate_receivables"
    )
    assert associate["connector_statuses"]["erp_mcp"] == "passed"
    dumped = response.text
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "model.example" not in dumped
    assert "reimbursement.example" not in dumped
    assert "erp.example" not in dumped
    assert "tenant-specific probe accepted" not in dumped


def test_admin_domain_readiness_matrix_blocks_stale_ready_validation_when_current_config_missing(tmp_path):
    state_db_path = str(tmp_path / "stale-domain-readiness.sqlite3")

    class ReadyModelProvider:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                model_endpoint="https://model.example/v1/chat/completions",
                model_api_key="model-secret",
                model_name="mimo-v2.5-pro",
                state_db_path=state_db_path,
            )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ReadyReimbursementAdapter:
        settings = RuntimeSettings(
            reimbursement_mcp_server="https://reimbursement.example/rpc",
            reimbursement_mcp_api_key="reimbursement-secret",
        )

        def status(self):
            return {
                "status": "connected",
                "tool_count": 6,
                "tool_names": [
                    "reimbursement.get_capabilities",
                    "reimbursement.get_policy",
                    "reimbursement.validate_draft",
                    "reimbursement.create_draft",
                    "reimbursement.submit",
                    "reimbursement.get_status",
                ],
                "tools": _tools_with_submit_snapshot_contract(),
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class ReadyErpAdapter:
        settings = RuntimeSettings(erp_mcp_server="https://erp.example/rpc")

        def status(self):
            return {
                "status": "connected",
                "tool_count": 3,
                "tool_names": [
                    "erp.finance.get_receivables_aging",
                    "erp.collection_task.create_draft",
                    "erp.collection_task.get_status",
                ],
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError("runtime validation ERP readiness must use tools/list only")

    ready_client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ReadyModelProvider(),
                adapter=ReadyReimbursementAdapter(),
                settings=RuntimeSettings(state_db_path=state_db_path),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ReadyErpAdapter()),
            hiker_orchestrator=HikerOrchestrator(adapter=ReadyHikerAdapter()),
        )
    )
    assert ready_client.post("/api/admin/runtime/validate").json()["status"] == "ready"

    stale_client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                settings=RuntimeSettings(state_db_path=state_db_path),
            )
        )
    )

    response = stale_client.get("/api/admin/harness/domain-readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["ready_count"] == 0
    assert body["summary"]["blocked_count"] == 5
    chat = next(domain for domain in body["domains"] if domain["domain_id"] == "chat.general_assistant")
    assert chat["latest_validation_id"] == "validation_001"
    assert chat["evidence_source"] == "latest_runtime_validation"
    assert chat["model_status"] == "not_configured"
    assert "model_not_configured" in chat["blocking_reasons"]
    reimbursement = next(
        domain for domain in body["domains"] if domain["domain_id"] == "cowork.reimbursement"
    )
    assert "reimbursement_mcp_not_configured" in reimbursement["blocking_reasons"]

    checklist_response = stale_client.get("/api/admin/live-validation/checklist")

    assert checklist_response.status_code == 200
    checklist_steps = {step["id"]: step for step in checklist_response.json()["steps"]}
    assert checklist_steps["domain_readiness"]["status"] == "blocked"
    assert checklist_steps["domain_readiness"]["evidence_id"] == "validation_001"
    assert checklist_steps["validation_report"]["status"] == "blocked"
    assert checklist_steps["validation_report"]["evidence_id"] == "validation_001"


def test_admin_domain_readiness_matrix_requires_revalidation_after_config_change(tmp_path):
    state_db_path = str(tmp_path / "changed-config-domain-readiness.sqlite3")

    class ReadyModelProvider:
        def __init__(self, endpoint: str) -> None:
            self.settings = RuntimeSettings(
                model_endpoint=endpoint,
                model_api_key="model-secret",
                model_name="mimo-v2.5-pro",
                state_db_path=state_db_path,
            )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ReadyReimbursementAdapter:
        def __init__(self, server: str) -> None:
            self.settings = RuntimeSettings(
                reimbursement_mcp_server=server,
                reimbursement_mcp_api_key="reimbursement-secret",
            )

        def status(self):
            return {
                "status": "connected",
                "tool_count": 6,
                "tool_names": [
                    "reimbursement.get_capabilities",
                    "reimbursement.get_policy",
                    "reimbursement.validate_draft",
                    "reimbursement.create_draft",
                    "reimbursement.submit",
                    "reimbursement.get_status",
                ],
                "tools": _tools_with_submit_snapshot_contract(),
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class ReadyErpAdapter:
        def __init__(self, server: str) -> None:
            self.settings = RuntimeSettings(
                erp_mcp_server=server,
                erp_mcp_api_key="erp-secret",
            )

        def status(self):
            return {
                "status": "connected",
                "tool_count": 3,
                "tool_names": [
                    "erp.finance.get_receivables_aging",
                    "erp.collection_task.create_draft",
                    "erp.collection_task.get_status",
                ],
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError("runtime validation ERP readiness must use tools/list only")

    ready_client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ReadyModelProvider("https://model-a.example/v1/chat/completions"),
                adapter=ReadyReimbursementAdapter("https://reimbursement-a.example/rpc"),
                settings=RuntimeSettings(state_db_path=state_db_path),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=ReadyErpAdapter("https://erp-a.example/rpc")
            ),
            hiker_orchestrator=HikerOrchestrator(adapter=ReadyHikerAdapter()),
        )
    )
    assert ready_client.post("/api/admin/runtime/validate").json()["status"] == "ready"

    changed_client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ReadyModelProvider("https://model-b.example/v1/chat/completions"),
                adapter=ReadyReimbursementAdapter("https://reimbursement-b.example/rpc"),
                settings=RuntimeSettings(state_db_path=state_db_path),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=ReadyErpAdapter("https://erp-b.example/rpc")
            ),
            hiker_orchestrator=HikerOrchestrator(adapter=ReadyHikerAdapter()),
        )
    )

    response = changed_client.get("/api/admin/harness/domain-readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["ready_count"] == 0
    assert body["summary"]["needs_validation_count"] == 5
    assert {domain["readiness_status"] for domain in body["domains"]} == {
        "needs_validation"
    }
    assert {domain["latest_validation_id"] for domain in body["domains"]} == {"validation_001"}
    assert {
        "runtime_validation_config_changed"
        for domain in body["domains"]
        for reason in domain["blocking_reasons"]
        if reason == "runtime_validation_config_changed"
    } == {"runtime_validation_config_changed"}
    dumped = response.text
    assert "model-a.example" not in dumped
    assert "model-b.example" not in dumped
    assert "reimbursement-a.example" not in dumped
    assert "reimbursement-b.example" not in dumped
    assert "erp-a.example" not in dumped
    assert "erp-b.example" not in dumped
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped

    checklist_response = changed_client.get("/api/admin/live-validation/checklist")

    assert checklist_response.status_code == 200
    checklist_steps = {step["id"]: step for step in checklist_response.json()["steps"]}
    assert checklist_steps["domain_readiness"]["status"] == "needs_validation"
    assert checklist_steps["domain_readiness"]["evidence_id"] == "validation_001"
    assert checklist_steps["validation_report"]["status"] == "needs_validation"
    assert checklist_steps["validation_report"]["evidence_id"] == "validation_001"


def test_admin_live_validation_checklist_reports_safe_default_blockers(
    monkeypatch,
    tmp_path,
):
    for key in [
        "ANNA_MODEL_ENDPOINT",
        "ANNA_MODEL_API_KEY",
        "ANNA_REIMBURSEMENT_MCP_SERVER",
        "ANNA_REIMBURSEMENT_MCP_API_KEY",
        "ANNA_ERP_MCP_SERVER",
        "ANNA_ERP_MCP_API_KEY",
        "ANNA_LIVE_REIMBURSEMENT_INPUT",
        "ANNA_LIVE_ALLOW_EXTERNAL_WRITES",
        "ANNA_RUNTIME_CONFIG_PATH",
        "ANNA_STATE_DB_PATH",
    ]:
        monkeypatch.delenv(key, raising=False)
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                settings=RuntimeSettings(state_db_path=str(tmp_path / "live-checklist.sqlite3")),
            )
        )
    )

    response = client.get("/api/admin/live-validation/checklist")

    assert response.status_code == 200
    body = response.json()
    assert body["writes_external_data"] is False
    assert body["command"] == "npm run live:e2e"
    assert body["summary"] == {
        "step_count": 9,
        "ready_count": 0,
        "blocked_count": 6,
        "manual_required_count": 3,
        "needs_validation_count": 0,
    }
    assert [step["id"] for step in body["steps"]] == [
        "runtime_configuration",
        "model_credentials",
        "reimbursement_mcp_credentials",
        "hiker_mcp_credentials",
        "erp_mcp_credentials",
        "domain_readiness",
        "validation_report",
        "live_input",
        "external_write_authorization",
    ]
    steps = {step["id"]: step for step in body["steps"]}
    assert steps["model_credentials"]["status"] == "blocked"
    assert steps["model_credentials"]["reason"] == "model_not_configured"
    assert steps["domain_readiness"]["status"] == "blocked"
    assert steps["validation_report"]["status"] == "blocked"
    assert steps["live_input"]["status"] == "manual_required"
    assert steps["live_input"]["env_var"] == "ANNA_LIVE_REIMBURSEMENT_INPUT"
    assert steps["external_write_authorization"]["status"] == "manual_required"
    assert steps["external_write_authorization"]["env_var"] == "ANNA_LIVE_ALLOW_EXTERNAL_WRITES"
    dumped = response.text
    assert "live reimbursement input" not in dumped.lower()
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped


def test_admin_live_validation_runners_report_all_commands_without_secret_values(
    monkeypatch,
    tmp_path,
):
    for key in [
        "ANNA_MODEL_ENDPOINT",
        "ANNA_MODEL_API_KEY",
        "ANNA_REIMBURSEMENT_MCP_SERVER",
        "ANNA_REIMBURSEMENT_MCP_API_KEY",
        "ANNA_ERP_MCP_SERVER",
        "ANNA_ERP_MCP_API_KEY",
        "ANNA_LIVE_REIMBURSEMENT_INPUT",
        "ANNA_LIVE_REIMBURSEMENT_ATTACHMENT_PATHS_JSON",
        "ANNA_LIVE_ASSOCIATE_PERIOD",
        "ANNA_LIVE_ASSOCIATE_GOAL",
        "ANNA_LIVE_ASSOCIATE_NODE_ID",
        "ANNA_LIVE_CREATE_SKILL_BRIEF",
        "ANNA_LIVE_CREATE_PROMPT_BRIEF",
        "ANNA_LIVE_CREATE_PYTHON_TOOL_BRIEF",
        "ANNA_LIVE_CREATE_DRAFTS",
        "ANNA_LIVE_CHAT_MESSAGE",
        "ANNA_LIVE_CHAT_TEMPLATE_ID",
        "ANNA_LIVE_ALLOW_EXTERNAL_WRITES",
        "ANNA_RUNTIME_CONFIG_PATH",
        "ANNA_STATE_DB_PATH",
    ]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ANNA_MODEL_API_KEY", "model-secret")
    monkeypatch.setenv("ANNA_ERP_MCP_API_KEY", "erp-secret")
    monkeypatch.setenv("ANNA_LIVE_CHAT_MESSAGE", "operator chat message must stay private")

    class ReadOnlyAdapter:
        settings = RuntimeSettings(
            erp_mcp_server="https://erp.example/rpc?access_token=secret",
            erp_mcp_api_key="erp-secret",
        )

        def status(self):
            return {"status": "not_configured", "tool_names": []}

        def call_tool(self, tool_name, arguments):
            raise AssertionError("live runner catalog must not execute ERP tools")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                settings=RuntimeSettings(state_db_path=str(tmp_path / "live-runners.sqlite3")),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ReadOnlyAdapter()),
            hiker_orchestrator=HikerOrchestrator(adapter=ReadyHikerAdapter()),
        )
    )

    response = client.get("/api/admin/live-validation/runners")

    assert response.status_code == 200
    body = response.json()
    assert body["writes_external_data"] is False
    assert body["summary"]["runner_count"] == 5
    assert body["summary"]["external_write_runner_count"] == 2
    assert [runner["id"] for runner in body["runners"]] == [
        "t07-review-to-validated-patch",
        "reimbursement",
        "associate",
        "create",
        "chat",
    ]
    commands = {runner["id"]: runner["command"] for runner in body["runners"]}
    assert commands == {
        "t07-review-to-validated-patch": "npm run live:t07",
        "reimbursement": "npm run live:e2e",
        "associate": "npm run live:associate",
        "create": "npm run live:create",
        "chat": "npm run live:chat",
    }
    envs = {
        runner["id"]: runner["required_env_vars"] + runner["optional_env_vars"]
        for runner in body["runners"]
    }
    assert "ANNA_LIVE_REIMBURSEMENT_INPUT" in envs["reimbursement"]
    assert "ANNA_T07_LIVE_OWNER_ID" in envs["t07-review-to-validated-patch"]
    assert "ANNA_T07_LIVE_PROVIDER" in envs["t07-review-to-validated-patch"]
    assert "ANNA_T07_LIVE_APPROVAL_ORIGIN" in envs["t07-review-to-validated-patch"]
    assert "ANNA_LIVE_REIMBURSEMENT_ATTACHMENT_PATHS_JSON" in envs["reimbursement"]
    assert "ANNA_LIVE_ASSOCIATE_PERIOD" in envs["associate"]
    assert "ANNA_LIVE_ASSOCIATE_GOAL" in envs["associate"]
    assert "ANNA_LIVE_CREATE_DRAFTS" in envs["create"]
    assert "ANNA_LIVE_CHAT_MESSAGE" in envs["chat"]
    assert "ANNA_LIVE_CHAT_TEMPLATE_ID" in envs["chat"]
    assert body["runners"][0]["status"] in {"blocked", "manual_required", "ready"}
    assert body["runners"][0]["status"] == "blocked"
    assert body["runners"][0]["reason"] == "real_review_approval_bridge_not_implemented"
    dumped = response.text
    assert "operator chat message must stay private" not in dumped
    assert "model-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "erp.example" not in dumped


def test_admin_desktop_delivery_readiness_reports_package_state_without_claiming_production_signing(
    monkeypatch,
    tmp_path,
):
    package_json = {
        "name": "anna",
        "version": "0.1.0",
        "build": {
            "appId": "dev.anna.app",
            "productName": "Anna",
            "asar": True,
            "asarUnpack": ["dist/**", "services/**", "skills/**", "build/python-runtime/**"],
            "mac": {"target": ["dir"]},
        },
        "scripts": {
            "desktop:package": "npm run build && npm run desktop:prepare-python && electron-builder --dir",
            "desktop:smoke-asar": "electron scripts/smoke-packaged-asar.mjs",
        },
    }
    (tmp_path / "package.json").write_text(
        json.dumps(package_json),
        encoding="utf-8",
    )
    resources = tmp_path / "release" / "mac-arm64" / "Anna.app" / "Contents" / "Resources"
    (resources / "app.asar").parent.mkdir(parents=True)
    (resources / "app.asar").write_bytes(b"asar-bytes")
    sidecar = resources / "app.asar.unpacked" / "build" / "python-runtime" / "python" / "bin"
    sidecar.mkdir(parents=True)
    (sidecar / "python3.12").write_text("#!/bin/sh\n", encoding="utf-8")
    (resources / "app.asar.unpacked" / "dist").mkdir(parents=True)
    (resources / "app.asar.unpacked" / "dist" / "index.html").write_text(
        '<div id="root"></div>',
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    response = TestClient(create_app()).get("/api/admin/desktop/delivery-readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["writes_external_data"] is False
    assert body["summary"]["status"] == "development_ready"
    assert body["summary"]["production_ready"] is False
    assert body["summary"]["blockers"] == [
        "production_signing_not_configured",
        "notarization_not_configured",
    ]
    assert body["app"] == {
        "name": "anna",
        "version": "0.1.0",
        "product_name": "Anna",
        "app_id": "dev.anna.app",
    }
    assert body["package"]["app_exists"] is True
    assert body["package"]["asar_enabled"] is True
    assert body["package"]["app_asar_exists"] is True
    assert body["package"]["unpacked_root_exists"] is True
    assert body["package"]["python_sidecar_exists"] is True
    assert body["package"]["desktop_index_exists"] is True
    assert body["package"]["size_bytes"] > 0
    assert body["signing"] == {
        "status": "not_configured",
        "production_signing_configured": False,
        "identity_configured": False,
        "development_ad_hoc_expected": True,
    }
    assert body["notarization"] == {
        "status": "not_configured",
        "configured": False,
    }
    assert body["commands"] == {
        "package": "npm run desktop:package",
        "smoke": "npm run desktop:smoke-asar",
    }


def test_admin_live_validation_checklist_turns_ready_after_current_validation_and_operator_flags(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("ANNA_LIVE_REIMBURSEMENT_INPUT", "真实报销验证请求")
    monkeypatch.setenv("ANNA_LIVE_ALLOW_EXTERNAL_WRITES", "1")
    state_db_path = str(tmp_path / "live-ready.sqlite3")

    class ReadyModelProvider:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                model_endpoint="https://model.example/v1/chat/completions",
                model_api_key="model-secret",
                model_name="mimo-v2.5-pro",
                state_db_path=state_db_path,
            )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ReadyReimbursementAdapter:
        settings = RuntimeSettings(
            reimbursement_mcp_server="https://reimbursement.example/rpc",
            reimbursement_mcp_api_key="reimbursement-secret",
        )

        def status(self):
            return {
                "status": "connected",
                "tool_count": 6,
                "tool_names": [
                    "reimbursement.get_capabilities",
                    "reimbursement.get_policy",
                    "reimbursement.validate_draft",
                    "reimbursement.create_draft",
                    "reimbursement.submit",
                    "reimbursement.get_status",
                ],
                "tools": _tools_with_submit_snapshot_contract(),
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {
                    "valid": True,
                    "missing_fields": [],
                    "policy_summary": "tenant-specific probe accepted",
                    "risk_level": "low",
                }
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class ReadyErpAdapter:
        settings = RuntimeSettings(
            erp_mcp_server="https://erp.example/rpc",
            erp_mcp_api_key="erp-secret",
        )

        def status(self):
            return {
                "status": "connected",
                "tool_count": 3,
                "tool_names": [
                    "erp.finance.get_receivables_aging",
                    "erp.collection_task.create_draft",
                    "erp.collection_task.get_status",
                ],
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError("live validation checklist must not execute ERP tools")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ReadyModelProvider(),
                adapter=ReadyReimbursementAdapter(),
                settings=RuntimeSettings(state_db_path=state_db_path),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ReadyErpAdapter()),
            hiker_orchestrator=HikerOrchestrator(adapter=ReadyHikerAdapter()),
        )
    )
    assert client.post("/api/admin/runtime/validate").json()["status"] == "ready"

    response = client.get("/api/admin/live-validation/checklist")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"] == {
        "step_count": 9,
            "ready_count": 9,
        "blocked_count": 0,
        "manual_required_count": 0,
        "needs_validation_count": 0,
    }
    assert {step["status"] for step in body["steps"]} == {"ready"}
    steps = {step["id"]: step for step in body["steps"]}
    assert steps["domain_readiness"]["evidence_id"] == "validation_001"
    assert steps["validation_report"]["evidence_id"] == "validation_001"
    assert steps["live_input"]["configured"] is True
    assert steps["external_write_authorization"]["configured"] is True
    dumped = response.text
    assert "真实报销验证请求" not in dumped
    assert "tenant-specific probe accepted" not in dumped
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "model.example" not in dumped
    assert "reimbursement.example" not in dumped
    assert "erp.example" not in dumped


def test_admin_sandbox_probe_runs_fixed_no_secret_fixture_and_updates_status(monkeypatch):
    monkeypatch.setenv("ANNA_MODEL_API_KEY", "model-secret")
    monkeypatch.setenv("ANNA_REIMBURSEMENT_MCP_API_KEY", "reimbursement-secret")
    monkeypatch.setenv("ANNA_ERP_MCP_API_KEY", "erp-secret")
    client = TestClient(create_app())

    response = client.post("/api/admin/sandbox/probe")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "passed"
    assert body["writes_external_data"] is False
    assert body["runner"] == "CreateToolSandbox"
    assert body["production_secrets_injected"] is False
    assert body["hardened_sandbox"] is False
    assert body["network_isolated"] is False
    assert body["preflight_policy"] == "ast_import_and_side_effect_preflight"
    assert body["timeout_enforced"] is True
    assert body["output_limited"] is True
    assert body["env_allowlist"] == ["PYTHONIOENCODING"]
    assert body["checks"] == [
        {
            "name": "python_fixture_execution",
            "status": "passed",
            "detail": "fixture executed in isolated workdir",
        },
        {
            "name": "production_secret_redaction",
            "status": "passed",
            "detail": "model and MCP API keys unavailable inside fixture process",
        },
        {
            "name": "filesystem_side_effect_preflight",
            "status": "passed",
            "detail": "disallowed filesystem operation blocked before execution",
        },
        {
            "name": "timeout_enforcement",
            "status": "passed",
            "detail": "long running fixture is terminated by runner timeout",
        },
        {
            "name": "output_limit",
            "status": "passed",
            "detail": "fixture stdout and stderr are capped before returning",
        },
        {
            "name": "network_import_preflight",
            "status": "passed",
            "detail": "network imports are blocked before execution",
        },
    ]
    assert "probe=admin-sandbox" in body["result"]["stdout"]
    assert "ANNA_MODEL_API_KEY=[redacted]" in body["result"]["stdout"]
    assert "ANNA_REIMBURSEMENT_MCP_API_KEY=[redacted]" in body["result"]["stdout"]
    assert "ANNA_ERP_MCP_API_KEY=[redacted]" in body["result"]["stdout"]
    assert "model-secret" not in body["result"]["stdout"]
    assert "reimbursement-secret" not in body["result"]["stdout"]
    assert "erp-secret" not in body["result"]["stdout"]
    assert "disallowed_python_operation" in body["blocked_result"]["stderr"]
    assert body["timeout_result"]["timed_out"] is True
    assert body["limited_result"]["output_truncated"] is True
    assert body["network_blocked_result"]["stderr"] == (
        "disallowed_python_operation: import:socket"
    )

    governance_response = client.get("/api/admin/governance/status")
    assert governance_response.json()["fixture_runner"]["last_probe_status"] == "passed"


def test_admin_sandbox_probe_ignores_request_body_code():
    client = TestClient(create_app())

    response = client.post(
        "/api/admin/sandbox/probe",
        json={
            "code": "print('attacker controlled')",
            "fixture_input": "malicious-input",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "passed"
    assert "attacker controlled" not in body["result"]["stdout"]
    assert "malicious-input" not in body["result"]["stdout"]
    assert "probe=admin-sandbox" in body["result"]["stdout"]


def test_admin_sandbox_probe_redacts_sensitive_output_before_returning():
    class SecretEchoSandbox:
        def __init__(self) -> None:
            self.calls = 0

        def run_python_tool(self, code: str, fixture_input: str) -> CreateSandboxResult:
            self.calls += 1
            if self.calls == 1:
                return CreateSandboxResult(
                    passed=True,
                    stdout="api_key=leaked-secret\nsecret=None\n",
                    stderr='{"password":"hunter2"}',
                    exit_code=0,
                    workdir="/tmp/anna-probe",
                )
            return CreateSandboxResult(
                passed=False,
                stdout="",
                stderr="disallowed_python_operation: call:open token=raw-token",
                exit_code=None,
                workdir="/tmp/anna-probe",
            )

    class SecretEchoCreate:
        workspace_root = "/tmp/anna-probe"

        def __init__(self) -> None:
            self.sandbox = SecretEchoSandbox()
            self.last_sandbox_probe_status = "not_run"

    client = TestClient(create_app(create_orchestrator=SecretEchoCreate()))

    response = client.post("/api/admin/sandbox/probe")

    assert response.status_code == 200
    body = response.json()
    assert "leaked-secret" not in body["result"]["stdout"]
    assert "hunter2" not in body["result"]["stderr"]
    assert "raw-token" not in body["blocked_result"]["stderr"]
    assert "api_key=[redacted]" in body["result"]["stdout"]
    assert '"password":[redacted]' in body["result"]["stderr"]
    assert "token=[redacted]" in body["blocked_result"]["stderr"]


def _tools_with_submit_snapshot_contract():
    return [
        {"name": "reimbursement.get_capabilities"},
        {"name": "reimbursement.get_policy"},
        {"name": "reimbursement.validate_draft"},
        {"name": "reimbursement.create_draft"},
        {
            "name": "reimbursement.submit",
            "input_schema": {
                "type": "object",
                "properties": {
                    "external_reimbursement_id": {"type": "string"},
                    "expected_draft_snapshot": {"type": "object"},
                    "expected_draft_snapshot_hash": {"type": "string"},
                },
            },
        },
        {"name": "reimbursement.get_status"},
    ]
