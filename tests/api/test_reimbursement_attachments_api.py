import hashlib
import base64

from fastapi.testclient import TestClient

from services.api.app.main import create_app
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelResponse
from services.runtime.app.model_provider import ModelToolCall
from tests.support.engine_fakes import FakeStreamModel


HEADERS = {
    "X-Anna-Workspace-ID": "demo",
    "X-Anna-User-ID": "u_demo",
}


def _configured_settings(tmp_path) -> RuntimeSettings:
    return RuntimeSettings(
        model_endpoint="https://model.test/v1/chat/completions",
        model_api_key="test-key",
        state_db_path=str(tmp_path / "state.sqlite3"),
    )


def _engine(stream: FakeStreamModel, settings: RuntimeSettings) -> QueryEngine:
    return QueryEngine(settings=settings, deps=QueryDeps(stream_model=stream))


class CollectingModelProvider(FakeStreamModel):
    def respond(self, request):
        return ModelResponse(
            assistant_message="请补充附件。",
            finish_reason="stop",
        )


class ConnectedStatusGateway:
    def status(self):
        return {"status": "connected", "server": "test-mcp"}

    def call_tool(self, tool_name, arguments):
        raise AssertionError("attachment collection should not call MCP tools")


class AttachmentDraftModelProvider(FakeStreamModel):
    def __init__(self, attachment: dict | None = None) -> None:
        super().__init__()
        self.attachment = attachment

    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                assistant_message="请补充附件和报销字段。",
                finish_reason="stop",
            )
        draft = {
            "category": "meal",
            "amount": 860,
            "currency": "CNY",
            "expense_date": "2026-05-28",
            "merchant": "上海客户餐厅",
            "reason": "ACME 续约客户晚餐",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
            "attachments": [self.attachment],
        }
        if len(self.requests) == 2:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={"draft": draft},
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 3:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={"draft": draft},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": "EXT-DRAFT-001",
                        "amount": 860,
                        "currency": "CNY",
                        "reason": "ACME 续约客户晚餐",
                        "policy_summary": "附件和报销字段校验通过",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class CapturingCreateDraftGateway:
    def __init__(self) -> None:
        self.create_draft_arguments = None

    def status(self):
        return {"status": "connected", "server": "test-mcp"}

    def call_tool(self, tool_name, arguments):
        if tool_name == "reimbursement.validate_draft":
            return {
                "valid": True,
                "missing_fields": [],
                "policy_summary": "附件和报销字段校验通过",
                "risk_level": "low",
            }
        if tool_name == "reimbursement.create_draft":
            self.create_draft_arguments = arguments
            return {
                "external_reimbursement_id": "EXT-DRAFT-001",
                "external_status": "draft",
                "created": True,
            }
        raise AssertionError(f"unexpected tool call: {tool_name}")


def test_reimbursement_attachment_upload_imports_file_without_leaking_path(tmp_path):
    content = b"receipt-bytes"
    sha256 = hashlib.sha256(content).hexdigest()
    settings = _configured_settings(tmp_path)
    orchestrator = ReimbursementOrchestrator(
        adapter=ConnectedStatusGateway(),
        engine=_engine(CollectingModelProvider(), settings),
        settings=settings,
    )
    client = TestClient(create_app(orchestrator=orchestrator))

    response = client.post(
        "/api/cowork/reimbursements/attachments",
        headers={
            **HEADERS,
            "X-Anna-Attachment-Name": "../receipt.pdf",
            "Content-Type": "application/octet-stream",
        },
        content=content,
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "name": "receipt.pdf",
        "uri": f"anna://attachment/{sha256}/receipt.pdf",
        "size_bytes": len(content),
        "sha256": sha256,
    }
    stored_path = tmp_path / "attachments" / "demo" / "u_demo" / sha256 / "receipt.pdf"
    assert stored_path.read_bytes() == content
    assert str(tmp_path) not in response.text


def test_answer_missing_fields_rejects_synthetic_attachment_uri(tmp_path):
    settings = _configured_settings(tmp_path)
    orchestrator = ReimbursementOrchestrator(
        adapter=ConnectedStatusGateway(),
        engine=_engine(CollectingModelProvider(), settings),
        settings=settings,
    )
    client = TestClient(create_app(orchestrator=orchestrator))
    run = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "请帮我报销，需要补附件。",
        },
    ).json()

    response = client.post(
        f"/api/cowork/reimbursements/runs/{run['id']}/answers",
        headers=HEADERS,
        json={
            "answers": {
                "attachments": [
                    {"name": "receipt.pdf", "uri": "anna://artifact/receipt.pdf"}
                ]
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "attachments must be imported through Anna"


def test_answer_missing_fields_accepts_imported_attachment_ref(tmp_path):
    content = b"receipt-bytes"
    settings = _configured_settings(tmp_path)
    orchestrator = ReimbursementOrchestrator(
        adapter=ConnectedStatusGateway(),
        engine=_engine(CollectingModelProvider(), settings),
        settings=settings,
    )
    client = TestClient(create_app(orchestrator=orchestrator))
    attachment = client.post(
        "/api/cowork/reimbursements/attachments",
        headers={
            **HEADERS,
            "X-Anna-Attachment-Name": "receipt.pdf",
            "Content-Type": "application/octet-stream",
        },
        content=content,
    ).json()
    run = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "请帮我报销，需要补附件。",
        },
    ).json()

    response = client.post(
        f"/api/cowork/reimbursements/runs/{run['id']}/answers",
        headers=HEADERS,
        json={"answers": {"attachments": [attachment]}},
    )

    assert response.status_code == 200
    assert response.json()["draft"]["attachments"] == [
        {"name": "receipt.pdf", "uri": attachment["uri"]}
    ]


def test_create_draft_materializes_imported_attachment_content_for_mcp(tmp_path):
    content = b"receipt-bytes"
    sha256 = hashlib.sha256(content).hexdigest()
    gateway = CapturingCreateDraftGateway()
    stream = AttachmentDraftModelProvider()
    settings = _configured_settings(tmp_path)
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream, settings),
        settings=settings,
    )
    client = TestClient(create_app(orchestrator=orchestrator))
    attachment = client.post(
        "/api/cowork/reimbursements/attachments",
        headers={
            **HEADERS,
            "X-Anna-Attachment-Name": "receipt.pdf",
            "Content-Type": "application/octet-stream",
        },
        content=content,
    ).json()
    stream.attachment = attachment
    run = client.post(
        "/api/cowork/reimbursements/runs",
        headers=HEADERS,
        json={
            "workspace_id": "demo",
            "actor_user_id": "u_demo",
            "input_text": "请帮我提交带发票的 ACME 客户餐费报销。",
        },
    ).json()
    answered = client.post(
        f"/api/cowork/reimbursements/runs/{run['id']}/answers",
        headers=HEADERS,
        json={
            "answers": {
                "category": "meal",
                "amount": 860,
                "currency": "CNY",
                "expense_date": "2026-05-28",
                "merchant": "上海客户餐厅",
                "reason": "ACME 续约客户晚餐",
                "department_id": "sales",
                "cost_center_id": "cc_acme",
                "attachments": [attachment],
            }
        },
    )

    assert answered.status_code == 200
    assert gateway.create_draft_arguments is not None
    mcp_attachment = gateway.create_draft_arguments["draft"]["attachments"][0]
    assert mcp_attachment == {
        "name": "receipt.pdf",
        "uri": attachment["uri"],
        "size_bytes": len(content),
        "sha256": sha256,
        "content_base64": base64.b64encode(content).decode("ascii"),
    }
    assert answered.json()["draft"]["attachments"] == [
        {"name": "receipt.pdf", "uri": attachment["uri"]}
    ]
    assert "content_base64" not in answered.text
