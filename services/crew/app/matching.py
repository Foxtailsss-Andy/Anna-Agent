from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import BaseModel

from services.crew.app.schemas import CrewProject
from services.identity.app.schemas import Account
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelRequest, OpenAICompatibleModelProvider

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool schema for the internal emit tool offered to the model
# ---------------------------------------------------------------------------

EMIT_TOOL: dict[str, Any] = {
    "name": "crew.emit_assignments",
    "effect": "proposal",
    "replay_policy": "safe",
    "description": (
        "Emit the assignment plan: for each unassigned task, pick the best-fit "
        "team member. Call this once with the complete assignments."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "assignments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "task_key": {"type": "string"},
                        "member_id": {"type": "string"},
                        "rationale": {"type": "string"},
                    },
                    "required": ["task_key", "member_id", "rationale"],
                },
            },
        },
        "required": ["assignments"],
    },
}


# ---------------------------------------------------------------------------
# Proposal model (frozen API contract)
# ---------------------------------------------------------------------------

class AssignmentProposal(BaseModel):
    task_id: str
    task_key: str
    task_title: str
    role_required: str
    member_id: str | None = None
    member_name: str | None = None
    member_kind: str | None = None
    rationale: str


# ---------------------------------------------------------------------------
# Deterministic role-match baseline
# ---------------------------------------------------------------------------

def deterministic_proposals(
    project: CrewProject,
    members: list[Account],
) -> list[AssignmentProposal]:
    """Propose an assignee for every unassigned task via pure role-matching.

    For each task where assignee_member_id is None:
    - candidates = members whose role == task.role_required
    - prefer human over agent when both match; first-match among the preferred kind
    - member_id=None when no candidates found
    """
    proposals: list[AssignmentProposal] = []

    for task in project.tasks:
        if task.assignee_member_id is not None:
            continue  # already assigned — skip

        candidates = [m for m in members if m.role == task.role_required]

        chosen: Account | None = None
        if candidates:
            # Prefer humans over agents
            humans = [m for m in candidates if m.kind == "human"]
            chosen = humans[0] if humans else candidates[0]

        if chosen is not None:
            rationale = f"角色匹配：{task.role_required}"
            proposals.append(AssignmentProposal(
                task_id=task.id,
                task_key=task.key,
                task_title=task.title,
                role_required=task.role_required,
                member_id=chosen.id,
                member_name=chosen.display_name,
                member_kind=chosen.kind,
                rationale=rationale,
            ))
        else:
            proposals.append(AssignmentProposal(
                task_id=task.id,
                task_key=task.key,
                task_title=task.title,
                role_required=task.role_required,
                member_id=None,
                member_name=None,
                member_kind=None,
                rationale="无匹配角色，请手动指派",
            ))

    return proposals


# ---------------------------------------------------------------------------
# Service: AI assignment with graceful deterministic fallback
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are Anna Crew. Assign each unassigned task to the best-fit team member "
    "by role/skill; you may assign an Agent member to producer tasks. "
    "Call crew.emit_assignments."
)


class CrewMatchingService:
    """Proposes assignees for unassigned tasks via the model.

    Falls back to deterministic_proposals when the model is unconfigured,
    fails, or does not emit a valid crew.emit_assignments tool call.
    Invalid member_ids and unknown task_keys from the model are silently
    ignored and the deterministic proposal is kept for those tasks.
    """

    def __init__(
        self,
        harness_runtime: AnnaHarnessRuntime | None = None,
        settings=None,
    ) -> None:
        if harness_runtime is not None:
            self.harness_runtime = harness_runtime
        else:
            from services.runtime.app.config import RuntimeSettings
            _settings = settings or RuntimeSettings.from_env()
            self.harness_runtime = AnnaHarnessRuntime(
                OpenAICompatibleModelProvider(_settings)
            )

    def propose(
        self,
        project: CrewProject,
        members: list[Account],
    ) -> list[AssignmentProposal]:
        """Propose assignees: call model to override deterministic baseline."""
        bind_scope = getattr(self.harness_runtime, "bind_scope", None)
        if callable(bind_scope):
            bind_scope(project.id, project.workspace_id, project.owner_user_id)
        # Start from deterministic baseline — guarantees full coverage
        baseline = deterministic_proposals(project, members)
        baseline_by_key = {p.task_key: p for p in baseline}

        # Build a roster lookup for validation
        member_by_id = {m.id: m for m in members}

        # Build unassigned task summary for the model
        unassigned_tasks = [
            t for t in project.tasks if t.assignee_member_id is None
        ]
        if not unassigned_tasks:
            return baseline

        tasks_text = json.dumps(
            [{"key": t.key, "title": t.title, "role_required": t.role_required}
             for t in unassigned_tasks],
            ensure_ascii=False, indent=2,
        )
        roster_text = json.dumps(
            [{"id": m.id, "display_name": m.display_name, "role": m.role, "kind": m.kind}
             for m in members],
            ensure_ascii=False, indent=2,
        )
        user_content = (
            f"Project goal: {project.goal_text}\n\n"
            f"Unassigned tasks:\n{tasks_text}\n\n"
            f"Team roster:\n{roster_text}"
        )

        request = ModelRequest(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            tools=[EMIT_TOOL],
        )

        # Pass a throwaway [] — do NOT pass project.audit_events
        result = self.harness_runtime.call_model(
            run_id=project.id,
            audit_events=[],
            request=request,
        )

        # Fallback: model not configured or call failed
        if result.response is None:
            logger.info(
                "crew matching fell back to deterministic: model_unconfigured_or_failed"
            )
            return baseline

        # Find the emit tool call
        emit_call = next(
            (tc for tc in result.response.tool_calls
             if tc.name == "crew.emit_assignments"),
            None,
        )
        if emit_call is None:
            logger.info(
                "crew matching fell back to deterministic: model_emitted_no_assignments"
            )
            return baseline

        # Merge model overrides into baseline — ANY malformed plan falls back to baseline
        try:
            raw_assignments = emit_call.arguments.get("assignments", [])
            if not isinstance(raw_assignments, list):
                raise TypeError(f"assignments is not a list: {type(raw_assignments)}")

            # Apply valid overrides; skip invalid member_id or unknown task_key
            result_by_key: dict[str, AssignmentProposal] = dict(baseline_by_key)
            for assignment in raw_assignments:
                task_key = assignment.get("task_key")
                member_id = assignment.get("member_id")
                rationale = assignment.get("rationale", "")

                if task_key not in result_by_key:
                    # Unknown task key — skip
                    continue
                if not member_id or member_id not in member_by_id:
                    # Invalid member — keep deterministic
                    continue

                member = member_by_id[member_id]
                original = result_by_key[task_key]
                result_by_key[task_key] = AssignmentProposal(
                    task_id=original.task_id,
                    task_key=original.task_key,
                    task_title=original.task_title,
                    role_required=original.role_required,
                    member_id=member.id,
                    member_name=member.display_name,
                    member_kind=member.kind,
                    rationale=rationale,
                )
        except Exception:
            logger.info(
                "crew matching fell back to deterministic: bad emit arguments"
            )
            return baseline

        # Return in the same order as the baseline
        return [result_by_key[p.task_key] for p in baseline]
