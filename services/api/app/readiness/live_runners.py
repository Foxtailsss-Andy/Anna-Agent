from __future__ import annotations

import os
from typing import Any

from ..redaction import _blank_to_none

LIVE_RUNNER_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {
        "id": "t07-review-to-validated-patch",
        "label": "T07 Review-to-Validated-Patch live canary",
        "command": "npm run live:t07",
        "domain_ids": [],
        "required_env_vars": [
            "ANNA_T07_LIVE_SOURCE",
            "ANNA_T07_LIVE_HEAD",
            "ANNA_T07_LIVE_BACKEND_ORIGIN",
            "ANNA_T07_LIVE_OWNER_ID",
            "ANNA_T07_LIVE_PROVIDER",
            "ANNA_T07_LIVE_APPROVAL_ORIGIN",
            "ANNA_T07_LIVE_EVIDENCE_DIR",
        ],
        "optional_env_vars": [],
        "writes_external_data": False,
        "writes_local_artifacts": True,
    },
    {
        "id": "reimbursement",
        "label": "Reimbursement live write validation",
        "command": "npm run live:e2e",
        "domain_ids": ["cowork.reimbursement"],
        "required_env_vars": [
            "ANNA_LIVE_REIMBURSEMENT_INPUT",
            "ANNA_LIVE_ALLOW_EXTERNAL_WRITES",
        ],
        "optional_env_vars": ["ANNA_LIVE_REIMBURSEMENT_ATTACHMENT_PATHS_JSON"],
        "writes_external_data": True,
        "writes_local_artifacts": False,
    },
    {
        "id": "associate",
        "label": "Associate receivables live validation",
        "command": "npm run live:associate",
        "domain_ids": ["cowork.associate_receivables"],
        "required_env_vars": [
            "ANNA_LIVE_ASSOCIATE_PERIOD",
            "ANNA_LIVE_ASSOCIATE_GOAL",
            "ANNA_LIVE_ALLOW_EXTERNAL_WRITES",
        ],
        "optional_env_vars": [],
        "writes_external_data": True,
        "writes_local_artifacts": False,
    },
    {
        "id": "create",
        "label": "Create live model generation validation",
        "command": "npm run live:create",
        "domain_ids": ["create.capability_draft"],
        "required_env_vars": [
            "ANNA_LIVE_CREATE_SKILL_BRIEF",
            "ANNA_LIVE_CREATE_PROMPT_BRIEF",
            "ANNA_LIVE_CREATE_PYTHON_TOOL_BRIEF",
            "ANNA_LIVE_CREATE_DRAFTS",
        ],
        "optional_env_vars": [],
        "writes_external_data": False,
        "writes_local_artifacts": True,
    },
    {
        "id": "chat",
        "label": "Chat live model validation",
        "command": "npm run live:chat",
        "domain_ids": ["chat.general_assistant"],
        "required_env_vars": ["ANNA_LIVE_CHAT_MESSAGE"],
        "optional_env_vars": ["ANNA_LIVE_CHAT_TEMPLATE_ID"],
        "writes_external_data": False,
        "writes_local_artifacts": False,
    },
)


def _live_runner_command_center(*, domain_readiness: dict[str, Any]) -> dict[str, Any]:
    domains_by_id = {
        str(domain.get("domain_id")): domain
        for domain in domain_readiness.get("domains", [])
    }
    runners = [
        _live_runner_projection(definition, domains_by_id)
        for definition in LIVE_RUNNER_DEFINITIONS
    ]
    return {
        "writes_external_data": False,
        "summary": {
            "runner_count": len(runners),
            "ready_count": sum(1 for runner in runners if runner["status"] == "ready"),
            "blocked_count": sum(1 for runner in runners if runner["status"] == "blocked"),
            "manual_required_count": sum(
                1 for runner in runners if runner["status"] == "manual_required"
            ),
            "external_write_runner_count": sum(
                1 for runner in runners if runner["writes_external_data"]
            ),
            "local_artifact_runner_count": sum(
                1 for runner in runners if runner["writes_local_artifacts"]
            ),
        },
        "runners": runners,
    }


def _live_runner_projection(
    definition: dict[str, Any],
    domains_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    required_env_vars = list(definition["required_env_vars"])
    optional_env_vars = list(definition["optional_env_vars"])
    domain_ids = list(definition["domain_ids"])
    missing_required_env_vars = [
        env_var for env_var in required_env_vars if not _live_env_configured(env_var)
    ]
    domain_rows = [domains_by_id.get(domain_id) for domain_id in domain_ids]
    missing_domain_ids = [
        domain_id
        for domain_id, domain in zip(domain_ids, domain_rows, strict=False)
        if domain is None
    ]
    non_ready_domains = [
        str(domain.get("domain_id"))
        for domain in domain_rows
        if domain and domain.get("readiness_status") != "ready"
    ]
    if definition["id"] == "t07-review-to-validated-patch":
        status = "blocked"
        reason = "real_review_approval_bridge_not_implemented"
    elif missing_domain_ids:
        status = "blocked"
        reason = "domain_readiness_unavailable"
    elif non_ready_domains:
        status = "blocked"
        reason = "runtime_validation_required"
    elif missing_required_env_vars:
        status = "manual_required"
        reason = "operator_input_required"
    else:
        status = "ready"
        reason = "runner_ready"
    blocking_reasons = []
    for domain in domain_rows:
        if domain:
            blocking_reasons.extend(domain.get("blocking_reasons", []))
    return {
        "id": definition["id"],
        "label": definition["label"],
        "command": definition["command"],
        "status": status,
        "reason": reason,
        "writes_external_data": definition["writes_external_data"],
        "writes_local_artifacts": definition["writes_local_artifacts"],
        "requires_runtime_ready": True,
        "domain_ids": domain_ids,
        "required_env_vars": required_env_vars,
        "optional_env_vars": optional_env_vars,
        "missing_required_env_vars": missing_required_env_vars,
        "blocking_reasons": sorted(set(blocking_reasons + missing_domain_ids + non_ready_domains)),
    }


def _live_env_configured(env_var: str) -> bool:
    if env_var == "ANNA_LIVE_ALLOW_EXTERNAL_WRITES":
        return os.environ.get(env_var) == "1"
    if env_var == "ANNA_LIVE_CREATE_DRAFTS":
        return os.environ.get(env_var) == "1"
    return bool(_blank_to_none(os.environ.get(env_var)))
