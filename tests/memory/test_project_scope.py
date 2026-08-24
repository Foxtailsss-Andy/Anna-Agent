"""B1b · BusinessMemory project scope (RED).

The business memory gains a ``scope`` axis (``"workspace"`` | ``"project"``)
plus ``project_id`` so a Crew project can pin its 共识 entries (约束/口径/决策)
alongside org-wide knowledge. A pre-B1b database keeps working: the store
migrates in place via ``ALTER TABLE ... ADD COLUMN`` and old rows read back
with ``scope="workspace"`` / ``project_id=None``.

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

import sqlite3

import pytest

from services.memory.app.store import BusinessMemoryStore

# The exact pre-B1b table shape (no scope / project_id columns), used to build
# an "existing database" that the new store must migrate without a rebuild.
_PRE_B1B_SHAPE = """
CREATE TABLE business_memory (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


def test_scope_defaults_to_workspace_backcompat(tmp_path):
    """Rows written by the old schema read back as workspace-scoped."""
    db_path = tmp_path / "anna-memory.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.execute(_PRE_B1B_SHAPE)
        connection.execute(
            "INSERT INTO business_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "business_memory_old", "demo", "business_rule", "旧口径",
                "逾期超过 30 天优先催收。", "admin", 1.0,
                "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z",
            ),
        )

    store = BusinessMemoryStore(db_path)  # opening migrates via ALTER TABLE

    listed = store.list_items("demo")
    assert [item.id for item in listed] == ["business_memory_old"]
    assert listed[0].scope == "workspace"
    assert listed[0].project_id is None
    # Scope filters: the old row counts as workspace, never as project.
    assert [i.id for i in store.list_items("demo", scope="workspace")] == [
        "business_memory_old"
    ]
    assert store.list_items("demo", scope="project", project_id="proj_1") == []
    # Re-opening runs the migration again — duplicate columns must be tolerated.
    assert BusinessMemoryStore(db_path).count("demo") == 1


def test_project_items_isolated(tmp_path):
    store = BusinessMemoryStore(tmp_path / "anna-memory.sqlite3")
    ws_item = store.add(
        workspace_id="demo", memory_type="business_rule",
        title="全局口径", content="全局口径内容。", source="admin",
    )
    a1 = store.add(
        workspace_id="demo", memory_type="口径",
        title="登录页只在远程 4xx 形态出现",
        content="登录页只在远程 4xx 形态出现", source="crew",
        scope="project", project_id="proj_a",
    )
    b1 = store.add(
        workspace_id="demo", memory_type="决策",
        title="主色只用 iris", content="主色只用 iris #575BC4。", source="crew",
        scope="project", project_id="proj_b",
    )

    a_items = store.list_items("demo", scope="project", project_id="proj_a")
    assert [i.id for i in a_items] == [a1.id]
    assert a_items[0].scope == "project"
    assert a_items[0].project_id == "proj_a"

    b_items = store.list_items("demo", scope="project", project_id="proj_b")
    assert [i.id for i in b_items] == [b1.id]

    # The workspace scope filter hides project entries entirely.
    assert [i.id for i in store.list_items("demo", scope="workspace")] == [ws_item.id]

    # Workspace isolation still applies on top of scope filters.
    assert store.list_items("other", scope="project", project_id="proj_a") == []


def test_add_validates_scope_and_project_id(tmp_path):
    store = BusinessMemoryStore(tmp_path / "anna-memory.sqlite3")
    with pytest.raises(ValueError):
        store.add(
            workspace_id="demo", memory_type="约束", title="t",
            content="c", source="crew", scope="project",  # missing project_id
        )
    with pytest.raises(ValueError):
        store.add(
            workspace_id="demo", memory_type="约束", title="t",
            content="c", source="crew", scope="nonsense",
        )
    with pytest.raises(ValueError):
        store.add(
            workspace_id="demo", memory_type="约束", title="t",
            content="c", source="crew", project_id="proj_a",  # workspace + project_id
        )


def test_search_excludes_project_scope_by_default(tmp_path):
    """B3 裁定: a generic workspace search never surfaces a project's 共识 rows.

    ``search()`` defaults to workspace-scoped knowledge (org-wide); a Crew
    project's 约束/口径/决策 are namespaced to that project and must not leak
    into an unrelated workspace retrieval (chat/finance memory recall)."""
    store = BusinessMemoryStore(tmp_path / "anna-memory.sqlite3")
    ws = store.add(
        workspace_id="demo", memory_type="口径",
        title="登录页只在远程 4xx 形态出现（工作区级）",
        content="登录页只在远程 4xx 形态出现（工作区级）", source="admin",
    )
    store.add(
        workspace_id="demo", memory_type="口径",
        title="登录页只在远程 4xx 形态出现（项目级）",
        content="登录页只在远程 4xx 形态出现（项目级）", source="crew",
        scope="project", project_id="proj_a",
    )

    # LIKE hit path: the query matches BOTH rows, but the project row is excluded.
    hits = store.search("demo", "登录页")
    assert [i.id for i in hits] == [ws.id]
    assert all(i.scope == "workspace" for i in hits)

    # Fuzzy fallback path (no direct LIKE hit) also stays workspace-only.
    fuzzy = store.search("demo", "远程形态")
    assert all(i.scope == "workspace" for i in fuzzy)

    # Opt-in override still reaches project rows when a caller explicitly asks.
    both = store.search("demo", "登录页", include_project=True)
    assert {i.scope for i in both} == {"workspace", "project"}


def test_get_update_delete_project_item(tmp_path):
    """The upsert/delete surface behind PUT/DELETE /api/crew/projects/{id}/memory."""
    store = BusinessMemoryStore(tmp_path / "anna-memory.sqlite3")
    item = store.add(
        workspace_id="demo", memory_type="约束", title="旧文案",
        content="旧文案", source="crew", scope="project", project_id="proj_a",
    )

    assert store.get(item.id) is not None
    assert store.get(item.id).content == "旧文案"
    assert store.get("business_memory_ghost") is None

    updated = store.update(item.id, memory_type="口径", title="新文案", content="新文案")
    assert updated is not None
    assert updated.memory_type == "口径"
    assert updated.content == "新文案"
    assert updated.scope == "project" and updated.project_id == "proj_a"
    assert store.update("business_memory_ghost", content="x") is None

    assert store.delete(item.id) is True
    assert store.get(item.id) is None
    assert store.delete(item.id) is False
