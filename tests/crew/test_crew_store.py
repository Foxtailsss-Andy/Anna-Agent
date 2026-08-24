from __future__ import annotations

import sqlite3
import tempfile
import threading
from pathlib import Path

import pytest

from services.crew.app.lifecycle import instantiate_project
from services.crew.app.schemas import ChannelMessage, CrewProject
from services.crew.app.sop_templates import get_template
from services.crew.app.store import (
    ProjectInvariantError,
    ProjectVersionConflictError,
    SQLiteCrewStore,
)


def _make_store(tmp_path: Path) -> SQLiteCrewStore:
    return SQLiteCrewStore(tmp_path / "crew.db")


def _make_project(project_id: str, workspace_id: str = "ws1") -> CrewProject:
    counter = {"n": 0}
    def task_id(key: str) -> str:
        counter["n"] += 1
        return f"{project_id}_task_{counter['n']}_{key}"
    return instantiate_project(
        project_id=project_id,
        workspace_id=workspace_id,
        owner_user_id="owner1",
        goal_text="Test project",
        template=get_template("feature_iteration"),
        task_id=task_id,
    )


def test_save_and_get_roundtrip(tmp_path: Path):
    store = _make_store(tmp_path)
    project = _make_project("proj_a")
    store.save_project(project)
    loaded = store.get_project("proj_a")
    assert loaded is not None
    assert loaded.id == "proj_a"
    assert loaded.workspace_id == "ws1"
    assert len(loaded.tasks) == 9  # R-B #4:并行段新增「技术预研」


def test_get_nonexistent_returns_none(tmp_path: Path):
    store = _make_store(tmp_path)
    assert store.get_project("does_not_exist") is None


def test_save_updates_existing(tmp_path: Path):
    store = _make_store(tmp_path)
    project = _make_project("proj_b")
    store.save_project(project)
    project.goal_text = "Updated goal"
    store.save_project(project)
    loaded = store.get_project("proj_b")
    assert loaded.goal_text == "Updated goal"


def test_stale_project_version_is_rejected(tmp_path: Path):
    store = _make_store(tmp_path)
    project = _make_project("proj_cas")
    store.save_project(project)

    first = store.get_project("proj_cas")
    second = store.get_project("proj_cas")
    assert first is not None
    assert second is not None

    first.goal_text = "first writer"
    store.save_project(first)
    second.goal_text = "stale writer"

    with pytest.raises(ProjectVersionConflictError):
        store.save_project(second)

    loaded = store.get_project("proj_cas")
    assert loaded is not None
    assert loaded.goal_text == "first writer"


def test_transactional_update_project_keeps_parallel_task_mutations(tmp_path: Path):
    db_path = tmp_path / "crew.db"
    store = SQLiteCrewStore(db_path)
    project = _make_project("proj_parallel")
    task_a, task_b = project.tasks[0], project.tasks[1]
    store.save_project(project)

    barrier = threading.Barrier(2)

    def block_task(task_id: str, blocker: str) -> None:
        local_store = SQLiteCrewStore(db_path)
        barrier.wait()

        def mutate(loaded: CrewProject) -> None:
            task = next(t for t in loaded.tasks if t.id == task_id)
            task.status = "blocked"
            task.blocker = blocker

        local_store.update_project("proj_parallel", mutate)

    threads = [
        threading.Thread(target=block_task, args=(task_a.id, "blocked a")),
        threading.Thread(target=block_task, args=(task_b.id, "blocked b")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    loaded = store.get_project("proj_parallel")
    assert loaded is not None
    by_id = {task.id: task for task in loaded.tasks}
    assert by_id[task_a.id].blocker == "blocked a"
    assert by_id[task_b.id].blocker == "blocked b"


def test_update_project_rejects_identity_mutation_and_rolls_back(tmp_path: Path):
    store = _make_store(tmp_path)
    project = _make_project("proj_identity")
    store.save_project(project)

    def mutate(loaded: CrewProject) -> None:
        loaded.id = "proj_other"
        loaded.goal_text = "should roll back"

    with pytest.raises(ProjectInvariantError):
        store.update_project("proj_identity", mutate)

    loaded = store.get_project("proj_identity")
    assert loaded is not None
    assert loaded.id == "proj_identity"
    assert loaded.goal_text == "Test project"


def test_project_revision_column_is_named_project_version(tmp_path: Path):
    store = _make_store(tmp_path)
    store.save_project(_make_project("proj_version_col"))
    with store._connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(crew_projects)")}
    assert "project_version" in columns
    assert "schema_version" not in columns


def test_channel_message_worker_provenance_roundtrips(tmp_path: Path):
    store = _make_store(tmp_path)
    msg = ChannelMessage(
        id="proj_a:m1",
        project_id="proj_a",
        workspace_id="ws1",
        seq=0,
        author_kind="worker",
        author_member_id=None,
        worker_profile_ref="member:agent_scribe",
        caused_by_execution_id="exec_123",
        kind="artifact",
        body="done",
        task_id="task_1",
        run_ref="exec_123",
        mentions=["agent_scribe"],
        audit_ref="#a1",
        payload=None,
        created_at="2026-08-16T00:00:00+00:00",
    )

    store.append_channel_message(msg)

    loaded = store.get_channel_message("proj_a:m1")
    assert loaded is not None
    assert loaded.author_kind == "worker"
    assert loaded.author_member_id is None
    assert loaded.worker_profile_ref == "member:agent_scribe"
    assert loaded.caused_by_execution_id == "exec_123"


def test_pre_worker_channel_row_remains_readable_after_migration(tmp_path: Path):
    db_path = tmp_path / "legacy-crew.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE crew_channel_messages (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                author_kind TEXT NOT NULL,
                author_member_id TEXT,
                kind TEXT NOT NULL,
                body TEXT NOT NULL,
                task_id TEXT,
                run_ref TEXT,
                mentions TEXT NOT NULL,
                audit_ref TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO crew_channel_messages (
                id, project_id, workspace_id, seq, author_kind, author_member_id,
                kind, body, task_id, run_ref, mentions, audit_ref, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "proj_legacy:m1",
                "proj_legacy",
                "ws1",
                1,
                "anna",
                None,
                "event",
                "legacy row",
                None,
                None,
                "[]",
                "#a1",
                "2026-08-15T00:00:00+00:00",
            ),
        )

    store = SQLiteCrewStore(db_path)
    loaded = store.get_channel_message("proj_legacy:m1")

    assert loaded is not None
    assert loaded.author_kind == "anna"
    assert loaded.worker_profile_ref is None
    assert loaded.caused_by_execution_id is None


def test_list_projects_workspace_scoped(tmp_path: Path):
    store = _make_store(tmp_path)
    proj_ws1 = _make_project("proj_ws1", workspace_id="ws1")
    proj_ws2 = _make_project("proj_ws2", workspace_id="ws2")
    store.save_project(proj_ws1)
    store.save_project(proj_ws2)

    ws1_projects = store.list_projects("ws1", "owner1")
    assert len(ws1_projects) == 1
    assert ws1_projects[0].id == "proj_ws1"

    ws2_projects = store.list_projects("ws2", "owner1")
    assert len(ws2_projects) == 1
    assert ws2_projects[0].id == "proj_ws2"


def test_sequence_counters_increment_monotonically(tmp_path: Path):
    store = _make_store(tmp_path)
    seq1 = store.next_project_sequence()
    seq2 = store.next_project_sequence()
    seq3 = store.next_project_sequence()
    assert seq1 < seq2 < seq3


def test_task_sequence_counters_increment_monotonically(tmp_path: Path):
    store = _make_store(tmp_path)
    seq1 = store.next_task_sequence()
    seq2 = store.next_task_sequence()
    assert seq1 < seq2
