from __future__ import annotations

import asyncio

from services.crew.app.agent_worker import QueryEngineLoopAdapter
from services.crew.app.service import CrewService
from services.crew.app.store import SQLiteCrewStore
from services.memory.app.store import BusinessMemoryStore
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import CapabilityError, ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.execution.models import ExecutionSnapshot, PendingSignal
from services.runtime.app.model_provider import ModelRequest, ModelResponse, ModelToolCall
from tests.support.engine_fakes import FakeStreamModel

_CONFIGURED = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class _TextModel(FakeStreamModel):
    def __init__(self, text: str = "# PRD\n- 目标\n- 范围") -> None:
        super().__init__()
        self._text = text

    def respond(self, request: ModelRequest) -> ModelResponse:
        return ModelResponse(
            assistant_message=self._text,
            tool_calls=[],
            finish_reason="stop",
        )


class _RaisingStream:
    def __init__(self) -> None:
        self.requests: list[ModelRequest] = []

    def __call__(self, run_id, audit_events, request, *, settings, config_error_message):
        self.requests.append(request)

        async def _gen():
            yield ModelChunk(kind="text_delta", text="partial")
            raise RuntimeError("stream exploded")

        return _gen()


class _NudgingHandler:
    def __init__(self, prompt: str) -> None:
        self.prompt = prompt

    def build_initial_request(self) -> ModelRequest:
        return ModelRequest(
            messages=[
                {"role": "system", "content": "test worker"},
                {"role": "user", "content": self.prompt},
            ],
            tools=[],
        )

    def dispatch_tool(self, tool_call: ModelToolCall) -> dict:
        raise CapabilityError("tool_not_allowed", tool_call.name)

    def on_assistant_final(self, assistant_message: str | None) -> str | None:
        return "继续"


class _NudgingResolver:
    def resolve(self, role_required: str):
        return _NudgingHandler


def _service_with_prd_ready(tmp_path):
    crew_store = SQLiteCrewStore(tmp_path / "crew.sqlite3")
    crew = CrewService(crew_store)
    project = crew.create_project("ws1", "acc_boss", "登录页重设计", "feature_iteration")
    brief = next(t for t in project.tasks if t.key == "brief")
    crew.assign(project.id, brief.id, "acc_boss")
    crew.start(project.id, brief.id)
    crew.submit(project.id, brief.id, "需求简报正文:重做登录页三态")
    prd = next(t for t in crew.get_project(project.id).tasks if t.key == "prd")
    crew.assign(project.id, prd.id, "acc_agent_scribe")
    return crew_store, project.id, prd.id


def _snapshot(
    *,
    project_id: str,
    task_id: str,
    workspace_id: str = "ws1",
    worker_profile_ref: str = "member:acc_agent_scribe",
    source_instruction: str = "@Scribe 请起草 PRD",
) -> ExecutionSnapshot:
    return ExecutionSnapshot(
        execution_id="exec_1",
        workspace_id=workspace_id,
        conversation_id="conversation:c1",
        channel_id="channel:crew",
        subject_ref=f"crew_task:{project_id}:{task_id}",
        trigger_ref="message:msg_1",
        status="running",
        worker_profile_ref=worker_profile_ref,
        run_profile_ref="run:crew-default",
        input={
            "project_id": project_id,
            "task_id": task_id,
            "source_message_id": "msg_1",
            "source_instruction": source_instruction,
        },
        state={},
        checkpoint={},
        version=1,
        created_at=1.0,
        updated_at=1.0,
        attempt=1,
        lease_owner="worker-a",
        lease_token=1,
        lease_expires_at=30.0,
    )


def _signal(signal_id: str, kind: str, text: str) -> PendingSignal:
    return PendingSignal(
        signal_id=signal_id,
        execution_id="exec_1",
        kind=kind,
        payload={"text": text},
        created_at=1.0,
    )


def test_query_engine_adapter_success_emits_artifact_and_grounded_prompt(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    memory = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    item = memory.add(
        workspace_id="ws1",
        memory_type="口径",
        title="登录页只在远程 4xx 形态出现",
        content="登录页只在远程 4xx 形态出现",
        source="crew",
        scope="project",
        project_id=project_id,
    )
    model = _TextModel("# PRD\n登录页目标与三态")
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
        memory_store=memory,
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "succeeded"
    assert result.applied_signal_ids == []
    assert any(event_type == "execution.frame" for event_type, _ in result.events)
    artifact_events = [
        payload for event_type, payload in result.events
        if event_type == "crew.task.artifact_produced"
    ]
    assert artifact_events and artifact_events[-1]["artifact"] == "# PRD\n登录页目标与三态"
    assert artifact_events[-1]["memory_hits"] == [item.id]

    prompt = next(m["content"] for m in model.requests[0].messages if m["role"] == "user")
    assert prompt.startswith("项目目标：登录页重设计")
    assert "触发频道指令：\n@Scribe 请起草 PRD" in prompt
    assert "上游产物·需求简报：" in prompt
    assert "需求简报正文:重做登录页三态" in prompt
    assert "项目共识：\n1. [口径] 登录页只在远程 4xx 形态出现" in prompt


def test_query_engine_adapter_ask_human_suspends_with_question_checkpoint(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    ask = ModelToolCall(
        id="ask_1",
        name="crew.ask_human",
        arguments={"question": "目标用户是哪一类?", "target": "acc_boss"},
    )
    model = FakeStreamModel(
        [[ModelChunk(kind="final", tool_calls=(ask,), finish_reason="tool_calls")]]
    )
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "awaiting_signal"
    assert result.applied_signal_ids == []
    assert result.checkpoint["kind"] == "crew.worker.awaiting_input.v1"
    assert result.checkpoint["tool_call_id"] == "ask_1"
    assert result.checkpoint["question"] == "目标用户是哪一类?"
    question_events = [
        payload for event_type, payload in result.events
        if event_type == "crew.worker.question"
    ]
    assert question_events and question_events[-1]["target"] == "acc_boss"
    frames = [payload for event_type, payload in result.events if event_type == "execution.frame"]
    assert frames[-1]["reason"] == "awaiting_input"
    assert frames[-1]["question"] == "目标用户是哪一类?"


def test_query_engine_adapter_answer_resumes_from_checkpoint_and_acks_answer(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    ask = ModelToolCall(
        id="ask_1",
        name="crew.ask_human",
        arguments={"question": "目标用户是哪一类?", "target": "acc_boss"},
    )
    model = FakeStreamModel(
        [
            [ModelChunk(kind="final", tool_calls=(ask,), finish_reason="tool_calls")],
            [ModelChunk(kind="text_delta", text="# PRD\n面向新用户"), ModelChunk(kind="final")],
        ]
    )
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )
    snapshot = _snapshot(project_id=project_id, task_id=prd_id)
    awaiting = asyncio.run(adapter.run(snapshot, []))
    resumed_snapshot = snapshot.__class__(
        **{**snapshot.__dict__, "checkpoint": awaiting.checkpoint}
    )

    result = asyncio.run(
        adapter.run(resumed_snapshot, [_signal("sig-answer", "answer", "面向新注册用户")])
    )

    assert result.status == "succeeded"
    assert result.applied_signal_ids == ["sig-answer"]
    assert result.checkpoint["kind"] == "crew.worker.completed.v1"
    artifact_events = [
        payload for event_type, payload in result.events
        if event_type == "crew.task.artifact_produced"
    ]
    assert artifact_events[-1]["artifact"] == "# PRD\n面向新用户"
    resume_request = model.requests[1]
    assert resume_request.messages[-1]["role"] == "tool"
    assert resume_request.messages[-1]["tool_call_id"] == "ask_1"
    assert "面向新注册用户" in resume_request.messages[-1]["content"]


def test_query_engine_adapter_ask_human_must_be_single_tool_call(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    ask = ModelToolCall(
        id="ask_1",
        name="crew.ask_human",
        arguments={"question": "目标用户是哪一类?"},
    )
    extra = ModelToolCall(
        id="extra_1",
        name="crew.unknown_tool",
        arguments={},
    )
    model = FakeStreamModel(
        [[ModelChunk(kind="final", tool_calls=(ask, extra), finish_reason="tool_calls")]]
    )
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "failed"
    assert result.last_error_code == "ask_human_must_be_single"
    assert result.checkpoint == {}
    assert not any(event_type == "crew.worker.question" for event_type, _ in result.events)


def test_query_engine_adapter_model_error_blocks(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    model = FakeStreamModel(
        [[ModelChunk(kind="error", error_code="model_failed", message="boom")]]
    )
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "failed"
    assert result.last_error_code == "model_failed"
    blocked = [payload for event_type, payload in result.events if event_type == "crew.task.agent_blocked"]
    assert blocked and blocked[-1]["reason"] == "boom"


def test_query_engine_adapter_exhausted_blocks(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    scripts = [
        [ModelChunk(kind="text_delta", text="draft"), ModelChunk(kind="final")]
        for _ in range(8)
    ]
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=FakeStreamModel(scripts)),
        handler_resolver=_NudgingResolver(),
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "failed"
    assert result.last_error_code == "agent_exhausted"
    assert any(
        event_type == "crew.task.agent_blocked"
        and payload["error_code"] == "agent_exhausted"
        for event_type, payload in result.events
    )


def test_query_engine_adapter_empty_result_blocks(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=_TextModel("   ")),
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "failed"
    assert result.last_error_code == "empty_artifact"


def test_query_engine_adapter_advanced_task_without_signals_skips_calmly(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    crew = CrewService(crew_store)
    crew.start(project_id, prd_id)
    crew.submit(project_id, prd_id, "PRD v1")
    model = _TextModel()
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )

    result = asyncio.run(adapter.run(_snapshot(project_id=project_id, task_id=prd_id), []))

    assert result.status == "succeeded"
    assert result.applied_signal_ids == []
    assert not model.requests
    assert not any(event_type == "crew.task.artifact_produced" for event_type, _ in result.events)
    assert not any(event_type == "crew.task.agent_blocked" for event_type, _ in result.events)
    assert result.state["crew"]["skipped"] is True


def test_query_engine_adapter_advanced_task_with_signal_waits_without_ack(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    crew = CrewService(crew_store)
    crew.start(project_id, prd_id)
    crew.submit(project_id, prd_id, "PRD v1")
    model = _TextModel()
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )

    result = asyncio.run(
        adapter.run(
            _snapshot(project_id=project_id, task_id=prd_id),
            [_signal("sig-late-steer", "steer", "太晚了")],
        )
    )

    assert result.status == "awaiting_signal"
    assert result.applied_signal_ids == []
    assert not model.requests
    assert not any(event_type == "crew.task.artifact_produced" for event_type, _ in result.events)
    assert not any(event_type == "crew.task.agent_blocked" for event_type, _ in result.events)
    frames = [payload for event_type, payload in result.events if event_type == "execution.frame"]
    assert frames and frames[-1]["reason"] == "signal_not_applicable"
    assert frames[-1]["detail"] == "task_already_advanced"


def test_query_engine_adapter_invalid_provenance_and_assignee_block(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    adapter = QueryEngineLoopAdapter(crew_store=crew_store, settings=_CONFIGURED)

    bad_provenance = _snapshot(project_id=project_id, task_id=prd_id)
    bad_provenance = bad_provenance.__class__(
        **{**bad_provenance.__dict__, "workspace_id": "wrong-ws"}
    )
    provenance_result = asyncio.run(adapter.run(bad_provenance, []))

    bad_prefix = _snapshot(
        project_id=project_id,
        task_id=prd_id,
        worker_profile_ref="worker:acc_agent_scribe",
    )
    bad_prefix_result = asyncio.run(adapter.run(bad_prefix, []))

    bad_assignee = _snapshot(
        project_id=project_id,
        task_id=prd_id,
        worker_profile_ref="member:acc_agent_design",
    )
    assignee_result = asyncio.run(adapter.run(bad_assignee, []))

    assert provenance_result.status == "failed"
    assert provenance_result.last_error_code == "invalid_provenance"
    assert bad_prefix_result.status == "failed"
    assert bad_prefix_result.last_error_code == "invalid_assignee"
    assert assignee_result.status == "failed"
    assert assignee_result.last_error_code == "invalid_assignee"


def test_query_engine_adapter_accepts_legacy_raw_worker_profile_ref(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=_TextModel("# PRD\nlegacy")),
    )

    result = asyncio.run(
        adapter.run(
            _snapshot(
                project_id=project_id,
                task_id=prd_id,
                worker_profile_ref="acc_agent_scribe",
            ),
            [],
        )
    )

    assert result.status == "succeeded"


def test_query_engine_adapter_stream_exception_blocks_and_acks_applied_steer(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    stream = _RaisingStream()
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=stream),
    )

    result = asyncio.run(
        adapter.run(
            _snapshot(project_id=project_id, task_id=prd_id),
            [_signal("sig-steer", "steer", "补充错误态")],
        )
    )

    assert result.status == "failed"
    assert result.last_error_code == "crew_adapter_error"
    assert result.applied_signal_ids == ["sig-steer"]
    blocked = [
        payload for event_type, payload in result.events
        if event_type == "crew.task.agent_blocked"
    ]
    assert blocked and blocked[-1]["reason"] == "stream exploded"
    assert blocked[-1]["error_code"] == "crew_adapter_error"


def test_query_engine_adapter_steer_is_applied_but_answer_is_not_acknowledged(tmp_path):
    crew_store, project_id, prd_id = _service_with_prd_ready(tmp_path)
    model = _TextModel("# PRD\nv2")
    adapter = QueryEngineLoopAdapter(
        crew_store=crew_store,
        settings=_CONFIGURED,
        deps=QueryDeps(stream_model=model),
    )
    snapshot = _snapshot(project_id=project_id, task_id=prd_id)

    awaiting = asyncio.run(
        adapter.run(
            snapshot,
            [
                _signal("sig-answer", "answer", "答案"),
                _signal("sig-approval", "approval", "同意"),
            ],
        )
    )
    assert awaiting.status == "awaiting_signal"
    assert awaiting.applied_signal_ids == []
    assert not model.requests

    steered = asyncio.run(adapter.run(snapshot, [_signal("sig-steer", "steer", "补充错误态")]))
    assert steered.status == "succeeded"
    assert steered.applied_signal_ids == ["sig-steer"]
    prompt = next(m["content"] for m in model.requests[0].messages if m["role"] == "user")
    assert "运行中补充指令（按时间顺序）：\n1. 补充错误态" in prompt
