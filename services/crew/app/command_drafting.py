from __future__ import annotations

import logging
from typing import Any

from services.crew.app.schemas import TaskDraft
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelRequest, OpenAICompatibleModelProvider

logger = logging.getLogger(__name__)

# A channel「+任务」command yields at most this many drafts — the composer shows
# a short checklist, not a re-plan (that is the SOP template's job).
MAX_DRAFTS = 3
# The deterministic fallback title is the raw message, clipped for scannability.
_FALLBACK_TITLE_CHARS = 40
# The neutral role for a fallback draft and for a model draft missing a role —
# 产品 (the Boss's function) owns triage of un-triaged asks.
_DEFAULT_ROLE = "产品"


# ---------------------------------------------------------------------------
# Tool schema for the drafts the model emits
# ---------------------------------------------------------------------------

DRAFT_TOOL: dict[str, Any] = {
    "name": "crew.emit_task_drafts",
    "effect": "proposal",
    "replay_policy": "safe",
    "description": (
        "Emit 1 to 3 concrete task drafts distilled from a teammate's channel "
        "message, tailored to the project. Call this once with the final drafts."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "drafts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "role": {
                            "type": "string",
                            "description": "the responsible 职能, chosen from the roster roles",
                        },
                        "depends_on": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "titles of other drafts or existing tasks that must "
                                "finish BEFORE this new task can start"
                            ),
                        },
                        "insert_before": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "titles of EXISTING tasks that must wait for this new "
                                "task (e.g. 'put it before X' -> [\"X\"])"
                            ),
                        },
                        "acceptance": {"type": "string"},
                    },
                    "required": ["title", "role"],
                },
            },
        },
        "required": ["drafts"],
    },
}


_SYSTEM_PROMPT = (
    "You are Anna Crew. A teammate posted a request in a project channel. Turn it "
    "into 1 to 3 concrete, actionable task drafts tailored to the project. Assign "
    "each a responsible 职能 from the roster roles. Add a short acceptance line "
    "where useful. Keep it minimal — do not re-plan the whole project. Express "
    "ordering against the existing tasks: depends_on lists tasks that must finish "
    "before the new task; insert_before lists existing tasks that must wait for "
    "the new task. Call crew.emit_task_drafts with the final drafts."
)


def _string_list(raw: Any) -> list[str]:
    """Normalize a model-emitted list of titles (strip, drop empties, dedupe)."""
    if not isinstance(raw, list):
        return []
    values: list[str] = []
    for item in raw:
        text = str(item).strip()
        if text and text not in values:
            values.append(text)
    return values


def deterministic_task_drafts(message_text: str) -> list[TaskDraft]:
    """One task, unrefined: the raw ask assigned to 产品 for triage.

    The single, honest interpretation when no model is available — never a
    fabricated multi-task plan."""
    text = message_text.strip()
    return [
        TaskDraft(
            title=text[:_FALLBACK_TITLE_CHARS] or "新任务",
            role=_DEFAULT_ROLE,
            depends_on=[],
            acceptance=text,
        )
    ]


def _drafts_from_tool_args(arguments: dict[str, Any]) -> list[TaskDraft]:
    """Coerce the model's emitted ``drafts`` into validated ``TaskDraft`` objects.

    Skips malformed entries, defaults a missing role to 产品, and truncates to
    ``MAX_DRAFTS``. Raises nothing the caller must handle — an empty result
    signals「fall back」to the service."""
    raw = arguments.get("drafts")
    if not isinstance(raw, list):
        return []
    drafts: list[TaskDraft] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        if not title:
            continue
        drafts.append(TaskDraft(
            title=title,
            role=str(entry.get("role") or _DEFAULT_ROLE).strip() or _DEFAULT_ROLE,
            depends_on=_string_list(entry.get("depends_on")),
            acceptance=str(entry.get("acceptance") or "").strip(),
            insert_before=_string_list(entry.get("insert_before")),
        ))
        if len(drafts) >= MAX_DRAFTS:
            break
    return drafts


class CommandDraftingService:
    """Drafts channel「+任务」tasks via the model, falling back deterministically.

    Mirrors ``CrewDecompositionService``: when the model is unconfigured, fails,
    or emits nothing usable, it returns the single deterministic fallback draft
    — so a command NEVER fabricates and NEVER crashes.
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

    def draft(
        self,
        *,
        project_id: str,
        goal_text: str,
        message_text: str,
        roster_roles: list[str],
        existing_tasks: list[dict[str, str]] | None = None,
    ) -> list[TaskDraft]:
        """Draft tasks; ``existing_tasks`` items carry ``title``/``role``/``status``."""
        roster = "、".join(roster_roles) if roster_roles else _DEFAULT_ROLE
        task_lines = "\n".join(
            f"- {task['title']}（职能：{task.get('role') or '-'}，状态：{task.get('status') or '-'}）"
            for task in (existing_tasks or [])
        ) or "（暂无）"
        user_content = (
            f"项目目标：{goal_text}\n"
            f"花名册职能：{roster}\n"
            f"现有任务：\n{task_lines}\n"
            f"频道请求：{message_text}\n\n"
            "请起草 1 到 3 项任务（≤3），每项给出 title、role（取自花名册职能）、"
            "可选 acceptance 验收标准，并用两个字段表达顺序：\n"
            "- depends_on：新任务开始前必须完成的任务 title（其他草案或现有任务）；\n"
            "- insert_before：必须等新任务完成才能开始的【现有任务】title。"
            "“放在 X 之前”即 insert_before:[\"X\"]；“在 X 之后”即 depends_on:[\"X\"]。"
        )
        request = ModelRequest(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            tools=[DRAFT_TOOL],
        )
        result = self.harness_runtime.call_model(
            run_id=project_id,
            audit_events=[],
            request=request,
        )
        if result.response is None:
            logger.info("crew command drafting fell back (model unconfigured/failed)")
            return deterministic_task_drafts(message_text)
        emit_call = next(
            (tc for tc in result.response.tool_calls
             if tc.name == "crew.emit_task_drafts"),
            None,
        )
        if emit_call is None:
            return deterministic_task_drafts(message_text)
        try:
            drafts = _drafts_from_tool_args(emit_call.arguments)
        except Exception:  # noqa: BLE001 — any parse failure falls back honestly
            drafts = []
        return drafts or deterministic_task_drafts(message_text)
