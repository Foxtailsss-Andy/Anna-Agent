from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from services.crew.app.showcase import (
    CrewShowcaseService,
    LEGACY_SHOWCASE_SCENARIO_IDS,
    SHOWCASE_GOAL,
    SHOWCASE_SCENARIO_ID,
    SHOWCASE_VERSION,
    showcase_project_id,
)
from services.crew.app.schemas import ChannelMessage, CrewProject
from services.crew.app.store import SQLiteCrewStore
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore


def _identity(tmp_path: Path) -> IdentityService:
    store = SQLiteIdentityStore(tmp_path / "identity.sqlite3")
    seed_demo_workspace(store)
    return IdentityService(store)


def _legacy_showcase_project_id(workspace_id: str, owner_user_id: str) -> str:
    digest = hashlib.sha1(
        f"{workspace_id}:{owner_user_id}:{LEGACY_SHOWCASE_SCENARIO_IDS[0]}".encode(
            "utf-8"
        )
    ).hexdigest()
    return f"crew_showcase_{digest[:12]}"


def test_showcase_ensure_is_idempotent_and_contains_weekly_action_flow(
    tmp_path: Path,
):
    identity = _identity(tmp_path)
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    showcase = CrewShowcaseService(store)
    members = identity.list_members("ws_crew_demo")

    first = showcase.ensure(
        workspace_id="ws_crew_demo",
        owner_user_id="acc_boss",
        members=members,
    )
    second = showcase.ensure(
        workspace_id="ws_crew_demo",
        owner_user_id="acc_boss",
        members=members,
    )

    assert first.created is True
    assert second.created is False
    assert first.project.id == showcase_project_id("ws_crew_demo", "acc_boss")
    assert second.project.id == first.project.id
    assert first.project.source == "showcase"
    assert first.project.showcase == {
        "scenario_id": SHOWCASE_SCENARIO_ID,
        "version": SHOWCASE_VERSION,
        "locale": "zh-CN",
        "mode": "deterministic",
    }

    by_key = {task.key: task for task in first.project.tasks}
    assert by_key["brief"].title == "周会原始纪要"
    assert by_key["prd"].title == "行动项清单"
    assert by_key["prd"].status == "done"
    assert len(by_key["prd"].artifact_versions) == 2
    assert by_key["prd_review"].status == "done"
    assert by_key["prd_review"].review_comment
    assert by_key["design"].title == "协作看板草图"
    assert by_key["design"].status == "submitted"
    assert by_key["tech_research"].title == "数据口径核对"
    assert "激活率口径" in (by_key["tech_research"].artifact or "")
    assert by_key["design_review"].status == "todo"
    assert by_key["build"].status == "blocked"
    assert by_key["code_review"].title == "闭环验收"

    messages = store.list_channel_messages(first.project.id)
    assert [m.seq for m in messages] == list(range(1, 11))
    assert store.list_channel_messages(first.project.id) == messages
    assert all(m.author_kind == "anna" for m in messages)
    assert all(m.run_ref is None for m in messages)
    assert all(m.worker_profile_ref is None for m in messages)
    assert all(m.caused_by_execution_id is None for m in messages)
    assert all(m.payload and m.payload["source"] == "showcase" for m in messages)
    assert any("周会行动项闭环案例" in m.body for m in messages)
    assert any(m.kind == "review" and "纪要发布评审" in m.body for m in messages)
    assert any(
        m.kind == "command" and m.payload and m.payload["origin"] == "anna_coordination"
        for m in messages
    )
    assert store.list_notifications("ws_crew_demo", "acc_boss") == []


def test_showcase_migrates_legacy_github_launch_demo(tmp_path: Path):
    identity = _identity(tmp_path)
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    showcase = CrewShowcaseService(store)
    members = identity.list_members("ws_crew_demo")
    legacy_id = _legacy_showcase_project_id("ws_crew_demo", "acc_boss")
    legacy = CrewProject(
        id=legacy_id,
        workspace_id="ws_crew_demo",
        owner_user_id="acc_boss",
        goal_text="Anna Crew GitHub 发布展示",
        sop_template_id="feature_iteration",
        source="showcase",
        showcase={
            "scenario_id": LEGACY_SHOWCASE_SCENARIO_IDS[0],
            "version": 1,
            "locale": "zh-CN",
            "mode": "deterministic",
        },
    )
    store.save_project(legacy)
    store.append_channel_message(
        ChannelMessage(
            id=f"{legacy.id}:legacy:m001",
            project_id=legacy.id,
            workspace_id=legacy.workspace_id,
            seq=1,
            author_kind="anna",
            kind="event",
            body="Anna 已导入 GitHub 发布展示案例",
            created_at="2026-08-16T01:01:00+00:00",
            payload={
                "source": "showcase",
                "scenario_id": LEGACY_SHOWCASE_SCENARIO_IDS[0],
            },
        )
    )

    result = showcase.ensure(
        workspace_id="ws_crew_demo",
        owner_user_id="acc_boss",
        members=members,
    )

    assert result.created is False
    assert result.migrated is True
    assert result.project.id == legacy_id
    assert result.project.showcase == {
        "scenario_id": SHOWCASE_SCENARIO_ID,
        "version": SHOWCASE_VERSION,
        "locale": "zh-CN",
        "mode": "deterministic",
    }
    assert result.project.goal_text == "周会行动项闭环：会议纪要、责任人返工、并行核对、评审与下游同步"
    messages = store.list_channel_messages(result.project.id)
    assert [m.seq for m in messages] == list(range(1, 11))
    assert not any("GitHub 发布" in m.body for m in messages)
    assert any("周会行动项闭环案例" in m.body for m in messages)


def test_showcase_migrates_previous_punctuation_version(tmp_path: Path):
    identity = _identity(tmp_path)
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    showcase = CrewShowcaseService(store)
    project_id = showcase_project_id("ws_crew_demo", "acc_boss")
    store.save_project(
        CrewProject(
            id=project_id,
            workspace_id="ws_crew_demo",
            owner_user_id="acc_boss",
            goal_text="周会行动项闭环: 会议纪要、责任人返工、并行核对、评审与下游同步",
            sop_template_id="feature_iteration",
            source="showcase",
            showcase={
                "scenario_id": SHOWCASE_SCENARIO_ID,
                "version": SHOWCASE_VERSION - 1,
                "locale": "zh-CN",
                "mode": "deterministic",
            },
        )
    )

    result = showcase.ensure(
        workspace_id="ws_crew_demo",
        owner_user_id="acc_boss",
        members=identity.list_members("ws_crew_demo"),
    )

    assert result.migrated is True
    assert result.project.showcase and result.project.showcase["version"] == SHOWCASE_VERSION
    assert result.project.goal_text == SHOWCASE_GOAL


def test_showcase_rejects_unknown_scenario_without_writing(tmp_path: Path):
    identity = _identity(tmp_path)
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    showcase = CrewShowcaseService(store)

    with pytest.raises(ValueError, match="unknown showcase scenario"):
        showcase.ensure(
            workspace_id="ws_crew_demo",
            owner_user_id="acc_boss",
            members=identity.list_members("ws_crew_demo"),
            scenario_id="unknown",
        )

    assert store.list_projects("ws_crew_demo", "acc_boss") == []
