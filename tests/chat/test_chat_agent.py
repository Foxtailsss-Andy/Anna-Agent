"""Chat drives the platform QueryEngine without business-system connector tools.

Chat is now the general-assistant surface. These tests drive the engine through the shared fake
``stream_model`` seam (``tests.support.engine_fakes.FakeStreamModel``, injected
via ``QueryEngine(deps=QueryDeps(stream_model=fake))``) and cover both the
preserved non-tool behavior (status machine, ``chat.response.generated``,
save_result/memory, associate_goal, empty-response fail, template handling) plus
the fail-closed tool guard.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import threading
import time
from pathlib import Path

from services.chat.app.capability import ChatCapabilityHandler, current_time_fact
from services.chat.app.orchestrator import (
    MAX_CHAT_MODEL_TOOL_ROUNDS,
    ChatOrchestrator,
)
from services.chat.app.schemas import ChatRun
from services.memory.app.store import BusinessMemoryStore
from services.reimbursement.app.audit import AuditService
from services.runtime.app.chat_tool_registry import ChatToolRegistry
from services.runtime.app.config import RuntimeSettings
from services.runtime.app.engine.capability import CapabilityError
from services.runtime.app.engine.capability import ModelChunk
from services.runtime.app.engine.query_deps import QueryDeps
from services.runtime.app.engine.query_engine import QueryEngine
from services.runtime.app.model_provider import ModelToolCall
from services.runtime.app.skill_loader import LoadedSkill, SkillLoader
from tests.support.engine_fakes import FakeStreamModel


_CONFIGURED_SETTINGS = RuntimeSettings(
    model_endpoint="https://model.example/v1/chat/completions",
    model_api_key="model-key",
)


class ForbiddenBusinessGateway:
    """A guard double proving Chat never reaches a business-system connector."""

    def __init__(self):
        self.calls = []

    def status(self):
        raise AssertionError("Chat must not preflight a business connector")

    def call_tool(self, tool_name, arguments):
        self.calls.append((tool_name, arguments))
        raise AssertionError("Chat must not call a business connector")


def _engine(stream_model) -> QueryEngine:
    return QueryEngine(
        settings=_CONFIGURED_SETTINGS, deps=QueryDeps(stream_model=stream_model)
    )


def _text_answer_stream(text: str = "已整理为三条行动建议。") -> FakeStreamModel:
    """Model answers directly with text, no tool call — the pure-text path."""
    return FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text=text),
                ModelChunk("final", finish_reason="stop"),
            ]
        ]
    )


def _tool_then_answer_stream() -> FakeStreamModel:
    return FakeStreamModel(
        [
            # round 1: model attempts a former business-system tool.
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_q",
                            name="erp.finance.query",
                            arguments={"question": "本月营收多少？"},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
            # round 2: answer from the observation.
            [
                ModelChunk("text_delta", text="本月营收 320 万，同比增长 12%。"),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )


def _orchestrator(
    *, stream, gateway=None, memory_store=None, settings=None
) -> ChatOrchestrator:
    settings = settings or _CONFIGURED_SETTINGS
    if gateway is not None:
        gateway.calls.clear()
    return ChatOrchestrator(
        engine=_engine(stream),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=settings,
        memory_store=memory_store,
    )


# --- preserved: pure-text run, status machine, audit trail ---------------------


def test_chat_run_loads_skill_and_answers_from_text(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    orchestrator = _orchestrator(
        stream=_text_answer_stream(), memory_store=memory_store
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="请总结这段经营复盘纪要。",
        template_id="summarize",
    )

    assert run.status == "ready"
    assert run.assistant_message == "已整理为三条行动建议。"
    assert run.associate_goal_text is None
    assert run.template_id == "summarize"
    assert [event.type for event in run.audit_events] == [
        "chat.run.created",
        "skill.loaded",
        "model.call.started",
        "model.call.completed",
        "chat.response.generated",
    ]


def test_chat_run_fails_without_model_config():
    orchestrator = ChatOrchestrator(
        engine=QueryEngine(
            settings=RuntimeSettings(),
            deps=QueryDeps(stream_model=_text_answer_stream()),
        ),
        skill_loader=SkillLoader(project_root=Path.cwd()),
        settings=RuntimeSettings(),
    )

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="写一段周报",
        template_id=None,
    )

    assert run.status == "failed"
    assert run.error_code == "model_not_configured"
    assert run.assistant_message is None
    # Preflight failed before the engine ran — no model call.
    assert [event.type for event in run.audit_events] == [
        "chat.run.created",
        "skill.loaded",
        "chat.run.failed",
    ]


def test_chat_run_does_not_preflight_business_connector():
    gateway = ForbiddenBusinessGateway()
    orchestrator = _orchestrator(
        stream=_text_answer_stream(), gateway=gateway
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="本月营收多少？",
        template_id=None,
    )

    assert run.status == "ready"
    assert run.error_code is None
    assert run.assistant_message == "已整理为三条行动建议。"
    assert gateway.calls == []


def test_chat_empty_response_fails_run():
    orchestrator = _orchestrator(
        stream=FakeStreamModel([[ModelChunk("final", finish_reason="stop")]])
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="随便说点什么",
        template_id=None,
    )

    assert run.status == "failed"
    assert run.error_code == "chat_response_empty"
    assert run.assistant_message is None
    assert run.audit_events[-1].type == "chat.run.failed"


def test_chat_rejects_erp_finance_query_without_calling_connector():
    gateway = ForbiddenBusinessGateway()
    orchestrator = _orchestrator(stream=_tool_then_answer_stream(), gateway=gateway)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="本月营收多少？",
        template_id="analyze",
    )

    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"
    assert gateway.calls == []


def test_chat_tool_not_allowed_fails_closed():
    """The model tries a non-allowed tool → fail-closed tool_not_allowed."""

    stream = FakeStreamModel(
        [
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_bad",
                            name="erp.finance.get_dashboard_snapshot",
                            arguments={"period": "2026-06"},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
        ]
    )
    gateway = ForbiddenBusinessGateway()
    orchestrator = _orchestrator(stream=stream, gateway=gateway)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="给我看看仪表盘",
        template_id=None,
    )

    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"
    # Fail-closed: the disallowed tool never reached the connector.
    assert gateway.calls == []
    assert run.audit_events[-1].type == "chat.run.failed"


def test_chat_repeated_disallowed_business_tool_fails_closed_immediately():
    tool_round = [
        ModelChunk(
            "final",
            tool_calls=(
                ModelToolCall(
                    id="call_q",
                    name="erp.finance.query",
                    arguments={"question": "本月营收多少？"},
                ),
            ),
            finish_reason="tool_calls",
        ),
    ]
    stream = FakeStreamModel(
        [list(tool_round) for _ in range(MAX_CHAT_MODEL_TOOL_ROUNDS + 1)]
    )
    orchestrator = _orchestrator(stream=stream)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="本月营收多少？",
        template_id=None,
    )

    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"
    event_types = [event.type for event in run.audit_events]
    assert "chat.run.failed" in event_types
    assert "run.suspended" not in event_types


# --- preserved: memory save, idempotency, associate_goal, templates ------------


def test_chat_save_result_persists_answer_to_business_memory(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    orchestrator = _orchestrator(
        stream=_text_answer_stream(), memory_store=memory_store
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我生成一个任务计划",
        template_id="task_plan",
    )

    saved = orchestrator.save_result(run.id, saved_by="u_demo")

    assert saved.saved_memory_id
    memories = memory_store.list_items("demo")
    assert len(memories) == 1
    assert memories[0].memory_type == "chat_result"
    assert memories[0].title == "Chat: task_plan"
    assert "已整理为三条行动建议" in memories[0].content
    assert run.audit_events[-1].type == "chat.result.saved"


def test_chat_save_result_is_idempotent_for_concurrent_saves(tmp_path):
    class SlowBusinessMemoryStore(BusinessMemoryStore):
        def __init__(self, db_path):
            super().__init__(db_path)
            self.active_adds = 0
            self.add_calls = 0
            self.max_concurrent_adds = 0
            self._active_lock = threading.Lock()

        def add(self, *args, **kwargs):
            with self._active_lock:
                self.add_calls += 1
                self.active_adds += 1
                self.max_concurrent_adds = max(
                    self.max_concurrent_adds,
                    self.active_adds,
                )
            try:
                time.sleep(0.05)
                return super().add(*args, **kwargs)
            finally:
                with self._active_lock:
                    self.active_adds -= 1

    memory_store = SlowBusinessMemoryStore(tmp_path / "memory.sqlite3")
    orchestrator = _orchestrator(
        stream=_text_answer_stream(), memory_store=memory_store
    )
    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="帮我生成一个任务计划",
        template_id="task_plan",
    )

    start = threading.Barrier(3)

    def save_from_thread():
        start.wait(timeout=5)
        return orchestrator.save_result(run.id, saved_by="u_demo")

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(save_from_thread), executor.submit(save_from_thread)]
        start.wait(timeout=5)
        saved_runs = [future.result() for future in futures]

    assert saved_runs[0].saved_memory_id == saved_runs[1].saved_memory_id
    assert memory_store.add_calls == 1
    assert memory_store.max_concurrent_adds == 1
    assert len(memory_store.list_items("demo")) == 1


def test_chat_associate_goal_text_only_comes_from_associate_goal_template(tmp_path):
    memory_store = BusinessMemoryStore(tmp_path / "memory.sqlite3")
    # Two runs need two model turns; give the shared orchestrator a stream with
    # a fresh script per run.
    stream = FakeStreamModel(
        [
            [
                ModelChunk("text_delta", text="已整理为三条行动建议。"),
                ModelChunk("final", finish_reason="stop"),
            ],
            [
                ModelChunk("text_delta", text="目标：三个月内..."),
                ModelChunk("final", finish_reason="stop"),
            ],
        ]
    )
    orchestrator = _orchestrator(stream=stream, memory_store=memory_store)

    summary_run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="请总结这段经营复盘纪要。",
        template_id="summarize",
    )
    goal_run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="请把这个目标交给 Associate。",
        template_id="associate_goal",
    )

    assert summary_run.associate_goal_text is None
    assert goal_run.associate_goal_text == goal_run.assistant_message


def test_chat_prompt_templates_cover_prd_p0():
    templates = ChatOrchestrator().prompt_templates()

    assert [template.id for template in templates] == [
        "summarize",
        "analyze",
        "task_plan",
        "associate_goal",
    ]


# --- F2 当前日期注入:模型必须知道今天几号 ---------------------------------------
#
# 评测 v0 的 G2 根因:用户问「上个月」,模型答 2025-11(真实当日是 2026-08-06)——
# system prompt 里根本没有时间事实,模型只能拿训练期猜。


def test_current_time_fact_is_code_generated_and_exact():
    """时间事实是纯代码生成(ADR-002),分钟粒度 + UTC 偏移(locale 无关)。"""
    stamp = datetime(2026, 8, 6, 15, 42, tzinfo=timezone(timedelta(hours=8)))

    fact = current_time_fact(stamp)

    assert fact.startswith("现在是 2026-08-06 15:42（本机时区 UTC+08:00）。")
    assert "以此换算" in fact
    # 负偏移与零偏移同样如实。
    west = current_time_fact(
        datetime(2026, 1, 2, 3, 4, tzinfo=timezone(timedelta(hours=-5)))
    )
    assert west.startswith("现在是 2026-01-02 03:04（本机时区 UTC-05:00）。")


def test_chat_system_prompt_carries_todays_date():
    stream = _text_answer_stream()
    orchestrator = _orchestrator(stream=stream)

    orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="上个月生意咋样?",
        template_id=None,
    )

    system_content = stream.requests[0].messages[0]["content"]
    assert system_content  # the system message is still first
    # 真实本机时间,不是硬编码常量。
    assert datetime.now().astimezone().strftime("%Y-%m-%d") in system_content
    assert "以此换算" in system_content


# --- F1 工具错误回喂:模型能自纠的内部工具输入错误不杀 run -------------------------


def _chat_handler() -> ChatCapabilityHandler:
    """A minimal chat handler for direct dispatch tests."""
    audit = AuditService()
    run = ChatRun(
        id="chat_run_test",
        workspace_id="demo",
        actor_user_id="u_demo",
        message="查一下应付账款最大的供应商",
        thread_id="chat_run_test",
        status="generating",
    )
    return ChatCapabilityHandler(
        skill=LoadedSkill(
            id="chat",
            name="Chat",
            version="1",
            path=Path("skills/chat/SKILL.md"),
            content="",
            content_hash="h",
            allowed_tools=[],
            forbidden_tools=[],
            frontmatter={},
        ),
        run=run,
        tool_registry=ChatToolRegistry(),
        audit=audit,
        hash_payload=lambda payload: "h",
        chat_skill_id="chat",
        template_label="通用对话",
        template_instruction="直接回答用户问题。",
    )


def test_chat_business_tool_error_is_a_permission_boundary():
    """Chat 不再包业务系统连接器错误；业务工具直接被能力边界拒绝。"""
    handler = _chat_handler()

    try:
        handler.dispatch_tool(
            ModelToolCall(
                id="call_bad",
                name="erp.finance.query",
                arguments={"question": "应付最大的供应商?"},
            )
        )
    except CapabilityError as exc:
        assert exc.error_code == "tool_not_allowed"
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("erp.finance.query must be rejected by Chat")

    assert handler.run.audit_events == []
    assert handler.run.status == "generating"
    assert handler.run.error_code is None


def test_chat_artifact_invalid_becomes_an_observation_not_a_fatal_error():
    """同族:emit 工具的空 title/content 是模型可自愈的输入错误 → 观察化。"""
    handler = _chat_handler()

    observation = handler.dispatch_tool(
        ModelToolCall(id="call_doc", name="chat.emit_document", arguments={"title": "", "markdown": "正文"})
    )

    payload = json.loads(observation["content"])
    assert payload["error"] == "artifact_invalid"
    assert payload["hint"]
    assert handler.run.artifacts == []
    assert handler.run.status == "generating"


def test_chat_business_tool_retry_is_not_allowed():
    """整链:模型尝试旧业务工具时立即 fail closed，不给重试伪连接器。"""

    gateway = ForbiddenBusinessGateway()
    stream = FakeStreamModel(
        [
            # round 1: the model attempts a former business-system tool.
            [
                ModelChunk(
                    "final",
                    tool_calls=(
                        ModelToolCall(
                            id="call_1",
                            name="erp.finance.query",
                            arguments={"question": "应付账款最大的供应商?"},
                        ),
                    ),
                    finish_reason="tool_calls",
                ),
            ],
        ]
    )
    orchestrator = _orchestrator(stream=stream, gateway=gateway)

    run = orchestrator.start_run(
        workspace_id="demo",
        actor_user_id="u_demo",
        message="应付账款金额最大的供应商是谁?",
        template_id=None,
    )

    assert run.status == "failed"
    assert run.error_code == "tool_not_allowed"
    assert gateway.calls == []
    assert [e.type for e in run.audit_events][-1] == "chat.run.failed"
