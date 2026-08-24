# Trace 轮（T1 装配器 + T2 瀑布图）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Anna 每次 run 的 journal + audit 双通道装配成 OpenTelemetry 形状的 span 树（`gen_ai.*` 命名），并在桌面端给出一个"执行过程 Trace"瀑布图——让"Anna 是怎么工作的"第一次可以被完整看见。

**Architecture:** 纯读装配器（`trace_assembler.py`）消费现有 `run_frames` 表（帧 JSON + `created_at` 列）与其中的 `{"type":"event"}` audit 帧，配对出 inference / execute_tool span；一条新 GET 路由输出 TraceDoc JSON；前端新增纯归约 `traceSpans.ts` + `TraceWaterfall` 组件，挂在 HomePage 运行详情处。**零写路径改动**（唯一例外是可选的 Task 6 帧 `ts` 附加字段）。

**Tech Stack:** Python stdlib（零新依赖）+ FastAPI 现有路由模式；前端 React + TS + vitest，复用 `lib/turns.ts` / crew `TraceLevels` 既有形态，不引入组件库。

## Global Constraints

- 术语只用本文件 §2 的定案表（OTel + `gen_ai.*`）；禁止自造词。
- 零新第三方依赖（后端 stdlib only；前端不加包）。
- 装配器**纯读、确定性**：不读墙钟（输出不含 generated_at 之类字段），同输入必同输出。
- 不改 `agent_loop.py` / `streaming_model.py` 的任何行为；Task 6 只在 `frame_journal.py` 加附加字段。
- 前端**设计克制条款**：本轮 FE 是工程页不是品牌面——复用 Iris 现有 drawer / tag / 等宽样式，不开新设计轮、不交 Claude Design；新 CSS 全部走 `var(--*, fallback)` 形式。
- 每个 Task：RED→GREEN→commit；轮末四门全绿（pytest / tsc / vitest / build）。
- **Commit 卫生**：每个 commit 只 stage 本 Task「Files」清单里的路径（逐个 `git add <path>`，**禁 `git add -A` / 慎 `-am`**——工作区常驻其他轮次的未跟踪文档，一律不碰不入库）。
- 中文注释与 UI 文案；禁 emoji（UI 面）。

---

## §1 目标与非目标

**为什么是这轮（runtime 实际效果为核心）**：Trace 是后续一切的地基——评测外环需要 scoreable trace；agent-facing telemetry（ADLC："giving agents the same observability they have in production"）需要同一份数据；重定位轮的每一步重构需要"手术台上有灯"。本轮产出对"Anna 更聪明"的贡献是间接但前置的：先能看见，才能优化。

**非目标（明确不做）**：
- 不做 OTLP 导出（T3 无限期后置）；
- 不做 live 流式瀑布图（v1 = 轮询 + 事后复盘；live 过程区已有）；
- 不接 crew / finance / create surface 的 trace 路由（装配器 surface 无关，路由 v1 只开 chat）；
- 不动 loop / 不加 recovery / 不做行动面（那是 Phase B/C 的活）。

## §2 术语定案表（规范，全仓引用此表）

| Anna 里的东西 | 规范术语 | 规范命名 |
|---|---|---|
| 一次 run | **Trace** | `trace_id` = run_id |
| run 里一轮 | **turn span** | 父子：agent → turn → 调用 |
| 一次模型调用 | **inference span** | `gen_ai.operation.name="chat"`、`gen_ai.request.model`、`gen_ai.usage.input_tokens/output_tokens` |
| 一次工具调用 | **execute_tool span** | `gen_ai.operation.name="execute_tool"`、`gen_ai.tool.name` |
| 整个 run 的根 | **agent span** | `gen_ai.operation.name="invoke_agent"`、`gen_ai.agent.name`、`gen_ai.conversation.id` |
| 压缩/排队/判断层瞬时事件 | **span event** | audit 事件原名（`context.compaction.applied` 等） |
| token/耗时/模型名 | **attribute** | `gen_ai.*` 优先；Anna 私有的用 `anna.*` 前缀 |
| 失败分类 | attribute | `error.type`（OTel 标准名）= error_code |

## §3 数据事实（装配器的输入，全部已核实）

1. `run_frames(surface, run_id, seq, frame, created_at)`，PK=(surface,run_id,seq)，`created_at=datetime('now')`（**秒粒度 UTC**）——[run_store.py:412-421](../../../services/runtime/app/run_store.py)。
2. `list_frames` 只回帧 JSON、**丢弃 created_at**（run_store.py:329-345）→ Task 1 补一个带 meta 的读法。
3. chat 的 journal 里**已经互相穿插**两类帧：过程帧（`step`/`tool_start`/`tool_done`/`text_delta`/`done`/`error`…来自 agent_loop.py）与 `{"type":"event","event":{type,run_id,payload,created_at}}` audit 帧（`AuditFrameWatermark` 冲刷，[event_stream.py:45-81](../../../services/runtime/app/event_stream.py)；chat orchestrator.py:420 装配）。前端今天忽略 event 帧（routes/chat.py:496 注释），本轮消费它。
4. audit 帧内层 `event.created_at` 是**单调 UTC**（audit.py:34），精度高于行级 created_at → 时间戳取值优先级：帧内 `ts`（Task 6 之后才有）→ `event.created_at` → 行 `created_at`。
5. `model.call.started` payload 含 `model_name / context_token_count / context_window / context_percent_left`（streaming_model.py:179-188）；`completed` 含 `finish_reason / tool_call_count / requested_tool_names` + 仅在 provider 真报时才有的 `input_tokens / output_tokens`（streaming_model.py:310-320，诚实规则：缺就不造 0）。
6. `step` 帧带 `phase("analyze"/"tool"/"deliver") / intent / tool / turn`（capability.py:144-152）；chat 定义了 `humanize_step`，所以 chat journal 必有 step 帧。
7. 续跑（L4a/J2）seq 跨段连续（run_store.py:347-362）——装配器天然吃多段。

## §4 TraceDoc JSON 契约（`GET /api/chat/runs/{run_id}/trace` 的响应）

```json
{
  "trace_id": "chat_run_007",
  "surface": "chat",
  "spans": [
    {
      "span_id": "s1",
      "parent_span_id": null,
      "name": "invoke_agent chat",
      "kind": "agent",
      "start_time": "2026-08-05T09:00:00+00:00",
      "end_time": "2026-08-05T09:00:19+00:00",
      "duration_ms": 19000,
      "status": "ok",
      "attributes": {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "anna.chat",
        "gen_ai.conversation.id": "chat_run_007",
        "anna.turns": 2
      },
      "events": [ { "name": "frame.done", "time": "...", "attributes": { "turns": 2 } } ]
    },
    { "span_id": "s2", "parent_span_id": "s1", "name": "turn 1", "kind": "turn", "...": "..." },
    { "span_id": "s3", "parent_span_id": "s2", "name": "chat deepseek-chat", "kind": "inference",
      "attributes": { "gen_ai.operation.name": "chat", "gen_ai.request.model": "deepseek-chat",
                      "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 80,
                      "anna.context.percent_left": 93.4, "anna.text_delta_count": 41 } },
    { "span_id": "s4", "parent_span_id": "s2", "name": "execute_tool erp.finance.query", "kind": "tool",
      "attributes": { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "erp.finance.query",
                      "anna.step.intent": "正在查询 ERP 财务数据" } }
  ]
}
```

规则：`status ∈ ok|error|unset`；`duration_ms ≥ 0`（时钟异常一律 clamp 0）；token 属性**只在 audit 里真有时出现**；spans 按开创顺序输出，`span_id = "s"+序号`。

**脱敏边界（三级下钻护栏①，显式声明）**：TraceDoc 只**重排已 journal 的数据**，不开新的敏感面——工具 args/结果原文本就不在过程帧里（`tool_start` 只带 name，agent_loop.py:315），本轮也不加；未来若要在 Trace 里露 args，必须走三级下钻既有的脱敏/预览通道，不得直通。鉴权与 frames 读取同门（`_assert_run_access`）。

## §5 装配规则（确定性状态机，走一遍 seq 升序的帧流）

1. **root**：首帧开 agent span；末帧时间收尾。`done` → status ok + `anna.turns`；`error` → status error + `error.type`；`exhausted` → status error + event；`awaiting_approval` → status unset + event。
2. **turn**：`step(phase=analyze)` 开新 turn（同时收掉上一个）；兜底——`model.call.started` 到来而无开着的 turn（或该 turn 已有闭合的 inference）也开新 turn（供无 step 帧的 surface 复用）。turn end = 其子 span 最大 end。
3. **inference**：`event(model.call.started)` 开（attrs 见 §3.5，context 三项记为 `anna.context.token_count/window/percent_left`）；`model.call.completed` 收（+usage/finish_reasons）；`model.call.failed` 收 status=error + `error.type`。`text_delta` 帧不建 span，只给开着的 inference 累加 `anna.text_delta_count`。
4. **tool**：`step(phase=tool)` 暂存 intent；`tool_start` 开 tool span（挂 intent 后清空）；`tool_done`（按开着的 tool 先进先出配对，loop 串行派发天然只有一个）收 status=ok。
5. **其余 audit 事件**（compaction/autocompact/run.queued/判断层事件…）：`model.*` 挂当前 inference，否则挂当前 turn，否则挂 root，作 span event（name=事件原名，attributes=payload）。
6. **未知帧类型**（interjection 等现在与将来的一切）：作 span event `frame.<type>` 挂当前 turn/root，attributes 取该帧的标量字段——**零丢失规则**，前向兼容。
7. **收尾扫描**：任何仍开着的 inference/tool → 在末帧时刻闭合，status=error + `anna.orphaned=true`（中途崩溃可视化）；开着的 turn 正常闭合。
8. 空帧列表 → `{"trace_id","surface","spans":[]}`。

## §6 前端规格（克制版）

- 入口：HomePage 运行详情（历史区）一枚"执行过程"按钮 → 右侧 drawer（复用现有 drawer 容器形态）。
- 结构三段：**L1 摘要条**（模型 · N 回合 · 总耗时 · tokens in/out · 结果）→ **瀑布区**（按 turn 分组，每 span 一行：左侧标签 = kind tag + 名称，右侧条形 offset/width 按时间比例，行尾 duration 与 token chip）→ 行点击展开 span 的 attributes/events（等宽降噪，同 crew `traceModel.l3Kind` 的 mono 语言）。
- 数据：`getRunTrace(runId)` 轮询 3s（照抄 `useRunFrames` 的轮询纪律，crew/inspect/useRunFrames.ts:10-46）；404/未上线 → 空态不造数。
- 复用不重造：类型 tag 文案沿用 `stepTypeTag`（思考/调用/生成/错误，traceModel.ts:16-27）；工具中文名沿用 `DEFAULT_TOOL_LABELS`（turns.ts:94-100）。
- **判断层 L2 可见（Q7）**：turn 分组头渲染**事件 chip**——已核实事件名走标签映射（`context.compaction.applied`→「压缩」、`context.autocompact.applied`→「压缩·摘要」、`run.queued`→「排队」、`run.evaluation.started`→「评审」），映射外的事件**原名直显**（标签映射允许、编造禁止，ADR-002）；chip 悬停 `title` = 事件原名；`step.*` 事件不做 chip（是相位不是治理）。

## §7 验收

- 新 gate：`tests/gates/test_gate_trace.py` 全绿（断言：span 计数、配对无孤儿、duration 全部 ≥0、`gen_ai.*` 属性齐、未知帧零丢失、orphan 场景不炸）。
- 四门：`python -m pytest tests -q` 0 fail；`npx tsc --noEmit` 0；`npx vitest run` 0 fail；`npm run build` ✓。
- 人工走查：真跑一次带 ERP 工具的 chat run → 打开"执行过程"→ 瀑布图逐 turn 可见模型耗时、token、工具成败；再看一次历史失败 run 的 error 标红。

## §8 风险与已知限制

- 旧 run 的 tool span 只有**秒粒度**（行 created_at）——<1s 的工具条形显示为最小宽度并标注"<1s"；Task 6 落地后新 run 变毫秒级。
- `事件帧 event.created_at` 若个别缺失 → 回落行 created_at（装配器已按优先级取值）。
- Task 6 可能碰碎"帧全等断言"的既有测试：决策规则——受影响 >5 处即降级为 opt-in 开关（只在 chat 后台驱动开启），≤5 处直接修断言。

---

### Task 0: 开分支（Q3 已拍板）

**Files:** 无代码；仅分支与计划入库。

- [ ] **Step 1: 从 main 开工作分支**（判断力轮已并 main；当前 `fix/judgment-review` 工作树无代码改动，只有未跟踪 docs，不受影响）

```bash
git checkout main
git checkout -b feat/trace-round
```

- [ ] **Step 2: 计划入库（本轮首 commit）**

```bash
git add docs/superpowers/plans/2026-08-05-trace-round
git commit -m "docs(trace): Trace 轮 spec — 00-plan(术语/契约/装配规则/8 Task)"
```

（`docs/learning/`、品牌 brief 等其他未跟踪文件不属于本轮，不入库不移动。）

---

### Task 1: RunStore 带时间戳的帧读取

**Files:**
- Modify: `services/runtime/app/run_store.py`（Protocol 与 SQLiteRunStore 各加一法）
- Test: `tests/runtime/test_run_store_frames_meta.py`（新建；`tests/runtime/` 已存在）

**Interfaces:**
- Produces: `list_frames_with_meta(surface, run_id, from_seq=0) -> list[dict]`，每项 `{"frame": dict, "created_at": str}`，seq 升序，坏行跳过（与 `list_frames` 同纪律）。Task 4 装配器、Task 5 路由消费。

- [ ] **Step 1: 写失败测试**

```python
"""list_frames_with_meta —— Trace 轮 T1 的读取面：帧 + 行级 created_at。"""
from services.runtime.app.run_store import SQLiteRunStore


def test_list_frames_with_meta_returns_frame_and_created_at(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs.db")
    store.append_frame("chat", "r1", 1, {"type": "tool_start", "name": "erp.finance.query", "seq": 1})
    store.append_frame("chat", "r1", 2, {"type": "tool_done", "name": "erp.finance.query", "seq": 2})
    rows = store.list_frames_with_meta("chat", "r1")
    assert [r["frame"]["seq"] for r in rows] == [1, 2]
    assert all(isinstance(r["created_at"], str) and r["created_at"] for r in rows)


def test_list_frames_with_meta_skips_corrupt_rows(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs.db")
    store.append_frame("chat", "r1", 1, {"type": "done", "seq": 1})
    with store._connect() as conn:  # 与 list_frames 的坏行纪律同源:直接塞坏 JSON
        conn.execute(
            "INSERT INTO run_frames (surface, run_id, seq, frame, created_at) VALUES ('chat','r1',2,'{broken', datetime('now'))"
        )
    rows = store.list_frames_with_meta("chat", "r1")
    assert [r["frame"]["seq"] for r in rows] == [1]
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `python -m pytest tests/runtime/test_run_store_frames_meta.py -q`
Expected: FAIL，`AttributeError: ... 'list_frames_with_meta'`

- [ ] **Step 3: 实现（SQLiteRunStore 内、`list_frames` 之后；Protocol 同步加签名）**

```python
    def list_frames_with_meta(
        self,
        surface: str,
        run_id: str,
        from_seq: int = 0,
    ) -> list[dict[str, Any]]:
        """帧 + 行级 created_at(Trace 轮 T1 读取面;list_frames 只回帧 JSON)。

        坏行跳过纪律与 ``list_frames`` 一致;created_at 是 SQLite ``datetime('now')``
        的秒粒度 UTC 字符串,装配器只把它当兜底时间源(优先帧内 ts / 事件 created_at)。
        """
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT frame, created_at FROM run_frames
                WHERE surface = ? AND run_id = ? AND seq >= ?
                ORDER BY seq ASC
                """,
                (surface, run_id, from_seq),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            try:
                parsed = json.loads(row["frame"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(parsed, dict):
                out.append({"frame": parsed, "created_at": row["created_at"]})
        return out
```

Protocol（run_store.py:97 `list_frames` 之后）加同签名 `...` 存根。

- [ ] **Step 4: 跑测试确认 GREEN**：同 Step 2 命令，Expected: 2 passed
- [ ] **Step 5: Commit**：`git add services/runtime/app/run_store.py tests/runtime/test_run_store_frames_meta.py && git commit -m "feat(runtime): Trace T1a — run_frames 带 created_at 读取面"`（只 stage 本任务两个文件）

---

### Task 2: gate 测试（RED）——装配器契约先行

**Files:**
- Test: `tests/gates/test_gate_trace.py`（新建）

**Interfaces:**
- Consumes: Task 3 的 `assemble_trace(run_id: str, surface: str, rows: list[dict], *, conversation_id: str | None = None) -> dict`（rows 即 Task 1 输出形状；conversation_id 为 Q6 增补）。

- [ ] **Step 1: 写 gate 测试（完整文件）**

```python
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
```

- [ ] **Step 2: 跑 gate 确认 RED**

Run: `python -m pytest tests/gates/test_gate_trace.py -q`
Expected: FAIL，`ModuleNotFoundError: ... trace_assembler`

- [ ] **Step 3: Commit（RED 单独入库，照判断力轮惯例）**：`git add tests/gates/test_gate_trace.py && git commit -m "test(gates): Trace 轮 gate — 装配器契约 (RED)"`

---

### Task 3: 装配器 GREEN

**Files:**
- Create: `services/runtime/app/trace_assembler.py`

**Interfaces:**
- Produces: `assemble_trace(run_id, surface, rows) -> dict`（§4 契约）。Task 5 路由消费。

- [ ] **Step 1: 完整实现**

```python
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

    def add_event(target: _Span, name: str, at: datetime, attributes: dict[str, Any]) -> None:
        target.events.append({"name": name, "time": at.isoformat(), "attributes": attributes})

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
                add_event(container(), f"step.{phase}", now, {"intent": frame.get("intent")})
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
                add_event(container(), ev_type, now, payload)
        elif ftype == "text_delta":
            if inference is not None:
                inference.attributes["anna.text_delta_count"] = (
                    int(inference.attributes.get("anna.text_delta_count", 0)) + 1
                )
        elif ftype == "tool_start":
            name = str(frame.get("name") or "")
            tool = new_span(turn or root, f"execute_tool {name}", "tool", now)
            tool.attributes = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name}
            if pending_intent is not None and pending_intent[1]:
                tool.attributes["anna.step.intent"] = pending_intent[1]
            pending_intent = None
            open_tools.append(tool)
        elif ftype == "tool_done":
            if open_tools:
                close(open_tools.pop(0), now, "ok")  # loop 串行派发,FIFO 配对
        elif ftype in ("done", "error", "exhausted", "awaiting_approval"):
            attributes = {k: v for k, v in frame.items() if k not in ("type", "seq", "ts") and isinstance(v, _SCALAR)}
            add_event(root, f"frame.{ftype}", now, attributes)
            if ftype == "done" and frame.get("turns") is not None:
                root.attributes["anna.turns"] = frame["turns"]
            if ftype in ("error", "exhausted"):
                root.status = "error"
            if ftype == "awaiting_approval":
                root.status = "unset"
        else:  # 未知帧:零丢失,前向兼容
            attributes = {k: v for k, v in frame.items() if k not in ("type", "seq", "ts") and isinstance(v, _SCALAR)}
            add_event(container(), f"frame.{ftype}", now, attributes)

    # 收尾扫描:孤儿闭合留证,层级时间归拢
    for orphan in ([inference] if inference is not None and inference.end is None else []) + open_tools:
        orphan.attributes["anna.orphaned"] = True
        close(orphan, now, "error")
    close(turn, now)
    close(root, now, None)
    for parent in spans:
        if parent.kind in ("turn", "agent"):
            child_ends = [s.end for s in spans if s.parent_span_id == parent.span_id and s.end is not None]
            if child_ends:
                parent.end = max([parent.end or parent.start, *child_ends])
            if any(s.status == "error" for s in spans if s.parent_span_id == parent.span_id) and parent.kind == "turn":
                parent.status = "error"

    def serialize(span: _Span) -> dict[str, Any]:
        end = span.end or span.start
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
```

- [ ] **Step 2: 跑 gate 确认 GREEN**：`python -m pytest tests/gates/test_gate_trace.py -q` → 6 passed
- [ ] **Step 3: 全量回归**：`python -m pytest tests -q` → 0 failed
- [ ] **Step 4: Commit**：`git commit -am "feat(runtime): Trace T1 — journal→OTel span 树装配器 (GREEN)"`

---

### Task 4: API 路由 `GET /api/chat/runs/{run_id}/trace`

**Files:**
- Modify: `services/api/app/routes/chat.py`（`get_chat_run`（:450-461）之后加路由；`BackgroundRunManager` 加 `trace` 方法）
- Test: `tests/api/test_chat_trace_route.py`（新建，fixture 模式照抄 `tests/api/test_chat_api.py` 的 app/client 装配）

**Interfaces:**
- Consumes: Task 1 `list_frames_with_meta`、Task 3 `assemble_trace`。
- Produces: HTTP 200 → §4 TraceDoc；404 → run 不存在；鉴权与 `get_chat_run` 完全同款（`X-Anna-Workspace-ID` / `X-Anna-User-ID` + `_assert_run_access`）。

- [ ] **Step 1: 先读 `BackgroundRunManager.__init__`（routes/chat.py:88 起）确认持有 store 的属性名**（`_read_frames`（:382-385）用的就是它；下面代码按 `self._store` 写，名字不同按实替换）
- [ ] **Step 2: 写失败测试**（照 `tests/api/test_chat_api.py` 的既有 fixture 起 app；核心断言）

```python
def test_chat_run_trace_route_returns_span_tree(chat_app_client, seeded_chat_run):
    client, run_id, headers = chat_app_client, seeded_chat_run, _identity_headers()
    res = client.get(f"/api/chat/runs/{run_id}/trace", headers=headers)
    assert res.status_code == 200
    doc = res.json()
    assert doc["trace_id"] == run_id
    assert isinstance(doc["spans"], list)
    assert doc["spans"][0]["kind"] == "agent"


def test_chat_run_trace_route_404_on_unknown_run(chat_app_client):
    res = chat_app_client.get("/api/chat/runs/nope/trace", headers=_identity_headers())
    assert res.status_code == 404
```

- [ ] **Step 3: 跑测试 RED**：`python -m pytest tests/api/test_chat_trace_route.py -q` → 404/405 断言失败
- [ ] **Step 4: 实现**——`BackgroundRunManager` 加：

```python
    def trace(self, run_id: str, conversation_id: str | None = None) -> dict:
        """一次 run 的 OTel 形状 span 树(Trace 轮 T1;纯读,无 store 时回空树)。
        conversation_id 传 run 的 thread_id(Q6),无 thread 由装配器回落 run_id。"""
        from services.runtime.app.trace_assembler import assemble_trace

        reader = getattr(self._store, "list_frames_with_meta", None)
        rows = reader(_CHAT_SURFACE, run_id) if reader is not None else []
        return assemble_trace(run_id, _CHAT_SURFACE, rows, conversation_id=conversation_id)
```

路由（放在 `get_chat_run` 之后；**路径段更长，与 `{run_id}` 不冲突**）：

```python
    @router.get("/api/chat/runs/{run_id}/trace")
    def get_chat_run_trace(
        run_id: str,
        anna_workspace_id: str = Header(alias="X-Anna-Workspace-ID"),
        anna_user_id: str = Header(alias="X-Anna-User-ID"),
    ) -> dict:
        """执行过程 Trace(§4 TraceDoc)——journal+audit 装配,纯读。"""
        try:
            run = chat.get_run(run_id)
        except ChatRunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="chat run not found") from exc
        _assert_run_access(run.workspace_id, run.actor_user_id, anna_workspace_id, anna_user_id)
        return manager.trace(run_id, conversation_id=getattr(run, "thread_id", None))
```

- [ ] **Step 5: GREEN + 回归**：`python -m pytest tests/api/test_chat_trace_route.py tests/api/test_chat_api.py -q` → 全过
- [ ] **Step 6: Commit**：`git commit -am "feat(api): Trace T1 — GET /api/chat/runs/{run_id}/trace"`

---

### Task 5: 前端 API client + 归约器（纯函数）

**Files:**
- Create: `apps/desktop/src/lib/api/trace.ts`
- Create: `apps/desktop/src/lib/traceSpans.ts`
- Test: `apps/desktop/src/lib/traceSpans.test.ts`

**Interfaces:**
- Produces: `getRunTrace(runId) -> Promise<TraceDto>`；`toWaterfall(doc: TraceDto) -> { summary, groups }`（Task 6 组件消费）。

- [ ] **Step 1: `trace.ts`（client 习语照抄 crew.ts:400-406 的 `apiJson` + `authHeaders`，从同目录既有模块 import）**

```ts
import { apiJson, authHeaders } from './client';

export interface TraceSpanDto {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  /** agent|turn|inference|tool,未来还有 invoke_agent 子代理等——刻意开成 string,
   *  渲染端 KIND_TAG 有 fallback(三级下钻四护栏之「subagent 留位」,前向兼容) */
  kind: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, unknown>;
  events: { name: string; time: string; attributes: Record<string, unknown> }[];
}

export interface TraceDto {
  trace_id: string;
  surface: string;
  spans: TraceSpanDto[];
}

export async function getRunTrace(runId: string): Promise<TraceDto> {
  return apiJson<TraceDto>(`/api/chat/runs/${runId}/trace`, { headers: authHeaders() });
}
```

（若 `apiJson`/`authHeaders` 实际所在模块名不同，以 crew.ts 顶部 import 为准同源引入。）

- [ ] **Step 2: 先写归约器失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { toWaterfall } from './traceSpans';
import type { TraceDto } from './api/trace';

const doc: TraceDto = {
  trace_id: 'r1',
  surface: 'chat',
  spans: [
    { span_id: 's1', parent_span_id: null, name: 'invoke_agent chat', kind: 'agent',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:10', duration_ms: 10000,
      status: 'ok', attributes: { 'anna.turns': 1 }, events: [] },
    { span_id: 's2', parent_span_id: 's1', name: 'turn 1', kind: 'turn',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:10', duration_ms: 10000,
      status: 'ok', attributes: {},
      events: [
        { name: 'context.compaction.applied', time: '2026-08-05T09:00:01', attributes: {} },
        { name: 'run.judgment.custom', time: '2026-08-05T09:00:02', attributes: {} },
      ] },
    { span_id: 's3', parent_span_id: 's2', name: 'chat deepseek-chat', kind: 'inference',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:03', duration_ms: 3000,
      status: 'ok',
      attributes: { 'gen_ai.usage.input_tokens': 900, 'gen_ai.usage.output_tokens': 40 }, events: [] },
    { span_id: 's4', parent_span_id: 's2', name: 'execute_tool erp.finance.query', kind: 'tool',
      start_time: '2026-08-05T09:00:04', end_time: '2026-08-05T09:00:06', duration_ms: 2000,
      status: 'ok', attributes: { 'gen_ai.tool.name': 'erp.finance.query' }, events: [] },
  ],
};

describe('toWaterfall', () => {
  it('分组到 turn、条形按总时长归一化、汇总真数', () => {
    const w = toWaterfall(doc);
    expect(w.summary.turns).toBe(1);
    expect(w.summary.tokensIn).toBe(900);
    expect(w.summary.tokensOut).toBe(40);
    expect(w.summary.durationMs).toBe(10000);
    expect(w.groups).toHaveLength(1);
    const rows = w.groups[0].rows;
    expect(rows.map((r) => r.kind)).toEqual(['inference', 'tool']);
    expect(rows[0].offsetPct).toBe(0);
    expect(rows[0].widthPct).toBe(30);
    expect(rows[1].offsetPct).toBe(40);
    expect(rows[1].widthPct).toBe(20);
    expect(w.groups[0].chips).toEqual([
      { name: 'context.compaction.applied', label: '压缩' },
      { name: 'run.judgment.custom', label: 'run.judgment.custom' },
    ]);
  });

  it('空 spans → 空瀑布不造数', () => {
    const w = toWaterfall({ trace_id: 'r1', surface: 'chat', spans: [] });
    expect(w.groups).toHaveLength(0);
    expect(w.summary.durationMs).toBe(0);
  });
});
```

- [ ] **Step 3: RED**：`npx vitest run src/lib/traceSpans.test.ts` → FAIL（模块不存在）
- [ ] **Step 4: 实现 `traceSpans.ts`**

```ts
/**
 * traceSpans · TraceDto → 瀑布图行(纯归约,零 React,vitest 可测)。
 * 条形几何:以 agent span 起止为 100%,offset/width 取百分比;
 * duration<1% 的行给最小宽度 1%(旧 run 秒粒度下 "<1s" 仍可见)。零捏造:token 缺就不显示。
 */
import type { TraceDto, TraceSpanDto } from './api/trace';

export interface WaterfallRow {
  id: string;
  kind: TraceSpanDto['kind'];
  label: string;
  status: TraceSpanDto['status'];
  durationMs: number;
  offsetPct: number;
  widthPct: number;
  tokensIn?: number;
  tokensOut?: number;
  intent?: string;
  span: TraceSpanDto;
}

export interface WaterfallGroup {
  turnId: string;
  title: string;
  status: TraceSpanDto['status'];
  rows: WaterfallRow[];
  /** 判断层/治理事件 chip(Q7):已知名走中文映射,未知原名直显——零编造 */
  chips: { name: string; label: string }[];
}

/** 已核实的事件名→chip 文案(标签映射允许,编造禁止,ADR-002)。映射外原名直显。 */
const CHIP_LABELS: Record<string, string> = {
  'context.compaction.applied': '压缩',
  'context.autocompact.applied': '压缩·摘要',
  'run.queued': '排队',
  'run.evaluation.started': '评审',
};

export interface WaterfallSummary {
  model?: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  status: TraceSpanDto['status'];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function toWaterfall(doc: TraceDto): { summary: WaterfallSummary; groups: WaterfallGroup[] } {
  const agent = doc.spans.find((s) => s.kind === 'agent');
  const turns = doc.spans.filter((s) => s.kind === 'turn');
  const t0 = agent ? Date.parse(agent.start_time) : 0;
  const total = agent ? Math.max(1, agent.duration_ms) : 1;

  const groups: WaterfallGroup[] = turns.map((turn) => ({
    turnId: turn.span_id,
    title: turn.name,
    status: turn.status,
    chips: turn.events
      .filter((e) => !e.name.startsWith('step.'))
      .map((e) => ({ name: e.name, label: CHIP_LABELS[e.name] ?? e.name })),
    rows: doc.spans
      .filter((s) => s.parent_span_id === turn.span_id)
      .map((s) => {
        const offset = agent ? ((Date.parse(s.start_time) - t0) / total) * 100 : 0;
        const width = (s.duration_ms / total) * 100;
        return {
          id: s.span_id,
          kind: s.kind,
          label: s.name,
          status: s.status,
          durationMs: s.duration_ms,
          offsetPct: Math.max(0, Math.round(offset)),
          widthPct: Math.max(1, Math.round(width)),
          tokensIn: num(s.attributes['gen_ai.usage.input_tokens']),
          tokensOut: num(s.attributes['gen_ai.usage.output_tokens']),
          intent: typeof s.attributes['anna.step.intent'] === 'string'
            ? (s.attributes['anna.step.intent'] as string) : undefined,
          span: s,
        };
      }),
  }));

  const infer = doc.spans.filter((s) => s.kind === 'inference');
  const sum = (k: string) => infer.reduce((a, s) => a + (num(s.attributes[k]) ?? 0), 0);
  return {
    summary: {
      model: infer.length
        ? (infer[0].attributes['gen_ai.request.model'] as string | undefined) : undefined,
      turns: turns.length,
      tokensIn: sum('gen_ai.usage.input_tokens'),
      tokensOut: sum('gen_ai.usage.output_tokens'),
      durationMs: agent?.duration_ms ?? 0,
      status: agent?.status ?? 'unset',
    },
    groups,
  };
}
```

- [ ] **Step 5: GREEN**：`npx vitest run src/lib/traceSpans.test.ts` → 2 passed
- [ ] **Step 6: Commit**：`git commit -am "feat(desktop): Trace T2a — trace client + 瀑布纯归约"`

---

### Task 6: 前端瀑布图组件 + HomePage 入口

**Files:**
- Create: `apps/desktop/src/pages/trace/TraceWaterfall.tsx`
- Create: `apps/desktop/src/pages/trace/TraceDrawer.tsx`
- Modify: `apps/desktop/src/pages/home/HomePage.tsx`（运行详情/历史区加入口按钮）
- Modify: `apps/desktop/src/App.css`（追加 `.trace-*` 样式块）
- Test: `apps/desktop/src/pages/trace/__tests__/TraceWaterfall.test.tsx`

**Interfaces:**
- Consumes: `getRunTrace` / `toWaterfall`（Task 5）。

- [ ] **Step 1: 侦察一步（不改码）**——打开 `pages/crew/inspect/TraceLevels.tsx` 与 `App.css`，记下现有 drawer 容器、tag、等宽块的 className 与 CSS 变量名；下面组件里的 `trace-*` 类名保持，容器外壳换成侦察到的现成 drawer 结构。
- [ ] **Step 2: `TraceWaterfall.tsx`（展示组件，零请求）**

```tsx
/**
 * TraceWaterfall · 执行过程瀑布图(§6):L1 摘要条 → turn 分组行 → 行内条形+token chip。
 * 纯展示:数据来自 toWaterfall;点击行展开 span attributes/events(等宽降噪)。零捏造。
 */
import { useState } from 'react';
import type { TraceDto } from '../../lib/api/trace';
import { toWaterfall, type WaterfallRow } from '../../lib/traceSpans';

const KIND_TAG: Record<string, string> = { inference: '思考', tool: '调用' };

function fmtMs(ms: number): string {
  if (ms < 1000) return ms > 0 ? `${ms}ms` : '<1s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function RowDetail({ row }: { row: WaterfallRow }) {
  return (
    <pre className="trace-detail">
      {JSON.stringify({ attributes: row.span.attributes, events: row.span.events }, null, 2)}
    </pre>
  );
}

export function TraceWaterfall({ doc }: { doc: TraceDto }) {
  const { summary, groups } = toWaterfall(doc);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!groups.length) return <div className="trace-empty">该 run 暂无可装配的执行帧。</div>;
  return (
    <div className="trace-waterfall">
      <div className="trace-summary">
        {summary.model ? <span>{summary.model}</span> : null}
        <span>{summary.turns} 回合</span>
        <span>{fmtMs(summary.durationMs)}</span>
        {summary.tokensIn || summary.tokensOut ? (
          <span>tokens {summary.tokensIn}↑ {summary.tokensOut}↓</span>
        ) : null}
        <span className={`trace-status trace-status--${summary.status}`}>
          {summary.status === 'ok' ? '完成' : summary.status === 'error' ? '失败' : '进行中'}
        </span>
      </div>
      {groups.map((group) => (
        <section key={group.turnId} className="trace-turn">
          <header className="trace-turn__title">
            {group.title}
            {group.chips.map((chip) => (
              <span key={chip.name + chip.label} className="trace-chip" title={chip.name}>
                {chip.label}
              </span>
            ))}
          </header>
          {group.rows.map((row) => (
            <div key={row.id}>
              <button type="button" className="trace-row" onClick={() => setOpenId(openId === row.id ? null : row.id)}>
                <span className="trace-row__tag">{KIND_TAG[row.kind] ?? row.kind}</span>
                <span className="trace-row__label">{row.intent ?? row.label}</span>
                <span className="trace-row__bar">
                  <span
                    className={`trace-row__fill trace-row__fill--${row.status}`}
                    style={{ marginInlineStart: `${row.offsetPct}%`, inlineSize: `${row.widthPct}%` }}
                  />
                </span>
                <span className="trace-row__ms">{fmtMs(row.durationMs)}</span>
                {row.tokensIn != null ? <span className="trace-row__chip">{row.tokensIn}↑{row.tokensOut ?? 0}↓</span> : null}
              </button>
              {openId === row.id ? <RowDetail row={row} /> : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: `TraceDrawer.tsx`（取数 + 轮询，纪律照抄 useRunFrames.ts:19-44）**

```tsx
import { useEffect, useState } from 'react';
import { getRunTrace, type TraceDto } from '../../lib/api/trace';
import { TraceWaterfall } from './TraceWaterfall';

const POLL_MS = 3000;

export function TraceDrawer({ runId, open, onClose }: { runId: string; open: boolean; onClose: () => void }) {
  const [doc, setDoc] = useState<TraceDto | null>(null);
  useEffect(() => {
    if (!open || !runId) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = await getRunTrace(runId);
        if (alive) setDoc(d);
      } catch {
        if (alive) setDoc((p) => p ?? null); // 404/未上线 → 空态,不造数
      }
    };
    void tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [runId, open]);
  if (!open) return null;
  return (
    <aside className="trace-drawer" role="dialog" aria-label="执行过程">
      <header className="trace-drawer__head">
        <span>执行过程</span>
        <button type="button" onClick={onClose}>关闭</button>
      </header>
      {doc ? <TraceWaterfall doc={doc} /> : <div className="trace-empty">加载中…</div>}
    </aside>
  );
}
```

- [ ] **Step 4: App.css 追加样式块（全部 `var(--*, fallback)`，不新增设计令牌）**

```css
/* Trace 轮 · 执行过程瀑布图(工程页,复用 Iris 变量,深浅色皆可读) */
.trace-drawer { position: fixed; inset-block: 0; inset-inline-end: 0; inline-size: min(560px, 92vw); overflow: auto; background: var(--surface, #fffdf9); border-inline-start: 1px solid var(--border, #e7ddd2); padding: 16px; z-index: 60; }
.trace-drawer__head { display: flex; justify-content: space-between; margin-block-end: 12px; font-weight: 600; }
.trace-summary { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--text-muted, #6b6257); padding-block-end: 8px; border-block-end: 1px solid var(--border, #e7ddd2); }
.trace-turn__title { font-size: 12px; color: var(--text-muted, #6b6257); margin-block: 10px 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.trace-chip { font-size: 11px; border: 1px solid var(--border, #e7ddd2); border-radius: 999px; padding: 0 8px; color: var(--text-muted, #6b6257); background: var(--surface-2, #f3ece3); }
.trace-row { display: grid; grid-template-columns: 44px minmax(120px, 1fr) 2fr 56px auto; gap: 8px; align-items: center; inline-size: 100%; border: 0; background: none; padding: 4px 0; cursor: pointer; text-align: start; font-size: 13px; }
.trace-row__tag { font-size: 11px; color: var(--text-muted, #6b6257); border: 1px solid var(--border, #e7ddd2); border-radius: 4px; text-align: center; }
.trace-row__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trace-row__bar { block-size: 8px; background: var(--surface-2, #f3ece3); border-radius: 4px; overflow: hidden; display: block; }
.trace-row__fill { display: block; block-size: 100%; border-radius: 4px; background: var(--accent, #b4654a); min-inline-size: 2px; }
.trace-row__fill--error { background: var(--danger, #b3382c); }
.trace-row__ms { font-variant-numeric: tabular-nums; text-align: end; color: var(--text-muted, #6b6257); }
.trace-row__chip { font-size: 11px; color: var(--text-muted, #6b6257); }
.trace-detail { font-size: 12px; background: var(--surface-2, #f3ece3); border-radius: 6px; padding: 8px; overflow: auto; max-block-size: 240px; }
.trace-empty { color: var(--text-muted, #6b6257); font-size: 13px; padding: 24px 0; text-align: center; }
```

- [ ] **Step 5: HomePage 入口**——在运行详情/历史项渲染处（grep `historyFrames` 的消费点）加状态 `const [traceRunId, setTraceRunId] = useState<string | null>(null);`、一枚"执行过程"按钮 `onClick={() => setTraceRunId(run.id)}`，页尾挂 `<TraceDrawer runId={traceRunId ?? ''} open={!!traceRunId} onClose={() => setTraceRunId(null)} />`。
- [ ] **Step 6: 组件测试**（渲染 fixture doc → 断言摘要条与行数、点击展开 detail；照 `pages/crew/inspect/__tests__` 的 testing-library 习语）
- [ ] **Step 7: 三门**：`npx tsc --noEmit` 0 错；`npx vitest run` 全绿；`npm run build` ✓
- [ ] **Step 8: Commit**：`git commit -am "feat(desktop): Trace T2 — 执行过程瀑布图 drawer + HomePage 入口"`

---

### Task 7:（可选，按 §8 决策规则）帧 `ts` 毫秒时间戳

**Files:**
- Modify: `services/runtime/app/frame_journal.py:93-95`（`append` 盖章处）
- Test: `tests/runtime/test_frame_journal.py`（既有文件追加用例；若无则新建）

- [ ] **Step 1: 失败测试**——`append` 后 `stamped["ts"]` 是 ISO8601 毫秒 UTC 字符串。
- [ ] **Step 2: 实现**：

```python
from datetime import UTC, datetime
# append 内 stamped 行改为:
stamped = {**frame, "seq": seq,
           "ts": datetime.now(UTC).isoformat(timespec="milliseconds")}
```

- [ ] **Step 3: 全量回归** `python -m pytest tests -q`。帧全等断言若碎：≤5 处直接修，>5 处改为 `FrameJournal(stamp_ts=True)` 仅 chat 后台驱动开启（构造参数默认 False）。
- [ ] **Step 4: Commit**：`git commit -am "feat(runtime): Trace T1b — journal 帧毫秒 ts(附加字段)"`

---

### Task 8: CONTEXT.md + ADR-003 + 走查收轮（Q4 已拍板：术语表升根文档）

**Files:**
- Create: `CONTEXT.md`（repo 根——新 Anna 第一份域文档）
- Create: `docs/adr/ADR-003-trace-and-terminology.md`
- Create: `docs/superpowers/plans/2026-08-05-trace-round/ACCEPTANCE.md`（轮目录只留验收记录）
- Modify: A2 帧契约事实源文档（先 grep `docs/` 定位 R2 帧契约文档）——加一行指针指向 CONTEXT.md 的 TraceDoc 契约节

- [ ] **Step 1: 写 `CONTEXT.md`**：§2 术语定案表原样拷入 + 九跳链路表 + TraceDoc 契约（§4 全文引入）+「本表是全仓术语契约，改词先改这里」声明
- [ ] **Step 2: 写 `ADR-003`**：决策三段——①为何纯读装配而非 loop 内埋 span（零风险 + Phase B 重构安全带）②为何用 OTel/`gen_ai.*` 命名而非自造（Cloudflare/OTel 对齐 + 弃用词清单）③重定位轮 D1/D2 认账（全溶解范围、测试 pin 改写成本、连接器保留）。ADR 门槛三条件均满足（可逆成本 / 后人会问为何 / 真实取舍）
- [ ] **Step 3: 人工走查**（§7 第三条；桌面 App 起真服务，跑一条带 `erp.finance.query` 的消息 + 复看一条失败 run 的标红）
- [ ] **Step 4: 四门终跑并记录**：`python -m pytest tests -q` / `npx tsc --noEmit` / `npx vitest run` / `npm run build`，四个数字写进 ACCEPTANCE.md
- [ ] **Step 5: Commit**：`git commit -am "docs(trace): CONTEXT.md + ADR-003 + 验收记录,收轮"`

---

## Self-Review 记录

- **Spec 覆盖**：§4 契约 → Task 2/3；§5 规则逐条有 gate 断言（配对/孤儿/零丢失/诚实 token）；§6 前端三段 → Task 5/6；§7 四门 → Task 8。无缺口。
- **占位符扫描**：Task 4 Step 1 与 Task 6 Step 1 是"侦察动作"（读真文件定名字），非 TBD；其余步骤代码完整。
- **类型一致性**：`assemble_trace(run_id, surface, rows)` 三处签名一致；`TraceDto/TraceSpanDto` 前后端字段一一对应（span_id/parent_span_id/duration_ms…）；`toWaterfall` 返回形状与组件解构一致。
