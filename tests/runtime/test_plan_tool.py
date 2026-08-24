"""W1.T3 — ``plan.update`` validation gate (ADR-002 code gate, pure function).

``apply_plan_update(current, items)`` is the pure validation门 behind the
``plan.update`` native tool: it enforces the code gate (≤20 items, title ≤60
chars, deduplicated ids, status enum) and implements full-table replacement
(idempotent — the result depends only on ``items``, never on ``current``).
Every violation raises ``PlanUpdateError`` carrying a Chinese message the model
reads to retry; the caller turns that into a tool error observation and leaves
run state untouched.
"""
from __future__ import annotations

import pytest

from services.runtime.app.engine.plan_tool import (
    PLAN_UPDATE_DESCRIPTION,
    PLAN_UPDATE_INPUT_SCHEMA,
    PLAN_UPDATE_TOOL_NAME,
    PlanUpdateError,
    apply_plan_update,
)


def _item(item_id: str, title: str = "步骤", status: str = "pending") -> dict:
    return {"id": item_id, "title": title, "status": status}


# --- valid path: normalization + full-table replacement ------------------------


def test_valid_items_returned_normalized_in_order():
    items = [
        _item("1", "分析上月费用", "done"),
        _item("2", "生成网页报告", "in_progress"),
        _item("3", "交付给用户", "pending"),
    ]

    result = apply_plan_update([], items)

    assert result == items
    # Each normalized item carries EXACTLY the three contract keys.
    assert all(set(entry) == {"id", "title", "status"} for entry in result)


def test_extra_keys_are_stripped_to_the_contract_shape():
    result = apply_plan_update(
        [], [{"id": "1", "title": "步骤", "status": "done", "notes": "junk", "x": 1}]
    )

    assert result == [{"id": "1", "title": "步骤", "status": "done"}]


def test_full_table_replacement_ignores_current():
    current = [_item("old", "旧计划", "done"), _item("old2", "旧计划二")]
    items = [_item("1", "新计划", "in_progress")]

    # Result depends ONLY on items — the prior plan is fully replaced.
    assert apply_plan_update(current, items) == items
    assert apply_plan_update([], items) == apply_plan_update(current, items)


def test_replacement_is_idempotent():
    items = [_item("1", "步骤一", "done"), _item("2", "步骤二", "pending")]

    once = apply_plan_update([], items)
    twice = apply_plan_update(once, items)

    assert once == twice == items


def test_empty_items_is_valid_and_clears_the_plan():
    assert apply_plan_update([_item("1")], []) == []


def test_boundary_twenty_items_ok_and_sixty_char_title_ok():
    twenty = [_item(str(n)) for n in range(20)]
    assert len(apply_plan_update([], twenty)) == 20

    title_60 = "标" * 60
    assert apply_plan_update([], [_item("1", title_60)])[0]["title"] == title_60


# --- code gate: every violation raises PlanUpdateError -------------------------


def test_more_than_twenty_items_rejected():
    twenty_one = [_item(str(n)) for n in range(21)]

    with pytest.raises(PlanUpdateError):
        apply_plan_update([], twenty_one)


def test_title_over_sixty_chars_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], [_item("1", "标" * 61)])


def test_duplicate_ids_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], [_item("dup", "一"), _item("dup", "二")])


def test_invalid_status_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], [_item("1", "步骤", "blocked")])


def test_non_list_items_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], {"id": "1"})  # type: ignore[arg-type]


def test_item_not_an_object_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], ["not-a-dict"])  # type: ignore[list-item]


def test_missing_required_field_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], [{"id": "1", "title": "步骤"}])  # no status


def test_empty_id_rejected():
    with pytest.raises(PlanUpdateError):
        apply_plan_update([], [_item("", "步骤", "done")])


def test_error_message_is_chinese_for_model_retry():
    with pytest.raises(PlanUpdateError) as excinfo:
        apply_plan_update([], [_item("1", "步骤", "blocked")])

    # The message the model reads to self-correct must be non-empty Chinese text.
    assert str(excinfo.value)
    assert any("一" <= ch <= "鿿" for ch in str(excinfo.value))


# --- schema constant matches the binding contract verbatim --------------------


def test_tool_name_and_description_constants():
    assert PLAN_UPDATE_TOOL_NAME == "plan.update"
    assert PLAN_UPDATE_DESCRIPTION == (
        "维护当前任务的执行计划清单。多步任务开始时先建计划；每完成一步立即更新状态。"
    )


def test_input_schema_matches_contract():
    assert PLAN_UPDATE_INPUT_SCHEMA == {
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
