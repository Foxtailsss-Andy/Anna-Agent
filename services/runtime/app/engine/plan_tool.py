"""``plan.update`` native tool — schema + pure validation门 (W1.T3).

The engine-layer home for the ``plan.update`` tool: the model-visible schema
constants plus ``apply_plan_update``, the pure ADR-002 code gate a capability
runs before writing ``run.plan``. Keeping the门 here (not in a surface) lets any
surface register the tool later (W7 Crew, W9 Code) by importing these constants
and calling the same validator — one source of truth for the contract and the
gate.

Semantics: FULL-TABLE replacement (the result depends only on ``items``, never on
``current``), which makes repeated identical calls idempotent. Every code-gate
violation raises ``PlanUpdateError`` with a Chinese message; the caller turns
that into a tool error observation the model reads to retry, leaving run state
untouched (the gate NEVER fails the run).
"""
from __future__ import annotations


PLAN_UPDATE_TOOL_NAME = "plan.update"

# Model-visible tool copy — a directive to plan first and keep the checklist
# current (Chinese, per Anna's product surface).
PLAN_UPDATE_DESCRIPTION = (
    "维护当前任务的执行计划清单。多步任务开始时先建计划；每完成一步立即更新状态。"
)

# Binding tool schema (W1 contract, verbatim). ``status`` uses a bare ``enum``
# and the object omits ``additionalProperties`` exactly as the contract states.
PLAN_UPDATE_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "status": {"enum": ["pending", "in_progress", "done"]},
                },
                "required": ["id", "title", "status"],
            },
        },
    },
    "required": ["items"],
}

# Code gate bounds (ADR-002).
MAX_PLAN_ITEMS = 20
MAX_TITLE_LEN = 60
_VALID_STATUSES = ("pending", "in_progress", "done")


class PlanUpdateError(ValueError):
    """A ``plan.update`` code-gate violation carrying a Chinese retry message.

    A ``ValueError``-style domain error: the caller catches it and returns the
    message as a tool error observation (the model reads it and can retry) —
    it does NOT terminate the run.
    """


def apply_plan_update(current: list[dict], items: object) -> list[dict]:
    """Validate ``items`` and return the new plan (full-table replacement).

    ``current`` is accepted for symmetry with the other ``apply_*`` folders and
    to make the replacement semantics explicit, but it is intentionally unused:
    the plan is REPLACED wholesale, so the result depends only on ``items``
    (hence idempotent). Each item is normalized to exactly ``{id, title,
    status}`` — extra keys are stripped so ``run.plan`` stays clean.

    Raises ``PlanUpdateError`` (Chinese message) on any gate violation: non-list
    input, more than ``MAX_PLAN_ITEMS`` items, a non-object item, a missing/empty
    ``id``, a duplicate ``id``, a non-string/over-length ``title``, or a status
    outside the enum.
    """
    if not isinstance(items, list):
        raise PlanUpdateError("计划 items 必须是数组")
    if len(items) > MAX_PLAN_ITEMS:
        raise PlanUpdateError(f"计划项不能超过 {MAX_PLAN_ITEMS} 条（当前 {len(items)} 条）")

    normalized: list[dict] = []
    seen_ids: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise PlanUpdateError("每个计划项必须是对象")
        for field in ("id", "title", "status"):
            if field not in item:
                raise PlanUpdateError(f"计划项缺少必填字段：{field}")

        item_id = item["id"]
        if not isinstance(item_id, str) or not item_id.strip():
            raise PlanUpdateError("计划项 id 必须是非空字符串")
        if item_id in seen_ids:
            raise PlanUpdateError(f"计划项 id 重复：{item_id}")
        seen_ids.add(item_id)

        title = item["title"]
        if not isinstance(title, str):
            raise PlanUpdateError("计划项 title 必须是字符串")
        if len(title) > MAX_TITLE_LEN:
            raise PlanUpdateError(f"计划项标题不能超过 {MAX_TITLE_LEN} 字")

        status = item["status"]
        if status not in _VALID_STATUSES:
            raise PlanUpdateError(
                f"计划项状态非法：{status}（须为 pending/in_progress/done）"
            )

        normalized.append({"id": item_id, "title": title, "status": status})

    return normalized
