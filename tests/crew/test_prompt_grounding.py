"""R-B #3 · prompt grounding (RED).

The agent worker's prompt must GROUND the model in the real project, not just the
task title — the diagnosed「跑题」bug (PRD 产出「在线教育平台」≠ 项目「登录页」) came
from feeding only the task title. The assembled Worker Profile prompt must carry:

  ① 项目目标 (goal_text) pinned at the very top;
  ② the latest artifact body of each upstream dependency (depends_on), each
     clipped, labeled「上游产物·{任务名}:」— resolving a review-gate dependency to
     the artifact of the task it reviewed (so 设计稿 sees the approved PRD body);
  ③ 项目共识 (B1b, retained).

Written BEFORE the implementation it must turn green.
"""
from __future__ import annotations

from services.crew.app.agent_worker import AgentWorkerExecutor
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.model_provider import ModelRequest, ModelResponse
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class _TextModel(FakeStreamModel):
    """Governed fake: fixed deliverable; the base class captures requests."""

    def __init__(self, text: str = "# PRD\n- 目标\n- 范围") -> None:
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text, tool_calls=[], finish_reason="stop"
        )


def _user_prompt(model: FakeStreamModel) -> str:
    assert model.requests, "the Worker Profile never reached the model"
    return next(
        m["content"] for m in model.requests[0].messages if m["role"] == "user"
    )


def _executor(model: FakeStreamModel) -> AgentWorkerExecutor:
    return AgentWorkerExecutor(settings=_CONFIGURED, deps=QueryDeps(stream_model=model))


def _prd_ready(tmp_path):
    """Project driven to: brief done (artifact「需求简报正文」), PRD assigned to agent."""
    crew = CrewService(SQLiteCrewStore(tmp_path / "crew.sqlite3"))
    project = crew.create_project("ws1", "acc_boss", "登录页重设计", "feature_iteration")
    brief = next(t for t in project.tasks if t.key == "brief")
    crew.assign(project.id, brief.id, "acc_boss")
    crew.start(project.id, brief.id)
    crew.submit(project.id, brief.id, "需求简报正文:重做登录页三态")
    prd = next(t for t in crew.get_project(project.id).tasks if t.key == "prd")
    crew.assign(project.id, prd.id, "acc_agent_scribe")
    return crew, project.id, prd.id


def test_prompt_pins_goal_and_feeds_upstream_brief_artifact(tmp_path):
    crew, pid, prd_id = _prd_ready(tmp_path)
    model = _TextModel()

    crew.run_agent(pid, prd_id, _executor(model), run_ref="crew_run_g1")

    prompt = _user_prompt(model)
    # ① goal pinned at the very top.
    assert prompt.startswith("项目目标：登录页重设计")
    # ② the upstream brief's real artifact body, labeled by task name.
    assert "上游产物·需求简报：" in prompt
    assert "需求简报正文:重做登录页三态" in prompt


def test_prompt_resolves_gate_dependency_to_reviewed_artifact(tmp_path):
    """设计稿 depends on the PRD 评审 gate → it must be fed the PRD body (the task
    the gate reviewed), not the empty gate."""
    crew, pid, prd_id = _prd_ready(tmp_path)
    # PRD produced by the agent, then approved → 设计稿 becomes ready.
    crew.run_agent(pid, prd_id, _executor(_TextModel("# PRD\n登录页目标与三态口径")),
                   run_ref="crew_run_g2")
    prd_review = next(t for t in crew.get_project(pid).tasks if t.key == "prd_review")
    crew.review(pid, prd_review.id, approved=True)

    design = next(t for t in crew.get_project(pid).tasks if t.key == "design")
    crew.assign(pid, design.id, "acc_agent_design")
    model = _TextModel("# 设计稿")
    crew.run_agent(pid, design.id, _executor(model), run_ref="crew_run_g3")

    prompt = _user_prompt(model)
    # Gate dep (prd_review) resolves to the reviewed producer (PRD 起草)'s artifact.
    assert "上游产物·PRD 起草：" in prompt
    assert "登录页目标与三态口径" in prompt


def test_rework_prompt_includes_rejection_feedback(tmp_path):
    """A rework re-run (「@Scribe 再改改」/ 驳回后重跑) must carry the reviewer's
    rejection note, so the agent addresses it instead of repeating v1 verbatim."""
    crew, pid, prd_id = _prd_ready(tmp_path)
    crew.run_agent(pid, prd_id, _executor(_TextModel("# PRD v1")), run_ref="crew_run_r1")
    prd_review = next(t for t in crew.get_project(pid).tasks if t.key == "prd_review")
    crew.review(pid, prd_review.id, approved=False, comment="缺少竞品对比,请补充")

    model = _TextModel("# PRD v2")
    crew.run_agent(pid, prd_id, _executor(model), run_ref="crew_run_r2")

    prompt = _user_prompt(model)
    assert "返工要求" in prompt
    assert "缺少竞品对比,请补充" in prompt


def test_prompt_clips_long_upstream_artifact(tmp_path):
    crew, pid, prd_id = _prd_ready(tmp_path)
    # Re-drive brief with a huge artifact to exercise truncation.
    crew2 = crew  # same store
    huge = "x" * 9000
    # brief is already done; instead submit a huge PRD-upstream via a fresh project.
    project = crew2.create_project("ws1", "acc_boss", "登录页重设计", "feature_iteration")
    brief = next(t for t in project.tasks if t.key == "brief")
    crew2.assign(project.id, brief.id, "acc_boss")
    crew2.start(project.id, brief.id)
    crew2.submit(project.id, brief.id, huge)
    prd = next(t for t in crew2.get_project(project.id).tasks if t.key == "prd")
    crew2.assign(project.id, prd.id, "acc_agent_scribe")
    model = _TextModel()

    crew2.run_agent(project.id, prd.id, _executor(model), run_ref="crew_run_g4")

    prompt = _user_prompt(model)
    assert "上游产物·需求简报：" in prompt
    assert "已截断" in prompt              # clip marker present
    assert prompt.count("x") < 9000        # not the full 9000-char body
