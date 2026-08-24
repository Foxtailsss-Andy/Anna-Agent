from __future__ import annotations

from typing import Any

from services.associate.app.orchestrator import AssociateReceivablesOrchestrator
from services.chat.app.orchestrator import ChatOrchestrator
from services.create.app.orchestrator import CreateOrchestrator
from services.reimbursement.app.orchestrator import ReimbursementOrchestrator


def _agent_run_ledger(
    workspace_id: str,
    actor_user_id: str,
    reimbursement: ReimbursementOrchestrator,
    associate: AssociateReceivablesOrchestrator,
    create: CreateOrchestrator,
    chat: ChatOrchestrator,
) -> dict[str, Any]:
    runs = [
        *[
            _ledger_item("reimbursement", "travel_reimbursement", run)
            for run in reimbursement.list_runs(workspace_id, actor_user_id)
        ],
        *[
            _ledger_item("associate", "receivables_recovery", run)
            for run in associate.list_runs(workspace_id, actor_user_id)
        ],
        *[
            _ledger_item("create", run.kind, run)
            for run in create.list_runs(workspace_id, actor_user_id)
        ],
        *[
            _ledger_item("chat", "general_assistant", run)
            for run in chat.list_runs(workspace_id, actor_user_id)
        ],
    ]
    runs.sort(key=lambda item: item["latest_event_at"], reverse=True)
    domain_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    for run in runs:
        domain_counts[run["domain"]] = domain_counts.get(run["domain"], 0) + 1
        status_counts[run["status"]] = status_counts.get(run["status"], 0) + 1
    return {
        "summary": {
            "run_count": len(runs),
            "event_count": sum(run["event_count"] for run in runs),
            "domains": dict(sorted(domain_counts.items())),
            "statuses": dict(sorted(status_counts.items())),
        },
        "runs": runs,
    }


def _ledger_item(domain: str, kind: str, run: Any) -> dict[str, Any]:
    event_types = [event.type for event in run.audit_events]
    return {
        "run_id": run.id,
        "domain": domain,
        "kind": kind,
        "status": run.status,
        "error_code": getattr(run, "error_code", None),
        "event_count": len(event_types),
        "event_types": event_types,
        "latest_event_at": run.audit_events[-1].created_at if run.audit_events else "",
        "writes_external_data": _run_writes_external_data(run),
        "approval_required": _run_has_pending_approval(run),
    }

def _run_writes_external_data(run: Any) -> bool:
    write_action = getattr(run, "write_action", None)
    if write_action is not None and getattr(write_action, "status", None) == "success":
        return True
    plan = getattr(run, "plan", None)
    if plan is None:
        return False
    for node in getattr(plan, "nodes", []):
        write_action = getattr(node, "write_action", None)
        if write_action is not None and getattr(write_action, "status", None) == "success":
            return True
    return False


def _run_has_pending_approval(run: Any) -> bool:
    approval = getattr(run, "approval", None)
    if approval is not None and getattr(approval, "status", None) == "pending":
        return True
    plan = getattr(run, "plan", None)
    if plan is None:
        return False
    for node in getattr(plan, "nodes", []):
        approval = getattr(node, "approval", None)
        if approval is not None and getattr(approval, "status", None) == "pending":
            return True
    return False
