from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.chat.app.orchestrator import ChatOrchestrator
from services.create.app.orchestrator import CreateOrchestrator
from services.hiker.app.orchestrator import HikerOrchestrator
from services.memory.app.schemas import CreateBusinessMemoryRequest
from services.memory.app.store import BusinessMemoryStore
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator
from services.runtime.app.harness_catalog import build_harness_catalog
from services.runtime.app.validation_ledger import SQLiteRuntimeValidationLedgerStore

from ..projections.agent_run_ledger import _agent_run_ledger
from ..projections.desktop import _desktop_delivery_readiness
from ..projections.governance import _fixture_runner_status, _sandbox_probe_response
from ..projections.tool_registry import _tool_registry_catalog, _tool_registry_status
from ..readiness.domain_matrix import _domain_readiness_matrix
from ..readiness.live_checklist import _live_validation_checklist
from ..readiness.live_runners import _live_runner_command_center
from ..security import _assert_workspace_access


def build_router(
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    hiker: HikerOrchestrator,
    create: CreateOrchestrator,
    chat: ChatOrchestrator,
    memory: BusinessMemoryStore,
    runtime_validation_store: SQLiteRuntimeValidationLedgerStore | None,
    runtime_validation_ledger: list[dict[str, Any]],
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/admin/governance/status")
    def get_governance_status() -> dict:
        harness_catalog = build_harness_catalog(reimbursement.settings)
        return {
            "harness": harness_catalog["summary"],
            "tool_registries": _tool_registry_status(),
            "memory": {
                "status": "available",
                "business_memory_count": memory.count(),
                "db_path": str(memory.db_path),
            },
            "fixture_runner": {
                **_fixture_runner_status(create),
            },
        }

    @router.get("/api/admin/agent-runs/ledger")
    def get_agent_run_ledger(
        workspace_id: str | None = None,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        target_workspace_id = workspace_id or anna_workspace_id
        _assert_workspace_access(target_workspace_id, anna_workspace_id, anna_user_id)
        return _agent_run_ledger(
            workspace_id=target_workspace_id,
            actor_user_id=anna_user_id,
            reimbursement=reimbursement,
            associate=associate,
            create=create,
            chat=chat,
        )

    @router.get("/api/admin/harness/catalog")
    def get_harness_catalog() -> dict:
        return build_harness_catalog(reimbursement.settings)

    @router.get("/api/admin/harness/domain-readiness")
    def get_harness_domain_readiness() -> dict:
        items = (
            runtime_validation_store.list_items()
            if runtime_validation_store
            else runtime_validation_ledger
        )
        latest_validation = items[0] if items else None
        return _domain_readiness_matrix(
            reimbursement=reimbursement,
            associate=associate,
            hiker=hiker,
            create=create,
            chat=chat,
            latest_validation=latest_validation,
        )

    @router.get("/api/admin/live-validation/checklist")
    def get_live_validation_checklist() -> dict:
        items = (
            runtime_validation_store.list_items()
            if runtime_validation_store
            else runtime_validation_ledger
        )
        latest_validation = items[0] if items else None
        domain_readiness = _domain_readiness_matrix(
            reimbursement=reimbursement,
            associate=associate,
            hiker=hiker,
            create=create,
            chat=chat,
            latest_validation=latest_validation,
        )
        return _live_validation_checklist(
            reimbursement=reimbursement,
            associate=associate,
            hiker=hiker,
            domain_readiness=domain_readiness,
            latest_validation=latest_validation,
        )

    @router.get("/api/admin/live-validation/runners")
    def get_live_validation_runners() -> dict:
        items = (
            runtime_validation_store.list_items()
            if runtime_validation_store
            else runtime_validation_ledger
        )
        latest_validation = items[0] if items else None
        domain_readiness = _domain_readiness_matrix(
            reimbursement=reimbursement,
            associate=associate,
            hiker=hiker,
            create=create,
            chat=chat,
            latest_validation=latest_validation,
        )
        return _live_runner_command_center(domain_readiness=domain_readiness)

    @router.get("/api/admin/desktop/delivery-readiness")
    def get_desktop_delivery_readiness() -> dict:
        return _desktop_delivery_readiness(Path.cwd())

    @router.get("/api/admin/tool-registry/catalog")
    def get_tool_registry_catalog() -> dict:
        return _tool_registry_catalog()

    @router.post("/api/admin/sandbox/probe")
    def run_sandbox_probe() -> dict:
        return _sandbox_probe_response(create)

    @router.get("/api/admin/memory/business")
    def list_business_memory(
        workspace_id: str,
        query: str | None = None,
        limit: int = 50,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(workspace_id, anna_workspace_id, anna_user_id)
        bounded_limit = max(1, min(limit, 100))
        items = (
            memory.search(workspace_id, query, limit=bounded_limit)
            if query
            else memory.list_items(workspace_id, limit=bounded_limit)
        )
        return {
            "items": [item.model_dump(mode="json") for item in items],
            "count": len(items),
        }

    @router.post("/api/admin/memory/business")
    def create_business_memory(
        request: CreateBusinessMemoryRequest,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        _assert_workspace_access(request.workspace_id, anna_workspace_id, anna_user_id)
        item = memory.add(
            workspace_id=request.workspace_id,
            memory_type=request.memory_type,
            title=request.title,
            content=request.content,
            source=request.source,
            confidence=request.confidence,
        )
        return item.model_dump(mode="json")

    return router
