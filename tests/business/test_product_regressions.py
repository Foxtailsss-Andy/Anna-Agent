from __future__ import annotations

import json

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.app.routes.chat import _apply_chat_host_run
from services.api.app.routes.crew import build_router as build_crew_router
from services.api.app.routes.reimbursement import _task_for_reimbursement_run
from services.business.harness_client import HarnessHostClient, HarnessRun
from services.business.mode import BusinessModeConfig
from services.chat.app.orchestrator import ChatOrchestrator
from services.chat.app.schemas import ChatRun
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.reimbursement.app.schemas import (
    ApprovalRequest,
    ReimbursementDraft,
    ReimbursementRun,
    ReimbursementWriteAction,
)
from services.api.app.routes.reimbursement import build_router as build_reimbursement_router
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.skill_loader import SkillLoader


def test_chat_host_nonterminal_and_pause_statuses_do_not_become_failed():
    chat = ChatOrchestrator(settings=RuntimeSettings())

    for host_status, expected in (
        ("queued", "generating"),
        ("running", "generating"),
        ("resumed", "generating"),
        ("awaiting_input", "awaiting_continue"),
        ("awaiting_approval", "awaiting_continue"),
        ("cancelled", "interrupted"),
        ("timed_out", "failed"),
        ("failed", "failed"),
    ):
        run = ChatRun(
            id=f"chat-{host_status}",
            workspace_id="ws",
            actor_user_id="u",
            message="hello",
            thread_id="thread",
            status="generating",
        )
        _apply_chat_host_run(
            chat,
            run,
            HarnessRun(run_id=run.id, status=host_status),
        )
        assert run.status == expected


def test_reimbursement_linked_answer_task_preserves_original_business_facts():
    run = ReimbursementOrchestrator(settings=RuntimeSettings()).begin_run(
        "ws", "u", "报销交通费"
    )
    task = _task_for_reimbursement_run(
        run,
        stage="answers",
        answers={"merchant": "上海交通服务"},
    )

    assert task.run_id != run.id
    assert task.conversation_id == f"reimbursement:{run.id}"
    assert task.context["linked_run_id"] == run.id
    assert task.context["continuation_kind"] == "answers"
    assert task.context["answers"] == {"merchant": "上海交通服务"}


def test_crew_frames_reject_unknown_run_before_host_lookup(tmp_path):
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    crew = CrewService(store)
    identity_store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(identity_store)
    identity = IdentityService(identity_store)
    token = identity.login("boss@anna.demo", "crew-demo").token
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(
            200,
            json={"run_id": "unexpected", "status": "completed", "events": []},
        )

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
    )
    host = HarnessHostClient(config, transport=httpx.MockTransport(handler))
    app = FastAPI()
    app.include_router(
        build_crew_router(
            crew,
            identity,
            decomposition=object(),
            matching=object(),
            local_session=None,
            harness_client=host,
            product_mode=True,
        )
    )

    response = TestClient(app).get(
        "/api/crew/runs/not-owned/frames",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 404
    assert calls == []


def test_reimbursement_completion_requires_verified_write_action_and_readback():
    reimbursement = ReimbursementOrchestrator(settings=RuntimeSettings())
    run = reimbursement.begin_run("ws", "u", "报销")
    run.status = "waiting_confirmation"
    run.draft.external_reimbursement_id = "draft-1"
    run.draft.external_status = "pending"

    result = reimbursement.apply_host_result(
        run,
        {"business_status": "completed", "answer": "已完成"},
        host_status="completed",
    )

    assert result.status != "completed"
    assert result.write_action is None


def test_reimbursement_host_approval_pause_preserves_business_wait_state():
    reimbursement = ReimbursementOrchestrator(settings=RuntimeSettings())
    run = reimbursement.begin_run("ws", "u", "报销")
    run.status = "waiting_confirmation"
    run.approval = ApprovalRequest(
        id="approval-1",
        run_id=run.id,
        action_type="reimbursement.submit",
        risk_level="low",
        payload={},
    )

    updated = reimbursement.apply_host_result(
        run,
        {},
        host_status="awaiting_approval",
    )

    assert updated.status == "waiting_confirmation"


def test_python_legacy_skill_catalog_excludes_host_native_todo():
    skill = SkillLoader().load("reimbursement/travel-expense")

    assert "todo" not in skill.allowed_tools
    assert "todo" in skill.frontmatter["allowed_tools"]


def test_product_approval_submits_linked_host_continuation_with_business_facts():
    run = ReimbursementRun(
        id="run_approval",
        workspace_id="ws",
        actor_user_id="u",
        input_text="报销交通费",
        status="waiting_confirmation",
        draft=ReimbursementDraft(
            amount=128,
            currency="CNY",
            reason="交通费",
            external_reimbursement_id="draft-1",
            external_status="pending",
        ),
        approval=ApprovalRequest(
            id="approval-1",
            run_id="run_approval",
            action_type="reimbursement.submit",
            risk_level="low",
            payload={"external_reimbursement_id": "draft-1"},
        ),
    )

    class StubReimbursement:
        def __init__(self):
            self.host_result = None

        def get_run_by_approval_id(self, approval_id):
            return run if approval_id == "approval-1" else None

        def approve_submit(self, approval_id, approved_by):
            run.write_action = ReimbursementWriteAction(
                id="write-1",
                run_id=run.id,
                approval_id=approval_id,
                external_reimbursement_id="draft-1",
                idempotency_key="idem-1",
                status="success",
                verify_status="verified",
            )
            run.status = "completed"
            return run

        def apply_host_result(self, value, result, *, host_status):
            self.host_result = (result, host_status)
            return value

    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(202, json={"run_id": "host-approval", "status": "queued"})
        return httpx.Response(
            200,
            json={"run_id": "host-approval", "status": "completed", "result": {"answer": "已提交"}},
        )

    config = BusinessModeConfig(
        enabled=True,
        host_origin="http://host.test",
        service_token="business-token",
        poll_interval_seconds=0,
        wait_timeout_seconds=1,
    )
    reimbursement = StubReimbursement()
    app = FastAPI()
    app.include_router(
        build_reimbursement_router(
            reimbursement,
            harness_client=HarnessHostClient(config, transport=httpx.MockTransport(handler)),
            product_mode=True,
        )
    )

    response = TestClient(app).post(
        "/api/cowork/reimbursements/approvals/approval-1/approve",
        headers={"X-Anna-Workspace-ID": "ws", "X-Anna-User-ID": "u"},
        json={"approved_by": "u"},
    )

    assert response.status_code == 200
    submitted = json.loads(requests[0].content)
    assert submitted["run_id"] != run.id
    assert submitted["context"]["linked_run_id"] == run.id
    assert submitted["context"]["continuation_kind"] == "approval"
    assert submitted["context"]["continuation_facts"]["approval_id"] == "approval-1"
    assert reimbursement.host_result[1] == "completed"
