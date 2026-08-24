import json

from fastapi.testclient import TestClient

from services.api.app import main as api_main
from services.api.app.main import create_app
from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.hiker.app.orchestrator import HikerOrchestrator
from services.mcp_gateway.app.reimbursement_adapter import ReimbursementMcpError
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import ModelProviderError, ModelResponse, ModelToolCall
from services.runtime.app.skill_loader import SkillLoader


def write_runtime_skill(tmp_path, skill_id: str, name: str) -> None:
    skill_dir = tmp_path / "skills" / skill_id
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
version: 0.1.0
allowed_tools:
  - reimbursement.submit_intent
forbidden_tools:
  - reimbursement.submit
required_fields:
  - reason
---

# {name}

Request approval only.
""",
        encoding="utf-8",
    )


class ConnectedErpAdapter:
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


def test_admin_runtime_status_reports_missing_model_and_connector(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["scheduler"] == {
        "execution_mode": "local",
        "runs_while_app_closed": False,
        "recovery_mode": "explicit",
    }
    assert body["model"] == {
        "provider": "openai-compatible",
        "model_name": "mimo-v2.5-pro",
        "configured": False,
        "status": "not_configured",
        "error_code": "model_not_configured",
    }
    assert body["reimbursement_mcp"]["status"] == "not_configured"
    assert body["reimbursement_mcp"]["error_code"] == "connector_not_configured"
    assert body["config"]["runtime_config_path"] is None
    assert body["config"]["model_api_key_configured"] is False


def test_admin_runtime_status_loads_skill_and_safe_tool_list(monkeypatch):
    monkeypatch.setenv("ANNA_MODEL_API_KEY", "test-key")
    monkeypatch.setenv("ANNA_MODEL_ENDPOINT", "https://model.example.test/v1/chat/completions")
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["model"]["configured"] is True
    assert body["model"]["status"] == "configured"
    assert body["skill"]["id"] == "reimbursement/travel-expense"
    assert body["skill"]["name"] == "travel-expense-reimbursement"
    assert body["skill"]["version"] == "0.1.0"
    assert body["skill"]["loaded"] is True
    assert len(body["skill"]["content_hash"]) == 64
    assert "reimbursement.submit_intent" in body["skill"]["allowed_tools"]
    assert "reimbursement.submit" in body["skill"]["forbidden_tools"]

    tool_names = [tool["name"] for tool in body["tools"]]
    assert "reimbursement.submit_intent" in tool_names
    assert "reimbursement.submit" not in tool_names


def test_admin_runtime_status_uses_active_reimbursement_skill_id(tmp_path):
    skill_dir = tmp_path / "skills" / "reimbursement" / "custom-travel"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: custom-travel-reimbursement
version: 0.1.0
allowed_tools:
  - reimbursement.submit_intent
forbidden_tools:
  - reimbursement.submit
required_fields:
  - reason
---

# Custom Travel Skill

Request approval only.
""",
        encoding="utf-8",
    )
    orchestrator = ReimbursementOrchestrator(
        skill_loader=SkillLoader(project_root=tmp_path),
        settings=RuntimeSettings(
            reimbursement_skill_id="reimbursement/custom-travel",
        ),
    )
    client = TestClient(create_app(orchestrator=orchestrator))

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["skill"]["id"] == "reimbursement/custom-travel"
    assert body["skill"]["name"] == "custom-travel-reimbursement"
    assert [tool["name"] for tool in body["tools"]] == [
        "reimbursement.submit_intent"
    ]


def test_admin_runtime_skills_lists_available_skills_and_active_one(tmp_path):
    write_runtime_skill(tmp_path, "reimbursement/custom-travel", "custom-travel")
    write_runtime_skill(tmp_path, "reimbursement/audit", "audit-reimbursement")
    orchestrator = ReimbursementOrchestrator(
        skill_loader=SkillLoader(project_root=tmp_path),
        settings=RuntimeSettings(
            reimbursement_skill_id="reimbursement/custom-travel",
        ),
    )
    client = TestClient(create_app(orchestrator=orchestrator))

    response = client.get("/api/admin/runtime/skills")

    assert response.status_code == 200
    body = response.json()
    assert body["active_skill_id"] == "reimbursement/custom-travel"
    assert [skill["id"] for skill in body["skills"]] == [
        "reimbursement/audit",
        "reimbursement/custom-travel",
    ]
    active_skills = [skill for skill in body["skills"] if skill["active"]]
    assert active_skills == [
        {
            "id": "reimbursement/custom-travel",
            "name": "custom-travel",
            "version": "0.1.0",
            "content_hash": active_skills[0]["content_hash"],
            "allowed_tools": ["reimbursement.submit_intent"],
            "forbidden_tools": ["reimbursement.submit"],
            "active": True,
        }
    ]


def test_admin_mcp_tools_reports_reimbursement_tool_registry(monkeypatch):
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.get("/api/admin/mcp/reimbursement/tools")

    assert response.status_code == 200
    body = response.json()
    assert body["runtime"] == "reimbursement-tool-registry"
    tool_names = [tool["name"] for tool in body["tools"]]
    assert "reimbursement.submit_intent" in tool_names
    assert "reimbursement.submit" not in tool_names


def test_admin_mcp_tools_uses_discovered_schema_for_safe_model_tools():
    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

        def status(self):
            return {
                "status": "connected",
                "server": self.settings.reimbursement_mcp_server,
                "tool_count": 2,
                "tool_names": [
                    "reimbursement.create_draft",
                    "reimbursement.submit",
                ],
                "tools": [
                    {
                        "name": "reimbursement.create_draft",
                        "description": "Create draft from MCP.",
                        "input_schema": {
                            "type": "object",
                            "properties": {
                                "workspace_id": {"type": "string"},
                                "draft": {
                                    "type": "object",
                                    "properties": {
                                        "amount": {"type": "number", "minimum": 1},
                                        "external_status": {"type": "string"},
                                    },
                                },
                            },
                            "required": ["workspace_id", "draft"],
                        },
                    },
                    {
                        "name": "reimbursement.submit",
                        "description": "Backend submit.",
                        "input_schema": {"type": "object"},
                    },
                ],
            }

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                adapter=ProbeAdapter(),
            )
        )
    )

    response = client.get("/api/admin/mcp/reimbursement/tools")

    assert response.status_code == 200
    body = response.json()
    tools = {tool["name"]: tool for tool in body["tools"]}
    create_schema = tools["reimbursement.create_draft"]["input_schema"]
    draft_schema = create_schema["properties"]["draft"]

    assert tools["reimbursement.create_draft"]["schema_source"] == "mcp"
    assert create_schema["required"] == ["draft"]
    assert "workspace_id" not in create_schema["properties"]
    assert draft_schema["properties"]["amount"]["minimum"] == 1
    assert "external_status" not in draft_schema["properties"]
    assert "reimbursement.submit" not in tools


def test_admin_runtime_status_reports_local_config_file(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        """
        {
          "model_endpoint": "https://model.example/v1/chat/completions",
          "model_api_key": "secret-key",
          "reimbursement_mcp_server": "https://mcp.example/rpc"
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["model"]["configured"] is True
    assert body["config"] == {
        "runtime_config_path": str(config_path),
        "state_db_path": str(tmp_path / "state" / "anna-state.sqlite3"),
        "model_endpoint_configured": True,
        "model_api_key_configured": True,
        "reimbursement_mcp_server_configured": True,
        "reimbursement_mcp_api_key_configured": False,
        "erp_mcp_server_configured": False,
        "erp_mcp_api_key_configured": False,
        "hiker_mcp_server_configured": False,
        "hiker_mcp_api_key_configured": False,
        "associate_receivables_skill_id": "associate/receivables-recovery",
        "chat_skill_id": "chat/general-assistant",
        "requires_restart_after_edit": True,
    }
    assert "secret-key" not in response.text


def test_admin_runtime_status_reports_erp_mcp_and_associate_skill_config(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "model_endpoint": "https://model.example/v1/chat/completions",
                "model_api_key": "secret-key",
                "reimbursement_mcp_server": "https://reimbursement.example/rpc",
                "erp_mcp_server": "https://user:erp-secret@erp.example/rpc?token=erp-token",
                "erp_mcp_api_key": "erp-api-secret",
                "associate_receivables_skill_id": "associate/custom-recovery",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))

    class ProbeErpAdapter:
        settings = RuntimeSettings(
            erp_mcp_server="https://user:erp-secret@erp.example/rpc?token=erp-token",
            erp_mcp_api_key="erp-api-secret",
            associate_receivables_skill_id="associate/custom-recovery",
            runtime_config_path=str(config_path),
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
                "message": f"connected to {self.settings.erp_mcp_server}",
            }

    associate = AssociateReceivablesOrchestrator(
        adapter=ProbeErpAdapter(),
        settings=RuntimeSettings(
            erp_mcp_server="https://user:erp-secret@erp.example/rpc?token=erp-token",
            erp_mcp_api_key="erp-api-secret",
            associate_receivables_skill_id="associate/custom-recovery",
            runtime_config_path=str(config_path),
        ),
    )
    client = TestClient(create_app(associate_orchestrator=associate))

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["erp_mcp"]["status"] == "connected"
    assert body["erp_mcp"]["server"] == "[configured]"
    assert body["erp_mcp"]["tool_names"] == [
        "erp.finance.get_receivables_aging",
        "erp.collection_task.create_draft",
        "erp.collection_task.get_status",
    ]
    assert body["config"]["erp_mcp_server_configured"] is True
    assert body["config"]["erp_mcp_api_key_configured"] is True
    assert body["config"]["associate_receivables_skill_id"] == "associate/custom-recovery"
    assert "erp-secret" not in response.text
    assert "erp-token" not in response.text
    assert "erp-api-secret" not in response.text


def test_admin_runtime_status_redacts_erp_mcp_error_payload_secrets():
    class LeakyErpAdapter:
        settings = RuntimeSettings(
            erp_mcp_server="https://erp.example/rpc",
            erp_mcp_api_key="header-erp-secret",
        )

        def status(self):
            return {
                "status": "unhealthy",
                "server": self.settings.erp_mcp_server,
                "error_code": "mcp_error",
                "message": (
                    'failed with {"api_key":"json-erp-secret",'
                    '"content_base64":"invoice-bytes-secret"} '
                    "clientSecret: plain-erp-secret "
                    "Authorization: Bearer bearer-erp-secret"
                ),
                "debug": {
                    "api_key": "structured-erp-secret",
                    "content_base64": "structured-invoice-bytes-secret",
                    "nested": {
                        "clientSecret": "structured-client-secret",
                    },
                },
                "retryable": True,
            }

    client = TestClient(
        create_app(
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=LeakyErpAdapter(),
            )
        )
    )

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["erp_mcp"]["server"] == "[configured]"
    assert body["erp_mcp"]["status"] == "unhealthy"
    assert "json-erp-secret" not in response.text
    assert "invoice-bytes-secret" not in response.text
    assert "plain-erp-secret" not in response.text
    assert "bearer-erp-secret" not in response.text
    assert "header-erp-secret" not in response.text
    assert "structured-erp-secret" not in response.text
    assert "structured-invoice-bytes-secret" not in response.text
    assert "structured-client-secret" not in response.text


def test_admin_runtime_status_uses_active_erp_adapter_settings_for_config():
    class ProbeErpAdapter:
        settings = RuntimeSettings(
            erp_mcp_server="https://erp.example/rpc",
            erp_mcp_api_key="active-erp-secret",
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

    client = TestClient(
        create_app(
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=ProbeErpAdapter(),
                settings=RuntimeSettings(),
            )
        )
    )

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["erp_mcp"]["status"] == "connected"
    assert body["config"]["erp_mcp_server_configured"] is True
    assert body["config"]["erp_mcp_api_key_configured"] is True
    assert "active-erp-secret" not in response.text


def test_admin_runtime_status_redacts_mcp_server_value(monkeypatch):
    secret_server = (
        "https://user:secret-token@mcp.example/rpc?"
        "access_token=access-secret&client_secret=client-secret&password=password-secret"
    )
    orchestrator = ReimbursementOrchestrator()
    orchestrator.adapter.settings = RuntimeSettings(reimbursement_mcp_server=secret_server)
    orchestrator.adapter.status = lambda: {
        "status": "connected",
        "server": secret_server,
        "message": f"failed to reach {secret_server}",
        "tool_count": 6,
        "tool_names": [],
    }
    client = TestClient(create_app(orchestrator=orchestrator))

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["reimbursement_mcp"]["server"] == "[configured]"
    assert "access-secret" not in response.text
    assert "client-secret" not in response.text
    assert "password-secret" not in response.text
    assert "secret-token" not in response.text
    assert "user:secret-token" not in response.text


def test_admin_runtime_status_uses_active_orchestrator_settings(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        """
        {
          "model_endpoint": "https://new-model.example/v1/chat/completions",
          "model_api_key": "new-key",
          "reimbursement_mcp_server": "https://new-mcp.example/rpc"
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    orchestrator = ReimbursementOrchestrator(
        model_provider=None,
        adapter=None,
    )
    orchestrator.model_provider.settings = RuntimeSettings(
        model_endpoint=None,
        model_api_key=None,
        runtime_config_path=str(config_path),
    )
    orchestrator.adapter.settings = RuntimeSettings(
        reimbursement_mcp_server=None,
        runtime_config_path=str(config_path),
    )
    client = TestClient(create_app(orchestrator=orchestrator))

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["model"]["configured"] is False
    assert body["model"]["status"] == "not_configured"
    assert body["reimbursement_mcp"]["status"] == "not_configured"
    assert body["config"]["runtime_config_path"] == str(config_path)
    assert body["config"]["model_endpoint_configured"] is False


def test_admin_runtime_config_requires_runtime_config_path(monkeypatch):
    monkeypatch.delenv("ANNA_RUNTIME_CONFIG_PATH", raising=False)
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/config")

    assert response.status_code == 400
    assert response.json()["detail"] == "ANNA_RUNTIME_CONFIG_PATH is not configured"


def test_admin_runtime_config_get_redacts_secret_values(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "model_provider": "openai-compatible",
                "model_endpoint": "https://model.example/v1/chat/completions",
                "model_name": "mimo-v2.5-pro",
                "model_api_key": "secret-key",
                "reimbursement_mcp_server": "https://user:secret-token@mcp.example/rpc?token=secret-token",
                "reimbursement_mcp_api_key": "mcp-secret-key",
                "reimbursement_skill_id": "reimbursement/custom-travel",
                "reimbursement_probe_draft": {
                    "category": "travel",
                    "amount": 88,
                    "currency": "CNY",
                    "expense_date": "2026-06-01",
                    "merchant": "真实差旅供应商",
                    "reason": "真实连接器只读探针",
                    "department_id": "sales-real",
                    "cost_center_id": "cc-real",
                    "attachments": [
                        {
                            "name": "invoice.pdf",
                            "uri": "https://signed.example/invoice.pdf?token=attachment-secret",
                        }
                    ],
                    "token": "draft-token-secret",
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/config")

    assert response.status_code == 200
    body = response.json()
    assert body["runtime_config_path"] == str(config_path)
    assert body["exists"] is True
    assert body["values"] == {
        "model_provider": "openai-compatible",
        "model_endpoint": "https://model.example/v1/chat/completions",
        "model_name": "mimo-v2.5-pro",
        "reimbursement_skill_id": "reimbursement/custom-travel",
        "associate_receivables_skill_id": "associate/receivables-recovery",
        "chat_skill_id": "chat/general-assistant",
        "reimbursement_probe_draft": {
            "category": "travel",
            "amount": 88,
            "currency": "CNY",
            "expense_date": "2026-06-01",
            "merchant": "真实差旅供应商",
            "reason": "真实连接器只读探针",
            "department_id": "sales-real",
            "cost_center_id": "cc-real",
        },
        # P3 refinement — Agent 中心/模型档案 round-trip 键(缺省为空)。
        "agent_directives": {},
        "model_profiles": [],
    }
    assert body["secrets"] == {
        "model_api_key_configured": True,
        "reimbursement_mcp_server_configured": True,
        "reimbursement_mcp_api_key_configured": True,
        "erp_mcp_server_configured": False,
        "erp_mcp_api_key_configured": False,
        "hiker_mcp_server_configured": False,
        "hiker_mcp_api_key_configured": False,
    }
    assert "secret-key" not in response.text
    assert "secret-token" not in response.text
    assert "mcp-secret-key" not in response.text
    assert "draft-token-secret" not in response.text
    assert "attachment-secret" not in response.text


def test_admin_runtime_config_get_redacts_erp_mcp_values(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "erp_mcp_server": "https://user:erp-secret@erp.example/rpc?token=erp-token",
                "erp_mcp_api_key": "erp-api-secret",
                "associate_receivables_skill_id": "associate/custom-recovery",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/config")

    assert response.status_code == 200
    body = response.json()
    assert body["values"]["associate_receivables_skill_id"] == "associate/custom-recovery"
    assert body["secrets"]["erp_mcp_server_configured"] is True
    assert body["secrets"]["erp_mcp_api_key_configured"] is True
    assert "erp-secret" not in response.text
    assert "erp-token" not in response.text
    assert "erp-api-secret" not in response.text


def test_admin_runtime_config_get_redacts_credential_bearing_model_endpoint(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "model_endpoint": "https://user:model-secret@model.example/v1/chat/completions?access_token=token-secret&client_secret=client-secret",
                "model_api_key": "header-secret",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.get("/api/admin/runtime/config")

    assert response.status_code == 200
    body = response.json()
    assert body["values"]["model_endpoint"] == (
        "https://[redacted]@model.example/v1/chat/completions"
        "?access_token=[redacted]&client_secret=[redacted]"
    )
    assert "model-secret" not in response.text
    assert "token-secret" not in response.text
    assert "client-secret" not in response.text
    assert "header-secret" not in response.text


def test_admin_runtime_config_put_preserves_redacted_endpoint_placeholder(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "runtime.json"
    original_endpoint = (
        "https://user:model-secret@model.example/v1/chat/completions"
        "?access_token=token-secret&client_secret=client-secret"
    )
    config_path.write_text(
        json.dumps(
            {
                "model_endpoint": original_endpoint,
                "model_name": "mimo-v2.5-pro",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.put(
        "/api/admin/runtime/config",
        json={
            "model_endpoint": (
                "https://[redacted]@model.example/v1/chat/completions"
                "?access_token=[redacted]&client_secret=[redacted]"
            ),
            "model_name": "mimo-v2.5-pro",
            "model_api_key": "new-secret",
        },
    )

    assert response.status_code == 200
    assert "model-secret" not in response.text
    assert "token-secret" not in response.text
    saved = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved["model_endpoint"] == original_endpoint
    assert saved["model_api_key"] == "new-secret"


def test_admin_runtime_config_put_writes_local_file_without_returning_secrets(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "model_provider": "openai-compatible",
                "model_endpoint": "https://old-model.example/v1",
                "model_name": "mimo-v2.5-pro",
                "model_api_key": "old-secret",
                "reimbursement_mcp_server": "https://old-mcp.example/rpc",
                "reimbursement_mcp_api_key": "old-mcp-secret",
                "custom_key": "kept",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.put(
        "/api/admin/runtime/config",
        json={
            "model_endpoint": "https://new-model.example/v1/chat/completions",
            "model_name": "mimo-v2.5-pro",
            "model_api_key": "new-secret",
            "reimbursement_mcp_server": "https://user:secret-token@mcp.example/rpc?token=secret-token",
            "reimbursement_mcp_api_key": "new-mcp-secret",
            "reimbursement_skill_id": "reimbursement/custom-travel",
            "reimbursement_probe_draft": {
                "category": "travel",
                "amount": 88,
                "currency": "CNY",
                "expense_date": "2026-06-01",
                "merchant": "真实差旅供应商",
                "reason": "真实连接器只读探针",
                "department_id": "sales-real",
                "cost_center_id": "cc-real",
                "attachments": [
                    {
                        "name": "invoice.pdf",
                        "uri": "https://signed.example/invoice.pdf?token=attachment-secret",
                    }
                ],
                "password": "draft-password-secret",
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["requires_restart_after_save"] is True
    assert body["values"]["model_endpoint"] == "https://new-model.example/v1/chat/completions"
    assert body["secrets"] == {
        "model_api_key_configured": True,
        "reimbursement_mcp_server_configured": True,
        "reimbursement_mcp_api_key_configured": True,
        "erp_mcp_server_configured": False,
        "erp_mcp_api_key_configured": False,
        "hiker_mcp_server_configured": False,
        "hiker_mcp_api_key_configured": False,
    }
    assert "new-secret" not in response.text
    assert "secret-token" not in response.text
    assert "new-mcp-secret" not in response.text

    saved = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved["model_endpoint"] == "https://new-model.example/v1/chat/completions"
    assert saved["model_api_key"] == "new-secret"
    assert saved["reimbursement_mcp_server"] == "https://user:secret-token@mcp.example/rpc?token=secret-token"
    assert saved["reimbursement_mcp_api_key"] == "new-mcp-secret"
    assert saved["reimbursement_skill_id"] == "reimbursement/custom-travel"
    assert saved["reimbursement_probe_draft"]["department_id"] == "sales-real"
    assert "attachments" not in saved["reimbursement_probe_draft"]
    assert "password" not in saved["reimbursement_probe_draft"]
    assert saved["custom_key"] == "kept"


def test_admin_runtime_config_put_writes_erp_mcp_and_associate_skill_fields(
    monkeypatch,
    tmp_path,
):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(
        json.dumps(
            {
                "erp_mcp_server": "https://old-erp.example/rpc",
                "erp_mcp_api_key": "old-erp-secret",
                "associate_receivables_skill_id": "associate/receivables-recovery",
                "chat_skill_id": "chat/general-assistant",
                "custom_key": "kept",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.put(
        "/api/admin/runtime/config",
        json={
            "erp_mcp_server": "https://user:erp-secret@erp.example/rpc?token=erp-token",
            "erp_mcp_api_key": "new-erp-secret",
            "associate_receivables_skill_id": "associate/custom-recovery",
            "chat_skill_id": "chat/custom-assistant",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["values"]["associate_receivables_skill_id"] == "associate/custom-recovery"
    assert body["values"]["chat_skill_id"] == "chat/custom-assistant"
    assert body["secrets"]["erp_mcp_server_configured"] is True
    assert body["secrets"]["erp_mcp_api_key_configured"] is True
    assert "erp-secret" not in response.text
    assert "erp-token" not in response.text
    assert "new-erp-secret" not in response.text

    saved = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved["erp_mcp_server"] == "https://user:erp-secret@erp.example/rpc?token=erp-token"
    assert saved["erp_mcp_api_key"] == "new-erp-secret"
    assert "finance_dashboard_skill_id" not in saved
    assert saved["associate_receivables_skill_id"] == "associate/custom-recovery"
    assert saved["chat_skill_id"] == "chat/custom-assistant"
    assert saved["custom_key"] == "kept"


def test_admin_runtime_validation_reports_blocked_without_fake_success(monkeypatch):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    client = TestClient(create_app())

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["writes_external_data"] is False
    assert body["model"]["status"] == "not_configured"
    assert body["model"]["error_code"] == "model_not_configured"
    assert body["reimbursement_mcp"]["status"] == "not_configured"
    assert body["skill"]["loaded"] is True


def test_admin_runtime_validation_calls_model_and_mcp_without_write_tools():
    class ProbeModelProvider:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                model_endpoint="https://model.example/v1/chat/completions",
                model_api_key="secret-key",
                model_name="mimo-v2.5-pro",
            )
            self.requests = []

        async def create_response(self, request):
            self.requests.append(request)
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                reimbursement_mcp_server="https://mcp.example/rpc"
            )
            self.status_calls = 0
            self.read_calls = []
            self.write_calls = []

        def status(self):
            self.status_calls += 1
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
            self.read_calls.append((tool_name, arguments))
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {
                    "valid": True,
                    "missing_fields": [],
                    "policy_summary": "runtime validation draft accepted",
                    "risk_level": "low",
                }
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

        def create_draft(self, **kwargs):
            self.write_calls.append(("create_draft", kwargs))

        def submit(self, **kwargs):
            self.write_calls.append(("submit", kwargs))

    class ProbeErpAdapter:
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

    model_provider = ProbeModelProvider()
    adapter = ProbeAdapter()
    orchestrator = ReimbursementOrchestrator(
        model_provider=model_provider,
        adapter=adapter,
    )
    client = TestClient(
        create_app(
            orchestrator=orchestrator,
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ProbeErpAdapter()),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["writes_external_data"] is False
    assert body["model"]["status"] == "connected"
    assert body["model"]["finish_reason"] == "stop"
    assert body["reimbursement_mcp"]["status"] == "connected"
    assert body["reimbursement_mcp_read_probe"] == {
        "status": "passed",
        "writes_external_data": False,
        "tool_names": [
            "reimbursement.get_capabilities",
            "reimbursement.validate_draft",
        ],
        "draft_source": "default",
    }
    assert body["reimbursement_mcp"]["server"] == "[configured]"
    assert body["tool_contract"]["model_visible_count"] == 6
    assert body["tool_contract"]["backend_submit_snapshot_contract"] == {
        "status": "passed",
    }
    assert adapter.status_calls == 1
    assert [call[0] for call in adapter.read_calls] == [
        "reimbursement.get_capabilities",
        "reimbursement.validate_draft",
    ]
    assert adapter.write_calls == []
    assert len(model_provider.requests) == 2


def test_admin_runtime_validation_ledger_records_redacted_summary(tmp_path):
    class LedgerModelProvider:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                model_endpoint="https://model.example/v1/chat/completions",
                model_api_key="model-secret",
                model_name="mimo-v2.5-pro",
            )
            self.requests = []

        async def create_response(self, request):
            self.requests.append(request)
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class LedgerReimbursementAdapter:
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

    class LedgerErpAdapter:
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
            raise AssertionError("runtime validation Associate ERP readiness must use tools/list only")

    model_provider = LedgerModelProvider()
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=model_provider,
                adapter=LedgerReimbursementAdapter(),
                settings=RuntimeSettings(state_db_path=str(tmp_path / "ledger.sqlite3")),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=LedgerErpAdapter()),
        )
    )

    validation_response = client.post("/api/admin/runtime/validate")
    ledger_response = client.get("/api/admin/runtime/validation-ledger")
    report_response = client.get("/api/admin/runtime/validation-report")

    assert validation_response.status_code == 200
    body = validation_response.json()
    assert ledger_response.status_code == 200
    assert report_response.status_code == 200
    ledger = ledger_response.json()
    assert ledger["summary"] == {
        "validation_count": 1,
        "ready_count": 1,
        "blocked_count": 0,
        "external_write_count": 0,
    }
    assert len(ledger["items"]) == 1
    item = ledger["items"][0]
    assert item["status"] == "ready"
    assert item["writes_external_data"] is False
    assert item["model_status"] == "connected"
    assert item["reimbursement_mcp_status"] == "connected"
    assert item["reimbursement_mcp_read_probe_status"] == "passed"
    assert item["associate_execution_status"] == "passed"
    assert item["skill_loaded"] is True
    assert item["tool_contract_status"] == "passed"
    dumped = json.dumps(ledger, ensure_ascii=False)
    assert "model-secret" not in dumped
    assert "reimbursement-secret" not in dumped
    assert "erp-secret" not in dumped
    assert "model.example" not in dumped
    assert "reimbursement.example" not in dumped
    assert "erp.example" not in dumped
    assert "tenant-specific probe accepted" not in dumped
    report = report_response.json()
    assert report["filename"].startswith("anna-runtime-validation-report-")
    assert report["content_type"] == "text/markdown; charset=utf-8"
    assert "# Anna Runtime Validation Report" in report["content"]
    assert "validation_001" in report["content"]
    assert "status: ready" in report["content"]
    assert "model: connected" in report["content"]
    assert "mcp_read_probe: passed" in report["content"]
    assert "tool_contract: passed" in report["content"]
    assert "writes_external_data: false" in report["content"]
    assert "model-secret" not in report["content"]
    assert "reimbursement-secret" not in report["content"]
    assert "erp-secret" not in report["content"]
    assert "model.example" not in report["content"]
    assert "reimbursement.example" not in report["content"]
    assert "erp.example" not in report["content"]
    assert "tenant-specific probe accepted" not in report["content"]
    assert model_provider.requests[0].tools == []
    tool_contract_probe = model_provider.requests[1]
    probed_tool_names = [tool["name"] for tool in tool_contract_probe.tools]
    assert "reimbursement.validate_draft" in probed_tool_names
    assert "reimbursement.submit_intent" in probed_tool_names
    assert "reimbursement.submit" not in probed_tool_names
    assert body["model"]["tool_contract_probe"] == {
        "status": "connected",
        "finish_reason": "stop",
        "tool_call_count": 0,
        "tool_count": 6,
    }


def test_admin_runtime_validation_ledger_recovers_after_app_restart(monkeypatch, tmp_path):
    monkeypatch.delenv("ANNA_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("ANNA_MODEL_ENDPOINT", raising=False)
    monkeypatch.delenv("ANNA_REIMBURSEMENT_MCP_SERVER", raising=False)
    monkeypatch.setenv("ANNA_STATE_DB_PATH", str(tmp_path / "anna-state.sqlite3"))

    first_client = TestClient(create_app())
    validation_response = first_client.post("/api/admin/runtime/validate")
    first_ledger_response = first_client.get("/api/admin/runtime/validation-ledger")

    second_client = TestClient(create_app())
    recovered_ledger_response = second_client.get("/api/admin/runtime/validation-ledger")

    assert validation_response.status_code == 200
    assert first_ledger_response.json()["summary"]["validation_count"] == 1
    assert recovered_ledger_response.status_code == 200
    recovered = recovered_ledger_response.json()
    assert recovered["summary"]["validation_count"] == 1
    assert recovered["summary"]["blocked_count"] == 1
    assert recovered["items"][0]["status"] == "blocked"
    assert recovered["items"][0]["model_error_code"] == "model_not_configured"


def test_admin_runtime_validation_blocks_without_erp_execution_connector():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeReimbursementAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeReimbursementAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["erp_mcp_associate_execution_readiness"] == {
        "status": "skipped",
        "writes_external_data": False,
        "required_tool_names": [
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
        ],
        "tool_names": [],
    }


def test_admin_runtime_validation_reports_associate_erp_readiness_without_tool_call():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeReimbursementAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class ProbeErpAdapter:
        settings = RuntimeSettings(erp_mcp_server="https://erp.example/rpc")

        def __init__(self) -> None:
            self.status_calls = 0
            self.tool_calls = []

        def status(self):
            self.status_calls += 1
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
            self.tool_calls.append((tool_name, arguments))
            raise AssertionError("Associate execution readiness must use tools/list only")

    erp_adapter = ProbeErpAdapter()
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeReimbursementAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=erp_adapter),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["writes_external_data"] is False
    assert body["erp_mcp_associate_execution_readiness"] == {
        "status": "passed",
        "writes_external_data": False,
        "required_tool_names": [
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
        ],
        "tool_names": [
            "erp.finance.get_receivables_aging",
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
        ],
        "missing_tools": [],
    }
    assert erp_adapter.status_calls == 1
    assert erp_adapter.tool_calls == []


def test_admin_runtime_validation_reports_associate_execution_readiness_without_tool_call():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeReimbursementAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class ProbeErpAdapter:
        settings = RuntimeSettings(erp_mcp_server="https://erp.example/rpc")

        def __init__(self) -> None:
            self.status_calls = 0
            self.tool_calls = []

        def status(self):
            self.status_calls += 1
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
            self.tool_calls.append((tool_name, arguments))
            raise AssertionError("Associate execution readiness must use tools/list only")

    erp_adapter = ProbeErpAdapter()
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeReimbursementAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=erp_adapter),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["writes_external_data"] is False
    assert body["erp_mcp_associate_execution_readiness"] == {
        "status": "passed",
        "writes_external_data": False,
        "required_tool_names": [
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
        ],
        "tool_names": [
                    "erp.finance.get_receivables_aging",
                    "erp.collection_task.create_draft",
                    "erp.collection_task.get_status",
        ],
        "missing_tools": [],
    }
    assert erp_adapter.status_calls == 1
    assert erp_adapter.tool_calls == []


def test_admin_runtime_validation_reports_when_associate_execution_tools_are_missing():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeReimbursementAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class MissingAssociateExecutionToolErpAdapter:
        settings = RuntimeSettings(erp_mcp_server="https://erp.example/rpc")

        def status(self):
            return {
                "status": "connected",
                "server": self.settings.erp_mcp_server,
                "tool_count": 2,
                "tool_names": [
                    "erp.finance.get_receivables_aging",
                    "erp.collection_task.create_draft",
                ],
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError("Associate execution readiness must not call ERP tools")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeReimbursementAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=MissingAssociateExecutionToolErpAdapter(),
            ),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["erp_mcp_associate_execution_readiness"] == {
        "status": "failed",
        "writes_external_data": False,
        "required_tool_names": [
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
        ],
        "tool_names": [
            "erp.finance.get_receivables_aging",
            "erp.collection_task.create_draft",
        ],
        "missing_tools": ["erp.collection_task.get_status"],
        "error_code": "associate_execution_tools_missing",
        "retryable": False,
    }


def test_admin_runtime_validation_does_not_block_core_when_optional_associate_erp_is_unhealthy():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeReimbursementAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    class MissingAssociateReadToolErpAdapter:
        settings = RuntimeSettings(erp_mcp_server="https://erp.example/rpc")

        def status(self):
            return {
                "status": "unhealthy",
                "server": self.settings.erp_mcp_server,
                "tool_count": 1,
                "tool_names": [],
                "missing_tools": ["erp.finance.get_receivables_aging"],
                "error_code": "mcp_required_tools_missing",
                "message": "ERP MCP server is missing required Associate tools",
                "retryable": False,
            }

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeReimbursementAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(
                adapter=MissingAssociateReadToolErpAdapter(),
            ),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["erp_mcp_associate_execution_readiness"] == {
        "status": "skipped",
        "writes_external_data": False,
        "required_tool_names": [
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
        ],
        "tool_names": [],
    }


def test_admin_runtime_validation_blocks_on_invalid_model_response():
    class InvalidModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            raise ModelProviderError(
                "model_response_invalid",
                "model response was not valid JSON",
                retryable=True,
            )

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=InvalidModelProvider(),
                adapter=ProbeAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["model"]["status"] == "failed"
    assert body["model"]["error_code"] == "model_response_invalid"
    assert body["model"]["retryable"] is True


def test_admin_runtime_validation_blocks_when_no_tool_probe_returns_tool_call():
    class ToolCallingModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            assert request.tools == []
            return ModelResponse(
                assistant_message=None,
                tool_calls=[
                    ModelToolCall(
                        id="call_probe",
                        name="reimbursement.get_capabilities",
                        arguments={},
                    )
                ],
                finish_reason="tool_calls",
            )

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ToolCallingModelProvider(),
                adapter=ProbeAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["model"]["status"] == "failed"
    assert body["model"]["error_code"] == "model_probe_requested_tools"
    assert body["model"]["tool_call_count"] == 1


def test_admin_runtime_validation_blocks_when_tool_contract_probe_requests_tool():
    class ToolContractCallingModelProvider:
        def __init__(self) -> None:
            self.settings = RuntimeSettings(
                model_endpoint="https://model.example/v1/chat/completions",
                model_api_key="secret-key",
                model_name="mimo-v2.5-pro",
            )
            self.requests = []

        async def create_response(self, request):
            self.requests.append(request)
            if len(self.requests) == 1:
                assert request.tools == []
                return ModelResponse(assistant_message="ok", finish_reason="stop")
            assert request.tools
            return ModelResponse(
                assistant_message=None,
                tool_calls=[
                    ModelToolCall(
                        id="call_probe_tool_contract",
                        name="reimbursement.get_capabilities",
                        arguments={},
                    )
                ],
                finish_reason="tool_calls",
            )

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    model_provider = ToolContractCallingModelProvider()
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=model_provider,
                adapter=ProbeAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["model"]["status"] == "failed"
    assert body["model"]["error_code"] == "model_tool_contract_probe_requested_tools"
    assert body["model"]["tool_contract_probe"] == {
        "status": "failed",
        "error_code": "model_tool_contract_probe_requested_tools",
        "retryable": False,
        "finish_reason": "tool_calls",
        "tool_call_count": 1,
        "tool_count": 6,
    }


def test_admin_runtime_validation_blocks_if_mcp_read_probe_fails():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class FailingReadAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
            assert tool_name == "reimbursement.get_capabilities"
            raise ReimbursementMcpError(
                "mcp_call_failed",
                "capabilities call failed",
                retryable=True,
            )

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=FailingReadAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["reimbursement_mcp_read_probe"] == {
        "status": "failed",
        "writes_external_data": False,
        "tool_names": ["reimbursement.get_capabilities"],
        "error_code": "mcp_call_failed",
        "retryable": True,
    }


def test_admin_runtime_validation_blocks_if_read_probe_lacks_explicit_valid_true():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class EmptyValidationAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                return {}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=EmptyValidationAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["reimbursement_mcp_read_probe"] == {
        "status": "failed",
        "writes_external_data": False,
        "tool_names": [
            "reimbursement.get_capabilities",
            "reimbursement.validate_draft",
        ],
        "error_code": "mcp_read_probe_validation_failed",
        "retryable": False,
    }


def test_admin_runtime_validation_read_probe_uses_generic_tools_call():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class GenericOnlyAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

        def __init__(self) -> None:
            self.calls = []

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
            self.calls.append((tool_name, arguments))
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected write probe call: {tool_name}")

    adapter = GenericOnlyAdapter()
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=adapter,
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ConnectedErpAdapter()),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert [name for name, _arguments in adapter.calls] == [
        "reimbursement.get_capabilities",
        "reimbursement.validate_draft",
    ]
    assert adapter.calls[0][1]["workspace_id"]
    assert adapter.calls[1][1]["draft"]["reason"] == "Anna runtime MCP read probe"


def test_admin_runtime_validation_uses_configured_reimbursement_probe_draft():
    probe_draft = {
        "category": "travel",
        "amount": 88,
        "currency": "CNY",
        "expense_date": "2026-06-01",
        "merchant": "真实差旅供应商",
        "reason": "真实连接器只读探针",
        "department_id": "sales-real",
        "cost_center_id": "cc-real",
        "attachments": [],
        "token": "draft-token-secret",
        "password": "draft-password-secret",
    }
    expected_probe_draft = {
        "category": "travel",
        "amount": 88,
        "currency": "CNY",
        "expense_date": "2026-06-01",
        "merchant": "真实差旅供应商",
        "reason": "真实连接器只读探针",
        "department_id": "sales-real",
        "cost_center_id": "cc-real",
    }

    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
            reimbursement_probe_draft=probe_draft,
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        settings = RuntimeSettings(
            reimbursement_mcp_server="https://mcp.example/rpc",
            reimbursement_probe_draft=probe_draft,
        )

        def __init__(self) -> None:
            self.validate_draft = None

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
                self.validate_draft = arguments["draft"]
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    adapter = ProbeAdapter()
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=adapter,
                settings=RuntimeSettings(reimbursement_probe_draft=probe_draft),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ConnectedErpAdapter()),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["reimbursement_mcp_read_probe"]["draft_source"] == "runtime_config"
    assert adapter.validate_draft == expected_probe_draft
    assert "draft-token-secret" not in response.text
    assert "draft-password-secret" not in response.text


def test_runtime_validation_draft_uses_current_date(monkeypatch):
    class FakeDate:
        @classmethod
        def today(cls):
            return cls()

        def isoformat(self):
            return "2030-01-02"

    monkeypatch.setattr(api_main, "date", FakeDate, raising=False)

    assert api_main._runtime_validation_draft()["expense_date"] == "2030-01-02"


def test_admin_runtime_validation_blocks_if_backend_submit_is_model_visible(
    monkeypatch,
):
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

        def status(self):
            return {
                "status": "connected",
                "server": self.settings.reimbursement_mcp_server,
                "tool_count": 6,
                "tool_names": [],
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    monkeypatch.setattr(
        "services.api.app.main._model_visible_reimbursement_tools",
        lambda _reimbursement, _mcp_status=None: [
            {
                "name": "reimbursement.submit",
                "description": "Backend submit.",
                "input_schema": {"type": "object"},
            }
        ],
    )
    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ConnectedErpAdapter()),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["tool_contract"]["backend_submit_model_visible"] is True


def test_admin_runtime_validation_blocks_if_submit_snapshot_contract_unknown():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                "tools": [{"name": "reimbursement.submit"}],
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ConnectedErpAdapter()),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["tool_contract"]["backend_submit_snapshot_contract"] == {
        "status": "unknown",
        "error_code": "submit_schema_missing",
    }


def test_admin_runtime_validation_blocks_if_submit_schema_lacks_snapshot_contract():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                "tools": [
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
                            },
                        },
                    },
                    {"name": "reimbursement.get_status"},
                ],
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["tool_contract"]["backend_submit_snapshot_contract"] == {
        "status": "failed",
        "error_code": "submit_snapshot_contract_missing_fields",
        "missing_fields": [
            "expected_draft_snapshot",
            "expected_draft_snapshot_hash",
        ],
    }


def test_admin_runtime_validation_blocks_if_mcp_requires_unsupported_draft_fields():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

        def status(self):
            tools = _tools_with_submit_snapshot_contract()
            tools.append(
                {
                    "name": "reimbursement.create_draft",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "draft": {
                                "type": "object",
                                "properties": {
                                    "invoice_type": {"type": "string"},
                                },
                                "required": ["invoice_type"],
                            }
                        },
                    },
                }
            )
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
                "tools": tools,
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeAdapter(),
            )
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "blocked"
    assert body["tool_contract"]["mcp_schema_compatibility"] == {
        "status": "failed",
        "error_code": "unsupported_mcp_required_fields",
        "unsupported_required_fields": ["invoice_type"],
    }


def test_admin_runtime_validation_accepts_submit_snapshot_contract_from_input_schema():
    class ProbeModelProvider:
        settings = RuntimeSettings(
            model_endpoint="https://model.example/v1/chat/completions",
            model_api_key="secret-key",
            model_name="mimo-v2.5-pro",
        )

        async def create_response(self, request):
            return ModelResponse(assistant_message="ok", finish_reason="stop")

    class ProbeAdapter:
        settings = RuntimeSettings(reimbursement_mcp_server="https://mcp.example/rpc")

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
                "tools": [
                    {"name": "reimbursement.get_capabilities"},
                    {"name": "reimbursement.get_policy"},
                    {"name": "reimbursement.validate_draft"},
                    {"name": "reimbursement.create_draft"},
                    {
                        "name": "reimbursement.submit",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "external_reimbursement_id": {"type": "string"},
                                "expected_draft_snapshot": {"type": "object"},
                                "expected_draft_snapshot_hash": {"type": "string"},
                            },
                        },
                    },
                    {"name": "reimbursement.get_status"},
                ],
            }

        def call_tool(self, tool_name, arguments):
            if tool_name == "reimbursement.get_capabilities":
                return {"supports_create_draft": True}
            if tool_name == "reimbursement.validate_draft":
                return {"valid": True, "missing_fields": []}
            raise AssertionError(f"unexpected runtime validation tool: {tool_name}")

    client = TestClient(
        create_app(
            orchestrator=ReimbursementOrchestrator(
                model_provider=ProbeModelProvider(),
                adapter=ProbeAdapter(),
            ),
            associate_orchestrator=AssociateReceivablesOrchestrator(adapter=ConnectedErpAdapter()),
        )
    )

    response = client.post("/api/admin/runtime/validate")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["tool_contract"]["backend_submit_snapshot_contract"] == {
        "status": "passed",
    }


def test_admin_runtime_status_reports_hiker_mcp_and_config():
    from services.hiker.app.orchestrator import HikerOrchestrator

    class ProbeHikerAdapter:
        settings = RuntimeSettings(
            hiker_mcp_server="https://hiker.example/rpc",
            hiker_mcp_api_key="hiker-secret",
        )

        def status(self):
            return {
                "status": "connected",
                "server": self.settings.hiker_mcp_server,
                "tool_count": 11,
                "tool_names": ["hiker.report.get_dashboard_summary"],
            }

    client = TestClient(
        create_app(
            hiker_orchestrator=HikerOrchestrator(
                adapter=ProbeHikerAdapter(),
                settings=RuntimeSettings(),
            )
        )
    )

    response = client.get("/api/admin/runtime/status")

    assert response.status_code == 200
    body = response.json()
    assert body["hiker_mcp"]["status"] == "connected"
    assert body["config"]["hiker_mcp_server_configured"] is True
    assert body["config"]["hiker_mcp_api_key_configured"] is True
    assert "hiker-secret" not in response.text


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


def test_admin_model_profiles_add_and_delete_roundtrip(monkeypatch, tmp_path):
    config_path = tmp_path / "runtime.json"
    config_path.write_text(json.dumps({"model_endpoint": "https://m.example/v1"}), encoding="utf-8")
    monkeypatch.setenv("ANNA_RUNTIME_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    added = client.post(
        "/api/admin/runtime/model-profiles",
        json={
            "id": "alt",
            "label": "Alt 模型",
            "endpoint": "https://alt.example/v1/chat/completions",
            "model_name": "alt-model",
            "api_key": "k",
        },
    )
    assert added.status_code == 200
    stored = json.loads(config_path.read_text(encoding="utf-8"))
    assert [p["id"] for p in stored["model_profiles"]] == ["alt"]
    assert stored["model_profiles"][0]["api_key"] == "k"
    # response redacts endpoint/key
    values = added.json()["values"]
    assert values["model_profiles"][0]["api_key_configured"] is True

    dup = client.post(
        "/api/admin/runtime/model-profiles",
        json={"id": "alt", "label": "x", "endpoint": "e", "model_name": "m"},
    )
    assert dup.status_code == 409

    removed = client.delete("/api/admin/runtime/model-profiles/alt")
    assert removed.status_code == 200
    stored = json.loads(config_path.read_text(encoding="utf-8"))
    assert stored["model_profiles"] == []

    missing = client.delete("/api/admin/runtime/model-profiles/ghost")
    assert missing.status_code == 404
