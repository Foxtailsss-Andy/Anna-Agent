import hashlib
import json
from pathlib import Path

import pytest

from services.mcp_gateway.app.reimbursement_adapter import ReimbursementMcpGateway
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from services.runtime.app.skill_loader import SkillLoader
from tests.mcp_gateway.local_reimbursement_mcp_server import (
    LocalReimbursementMcpContractServer,
)
from tests.support.engine_fakes import FakeStreamModel


CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.test/v1/chat/completions",
    model_api_key="test-key",
)


def write_minimal_reimbursement_skill(project_root: Path, skill_id: str) -> None:
    skill_dir = project_root / "skills" / skill_id
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


# --- fake streaming model -----------------------------------------------------
# FakeStreamModel is the shared governed fake (tests/support/engine_fakes):
# subclasses below keep the old fake-model-provider bodies (one ModelResponse
# per round, staged on len(self.requests)) via its respond() adapter.


def _engine(stream: FakeStreamModel) -> QueryEngine:
    return QueryEngine(
        settings=CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=stream)
    )


def stepwise_engine() -> QueryEngine:
    """A fresh engine wired to a fresh ``StepwiseFakeModelProvider`` (shared
    with the state-store tests)."""
    return _engine(StepwiseFakeModelProvider())


class FakeModelProvider(FakeStreamModel):
    def respond(self, request):
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_create",
                    name="reimbursement.create_draft",
                    arguments={
                        "draft": {
                            "category": "transport",
                            "amount": 128,
                            "currency": "CNY",
                            "expense_date": "2026-05-29",
                            "merchant": "上海交通服务",
                            "reason": "ACME 项目差旅交通",
                            "department_id": "sales",
                            "cost_center_id": "cc_acme",
                        }
                    },
                ),
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": "EXT-DRAFT-001",
                        "risk_level": "low",
                    },
                ),
            ],
            finish_reason="tool_calls",
        )


class CollectingModelProvider(FakeStreamModel):
    def respond(self, request):
        return ModelResponse(
            assistant_message="请补充报销信息。",
            finish_reason="stop",
        )


class FakeReimbursementMcpGateway:
    def __init__(self) -> None:
        self.validate_call_count = 0
        self.create_draft_call_count = 0
        self.submit_call_count = 0
        self.submit_arguments = []

    def status(self):
        return {"status": "connected", "server": "fake-test-server"}

    def call_tool(self, tool_name, arguments):
        if tool_name == "reimbursement.get_capabilities":
            return {
                "supports_draft": True,
                "supports_submit": True,
                "requires_attachment": False,
            }
        if tool_name == "reimbursement.get_policy":
            return self.get_policy(**arguments)
        if tool_name == "reimbursement.validate_draft":
            return self.validate_draft(
                arguments["workspace_id"],
                arguments["actor_user_id"],
                arguments["draft"],
            )
        if tool_name == "reimbursement.create_draft":
            return self.create_draft(**arguments)
        if tool_name == "reimbursement.get_status":
            return self.get_status(
                arguments["workspace_id"],
                arguments["actor_user_id"],
                arguments["external_reimbursement_id"],
            )
        raise AssertionError(f"unexpected tool call: {tool_name}")

    def create_draft(self, **kwargs):
        self.create_draft_call_count += 1
        return {
            "external_reimbursement_id": "EXT-DRAFT-001",
            "external_status": "draft",
            "created": True,
        }

    def get_policy(self, **kwargs):
        return {
            "policy_result": "allowed",
            "policy_summary": "交通费在标准内",
            "risk_level": "low",
        }

    def validate_draft(self, *args, **kwargs):
        self.validate_call_count += 1
        return {
            "valid": True,
            "missing_fields": [],
            "policy_summary": "交通费在标准内",
            "risk_level": "low",
        }

    def submit(self, **kwargs):
        self.submit_call_count += 1
        self.submit_arguments.append(kwargs)
        return {
            "external_reimbursement_id": "EXT-001",
            "external_status": "submitted",
            "submitted": True,
        }

    def get_status(self, workspace_id, actor_user_id, external_reimbursement_id):
        return {
            "external_reimbursement_id": external_reimbursement_id,
            "external_status": "submitted",
            "approval_stage": "manager_review",
        }


class GenericOnlyReimbursementMcpGateway:
    def __init__(self) -> None:
        self.calls = []

    def status(self):
        return {"status": "connected", "server": "generic-test-server"}

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        if tool_name == "reimbursement.validate_draft":
            return {
                "valid": True,
                "missing_fields": [],
                "policy_summary": "交通费在标准内",
                "risk_level": "low",
            }
        if tool_name == "reimbursement.create_draft":
            return {
                "external_reimbursement_id": "EXT-DRAFT-001",
                "external_status": "draft",
                "created": True,
            }
        raise AssertionError(f"unexpected tool call: {tool_name}")


class StepwiseFakeModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 2:
            assert any(
                message.get("role") == "tool"
                and message.get("name") == "reimbursement.validate_draft"
                and "交通费在标准内" in message.get("content", "")
                for message in request.messages
            )
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        assert any(
            message.get("role") == "tool"
            and message.get("name") == "reimbursement.create_draft"
            and "EXT-DRAFT-001" in message.get("content", "")
            for message in request.messages
        )
        assistant_tool_messages = [
            message
            for message in request.messages
            if message.get("role") == "assistant" and message.get("tool_calls")
        ]
        assert assistant_tool_messages
        assert request.messages.index(assistant_tool_messages[-1]) < next(
            index
            for index, message in enumerate(request.messages)
            if message.get("role") == "tool"
            and message.get("tool_call_id") == "call_create"
        )
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": "EXT-DRAFT-001",
                        "amount": 128,
                        "currency": "CNY",
                        "reason": "ACME 项目差旅交通",
                        "policy_summary": "交通费在标准内",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class ContractServerModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={
                            "draft": {
                                "category": "meal",
                                "amount": 860,
                                "currency": "CNY",
                                "expense_date": "2026-05-28",
                                "merchant": "上海客户餐厅",
                                "reason": "ACME 续约客户晚餐",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 2:
            assert any(
                message.get("role") == "tool"
                and message.get("name") == "reimbursement.validate_draft"
                for message in request.messages
            )
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={
                            "draft": {
                                "category": "meal",
                                "amount": 860,
                                "currency": "CNY",
                                "expense_date": "2026-05-28",
                                "merchant": "上海客户餐厅",
                                "reason": "ACME 续约客户晚餐",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )

        create_observation = next(
            message
            for message in request.messages
            if message.get("role") == "tool"
            and message.get("name") == "reimbursement.create_draft"
        )
        external_id = json.loads(create_observation["content"])[
            "external_reimbursement_id"
        ]
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": external_id,
                        "amount": 860,
                        "currency": "CNY",
                        "reason": "ACME 续约客户晚餐",
                        "policy_summary": "contract server validation passed",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class PolicyObservationFakeModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_policy",
                        name="reimbursement.get_policy",
                        arguments={
                            "category": "transport",
                            "amount": 128,
                            "currency": "CNY",
                            "department_id": "sales",
                            "cost_center_id": "cc_acme",
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        assert any(
            message.get("role") == "tool"
            and message.get("name") == "reimbursement.get_policy"
            and "交通费在标准内" in message.get("content", "")
            for message in request.messages
        )
        return ModelResponse(
            assistant_message="还需要发票附件。",
            finish_reason="stop",
        )


class MismatchedSubmitIntentFakeModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 2:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
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
                        "external_reimbursement_id": "EXT-OTHER",
                        "amount": 128,
                        "currency": "CNY",
                        "reason": "ACME 项目差旅交通",
                        "policy_summary": "交通费在标准内",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class ForbiddenSubmitFakeModelProvider(FakeStreamModel):
    def respond(self, request):
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_forbidden_submit",
                    name="reimbursement.submit",
                    arguments={"external_reimbursement_id": "EXT-DRAFT-001"},
                )
            ],
            finish_reason="tool_calls",
        )


class MismatchedStatusReadFakeModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 2:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 3:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_status",
                        name="reimbursement.get_status",
                        arguments={"external_reimbursement_id": "EXT-OTHER"},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="读回完成。",
            finish_reason="stop",
        )


class CreateWithoutValidationModelProvider(FakeStreamModel):
    def respond(self, request):
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_create",
                    name="reimbursement.create_draft",
                    arguments={
                        "draft": {
                            "category": "transport",
                            "amount": 128,
                            "currency": "CNY",
                            "expense_date": "2026-05-29",
                            "merchant": "上海交通服务",
                            "reason": "ACME 项目差旅交通",
                            "department_id": "sales",
                            "cost_center_id": "cc_acme",
                        }
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class SubmitIntentMissingContextModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) == 2:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_create",
                        name="reimbursement.create_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                            }
                        },
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
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class MissingRequiredFieldAfterValidationModelProvider(FakeStreamModel):
    def respond(self, request):
        draft = {
            "category": "transport",
            "amount": 128,
            "currency": "CNY",
            "expense_date": "2026-05-29",
            "reason": "ACME 项目差旅交通",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
        }
        if len(self.requests) == 1:
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


class ConnectorMissingFieldsModelProvider(FakeStreamModel):
    def respond(self, request):
        if len(self.requests) != 1:
            raise AssertionError("connector missing fields should stop the model loop")
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_validate",
                    name="reimbursement.validate_draft",
                    arguments={
                        "draft": {
                            "category": "transport",
                            "amount": 128,
                            "currency": "CNY",
                            "expense_date": "2026-05-29",
                            "merchant": "上海交通服务",
                            "reason": "ACME 项目差旅交通",
                            "department_id": "sales",
                            "cost_center_id": "cc_acme",
                        }
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class MissingCurrencyAfterValidationModelProvider(FakeStreamModel):
    def respond(self, request):
        draft = {
            "category": "transport",
            "amount": 128,
            "expense_date": "2026-05-29",
            "merchant": "上海交通服务",
            "reason": "ACME 项目差旅交通",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
        }
        if len(self.requests) == 1:
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


class MissingFieldRecoveryModelProvider(FakeStreamModel):
    def __init__(self) -> None:
        super().__init__()
        self.draft_without_merchant = {
            "category": "transport",
            "amount": 128,
            "currency": "CNY",
            "expense_date": "2026-05-29",
            "reason": "ACME 项目差旅交通",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
        }

    def respond(self, request):
        if len(self.requests) in {1, 3}:
            if len(self.requests) == 3:
                assert any(
                    message.get("role") == "user"
                    and "Current reimbursement draft" in message.get("content", "")
                    and "上海交通服务" in message.get("content", "")
                    for message in request.messages
                )
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id=f"call_validate_{len(self.requests)}",
                        name="reimbursement.validate_draft",
                        arguments={"draft": self.draft_without_merchant},
                    )
                ],
                finish_reason="tool_calls",
            )
        if len(self.requests) in {2, 4}:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id=f"call_create_{len(self.requests)}",
                        name="reimbursement.create_draft",
                        arguments={"draft": self.draft_without_merchant},
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
                        "amount": 128,
                        "currency": "CNY",
                        "reason": "ACME 项目差旅交通",
                        "policy_summary": "交通费在标准内",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


class CreateDraftWithExternalStateModelProvider(FakeStreamModel):
    def respond(self, request):
        draft = {
            "category": "transport",
            "amount": 128,
            "currency": "CNY",
            "expense_date": "2026-05-29",
            "merchant": "上海交通服务",
            "reason": "ACME 项目差旅交通",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
            "external_reimbursement_id": "MODEL-INVENTED-ID",
            "external_status": "submitted",
        }
        if len(self.requests) == 1:
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


class MismatchedPolicySummarySubmitIntentModelProvider(FakeStreamModel):
    def respond(self, request):
        draft = {
            "category": "transport",
            "amount": 128,
            "currency": "CNY",
            "expense_date": "2026-05-29",
            "merchant": "上海交通服务",
            "reason": "ACME 项目差旅交通",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
        }
        if len(self.requests) == 1:
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
        if len(self.requests) == 2:
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
                        "amount": 128,
                        "currency": "CNY",
                        "reason": "ACME 项目差旅交通",
                        "policy_summary": "模型自编政策结论",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


def test_agent_rejects_submit_intent_mixed_with_external_tool_calls():
    stream = FakeModelProvider()
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "submit_intent_requires_prior_observation"
    assert len(stream.requests) == 1
    assert run.approval is None
    assert run.draft.external_reimbursement_id is None
    assert gateway.create_draft_call_count == 0
    assert gateway.submit_call_count == 0
    event_types = [event.type for event in run.audit_events]
    assert "skill.loaded" in event_types
    assert "model.call.started" in event_types
    assert "model.call.completed" in event_types
    assert "reimbursement.failed" in event_types


def test_orchestrator_blocks_model_call_when_mcp_connector_is_missing():
    class MissingConnectorGateway:
        settings = RuntimeSettings()

        def status(self):
            return {
                "status": "not_configured",
                "error_code": "connector_not_configured",
            }

        def call_tool(self, tool_name, arguments):
            raise AssertionError("MCP tools should not be called when connector is missing")

    stream = CollectingModelProvider()
    orchestrator = ReimbursementOrchestrator(
        adapter=MissingConnectorGateway(),
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "connector_not_configured"
    assert len(stream.requests) == 0
    event_types = [event.type for event in run.audit_events]
    assert "skill.loaded" in event_types
    assert "model.call.started" not in event_types
    assert "reimbursement.failed" in event_types


def test_orchestrator_loads_reimbursement_skill_from_runtime_settings(tmp_path):
    write_minimal_reimbursement_skill(tmp_path, "reimbursement/custom-travel")
    stream = FakeModelProvider()
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=_engine(stream),
        skill_loader=SkillLoader(project_root=tmp_path),
        settings=RuntimeSettings(
            model_endpoint="https://model.test/v1/chat/completions",
            model_api_key="test-key",
            reimbursement_skill_id="reimbursement/custom-travel",
        ),
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "submit_intent_requires_prior_observation"
    loaded_events = [
        event for event in run.audit_events if event.type == "skill.loaded"
    ]
    assert loaded_events[0].payload["skill_id"] == "reimbursement/custom-travel"
    assert loaded_events[0].payload["skill_name"] == "custom-travel-reimbursement"
    assert [tool["name"] for tool in stream.requests[0].tools] == [
        "reimbursement.submit_intent"
    ]


def test_orchestrator_model_request_uses_safely_merged_mcp_schema():
    class SchemaReportingGateway(FakeReimbursementMcpGateway):
        def status(self):
            return {
                "status": "connected",
                "server": "fake-test-server",
                "tools": [
                    {
                        "name": "reimbursement.create_draft",
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
                        },
                    },
                    {
                        "name": "reimbursement.submit",
                        "input_schema": {"type": "object"},
                    },
                ],
            }

    stream = CollectingModelProvider()
    orchestrator = ReimbursementOrchestrator(
        adapter=SchemaReportingGateway(),
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    tools = {tool["name"]: tool for tool in stream.requests[0].tools}
    create_schema = tools["reimbursement.create_draft"]["input_schema"]
    draft_schema = create_schema["properties"]["draft"]
    assert tools["reimbursement.create_draft"]["schema_source"] == "mcp"
    assert "workspace_id" not in create_schema["properties"]
    assert draft_schema["properties"]["amount"]["minimum"] == 1
    assert "external_status" not in draft_schema["properties"]
    assert "reimbursement.submit" not in tools
    started_event = next(
        event for event in run.audit_events if event.type == "model.call.started"
    )
    provider_visible_tools = [
        {
            "type": "function",
            "function": {
                "name": tool["name"].replace(".", "__"),
                "description": tool["description"],
                "parameters": tool["input_schema"],
            },
        }
        for tool in stream.requests[0].tools
    ]
    expected_hash = hashlib.sha256(
        json.dumps(
            {"tools": provider_visible_tools},
            sort_keys=True,
            ensure_ascii=True,
        ).encode()
    ).hexdigest()
    assert started_event.payload["tool_contract_hash"] == expected_hash
    # model.call.started no longer carries tool_schema_sources / skill_id /
    # prompt_hash (the platform engine has no business context); the merged
    # schema provenance is still asserted through the tools the model saw.
    assert "tool_schema_sources" not in started_event.payload
    assert "skill_id" not in started_event.payload
    assert tools["reimbursement.submit_intent"]["schema_source"] == "registry"


def test_agent_message_is_persisted_on_collecting_run():
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=_engine(CollectingModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    assert run.agent_message == "请补充报销信息。"
    agent_event = next(
        event
        for event in run.audit_events
        if event.type == "reimbursement.agent.message"
    )
    assert agent_event.payload["message_hash"]
    assert "请补充报销信息" not in json.dumps(
        agent_event.payload,
        ensure_ascii=False,
    )


def test_agent_loop_feeds_tool_observation_back_to_model_before_submit_intent():
    stream = StepwiseFakeModelProvider()
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "waiting_confirmation"
    assert len(stream.requests) == 3
    assert run.approval is not None
    assert run.draft.external_reimbursement_id == "EXT-DRAFT-001"
    assert run.approval.payload == {
        "external_reimbursement_id": "EXT-DRAFT-001",
        "amount": 128,
        "currency": "CNY",
        "reason": "ACME 项目差旅交通",
        "policy_summary": "交通费在标准内",
    }
    expected_payload_hash = orchestrator._hash_payload(
        {"approval_payload": run.approval.payload}
    )
    expected_draft_snapshot = run.draft.as_mcp_payload()
    expected_draft_snapshot_hash = orchestrator._draft_hash(expected_draft_snapshot)
    assert run.approval.payload_hash == expected_payload_hash
    assert run.approval.draft_snapshot == expected_draft_snapshot
    assert run.approval.draft_snapshot_hash == expected_draft_snapshot_hash
    assert gateway.validate_call_count == 1
    assert gateway.submit_call_count == 0
    event_types = [event.type for event in run.audit_events]
    assert event_types.count("model.call.started") == 3
    assert event_types.count("model.call.completed") == 3
    completed_events = [
        event for event in run.audit_events if event.type == "model.call.completed"
    ]
    assert completed_events[0].payload["finish_reason"] == "tool_calls"
    assert completed_events[0].payload["tool_call_count"] == 1
    assert completed_events[0].payload["requested_tool_names"] == [
        "reimbursement.validate_draft"
    ]
    assert completed_events[1].payload["finish_reason"] == "tool_calls"
    assert completed_events[1].payload["tool_call_count"] == 1
    assert completed_events[1].payload["requested_tool_names"] == [
        "reimbursement.create_draft"
    ]
    assert completed_events[2].payload["finish_reason"] == "tool_calls"
    assert completed_events[2].payload["tool_call_count"] == 1
    assert completed_events[2].payload["requested_tool_names"] == [
        "reimbursement.submit_intent"
    ]
    assert "approval.intent.requested" in event_types
    policy_event = next(
        event
        for event in run.audit_events
        if event.type == "reimbursement.policy.checked"
    )
    assert policy_event.payload["tool_name"] == "reimbursement.validate_draft"
    assert policy_event.payload["policy_summary"] == "交通费在标准内"
    assert policy_event.payload["risk_level"] == "low"
    assert policy_event.payload["missing_fields"] == []
    assert policy_event.payload["valid"] is True
    requested_event = next(
        event for event in run.audit_events if event.type == "approval.requested"
    )
    assert requested_event.payload["approval_payload_hash"] == expected_payload_hash
    assert requested_event.payload["draft_snapshot_hash"] == expected_draft_snapshot_hash
    assert not any(
        event.type == "mcp.tool.called"
        and event.payload.get("tool_name") == "reimbursement.submit_intent"
        for event in run.audit_events
    )

    submitted = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )

    assert submitted.status == "completed"
    assert submitted.write_action is not None
    assert submitted.write_action.approval_payload_hash == expected_payload_hash
    assert submitted.write_action.draft_snapshot_hash == expected_draft_snapshot_hash
    assert submitted.write_action.verify_status == "verified"
    assert gateway.submit_call_count == 1
    assert gateway.submit_arguments[0]["expected_draft_snapshot"] == expected_draft_snapshot
    assert (
        gateway.submit_arguments[0]["expected_draft_snapshot_hash"]
        == expected_draft_snapshot_hash
    )
    approved_event = next(
        event for event in submitted.audit_events if event.type == "approval.approved"
    )
    assert approved_event.payload["approval_payload_hash"] == expected_payload_hash
    assert approved_event.payload["draft_snapshot_hash"] == expected_draft_snapshot_hash
    submitted_event = next(
        event
        for event in submitted.audit_events
        if event.type == "reimbursement.submitted"
    )
    assert submitted_event.payload["approval_id"] == run.approval.id
    assert submitted_event.payload["write_action_id"] == submitted.write_action.id
    assert submitted_event.payload["approval_payload_hash"] == expected_payload_hash
    assert submitted_event.payload["draft_snapshot_hash"] == expected_draft_snapshot_hash


def test_submit_readback_requires_matching_external_reimbursement_id():
    class MismatchedReadbackGateway(FakeReimbursementMcpGateway):
        def get_status(self, workspace_id, actor_user_id, external_reimbursement_id):
            return {
                "external_reimbursement_id": "EXT-OTHER",
                "external_status": "submitted",
            }

    gateway = MismatchedReadbackGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    submitted = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )

    assert submitted.status == "verify_pending"
    assert submitted.write_action is not None
    assert submitted.write_action.verify_status == "verify_pending"
    verified_event = next(
        event
        for event in submitted.audit_events
        if event.type == "reimbursement.verified"
    )
    assert verified_event.payload["verify_status"] == "verify_pending"
    assert verified_event.payload["external_reimbursement_id"] == "EXT-001"
    assert verified_event.payload["readback_external_reimbursement_id"] == "EXT-OTHER"


def test_approve_submit_requires_approval_payload_to_match_current_draft():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.approval is not None
    run.approval.payload["external_reimbursement_id"] = "EXT-DRAFT-TAMPERED"

    with pytest.raises(ValueError, match="approval payload does not match current draft"):
        orchestrator.approve_submit(
            approval_id=run.approval.id,
            approved_by="u_demo",
        )

    assert gateway.submit_call_count == 0
    assert run.approval.status == "pending"


def test_approve_submit_rejects_when_current_draft_changed_after_approval():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.approval is not None
    run.draft.merchant = "审批后变更的商户"

    with pytest.raises(ValueError, match="approval payload does not match current draft"):
        orchestrator.approve_submit(
            approval_id=run.approval.id,
            approved_by="u_demo",
        )

    assert gateway.submit_call_count == 0
    assert run.approval.status == "pending"


def test_approve_submit_rejects_when_approval_payload_hash_is_tampered():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.approval is not None
    run.approval.payload_hash = "tampered"

    with pytest.raises(ValueError, match="approval payload does not match current draft"):
        orchestrator.approve_submit(
            approval_id=run.approval.id,
            approved_by="u_demo",
        )

    assert gateway.submit_call_count == 0
    assert run.approval.status == "pending"


def test_approve_submit_compares_legacy_snapshot_even_without_snapshot_hash():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.approval is not None
    run.approval.draft_snapshot_hash = None
    run.draft.merchant = "审批后变更的商户"

    with pytest.raises(ValueError, match="approval payload does not match current draft"):
        orchestrator.approve_submit(
            approval_id=run.approval.id,
            approved_by="u_demo",
        )

    assert gateway.submit_call_count == 0
    assert run.approval.status == "pending"


def test_skill_visible_external_tools_dispatch_through_generic_mcp_call_tool():
    gateway = GenericOnlyReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=stepwise_engine(),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "waiting_confirmation"
    assert run.draft.external_reimbursement_id == "EXT-DRAFT-001"
    assert [name for name, _arguments in gateway.calls] == [
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
    ]
    validate_arguments = gateway.calls[0][1]
    create_arguments = gateway.calls[1][1]
    assert validate_arguments["workspace_id"] == "demo"
    assert validate_arguments["actor_user_id"] == "u_demo"
    assert validate_arguments["draft"]["merchant"] == "上海交通服务"
    assert create_arguments["workspace_id"] == "demo"
    assert create_arguments["actor_user_id"] == "u_demo"
    assert create_arguments["source"] == "Anna"
    assert create_arguments["source_run_id"] == run.id
    assert create_arguments["idempotency_key"] == f"idem_{run.id}_create"
    assert create_arguments["draft"]["merchant"] == "上海交通服务"


def test_user_answers_cannot_set_external_reimbursement_state():
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=_engine(PolicyObservationFakeModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )
    assert run.status == "collecting"

    with pytest.raises(ValueError, match="field is not user-editable"):
        orchestrator.answer_missing_fields(
            run.id,
            {
                "external_reimbursement_id": "USER-INVENTED-ID",
                "external_status": "submitted",
            },
        )

    assert run.draft.external_reimbursement_id is None
    assert run.draft.external_status is None


def test_model_cannot_supply_unimported_attachment_reference():
    class SyntheticAttachmentModelProvider(FakeStreamModel):
        def respond(self, request):
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_validate",
                        name="reimbursement.validate_draft",
                        arguments={
                            "draft": {
                                "category": "transport",
                                "amount": 128,
                                "currency": "CNY",
                                "expense_date": "2026-05-29",
                                "merchant": "上海交通服务",
                                "reason": "ACME 项目差旅交通",
                                "department_id": "sales",
                                "cost_center_id": "cc_acme",
                                "attachments": [
                                    {
                                        "name": "taxi.pdf",
                                        "uri": "anna://artifact/taxi.pdf",
                                    }
                                ],
                            }
                        },
                    )
                ],
                finish_reason="tool_calls",
            )

    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(SyntheticAttachmentModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费，附件 taxi.pdf。",
    )

    assert run.status == "collecting"
    assert run.missing_fields == ["attachments"]
    assert gateway.validate_call_count == 0
    assert gateway.create_draft_call_count == 0


def test_create_draft_requires_prior_successful_validation():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(CreateWithoutValidationModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "draft_validation_required"
    assert gateway.create_draft_call_count == 0


def test_create_draft_rejects_validate_draft_without_explicit_valid_true():
    class ValidateThenCreateModelProvider(FakeStreamModel):
        def respond(self, request):
            draft = {
                "category": "transport",
                "amount": 128,
                "currency": "CNY",
                "expense_date": "2026-05-29",
                "merchant": "上海交通服务",
                "reason": "ACME 项目差旅交通",
                "department_id": "sales",
                "cost_center_id": "cc_acme",
            }
            if len(self.requests) == 1:
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
            if len(self.requests) == 2:
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
                assistant_message="draft created",
                finish_reason="stop",
            )

    class EmptyValidationGateway(FakeReimbursementMcpGateway):
        def validate_draft(self, *args, **kwargs):
            self.validate_call_count += 1
            return {}

    gateway = EmptyValidationGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(ValidateThenCreateModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "draft_validation_required"
    assert gateway.validate_call_count == 1
    assert gateway.create_draft_call_count == 0
    assert not any(
        event.type == "reimbursement.draft.validated"
        for event in run.audit_events
    )


def test_create_draft_collects_skill_required_fields_after_validation():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(MissingRequiredFieldAfterValidationModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    assert run.error_code is None
    assert run.error_message is None
    assert run.missing_fields == ["merchant"]
    assert gateway.create_draft_call_count == 0
    assert any(
        event.type == "reimbursement.missing_fields.requested"
        and event.payload.get("missing_fields") == ["merchant"]
        for event in run.audit_events
    )


def test_validate_draft_missing_fields_collects_connector_required_fields():
    class ConnectorMissingFieldsGateway(FakeReimbursementMcpGateway):
        def validate_draft(self, *args, **kwargs):
            self.validate_call_count += 1
            return {
                "valid": False,
                "missing_fields": ["project_id", "attachments"],
                "policy_summary": "缺少项目和附件",
                "risk_level": "medium",
            }

    stream = ConnectorMissingFieldsModelProvider()
    gateway = ConnectorMissingFieldsGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    assert run.error_code is None
    assert run.error_message is None
    assert run.missing_fields == ["project_id", "attachments"]
    assert run.draft.project_id is None
    assert gateway.validate_call_count == 1
    assert gateway.create_draft_call_count == 0
    assert len(stream.requests) == 1
    assert any(
        event.type == "reimbursement.policy.checked"
        and event.payload.get("tool_name") == "reimbursement.validate_draft"
        and event.payload.get("missing_fields") == ["project_id", "attachments"]
        for event in run.audit_events
    )
    assert any(
        event.type == "reimbursement.missing_fields.requested"
        and event.payload.get("missing_fields") == ["project_id", "attachments"]
        for event in run.audit_events
    )


def test_create_draft_collects_missing_currency_after_validation():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(MissingCurrencyAfterValidationModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    assert run.error_code is None
    assert run.error_message is None
    assert run.missing_fields == ["currency"]
    assert run.draft.currency is None
    assert gateway.create_draft_call_count == 0


def test_answer_missing_fields_merges_answers_into_next_agent_tool_round():
    stream = MissingFieldRecoveryModelProvider()
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    assert run.missing_fields == ["merchant"]
    assert run.draft.merchant is None

    recovered = orchestrator.answer_missing_fields(
        run.id,
        {"merchant": "上海交通服务"},
    )

    assert recovered.status == "waiting_confirmation"
    assert recovered.draft.merchant == "上海交通服务"
    assert recovered.draft.external_reimbursement_id == "EXT-DRAFT-001"
    assert recovered.approval is not None
    assert len(stream.requests) == 5
    assert gateway.validate_call_count == 2
    assert gateway.create_draft_call_count == 1


def test_create_draft_rejects_model_supplied_external_state():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(CreateDraftWithExternalStateModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "external_state_not_allowed"
    assert gateway.create_draft_call_count == 0


def test_submit_intent_requires_review_context():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(SubmitIntentMissingContextModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "submit_intent_context_required"
    assert run.approval is None
    assert gateway.submit_call_count == 0


def test_submit_intent_uses_authoritative_policy_context_over_model_value():
    # policy_summary / risk_level are authoritative validate_draft outputs.
    # Even when the model submits a different self-authored summary, the
    # orchestrator overrides it with the validated value, so the model cannot
    # alter the assessed approval context.
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(MismatchedPolicySummarySubmitIntentModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "waiting_confirmation"
    assert run.approval is not None
    assert run.approval.payload["policy_summary"] == "交通费在标准内"
    assert run.approval.payload["policy_summary"] != "模型自编政策结论"
    assert gateway.submit_call_count == 0


def test_agent_loop_feeds_actual_mcp_tool_result_back_to_model():
    stream = PolicyObservationFakeModelProvider()
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "collecting"
    assert len(stream.requests) == 2
    assert any(
        event.type == "reimbursement.agent.message"
        for event in run.audit_events
    )
    assert any(
        event.type == "reimbursement.policy.checked"
        and event.payload.get("tool_name") == "reimbursement.get_policy"
        and event.payload.get("policy_summary") == "交通费在标准内"
        and event.payload.get("risk_level") == "low"
        for event in run.audit_events
    )


def test_agent_flow_uses_real_gateway_against_local_contract_server():
    server = LocalReimbursementMcpContractServer()
    gateway = ReimbursementMcpGateway(
        settings=RuntimeSettings(reimbursement_mcp_server=server.url),
        transport=server.transport(),
    )
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(ContractServerModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    assert gateway.status()["status"] == "connected"

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目客户餐费。",
    )

    assert run.status == "waiting_confirmation"
    assert run.draft.external_reimbursement_id == "contract-draft-run_001"
    assert run.approval is not None

    submitted = orchestrator.approve_submit(
        approval_id=run.approval.id,
        approved_by="u_demo",
    )

    assert submitted.status == "completed"
    assert submitted.write_action is not None
    assert submitted.write_action.verify_status == "verified"
    assert submitted.draft.external_status == "submitted"
    assert [request["method"] for request in server.requests] == [
        "tools/list",
        "tools/list",
        "tools/call",
        "tools/call",
        "tools/call",
        "tools/call",
    ]


def test_agent_rejects_submit_intent_for_different_external_draft_id():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(MismatchedSubmitIntentFakeModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "external_reimbursement_id_mismatch"
    assert run.approval is None
    assert gateway.submit_call_count == 0


def test_agent_forbidden_submit_tool_fails_with_audit_without_submit():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(ForbiddenSubmitFakeModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"
    assert gateway.submit_call_count == 0
    assert any(
        event.type == "reimbursement.failed"
        and event.payload.get("error_code") == "tool_not_allowed"
        for event in run.audit_events
    )


class DraftThenSilenceModelProvider(FakeStreamModel):
    """Creates the external draft, then stops calling tools; only after the
    Harness nudge does it request submit_intent."""

    def respond(self, request):
        draft = {
            "category": "transport",
            "amount": 128,
            "currency": "CNY",
            "expense_date": "2026-05-29",
            "merchant": "上海交通服务",
            "reason": "ACME 项目差旅交通",
            "department_id": "sales",
            "cost_center_id": "cc_acme",
        }
        if len(self.requests) == 1:
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
        if len(self.requests) == 2:
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
        if len(self.requests) == 3:
            # Model gives up in words instead of requesting submit_intent.
            return ModelResponse(
                assistant_message="草稿已创建，请人工提交。",
                finish_reason="stop",
            )
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_submit_intent",
                    name="reimbursement.submit_intent",
                    arguments={
                        "external_reimbursement_id": "EXT-DRAFT-001",
                        "amount": 128,
                        "currency": "CNY",
                        "reason": "ACME 项目差旅交通",
                        "policy_summary": "交通费在标准内",
                        "risk_level": "low",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


def test_agent_nudges_model_to_finish_submit_intent_after_draft_created():
    from services.reimbursement.app.capability import SUBMIT_GUIDANCE_MESSAGE

    stream = DraftThenSilenceModelProvider()
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    # The nudge spent one extra model round and completed the approval flow.
    assert run.status == "waiting_confirmation"
    assert run.approval is not None
    assert len(stream.requests) == 4
    # The nudged round carries the guidance as a spliced user message after
    # the model's no-tool assistant reply.
    nudged_messages = stream.requests[3].messages
    assert nudged_messages[-1] == {"role": "user", "content": SUBMIT_GUIDANCE_MESSAGE}
    assert nudged_messages[-2]["role"] == "assistant"
    assert nudged_messages[-2]["content"] == "草稿已创建，请人工提交。"
    # The no-tool round still recorded the agent message before nudging.
    assert any(
        event.type == "reimbursement.agent.message" for event in run.audit_events
    )


class AlwaysToolCallingModelProvider(FakeStreamModel):
    """Requests get_policy on EVERY round — drives the loop into exhaustion."""

    def respond(self, request):
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id=f"call_policy_{len(self.requests)}",
                    name="reimbursement.get_policy",
                    arguments={
                        "category": "transport",
                        "amount": 128,
                        "currency": "CNY",
                        "department_id": "sales",
                        "cost_center_id": "cc_acme",
                    },
                )
            ],
            finish_reason="tool_calls",
        )


def test_agent_fails_when_tool_loop_exhausts_max_rounds():
    stream = AlwaysToolCallingModelProvider()
    orchestrator = ReimbursementOrchestrator(
        adapter=FakeReimbursementMcpGateway(),
        engine=_engine(stream),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "tool_loop_exhausted"
    assert run.error_message == "model tool loop exceeded the maximum number of rounds"
    # Exactly MAX_MODEL_TOOL_ROUNDS (6) model calls were spent.
    assert len(stream.requests) == 6
    assert run.audit_events[-1].type == "reimbursement.failed"


def test_agent_rejects_status_read_for_different_external_draft_id():
    gateway = FakeReimbursementMcpGateway()
    orchestrator = ReimbursementOrchestrator(
        adapter=gateway,
        engine=_engine(MismatchedStatusReadFakeModelProvider()),
        settings=CONFIGURED_SETTINGS,
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        input_text="请帮我报销 ACME 项目交通费。",
    )

    assert run.status == "failed"
    assert run.error_code == "external_reimbursement_id_mismatch"
    assert gateway.submit_call_count == 0
