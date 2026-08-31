from __future__ import annotations

import json
import logging
from typing import Any, Callable

from services.crew.app import lifecycle
from services.crew.app.schemas import CrewProject, CrewTask, SopTemplate
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelRequest, OpenAICompatibleModelProvider

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool schema for the internal emit tool offered to the model
# ---------------------------------------------------------------------------

EMIT_TOOL: dict[str, Any] = {
    "name": "crew.emit_project_plan",
    "effect": "proposal",
    "replay_policy": "safe",
    "description": (
        "Emit the final refined project plan as a structured task DAG. "
        "Call this once with the complete plan tailored to the goal."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "goal": {"type": "string"},
            "summary": {"type": "string"},
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {"type": "string"},
                        "title": {"type": "string"},
                        "role_required": {"type": "string"},
                        "depends_on": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "is_gate": {"type": "boolean"},
                        "reviews": {"type": ["string", "null"]},
                        "description": {"type": "string"},
                        "acceptance_criteria": {"type": ["string", "null"]},
                    },
                    "required": ["key", "title", "role_required"],
                },
            },
        },
        "required": ["goal", "summary", "tasks"],
    },
}


# ---------------------------------------------------------------------------
# Pure conversion: emitted plan dict -> CrewProject (mirrors instantiate_project)
# ---------------------------------------------------------------------------

def plan_to_project(
    plan: dict[str, Any],
    *,
    project_id: str,
    workspace_id: str,
    owner_user_id: str,
    goal_text: str,
    template_id: str,
    task_id: Callable[[str], str],
) -> CrewProject:
    """Convert the model-emitted plan dict into a CrewProject.

    Mirrors lifecycle.instantiate_project: first pass builds key->id mapping,
    second pass constructs CrewTask objects with resolved dep/review ids.
    Unknown dep/review keys are silently skipped (defensive).
    """
    task_specs: list[dict[str, Any]] = plan.get("tasks", [])

    # First pass: key -> generated id
    key_to_id: dict[str, str] = {}
    for spec in task_specs:
        key = spec.get("key")
        if key and key not in key_to_id:
            key_to_id[key] = task_id(key)

    # Second pass: build CrewTask objects (one per unique key)
    tasks: list[CrewTask] = []
    for key, tid in key_to_id.items():
        # Find the first spec for this key (duplicates are skipped via key_to_id iteration)
        spec = next(s for s in task_specs if s.get("key") == key)

        raw_deps: list[str] = spec.get("depends_on") or []
        dep_ids = [key_to_id[dep] for dep in raw_deps if dep in key_to_id]

        reviews_key: str | None = spec.get("reviews") or None
        reviews_task_id: str | None = key_to_id.get(reviews_key) if reviews_key else None

        # Fix 3: if reviews was specified but unresolvable, drop the gate flag
        is_gate = bool(spec.get("is_gate", False))
        if reviews_key is not None and reviews_task_id is None:
            is_gate = False

        initial_status = "todo" if not dep_ids else "blocked"

        tasks.append(CrewTask(
            id=tid,
            project_id=project_id,
            key=key,
            title=spec.get("title", ""),
            description=spec.get("description") or "",
            role_required=spec.get("role_required", ""),
            status=initial_status,
            depends_on=dep_ids,
            is_gate=is_gate,
            reviews_task_id=reviews_task_id,
            acceptance_criteria=spec.get("acceptance_criteria") or None,
        ))

    return CrewProject(
        id=project_id,
        workspace_id=workspace_id,
        owner_user_id=owner_user_id,
        goal_text=goal_text,
        sop_template_id=template_id,
        tasks=tasks,
    )


# ---------------------------------------------------------------------------
# Service: model call with graceful fallback
# ---------------------------------------------------------------------------

def _fallback(
    reason: str,
    *,
    project_id: str,
    workspace_id: str,
    owner_user_id: str,
    goal_text: str,
    template: SopTemplate,
    task_id: Callable[[str], str],
) -> CrewProject:
    logger.info("crew decomposition fell back to deterministic template: %s", reason)
    return lifecycle.instantiate_project(
        project_id=project_id,
        workspace_id=workspace_id,
        owner_user_id=owner_user_id,
        goal_text=goal_text,
        template=template,
        task_id=task_id,
    )


_SYSTEM_PROMPT = (
    "You are Anna Crew. Refine the given SOP template into a concrete task plan "
    "tailored to the goal. Keep the review gates. "
    "Call crew.emit_project_plan with the final plan."
)


class CrewDecompositionService:
    """Refines a SOP template into a goal-tailored task DAG via the model.

    Falls back to lifecycle.instantiate_project when the model is unconfigured,
    fails, or does not emit a valid crew.emit_project_plan tool call.
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

    def decompose(
        self,
        *,
        project_id: str,
        workspace_id: str,
        owner_user_id: str,
        goal_text: str,
        template: SopTemplate,
        task_id: Callable[[str], str],
    ) -> CrewProject:
        """Decompose: call model to refine template, fall back if unconfigured/failed."""
        # Build user message: template skeleton + goal
        template_json = json.dumps(template.model_dump(), ensure_ascii=False, indent=2)
        user_content = (
            f"SOP Template:\n{template_json}\n\n"
            f"Goal: {goal_text}"
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
            run_id=project_id,
            audit_events=[],
            request=request,
        )

        _fb_kwargs = dict(
            project_id=project_id,
            workspace_id=workspace_id,
            owner_user_id=owner_user_id,
            goal_text=goal_text,
            template=template,
            task_id=task_id,
        )

        # Fallback: model not configured or call failed
        if result.response is None:
            return _fallback("model_unconfigured_or_failed", **_fb_kwargs)

        # Find the emit tool call
        emit_call = next(
            (tc for tc in result.response.tool_calls if tc.name == "crew.emit_project_plan"),
            None,
        )
        if emit_call is None:
            return _fallback("model_emitted_no_plan", **_fb_kwargs)

        # Validate and convert; fall back on any error
        try:
            return plan_to_project(
                emit_call.arguments,
                project_id=project_id,
                workspace_id=workspace_id,
                owner_user_id=owner_user_id,
                goal_text=goal_text,
                template_id=template.id,
                task_id=task_id,
            )
        except Exception:
            return _fallback("plan_validation_failed", **_fb_kwargs)
