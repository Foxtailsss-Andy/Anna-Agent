import sqlite3

from services.memory.app.store import BusinessMemoryStore


def test_business_memory_persists_and_searches_by_workspace(tmp_path):
    db_path = tmp_path / "anna-memory.sqlite3"
    store = BusinessMemoryStore(db_path)

    item = store.add(
        workspace_id="demo",
        memory_type="business_rule",
        title="应收逾期口径",
        content="逾期超过 30 天且金额大于 10 万的客户需要优先催收。",
        source="admin",
        confidence=0.9,
    )

    reloaded = BusinessMemoryStore(db_path)

    listed = reloaded.list_items("demo")
    assert [memory.title for memory in listed] == ["应收逾期口径"]
    assert listed[0].id == item.id

    matches = reloaded.search("demo", "优先催收", limit=5)
    assert [memory.id for memory in matches] == [item.id]

    assert reloaded.search("another-workspace", "优先催收", limit=5) == []


def test_business_memory_ids_are_not_reused_after_deleted_rows(tmp_path):
    db_path = tmp_path / "anna-memory.sqlite3"
    store = BusinessMemoryStore(db_path)

    first = store.add(
        workspace_id="demo",
        memory_type="business_rule",
        title="旧规则",
        content="旧规则内容。",
        source="admin",
    )
    with sqlite3.connect(db_path) as connection:
        connection.execute("DELETE FROM business_memory WHERE id = ?", (first.id,))

    second = store.add(
        workspace_id="demo",
        memory_type="business_rule",
        title="新规则",
        content="新规则内容。",
        source="admin",
    )

    assert second.id != first.id
