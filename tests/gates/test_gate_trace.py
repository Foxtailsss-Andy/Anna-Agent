"""Trace 轮 gate —— 装配器契约:配对、层级、非负耗时、gen_ai 命名、零丢失。RED 先行。"""
from services.runtime.app.trace_assembler import assemble_trace


def _row(frame: dict, created_at: str = "2026-08-05 09:00:00") -> dict:
    return {"frame": frame, "created_at": created_at}


def _event(ev_type: str, payload: dict, created_at: str) -> dict:
    return {"type": "event", "event": {"type": ev_type, "run_id": "r1", "payload": payload, "created_at": created_at}}


def _fixture_rows() -> list[dict]:
    t = "2026-08-05T09:00:{:02d}+00:00"
    return [
        _row({"type": "step", "phase": "analyze", "intent": "正在思考", "tool": None, "turn": 1}),
        _row(_event("model.call.started", {"model_name": "deepseek-chat", "context_token_count": 900,
                                           "context_window": 65536, "context_percent_left": 98.6}, t.format(0))),
        _row({"type": "text_delta", "text": "好"}),
        _row({"type": "text_delta", "text": "的"}),
        _row(_event("model.call.completed", {"finish_reason": "tool_calls", "tool_call_count": 1,
                                             "requested_tool_names": ["erp.finance.query"],
                                             "input_tokens": 900, "output_tokens": 40}, t.format(3))),
        _row({"type": "step", "phase": "tool", "intent": "正在查询 ERP 财务数据", "tool": "erp.finance.query", "turn": 1}),
        _row({"type": "tool_start", "name": "erp.finance.query"}, "2026-08-05 09:00:04"),
        _row(_event("context.compaction.applied", {"tokens_freed": 0}, t.format(4))),
        _row({"type": "tool_done", "name": "erp.finance.query"}, "2026-08-05 09:00:06"),
        _row({"type": "interjection.queued", "text": "顺便看下Q2"}),          # 未知帧 → 零丢失
        _row({"type": "step", "phase": "analyze", "intent": "正在思考", "tool": None, "turn": 2}),
        _row(_event("model.call.started", {"model_name": "deepseek-chat", "context_token_count": 1100,
                                           "context_window": 65536, "context_percent_left": 98.3}, t.format(7))),
        _row(_event("model.call.completed", {"finish_reason": "stop", "tool_call_count": 0,
                                             "requested_tool_names": []}, t.format(9))),
        _row({"type": "step", "phase": "deliver", "intent": "正在组织回答", "tool": None, "turn": 2}),
        _row({"type": "done", "turns": 2}, "2026-08-05 09:00:10"),
    ]


def _by_kind(doc: dict, kind: str) -> list[dict]:
    return [s for s in doc["spans"] if s["kind"] == kind]


def test_gate_span_tree_shape_and_pairing():
    doc = assemble_trace("r1", "chat", _fixture_rows())
    assert doc["trace_id"] == "r1" and doc["surface"] == "chat"
    agent, turns = _by_kind(doc, "agent"), _by_kind(doc, "turn")
    infer, tools = _by_kind(doc, "inference"), _by_kind(doc, "tool")
    assert len(agent) == 1 and len(turns) == 2 and len(infer) == 2 and len(tools) == 1
    ids = {s["span_id"] for s in doc["spans"]}
    assert all(s["parent_span_id"] in ids for s in doc["spans"] if s["parent_span_id"])
    assert all(s["end_time"] is not None for s in infer + tools)          # 配对无孤儿


def test_gate_durations_nonnegative_and_status():
    doc = assemble_trace("r1", "chat", _fixture_rows())
    assert all(s["duration_ms"] >= 0 for s in doc["spans"])
    assert _by_kind(doc, "agent")[0]["status"] == "ok"
    assert _by_kind(doc, "agent")[0]["attributes"]["anna.turns"] == 2


def test_gate_gen_ai_naming():
    doc = assemble_trace("r1", "chat", _fixture_rows())
    first = _by_kind(doc, "inference")[0]
    assert first["name"] == "chat deepseek-chat"
    assert first["attributes"]["gen_ai.operation.name"] == "chat"
    assert first["attributes"]["gen_ai.request.model"] == "deepseek-chat"
    assert first["attributes"]["gen_ai.usage.input_tokens"] == 900
    assert first["attributes"]["anna.text_delta_count"] == 2
    second = _by_kind(doc, "inference")[1]
    assert "gen_ai.usage.input_tokens" not in second["attributes"]        # 诚实规则:没报就没有
    tool = _by_kind(doc, "tool")[0]
    assert tool["name"] == "execute_tool erp.finance.query"
    assert tool["attributes"]["gen_ai.tool.name"] == "erp.finance.query"
    assert tool["attributes"]["anna.step.intent"] == "正在查询 ERP 财务数据"


def test_gate_conversation_id_prefers_thread():
    """Q6:conversation=会话(thread),多 run 一线;无 thread 回落 run_id。"""
    doc = assemble_trace("r1", "chat", _fixture_rows(), conversation_id="thread_9")
    assert _by_kind(doc, "agent")[0]["attributes"]["gen_ai.conversation.id"] == "thread_9"
    assert doc["trace_id"] == "r1"
    fallback = assemble_trace("r1", "chat", _fixture_rows())
    assert _by_kind(fallback, "agent")[0]["attributes"]["gen_ai.conversation.id"] == "r1"


def test_gate_unknown_frame_preserved_and_events_attached():
    doc = assemble_trace("r1", "chat", _fixture_rows())
    turn1 = _by_kind(doc, "turn")[0]
    names = [e["name"] for s in doc["spans"] for e in s["events"]]
    assert "frame.interjection.queued" in names                            # 零丢失
    assert "context.compaction.applied" in names
    assert any(e["name"] == "frame.done" for e in _by_kind(doc, "agent")[0]["events"])
    assert turn1["status"] == "ok"


def test_gate_orphaned_spans_closed_with_error():
    rows = _fixture_rows()[:4]                                             # started 后即断
    doc = assemble_trace("r1", "chat", rows)
    infer = _by_kind(doc, "inference")
    assert len(infer) == 1
    assert infer[0]["status"] == "error"
    assert infer[0]["attributes"]["anna.orphaned"] is True
    assert infer[0]["duration_ms"] >= 0


def test_gate_empty_rows():
    assert assemble_trace("r1", "chat", []) == {"trace_id": "r1", "surface": "chat", "spans": []}


def test_gate_production_terminal_shapes():
    """真实 chat 终局帧:done/error 都带嵌套 run 对象——error_code 在 run 里,
    turns 字段根本不存在(引擎终局被 orchestrator 吞掉重造)。"""
    rows = _fixture_rows()[:-1] + [
        _row({"type": "error", "run": {"error_code": "model_call_timeout", "status": "failed"}},
             "2026-08-05 09:00:10"),
    ]
    doc = assemble_trace("r1", "chat", rows)
    agent = _by_kind(doc, "agent")[0]
    assert agent["status"] == "error"
    assert agent["attributes"]["error.type"] == "model_call_timeout"


def test_gate_failed_tool_span_is_marked_error_not_ok():
    """F1b 诚实:F1 起工具错误回喂模型,loop 照常发 tool_done —— 若装配器只认
    tool_done,失败的调用会在瀑布里画成绿色 ok。审计事件 ``mcp.tool.called``
    (status=failed + error.error_code)恰落在 tool_start 与 tool_done 之间
    (watermark 在每个引擎帧前 flush),据此把该 span 判为 error 并写 error.type。"""
    rows = _fixture_rows()[:7] + [                                          # ...到 tool_start 为止
        _row(_event("mcp.tool.called", {
            "tool_name": "erp.finance.query", "input_hash": "h", "status": "failed",
            "error": {"error_code": "invalid_arguments",
                      "message": "period 参数非法(应为 YYYY-MM):None", "retryable": False},
        }, "2026-08-05T09:00:05+00:00")),
        _row({"type": "tool_done", "name": "erp.finance.query"}, "2026-08-05 09:00:06"),
    ] + _fixture_rows()[9:]
    doc = assemble_trace("r1", "chat", rows)
    tool = _by_kind(doc, "tool")[0]
    assert tool["status"] == "error"
    assert tool["attributes"]["error.type"] == "invalid_arguments"
    assert "anna.orphaned" not in tool["attributes"]                        # 配对成功,不是孤儿
    assert _by_kind(doc, "turn")[0]["status"] == "error"                    # 错误上浮到本回合
    names = [e["name"] for s in doc["spans"] for e in s["events"]]
    assert "mcp.tool.called" in names                                       # 零丢失照旧


def test_gate_successful_tool_span_stays_ok_after_failure_marking():
    """反向守卫:status=success 的审计事件绝不把正常工具 span 判成 error。"""
    rows = _fixture_rows()[:7] + [
        _row(_event("mcp.tool.called", {
            "tool_name": "erp.finance.query", "input_hash": "h", "status": "success",
        }, "2026-08-05T09:00:05+00:00")),
    ] + _fixture_rows()[8:]
    doc = assemble_trace("r1", "chat", rows)
    tool = _by_kind(doc, "tool")[0]
    assert tool["status"] == "ok"
    assert "error.type" not in tool["attributes"]


def test_gate_turns_derived_and_awaiting_status_survives():
    """anna.turns 从 turn span 数派生(不再依赖不存在的帧字段);
    awaiting_approval 的 root status=unset 不得被收尾 close 改写回 ok。"""
    done_shape = _fixture_rows()[:-1] + [
        _row({"type": "done", "run": {"status": "ready"}}, "2026-08-05 09:00:10"),
    ]
    doc = assemble_trace("r1", "chat", done_shape)
    assert _by_kind(doc, "agent")[0]["attributes"]["anna.turns"] == 2

    awaiting = _fixture_rows()[:9] + [
        _row({"type": "awaiting_approval", "reason": "awaiting_approval"}, "2026-08-05 09:00:07"),
    ]
    doc2 = assemble_trace("r1", "chat", awaiting)
    assert _by_kind(doc2, "agent")[0]["status"] == "unset"
