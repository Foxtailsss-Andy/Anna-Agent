"""Home 合并轮 B2/B3 — Create 的工作空间注入 + permission_mode 参数链。

create 是单次结构化调用(无工具循环):workdir 只做 [工作空间] 段追加到
system prompt 末尾,不挂 read 工具;permission_mode 本轮真存真审计(run 字段
+ created 审计 payload),拦截点随后续写工具/Code 模式点亮。
真值口径:FakeStreamModel.requests 捕获的 ModelRequest 即引擎实发提示。
"""
import asyncio
import json

from tests.create.test_create_skill_draft import (
    _orchestrator,
    _skill_stream,
)


_WORKDIR_ID = "wd_create_b2"


def _register_workdir(tmp_path, monkeypatch, folder) -> str:
    store = tmp_path / "workdirs.json"
    store.write_text(
        json.dumps(
            {
                "workdirs": [
                    {
                        "id": _WORKDIR_ID,
                        "name": "proj",
                        "path": str(folder),
                        "last_used_at": "2026-07-12T00:00:00+00:00",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(store))
    return _WORKDIR_ID


def _collect(orchestrator, **kwargs) -> list[dict]:
    async def _run() -> list[dict]:
        return [frame async for frame in orchestrator.stream_draft(**kwargs)]

    return asyncio.run(_run())


def _system_text(stream) -> str:
    assert stream.requests, "engine never called the model"
    return "\n".join(
        str(m.get("content") or "")
        for m in stream.requests[0].messages
        if m.get("role") == "system"
    )


def _created_event(run):
    created = run.audit_events[0]
    assert created.type.endswith(".run.created")
    return created


def test_stream_with_workdir_injects_context_into_system(tmp_path, monkeypatch):
    folder = tmp_path / "proj"
    folder.mkdir()
    (folder / "spec.md").write_text("规格", encoding="utf-8")
    wid = _register_workdir(tmp_path, monkeypatch, folder)
    project_root = tmp_path / "project"
    project_root.mkdir()
    stream = _skill_stream()
    orchestrator = _orchestrator(
        stream=stream,
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    frames = _collect(
        orchestrator,
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="按项目规格建一个 Skill",
        kind="skill",
        workdir_id=wid,
    )

    assert frames[-1]["type"] == "done"
    run = frames[-1]["run"]
    assert run.workdir_id == wid
    assert _created_event(run).payload["workdir_id"] == wid
    system = _system_text(stream)
    assert "[工作空间]" in system
    assert "spec.md" in system


def test_permission_mode_defaults_to_ask_and_bypass_is_stored(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()

    default_run = _orchestrator(
        stream=_skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    ).create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="建技能",
        kind="skill",
    )
    assert default_run.permission_mode == "ask"
    assert _created_event(default_run).payload["permission_mode"] == "ask"

    bypass_run = _orchestrator(
        stream=_skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs-2",
    ).create_draft(
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="建技能",
        kind="skill",
        permission_mode="bypass",
    )
    assert bypass_run.permission_mode == "bypass"
    assert _created_event(bypass_run).payload["permission_mode"] == "bypass"


def test_stream_permission_mode_bypass_reaches_run_and_audit(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        stream=_skill_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    frames = _collect(
        orchestrator,
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="建技能",
        kind="skill",
        permission_mode="bypass",
    )

    run = frames[-1]["run"]
    assert run.permission_mode == "bypass"
    assert _created_event(run).payload["permission_mode"] == "bypass"


def test_stale_workdir_downgrades_honestly(tmp_path, monkeypatch):
    monkeypatch.setenv("ANNA_WORKDIRS_PATH", str(tmp_path / "empty-store.json"))
    project_root = tmp_path / "project"
    project_root.mkdir()
    stream = _skill_stream()
    orchestrator = _orchestrator(
        stream=stream,
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    frames = _collect(
        orchestrator,
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="建技能",
        kind="skill",
        workdir_id="wd_gone",
    )

    # 解析不到:不注入、审计 workdir.missing,run 照常完成(诚实降级)。
    assert frames[-1]["type"] == "done"
    run = frames[-1]["run"]
    assert run.status == "ready_for_review"
    assert "[工作空间]" not in _system_text(stream)
    missing = [e for e in run.audit_events if e.type == "workdir.missing"]
    assert len(missing) == 1
    assert missing[0].payload == {"workdir_id": "wd_gone"}
