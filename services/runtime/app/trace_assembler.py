"""Trace 装配器(Trace 轮 T1)—— journal 帧流 → OTel 形状 span 树,纯读、确定性。

输入 = ``RunStore.list_frames_with_meta`` 的行(帧 JSON + 行级 created_at);
输出 = §4 TraceDoc。规则见 00-plan §5:step(analyze) 开 turn,model.call.*
配对成 inference span,tool_start/done 配对成 execute_tool span,其余 audit
事件与未知帧一律作 span event 挂最近的容器(零丢失)。命名遵循 OTel GenAI
semantic conventions(gen_ai.*),Anna 私有属性用 anna.* 前缀。ADR-002:所有
标签均为代码生成,不含模型散文。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

_SCALAR = (str, int, float, bool)


@dataclass
class _Span:
    span_id: str
    parent_span_id: str | None
    name: str
    kind: str
    start: datetime
    end: datetime | None = None
    status: str = "unset"
    attributes: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)


def _parse_ts(value: Any) -> datetime | None:
    """SQLite 'YYYY-MM-DD HH:MM:SS'(naive UTC)与 ISO8601(可带时区)都吃,
    一律归一为 naive UTC。两个时间源(journal 行 / audit 事件)混用,不归一
    会在 span 减法处直接 TypeError(offset-naive vs offset-aware)。失败回 None。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone(UTC).replace(tzinfo=None)


def _row_ts(row: dict[str, Any], fallback: datetime) -> datetime:
    """时间取值优先级:帧内 ts(Task 6 起) → 事件 created_at → 行 created_at → 上一时刻。"""
    frame = row.get("frame") or {}
    for candidate in (frame.get("ts"), (frame.get("event") or {}).get("created_at") if isinstance(frame.get("event"), dict) else None, row.get("created_at")):
        ts = _parse_ts(candidate)
        if ts is not None:
            return ts
    return fallback


def assemble_trace(
    run_id: str,
    surface: str,
    rows: list[dict[str, Any]],
    *,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """conversation_id = 会话标识(Q6):传 Anna 的 thread_id——一个 thread 多个 run,
    正合 OTel semconv 的 conversation 语义;无 thread 回落 run_id。trace_id 恒=run_id。"""
    if not rows:
        return {"trace_id": run_id, "surface": surface, "spans": []}

    spans: list[_Span] = []

    def new_span(parent: _Span | None, name: str, kind: str, start: datetime) -> _Span:
        span = _Span(f"s{len(spans) + 1}", parent.span_id if parent else None, name, kind, start)
        spans.append(span)
        return span

    epoch = _parse_ts(rows[0].get("created_at")) or datetime(1970, 1, 1)
    now = _row_ts(rows[0], epoch)
    root = new_span(None, f"invoke_agent {surface}", "agent", now)
    root.attributes = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": f"anna.{surface}",
        "gen_ai.conversation.id": conversation_id or run_id,
    }
    root.status = "ok"

    turn: _Span | None = None
    inference: _Span | None = None
    open_tools: list[_Span] = []
    pending_intent: tuple[str | None, str] | None = None  # (tool_name, intent)
    turn_count = 0

    def close(span: _Span | None, at: datetime, status: str | None = None) -> None:
        if span is not None and span.end is None:
            span.end = at
            if status is not None or span.status == "unset":
                span.status = status or "ok"

    def open_turn(at: datetime) -> _Span:
        nonlocal turn, inference, turn_count
        if inference is not None and inference.end is None:
            # started 没等到 completed 就换轮:诚实标孤儿,绝不默算 ok(诚实规则)
            inference.attributes["anna.orphaned"] = True
            close(inference, at, "error")
        inference = None
        close(turn, at)
        turn_count += 1
        turn = new_span(root, f"turn {turn_count}", "turn", at)
        return turn

    def container() -> _Span:
        # 已闭合的 inference 不再收事件——否则回合级事件(评审/插话)会被错挂到
        # 上一次模型调用里;Q7 的 chip 归属也依赖 turn 层的正确性
        if inference is not None and inference.end is None:
            return inference
        return turn or root

    def mark_tool_failed(payload: dict[str, Any]) -> None:
        """F1b 诚实:把失败的工具调用标进它自己的 span,而不是画成绿色 ok。

        F1 起工具错误作为观察回喂模型(run 不再被一个笔误杀掉),于是 loop 照常发
        ``tool_done`` —— 只认帧的话,失败与成功在瀑布里长得一模一样。审计事件
        ``mcp.tool.called {status: failed, error: {error_code}}`` 恰好落在
        ``tool_start`` 与 ``tool_done`` 之间(watermark 在每个引擎帧前 flush),
        所以此刻 FIFO 首个未闭合 tool span 就是它;工具名对不上就不标(防跨工具
        错配,与 ``anna.step.intent`` 同一纪律)。状态在 tool_done 处保留(见下)。
        """
        if not open_tools:
            return
        span = open_tools[0]
        name = payload.get("tool_name")
        if isinstance(name, str) and name and span.attributes.get("gen_ai.tool.name") != name:
            return
        span.status = "error"
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("error_code"), str):
            span.attributes["error.type"] = error["error_code"]

    def add_event(target: _Span, name: str, at: datetime, attributes: dict[str, Any]) -> None:
        scalars = {k: v for k, v in attributes.items() if isinstance(v, _SCALAR)}  # 标量纪律统一在此把关,且不别名调用方 dict
        target.events.append({"name": name, "time": at.isoformat(), "attributes": scalars})

    for row in rows:
        frame = row.get("frame") or {}
        now = _row_ts(row, now)
        ftype = frame.get("type")

        if ftype == "step":
            phase = frame.get("phase")
            if phase == "analyze":
                open_turn(now)
            elif phase == "tool":
                pending_intent = (frame.get("tool"), str(frame.get("intent") or ""))
            else:  # deliver / compact / 未来相位:留痕不建 span
                add_event(container(), f"step.{phase or 'unknown'}", now, {"intent": frame.get("intent")})
        elif ftype == "event" and isinstance(frame.get("event"), dict):
            event = frame["event"]
            ev_type = str(event.get("type") or "event")
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if ev_type == "model.call.started":
                if turn is None or (inference is not None and inference.end is not None):
                    open_turn(now)  # 无 step 帧 surface 的兜底开 turn 规则
                inference = new_span(turn, f"chat {payload.get('model_name', '')}".strip(), "inference", now)
                inference.attributes["gen_ai.operation.name"] = "chat"
                if payload.get("model_name") is not None:
                    inference.attributes["gen_ai.request.model"] = payload["model_name"]
                for src, dst in (("context_token_count", "anna.context.token_count"),
                                 ("context_window", "anna.context.window"),
                                 ("context_percent_left", "anna.context.percent_left")):
                    if payload.get(src) is not None:
                        inference.attributes[dst] = payload[src]
            elif ev_type == "model.call.completed" and inference is not None:
                for src, dst in (("input_tokens", "gen_ai.usage.input_tokens"),
                                 ("output_tokens", "gen_ai.usage.output_tokens")):
                    if payload.get(src) is not None:
                        inference.attributes[dst] = payload[src]  # 诚实规则:没报就没有
                if payload.get("finish_reason"):
                    inference.attributes["gen_ai.response.finish_reasons"] = [payload["finish_reason"]]
                close(inference, now, "ok")
            elif ev_type == "model.call.failed" and inference is not None:
                if payload.get("error_code"):
                    inference.attributes["error.type"] = payload["error_code"]
                close(inference, now, "error")
            else:
                if ev_type == "mcp.tool.called" and payload.get("status") in ("failed", "error"):
                    mark_tool_failed(payload)
                add_event(container(), ev_type, now, payload)
        elif ftype == "text_delta":
            if inference is not None and inference.end is None:  # 已闭合的 inference 不再计 delta
                inference.attributes["anna.text_delta_count"] = (
                    int(inference.attributes.get("anna.text_delta_count", 0)) + 1
                )
        elif ftype == "tool_start":
            name = str(frame.get("name") or "")
            tool = new_span(turn or root, f"execute_tool {name}", "tool", now)
            tool.attributes = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name}
            if pending_intent is not None and pending_intent[1] and (pending_intent[0] is None or pending_intent[0] == name):
                tool.attributes["anna.step.intent"] = pending_intent[1]  # 名字对不上不挂:防跨工具错配
            pending_intent = None
            open_tools.append(tool)
        elif ftype == "tool_done":
            if open_tools:
                done = open_tools.pop(0)  # loop 串行派发,FIFO 配对
                close(done, now, "error" if done.status == "error" else "ok")  # F1b 的判错不被 tool_done 洗回 ok
            else:
                attributes = {k: v for k, v in frame.items() if k not in ("type", "seq", "ts") and isinstance(v, _SCALAR)}
                add_event(container(), "frame.tool_done", now, attributes)  # 无匹配 tool_start:零丢失兜底
        elif ftype in ("done", "error", "exhausted", "awaiting_approval"):
            attributes = {k: v for k, v in frame.items() if k not in ("type", "seq", "ts") and isinstance(v, _SCALAR)}
            add_event(root, f"frame.{ftype}", now, attributes)
            run_obj = frame.get("run")  # 生产真实终局帧:error_code 嵌套在 run 里,顶层字段不存在
            error_code = (
                frame.get("error_code") or (run_obj or {}).get("error_code")
                if isinstance(run_obj, dict) else frame.get("error_code")
            )
            if ftype == "error" and isinstance(error_code, str):
                root.attributes["error.type"] = error_code
            if ftype in ("error", "exhausted"):
                root.status = "error"
            if ftype == "awaiting_approval":
                root.status = "unset"
        else:  # 未知帧:零丢失,前向兼容
            attributes = {k: v for k, v in frame.items() if k not in ("type", "seq", "ts") and isinstance(v, _SCALAR)}
            add_event(container(), f"frame.{ftype}", now, attributes)

    # 收尾扫描:孤儿闭合留证,层级时间归拢
    root.attributes["anna.turns"] = turn_count  # 派生自 turn span 计数,不依赖(不存在的)帧字段
    for orphan in ([inference] if inference is not None and inference.end is None else []) + open_tools:
        orphan.attributes["anna.orphaned"] = True
        close(orphan, now, "error")
    close(turn, now)
    close(root, now, root.status)  # error/unset/ok 原样收尾,不被 close() 的 unset→ok 默认值打回
    for parent in spans:
        if parent.kind in ("turn", "agent"):
            child_ends = [s.end for s in spans if s.parent_span_id == parent.span_id and s.end is not None]
            if child_ends:
                parent.end = max([parent.end or parent.start, *child_ends])
            if any(s.status == "error" for s in spans if s.parent_span_id == parent.span_id) and parent.kind == "turn":
                parent.status = "error"

    def serialize(span: _Span) -> dict[str, Any]:
        end = span.end or span.start
        if end < span.start:
            end = span.start  # 时钟乱序兜底:end_time 不倒挂 start_time
        return {
            "span_id": span.span_id,
            "parent_span_id": span.parent_span_id,
            "name": span.name,
            "kind": span.kind,
            "start_time": span.start.isoformat(),
            "end_time": end.isoformat(),
            "duration_ms": max(0, int((end - span.start).total_seconds() * 1000)),
            "status": span.status,
            "attributes": span.attributes,
            "events": span.events,
        }

    return {"trace_id": run_id, "surface": surface, "spans": [serialize(s) for s in spans]}
