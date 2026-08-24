"""B4 · artifact 版本历史 (RED).

Every submit (human or Agent) appends an ``ArtifactVersion`` to the task's
``artifact_versions`` (1-based, monotonic); the flat ``artifact`` field is kept
as the LATEST version's content so every existing reader keeps working. A rework
re-submit appends v2 (the history is retained, never overwritten), and the whole
history round-trips through the store's JSON payload.

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

from pathlib import Path

from services.crew.app.agent_worker import AgentWorkerExecutor
from services.crew.app.lifecycle import (
    assign_task,
    instantiate_project,
    review_task,
    start_task,
    submit_task,
)
from services.crew.app.service import CrewService
from services.crew.app.sop_templates import get_template
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


def _project():
    counter = {"n": 0}

    def task_id(key):
        counter["n"] += 1
        return f"task_{counter['n']}_{key}"

    return instantiate_project(
        project_id="proj1", workspace_id="ws1", owner_user_id="boss",
        goal_text="做一个新功能", template=get_template("feature_iteration"),
        task_id=task_id,
    )


def _task(project, key):
    return next(t for t in project.tasks if t.key == key)


def _bring_prd_running(project):
    """Drive brief -> done, then prd -> running (ready to submit)."""
    brief = _task(project, "brief")
    assign_task(project, brief.id, "m_pm")
    start_task(project, brief.id)
    submit_task(project, brief.id, "需求文档")
    prd = _task(project, "prd")
    assign_task(project, prd.id, "m_scribe")
    start_task(project, prd.id)
    return prd


# --- lifecycle level ---------------------------------------------------------


def test_first_submit_creates_version_one():
    project = _project()
    prd = _bring_prd_running(project)
    submit_task(project, prd.id, "PRD v1")

    assert len(prd.artifact_versions) == 1
    v1 = prd.artifact_versions[0]
    assert v1.version == 1
    assert v1.content == "PRD v1"
    assert v1.submitted_at  # ISO timestamp stamped at submit
    # Flat field mirrors the latest version (back-compat for existing readers).
    assert prd.artifact == "PRD v1"


def test_rework_resubmit_appends_version_two_and_keeps_history():
    project = _project()
    prd = _bring_prd_running(project)
    submit_task(project, prd.id, "PRD v1")            # -> submitted (has gate)
    review_task(project, _task(project, "prd_review").id, approved=False, comment="改")
    assert prd.status == "rework"
    start_task(project, prd.id)
    submit_task(project, prd.id, "PRD v2")

    assert [v.version for v in prd.artifact_versions] == [1, 2]
    assert [v.content for v in prd.artifact_versions] == ["PRD v1", "PRD v2"]
    # Latest content is v2; the v1 row is retained (history, not overwritten).
    assert prd.artifact == "PRD v2"


def test_no_gate_producer_is_versioned_too():
    """A producer with no downstream gate (brief) still records a version."""
    project = _project()
    brief = _task(project, "brief")
    assign_task(project, brief.id, "m_pm")
    start_task(project, brief.id)
    submit_task(project, brief.id, "需求文档")

    assert brief.status == "done"
    assert len(brief.artifact_versions) == 1
    assert brief.artifact_versions[0].content == "需求文档"


# --- service level (persistence + agent produce) -----------------------------


def _svc(tmp_path: Path) -> CrewService:
    return CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))


def _service_prd_running(svc: CrewService):
    project = svc.create_project("ws1", "acc_boss", "登录页重设计", "feature_iteration")
    pid = project.id
    brief = _task(project, "brief")
    svc.assign(pid, brief.id, "acc_boss")
    svc.start(pid, brief.id)
    svc.submit(pid, brief.id, "需求")
    prd = next(t for t in svc.get_project(pid).tasks if t.key == "prd")
    svc.assign(pid, prd.id, "acc_agent_scribe")
    svc.start(pid, prd.id)
    return svc, pid, prd.id


def test_versions_survive_store_reload(tmp_path):
    store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    svc = CrewService(store=store)
    _svc2, pid, prd_id = _service_prd_running(svc)
    svc.submit(pid, prd_id, "PRD v1")

    # Reload with a fresh service on the same store.
    reloaded = CrewService(store=store).get_project(pid)
    prd = next(t for t in reloaded.tasks if t.id == prd_id)
    assert [v.version for v in prd.artifact_versions] == [1]
    assert prd.artifact_versions[0].content == "PRD v1"
    assert prd.artifact == "PRD v1"


class _TextModel(FakeStreamModel):
    def __init__(self, text="# PRD\n- 目标"):
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text, tool_calls=[], finish_reason="stop"
        )


def test_agent_produced_artifact_is_versioned(tmp_path):
    svc = _svc(tmp_path)
    project = svc.create_project("ws1", "acc_boss", "做一个新功能", "feature_iteration")
    pid = project.id
    brief = _task(project, "brief")
    svc.assign(pid, brief.id, "acc_boss")
    svc.start(pid, brief.id)
    svc.submit(pid, brief.id, "需求")
    prd = next(t for t in svc.get_project(pid).tasks if t.key == "prd")
    svc.assign(pid, prd.id, "acc_agent_scribe")

    executor = AgentWorkerExecutor(
        settings=_CONFIGURED, deps=QueryDeps(stream_model=_TextModel("# PRD\n- 目标")),
    )
    updated, _result = svc.run_agent(pid, prd.id, executor, run_ref="crew_run_007")

    done_prd = next(t for t in updated.tasks if t.id == prd.id)
    assert len(done_prd.artifact_versions) == 1
    assert done_prd.artifact_versions[0].version == 1
    assert done_prd.artifact_versions[0].content == "# PRD\n- 目标"
    assert done_prd.artifact == "# PRD\n- 目标"
