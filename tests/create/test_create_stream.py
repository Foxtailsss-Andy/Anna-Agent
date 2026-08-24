"""Home 合并轮 B1 — Create 流式管线(stream_draft)。

Create 仍是单次结构化输出调用 + 确定性后处理;流式化 = 工作线程跑 _advance_run,
主协程按审计水位直播真事件 + 阶段边界 step 帧(analyze → deliver),终帧 done/error
与 chat 同形。断言帧序列、真值透传(agent_id)与失败路径。
"""
import asyncio
from dataclasses import replace
from pathlib import Path

from services.runtime.app.config import RuntimeSettings

from tests.create.test_create_skill_draft import (
    _CONFIGURED_SETTINGS,
    _failing_stream,
    _orchestrator,
    _skill_stream,
)


def _collect(orchestrator, **kwargs) -> list[dict]:
    async def _run() -> list[dict]:
        return [frame async for frame in orchestrator.stream_draft(**kwargs)]

    return asyncio.run(_run())


def _event_types(frames: list[dict]) -> list[str]:
    out = []
    for f in frames:
        if f.get("type") == "event":
            ev = f["event"]
            out.append(getattr(ev, "type", None) or ev.get("type"))
    return out


def test_stream_draft_emits_audit_steps_and_done(tmp_path):
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
        prompt="创建一个逾期应收风险分析 Skill",
        kind="skill",
    )

    kinds = [f.get("type") for f in frames]
    assert kinds[-1] == "done"
    assert kinds.count("done") == 1
    # 真审计直播:created → model.call.* → generated → validated
    events = _event_types(frames)
    assert events[0] == "create.skill.run.created"
    assert "model.call.started" in events
    assert "model.call.completed" in events
    assert "create.skill.generated" in events
    assert "create.skill.validated" in events
    # 阶段 step 帧:analyze 先行,deliver 在 generated 审计之后
    steps = [f for f in frames if f.get("type") == "step"]
    assert [s["phase"] for s in steps] == ["analyze", "deliver"]
    gen_idx = next(
        i for i, f in enumerate(frames)
        if f.get("type") == "event"
        and (getattr(f["event"], "type", None) or f["event"].get("type")) == "create.skill.generated"
    )
    deliver_idx = next(i for i, f in enumerate(frames) if f.get("type") == "step" and f["phase"] == "deliver")
    assert deliver_idx > gen_idx
    # 终帧带完整 run
    final = frames[-1]["run"]
    assert final.status == "ready_for_review"
    assert final.validation is not None and final.validation.valid


def test_stream_draft_invalid_kind_yields_error(tmp_path):
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
        prompt="做点什么",
        kind="nonsense",
    )

    assert frames[-1]["type"] == "error"
    assert frames[-1]["run"].error_code == "create_kind_invalid"


def test_stream_draft_model_failure_yields_error_run(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    orchestrator = _orchestrator(
        stream=_failing_stream(),
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
    )

    frames = _collect(
        orchestrator,
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="创建技能",
        kind="skill",
    )

    assert frames[-1]["type"] == "error"
    assert frames[-1]["run"].status == "failed"
    assert frames[-1]["run"].error_code == "model_call_failed"


def test_stream_draft_agent_id_overrides_create_directive(tmp_path):
    project_root = tmp_path / "project"
    project_root.mkdir()
    settings: RuntimeSettings = replace(
        _CONFIGURED_SETTINGS,
        agent_directives={"create": "构建默认口径。", "finance": "财务口径:先确认期间。"},
    )
    stream = _skill_stream()
    orchestrator = _orchestrator(
        stream=stream,
        project_root=project_root,
        workspace_root=tmp_path / "create-runs",
        settings=settings,
    )

    frames = _collect(
        orchestrator,
        workspace_id="demo",
        actor_user_id="u_demo",
        prompt="建一个财务技能",
        kind="skill",
        agent_id="finance",
    )

    assert frames[-1]["type"] == "done"
    assert frames[-1]["run"].agent_id == "finance"
    system = "\n".join(
        str(m.get("content") or "")
        for m in stream.requests[0].messages
        if m.get("role") == "system"
    )
    assert "财务口径:先确认期间。" in system
    assert "构建默认口径。" not in system
