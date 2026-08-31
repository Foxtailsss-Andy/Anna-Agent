from services.hiker.app.orchestrator import (
    MAX_HIKER_MODEL_TOOL_ROUNDS,
    HikerOrchestrator,
)
from services.mcp_gateway.app.hiker_adapter import HikerMcpError
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.model_provider import ModelResponse, ModelToolCall
from tests.hiker.hiker_fakes import FakeGateway, FakeSkillLoader
from tests.support.engine_fakes import FakeStreamModel, build_engine


def _orchestrator():
    return HikerOrchestrator(adapter=FakeGateway(), settings=RuntimeSettings())


def test_dashboard_assembles_real_kpis():
    run = _orchestrator().start_dashboard_run("ws_demo", "admin")

    assert run.status == "ready"
    snapshot = run.snapshot
    kpis = {kpi.id: kpi.value for kpi in snapshot.kpis}
    assert kpis["contract_count"] == 4
    assert kpis["contract_amount"] == 1000000.0
    assert kpis["customer_count"] == 2
    assert kpis["country_count"] == 2
    assert snapshot.collection.planned_amount == 600000.0
    assert snapshot.source == "Hiker MCP"


def test_dashboard_top_customers_sorted_desc():
    run = _orchestrator().start_dashboard_run("ws_demo", "admin")
    names = [row.customer_name for row in run.snapshot.top_customers]
    assert names[0] == "示例客户甲"


def test_dashboard_flags_concentration_anomaly():
    run = _orchestrator().start_dashboard_run("ws_demo", "admin")
    titles = " ".join(a.title for a in run.snapshot.anomalies)
    # 700,000 / 1,000,000 = 70% from a single customer -> concentration risk.
    assert "集中度" in titles


def test_dashboard_not_configured_when_connector_down():
    class DownGateway(FakeGateway):
        def status(self):
            return {"status": "not_configured", "error_code": "connector_not_configured"}

    run = HikerOrchestrator(adapter=DownGateway(), settings=RuntimeSettings()).start_dashboard_run("ws_demo", "admin")
    assert run.status == "failed"
    assert run.error_code == "connector_not_configured"


def test_dashboard_sends_hiker_default_actor_not_anna_user():
    # Hiker rejects unknown actor_user_id with permission_denied. Anna's local
    # session user (e.g. "local-user") is NOT a Hiker user, so every MCP
    # call must carry the configured Hiker default actor ("admin"), never the
    # Anna session user.
    seen_actors = []

    class CapturingGateway(FakeGateway):
        def call_tool(self, tool_name, arguments):
            seen_actors.append(arguments.get("actor_user_id"))
            return super().call_tool(tool_name, arguments)

    run = HikerOrchestrator(
        adapter=CapturingGateway(), settings=RuntimeSettings()
    ).start_dashboard_run("ws_demo", "local-user")

    assert run.status == "ready"
    assert seen_actors, "expected Hiker MCP calls"
    assert set(seen_actors) == {"admin"}


# ---------------------------------------------------------------------------
# Assistant ReAct tests (engine seam: fake stream_model via QueryEngine deps)
# ---------------------------------------------------------------------------

CONFIGURED_SETTINGS = RuntimeSettings(
    model_api_key="k",
    model_endpoint="http://m",
    hiker_assistant_skill_id="hiker/global-customer",
)


class HikerAssistantStream(FakeStreamModel):
    """First round: dashboard-summary tool call; second round: final answer."""

    def respond(self, request):
        if len(self.requests) == 1:
            return ModelResponse(
                tool_calls=[
                    ModelToolCall(
                        id="call_hiker_1",
                        name="hiker.report.get_dashboard_summary",
                        arguments={},
                    )
                ],
                finish_reason="tool_calls",
            )
        return ModelResponse(
            assistant_message="整体经营稳健。数据来自 Hiker MCP",
            finish_reason="stop",
        )


class ForbiddenToolStream(FakeStreamModel):
    """Requests a tool outside HIKER_ALLOWED_TOOLS (governance must deny)."""

    def respond(self, request):
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_forbidden",
                    name="hiker.contract.delete_contract",
                    arguments={},
                )
            ],
            finish_reason="tool_calls",
        )


class AlwaysToolCallingStream(FakeStreamModel):
    """Requests the dashboard tool on EVERY round — drives max-rounds exhaustion."""

    def respond(self, request):
        return ModelResponse(
            tool_calls=[
                ModelToolCall(
                    id="call_hiker_loop",
                    name="hiker.report.get_dashboard_summary",
                    arguments={},
                )
            ],
            finish_reason="tool_calls",
        )


def _assistant_orchestrator(gateway, stream, settings=CONFIGURED_SETTINGS):
    return HikerOrchestrator(
        adapter=gateway,
        skill_loader=FakeSkillLoader(),
        settings=settings,
        engine=build_engine(stream, settings=settings),
    )


def test_assistant_react_happy_path():
    orchestrator = _assistant_orchestrator(FakeGateway(), HikerAssistantStream())

    run = orchestrator.start_assistant_run("ws_demo", "admin", "整体经营怎么样?")

    assert run.status == "ready"
    assert run.answer is not None and "Hiker MCP" in run.answer
    assert run.tools_used == ["hiker.report.get_dashboard_summary"]
    assert run.agent_message == run.answer


def test_assistant_run_ids_are_unique_across_orchestrator_restarts():
    first_process = _orchestrator()
    restarted_process = _orchestrator()

    first = first_process.begin_assistant_run("ws_demo", "admin", "第一问")
    second = restarted_process.begin_assistant_run("ws_demo", "admin", "第二问")

    assert first.id.startswith("hiker_assistant_run_")
    assert second.id.startswith("hiker_assistant_run_")
    assert first.id != second.id


def test_assistant_audit_trail_matches_old_loop_order():
    orchestrator = _assistant_orchestrator(FakeGateway(), HikerAssistantStream())

    run = orchestrator.start_assistant_run("ws_demo", "admin", "整体经营怎么样?")

    assert [event.type for event in run.audit_events] == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "model.call.started",
        "model.call.completed",
        "hiker.assistant.answered",
    ]
    answered = run.audit_events[-1]
    assert answered.payload == {"tools_used": ["hiker.report.get_dashboard_summary"]}
    mcp_event = next(e for e in run.audit_events if e.type == "mcp.tool.called")
    assert mcp_event.payload["tool_name"] == "hiker.report.get_dashboard_summary"
    assert mcp_event.payload["status"] == "success"
    # Accepted migration delta (same as the finance/reimbursement reference
    # pair): model.call.started comes from the engine's stream_model and no
    # longer carries skill_id — skill_id still lives on skill.loaded.
    started = [e for e in run.audit_events if e.type == "model.call.started"]
    assert all("skill_id" not in e.payload for e in started)
    skill_loaded = next(e for e in run.audit_events if e.type == "skill.loaded")
    assert skill_loaded.payload["skill_id"] == "hiker/global-customer"


def test_assistant_sends_hiker_default_actor_and_request_id():
    # Same actor mapping as the dashboard path: Anna's session user is NOT a
    # Hiker user; every MCP call carries the configured Hiker default actor
    # plus the run id as request_id, merged with the model's arguments.
    seen = []

    class CapturingGateway(FakeGateway):
        def call_tool(self, tool_name, arguments):
            seen.append((tool_name, arguments))
            return super().call_tool(tool_name, arguments)

    orchestrator = _assistant_orchestrator(CapturingGateway(), HikerAssistantStream())

    run = orchestrator.start_assistant_run("ws_demo", "local-user", "整体经营怎么样?")

    assert run.status == "ready"
    assert seen == [
        (
            "hiker.report.get_dashboard_summary",
            {"request_id": run.id, "actor_user_id": "admin"},
        )
    ]


def test_assistant_denies_tool_outside_allowlist_before_any_mcp_call():
    calls = []

    class CountingGateway(FakeGateway):
        def call_tool(self, tool_name, arguments):
            calls.append(tool_name)
            return super().call_tool(tool_name, arguments)

    orchestrator = _assistant_orchestrator(CountingGateway(), ForbiddenToolStream())

    run = orchestrator.start_assistant_run("ws_demo", "admin", "删掉一个合同")

    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"
    assert calls == []
    assert run.audit_events[-1].type == "hiker.assistant.failed"
    assert run.audit_events[-1].payload["error_code"] == "tool_not_allowed"


def test_assistant_mcp_error_fails_run_with_audited_failed_tool_call():
    class FailingGateway(FakeGateway):
        def call_tool(self, tool_name, arguments):
            raise HikerMcpError("hiker_upstream_unavailable", "Hiker upstream is down", True)

    orchestrator = _assistant_orchestrator(FailingGateway(), HikerAssistantStream())

    run = orchestrator.start_assistant_run("ws_demo", "admin", "整体经营怎么样?")

    assert run.status == "failed"
    assert run.error_code == "hiker_upstream_unavailable"
    assert run.error_message == "Hiker upstream is down"
    assert [event.type for event in run.audit_events] == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "mcp.tool.called",
        "hiker.assistant.failed",
    ]
    mcp_event = next(e for e in run.audit_events if e.type == "mcp.tool.called")
    assert mcp_event.payload["status"] == "failed"


def test_assistant_fails_when_tool_loop_exhausts_max_rounds():
    orchestrator = _assistant_orchestrator(FakeGateway(), AlwaysToolCallingStream())

    run = orchestrator.start_assistant_run("ws_demo", "admin", "整体经营怎么样?")

    assert run.status == "failed"
    assert run.error_code == "tool_loop_exhausted"
    assert run.error_message == "Hiker assistant tool loop exceeded max rounds"
    assert run.audit_events[-1].type == "hiker.assistant.failed"
    # Exactly MAX_HIKER_MODEL_TOOL_ROUNDS model calls were spent.
    started = [e for e in run.audit_events if e.type == "model.call.started"]
    assert len(started) == MAX_HIKER_MODEL_TOOL_ROUNDS


def test_assistant_fails_clearly_without_model_config():
    # Hiker uses the reimbursement-style preflight: with no model configured
    # the connector is not checked; the missing config surfaces through the
    # engine's model seam with hiker's own config error message.
    stream = HikerAssistantStream()
    orchestrator = _assistant_orchestrator(
        FakeGateway(), stream, settings=RuntimeSettings()
    )

    run = orchestrator.start_assistant_run("ws_demo", "admin", "整体经营怎么样?")

    assert run.status == "failed"
    assert run.error_code == "model_not_configured"
    assert (
        run.error_message
        == "model endpoint and API key are required before running Anna Hiker assistant"
    )
    assert stream.requests == []
    assert [event.type for event in run.audit_events] == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "hiker.assistant.failed",
    ]


def test_assistant_fails_before_model_when_connector_down_and_model_configured():
    class DownGateway(FakeGateway):
        def status(self):
            return {"status": "not_configured", "error_code": "connector_not_configured"}

    stream = HikerAssistantStream()
    orchestrator = _assistant_orchestrator(DownGateway(), stream)

    run = orchestrator.start_assistant_run("ws_demo", "admin", "整体经营怎么样?")

    assert run.status == "failed"
    assert run.error_code == "connector_not_configured"
    assert stream.requests == []
    assert [event.type for event in run.audit_events] == [
        "hiker.assistant.run.created",
        "skill.loaded",
        "hiker.assistant.failed",
    ]
