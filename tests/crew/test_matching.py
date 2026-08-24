from __future__ import annotations

from services.crew.app.matching import AssignmentProposal, deterministic_proposals
from services.crew.app.lifecycle import instantiate_project
from services.crew.app.sop_templates import get_template
from services.identity.app.schemas import Account


def _members():
    return [
        Account(id="m_boss", workspace_id="ws1", email="b@x", display_name="Boss", role="产品", kind="human"),
        Account(id="m_andy", workspace_id="ws1", email="a@x", display_name="Andy", role="工程", kind="human"),
        Account(id="m_scribe", workspace_id="ws1", email="s@x", display_name="Scribe", role="文案", kind="agent"),
        Account(id="m_design", workspace_id="ws1", email="d@x", display_name="Design", role="设计", kind="agent"),
    ]


def _project():
    seq = {"n": 0}
    def tid(k):
        seq["n"] += 1
        return f"t{seq['n']}_{k}"
    return instantiate_project(project_id="p1", workspace_id="ws1", owner_user_id="boss",
                              goal_text="g", template=get_template("feature_iteration"), task_id=tid)


_ALL_KEYS = {
    "brief", "prd", "prd_review", "design", "tech_research",
    "design_review", "build", "code_review", "accept",
}


def test_deterministic_matches_role_and_covers_all_unassigned():
    project, members = _project(), _members()
    props = deterministic_proposals(project, members)
    by_key = {p.task_key: p for p in props}
    assert len(props) == 9  # all unassigned (R-B #4:含技术预研)
    assert by_key["prd"].member_id == "m_scribe"       # role 文案
    assert by_key["prd_review"].member_id == "m_boss"   # role 产品 (gate)
    assert by_key["design"].member_id == "m_design"     # role 设计
    assert by_key["build"].member_id == "m_andy"        # role 工程
    assert by_key["tech_research"].member_id == "m_andy"  # role 工程 (并行支)
    assert all(p.rationale for p in props)


def test_deterministic_member_id_null_when_no_role_match():
    project = _project()
    members = [Account(id="m_x", workspace_id="ws1", email="x@x", display_name="X", role="财务", kind="human")]
    props = deterministic_proposals(project, members)
    assert all(p.member_id is None for p in props)
    assert all("无匹配" in p.rationale or p.member_id is None for p in props)


# ---------------------------------------------------------------------------
# Task A2 tests: CrewMatchingService with injected fake harness
# ---------------------------------------------------------------------------

from services.crew.app.matching import CrewMatchingService, EMIT_TOOL
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.harness_runtime import AnnaHarnessRuntime
from services.runtime.app.model_provider import ModelResponse, ModelToolCall


class _EmitProvider:
    def __init__(self, assignments):
        self.settings = RuntimeSettings(model_endpoint="https://m/v1", model_api_key="k")
        self._a = assignments
    async def create_response(self, request):
        return ModelResponse(tool_calls=[ModelToolCall(id="c1", name="crew.emit_assignments",
            arguments={"assignments": self._a})], finish_reason="tool_calls")


class _DeadProvider:
    def __init__(self):
        self.settings = RuntimeSettings()
    async def create_response(self, request):
        raise AssertionError("unconfigured -> should not be called")


def test_emit_tool_shape():
    assert EMIT_TOOL["name"] == "crew.emit_assignments"


def test_propose_uses_model_assignments():
    project, members = _project(), _members()
    svc = CrewMatchingService(AnnaHarnessRuntime(_EmitProvider(
        [{"task_key": "prd", "member_id": "m_andy", "rationale": "临时交给工程处理"}])))
    props = svc.propose(project, members)
    prd_prop = next(p for p in props if p.task_key == "prd")
    assert prd_prop.member_id == "m_andy" and "工程" in prd_prop.rationale
    # tasks the model omitted still get a deterministic proposal (full coverage)
    assert len(props) == 9


def test_propose_falls_back_when_unconfigured():
    project, members = _project(), _members()
    props = CrewMatchingService(AnnaHarnessRuntime(_DeadProvider())).propose(project, members)
    assert {p.task_key for p in props} == _ALL_KEYS


def test_propose_ignores_invalid_member_id_from_model():
    project, members = _project(), _members()
    svc = CrewMatchingService(AnnaHarnessRuntime(_EmitProvider(
        [{"task_key": "prd", "member_id": "ghost", "rationale": "x"}])))
    prd_prop = next(p for p in svc.propose(project, members) if p.task_key == "prd")
    assert prd_prop.member_id == "m_scribe"  # invalid -> deterministic (文案)
