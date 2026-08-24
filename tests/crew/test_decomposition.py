from __future__ import annotations

from services.crew.app.decomposition import EMIT_TOOL, plan_to_project


def _plan():
    return {
        "goal": "做一个新功能",
        "summary": "围绕目标细化的计划",
        "tasks": [
            {"key": "clarify", "title": "需求澄清(竞品对比)", "role_required": "PM",
             "depends_on": [], "is_gate": False, "reviews": None,
             "description": "澄清目标与范围", "acceptance_criteria": None},
            {"key": "prd", "title": "PRD 撰写", "role_required": "PM",
             "depends_on": ["clarify"], "is_gate": False, "reviews": None,
             "description": "", "acceptance_criteria": None},
            {"key": "prd_review", "title": "PRD 评审", "role_required": "boss",
             "depends_on": ["prd"], "is_gate": True, "reviews": "prd",
             "description": "", "acceptance_criteria": "目标清晰"},
        ],
    }


def test_emit_tool_shape():
    assert EMIT_TOOL["name"] == "crew.emit_project_plan"
    assert "tasks" in EMIT_TOOL["input_schema"]["properties"]


def test_plan_to_project_builds_dag():
    seq = {"n": 0}
    def task_id(key):
        seq["n"] += 1
        return f"t{seq['n']}_{key}"
    project = plan_to_project(
        _plan(), project_id="p1", workspace_id="ws1",
        owner_user_id="boss", goal_text="做一个新功能", template_id="feature_iteration",
        task_id=task_id,
    )
    clarify = next(t for t in project.tasks if t.key == "clarify")
    prd = next(t for t in project.tasks if t.key == "prd")
    review = next(t for t in project.tasks if t.key == "prd_review")
    assert clarify.status == "todo" and prd.status == "blocked"
    assert prd.depends_on == [clarify.id]
    assert review.is_gate and review.reviews_task_id == prd.id
    assert clarify.title == "需求澄清(竞品对比)"   # model-refined title preserved


# ---------------------------------------------------------------------------
# Task 2 tests: CrewDecompositionService with injected fake harness
# ---------------------------------------------------------------------------

from services.crew.app.decomposition import CrewDecompositionService
from services.crew.app.sop_templates import get_template
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelResponse, ModelToolCall


class _EmitProvider:
    def __init__(self, plan):
        self.settings = RuntimeSettings(
            model_endpoint="https://m.example/v1", model_api_key="k")
        self._plan = plan

    async def create_response(self, request):
        return ModelResponse(tool_calls=[ModelToolCall(
            id="c1", name="crew.emit_project_plan", arguments=self._plan)],
            finish_reason="tool_calls")


class _DeadProvider:
    def __init__(self):
        self.settings = RuntimeSettings()  # no key/endpoint -> not configured

    async def create_response(self, request):
        raise AssertionError("should not be called when unconfigured")


def _ids():
    seq = {"n": 0}
    def task_id(key):
        seq["n"] += 1
        return f"t{seq['n']}_{key}"
    return task_id


def test_decompose_uses_model_plan(tmp_path):
    svc = CrewDecompositionService(AnnaHarnessRuntime(_EmitProvider(_plan())))
    project = svc.decompose(project_id="p1", workspace_id="ws1", owner_user_id="boss",
                            goal_text="做一个新功能", template=get_template("feature_iteration"),
                            task_id=_ids())
    assert next(t for t in project.tasks if t.key == "clarify").title == "需求澄清(竞品对比)"


def test_plan_to_project_duplicate_key_yields_unique_task_ids():
    """A plan with a repeated key must produce exactly one task with a unique id."""
    dup_plan = {
        "goal": "dup",
        "summary": "test",
        "tasks": [
            {"key": "alpha", "title": "Alpha", "role_required": "PM"},
            {"key": "alpha", "title": "Alpha dup", "role_required": "PM"},  # duplicate
            {"key": "beta", "title": "Beta", "role_required": "Dev"},
        ],
    }
    seq = {"n": 0}
    def task_id(key):
        seq["n"] += 1
        return f"t{seq['n']}_{key}"

    project = plan_to_project(
        dup_plan, project_id="p2", workspace_id="ws1",
        owner_user_id="boss", goal_text="dup test", template_id="feature_iteration",
        task_id=task_id,
    )
    ids = [t.id for t in project.tasks]
    assert len(ids) == len(set(ids)), "task ids must be unique"
    keys = [t.key for t in project.tasks]
    assert keys.count("alpha") == 1, "duplicate key must yield only one task"


def test_decompose_falls_back_when_model_unconfigured(tmp_path):
    svc = CrewDecompositionService(AnnaHarnessRuntime(_DeadProvider()))
    project = svc.decompose(project_id="p1", workspace_id="ws1", owner_user_id="boss",
                            goal_text="g", template=get_template("feature_iteration"),
                            task_id=_ids())
    # deterministic template DAG (9 tasks, original titles; R-B #4 含技术预研)
    keys = {t.key for t in project.tasks}
    assert keys == {
        "brief", "prd", "prd_review", "design", "tech_research",
        "design_review", "build", "code_review", "accept",
    }
    assert next(t for t in project.tasks if t.key == "prd").title == "PRD 起草"
