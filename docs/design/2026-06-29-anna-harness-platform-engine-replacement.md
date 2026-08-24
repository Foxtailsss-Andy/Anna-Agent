# Anna 底层 Harness 平台引擎替换 — 设计 (Platform Engine Replacement)

> **版本** v2(流式修正)｜ **日期** 2026-06-29 ｜ **状态** 执行基准
> **范围铁律**:**只换底层 Harness 平台引擎**。业务域(finance/reimbursement/hiker/chat/create/associate)与四个 surface 这轮**一个都不碰**,继续跑现有代码。新引擎在平台层独立建好、独立测透、**零业务接线**。
> **v2 修正(重要)**:v1 把引擎设计成"非流式、删掉 Andy 流式机制" —— **错的**。引擎**必须是流式的**:在 ReAct 过程中**逐 token 流式产出模型文本 + 工具轮间执行 + 过程事件**,忠于 Andy `02-agent-loop.md`(它本就是流式 async generator)。否则 ReAct 流永远没有逐字流式,且将来 chat 接引擎会丢掉它现有的 token 流式。
> **蓝本** Andy `forge-harness/02-agent-loop.md`(流式 Loop/Config/State/Deps)+ `01-orchestration.md`(装配)。**保留 Andy 结构,适配 Anna**(OpenAI-dict 消息、模型无关、复用既有 audit/compaction)。

---

## 1. 为什么换

agent loop **被复制在每个业务域**(`finance/_advance_run` 等,审计 ~20% copy-paste),且**流式四分五裂**:chat 有 token 流式但无工具;ReAct 工具流有过程事件但答案不逐字。**替换 = 一个平台引擎,统一**:流式 ReAct(逐 token + 工具 + 过程事件)。域将来只给"配置 + 薄 handler"。

## 2. Anna 现状的流式真相(改前必读)

- `services/runtime/app/engine/streaming.py::stream_chat_text()` —— 真·流式调模型(`stream:True`,读 SSE `delta.content`,逐 token yield)。**仅 chat 用,无工具**。
- `services/runtime/app/event_stream.py::stream_run_action()` —— 把**同步** ReAct loop 丢 worker 线程,观察 `audit_events` 追加,把**过程事件**流出。财务/报销/hiker 用。**模型文本非流式**(`call_model` 一次性返完整 response)。
- `services/runtime/app/harness_runtime.py::call_model()` —— **非流式** chokepoint(单次 POST + 完整解析),已含 compaction + context_usage + audit。

**结论**:新引擎要把这两种统一成**一个流式 ReAct 循环**,并新建一个**流式 `call_model`**(既流 token、又累积 tool_calls、又复用 compaction/audit/context_usage)。

## 3. Andy → Anna 对应(要建的文件,全在 `services/runtime/app/engine/`)

| Andy 组件 | Andy 文件 | → Anna 新文件 |
|---|---|---|
| 02 Config 快照 | `query_config.py` | `engine/query_config.py`(`QueryConfig` frozen) |
| 02 State | `query.py` 的 `State` | `engine/run_state.py`(`RunState` frozen + `Transition`) |
| 02 Deps(DI) | `query_deps.py` | `engine/query_deps.py`(`QueryDeps` + `production_deps`) |
| **02 流式 call_model** | `query.py` `deps.call_model`(流式)+ `services/api/model` | `engine/streaming_model.py`(`stream_model`,**新**:流 token + 累积 tool_calls + compaction/audit/context_usage) |
| **02 流式 Agent Loop** | `query.py` `query_loop`(async generator) | `engine/agent_loop.py`(`AgentLoop.run`,**async generator**) |
| 02 Token 预算 | `query_token_budget.py` | (只留 `Transition` 扩展点,本轮不实现,见 §6) |
| 01 装配 | `query_engine.py` | `engine/query_engine.py`(`QueryEngine.run`) |
| (Anna 适配)域接缝 | — | `engine/capability.py`(`CapabilityHandler` 协议 + `CapabilityError` + `LoopOutcome`) |
| 03 压缩 | `auto_compact.py` | **复用** `context_compaction.py` |
| 流式 token 读取 | — | **复用/扩展** `engine/streaming.py::stream_chat_text` 的 SSE 读取 |

## 4. 目标结构(流式,忠于 Andy,Anna 适配)

**4.1 Config / State / Deps**(对应 Andy,不可变 + 注入):

```python
@dataclass(frozen=True)
class QueryConfig:
    run_id: str; skill_id: str; tools: list[dict]; max_turns: int = 8
    config_error_message: str = "model endpoint and API key are required before running Anna agent"

@dataclass(frozen=True)
class Transition:
    reason: str                          # "next_turn"|"max_turns"... 供测试断言路径
@dataclass(frozen=True)
class RunState:
    messages: list[dict]; turn_count: int; transition: Transition | None
# 铁律:续轮 state = replace(state, ...),禁止逐字段 mutate

@dataclass(frozen=True)
class QueryDeps:
    stream_model: Callable[..., AsyncIterator["ModelChunk"]]   # 默认 = engine.streaming_model.stream_model
```

**4.2 流式 call_model**(`engine/streaming_model.py`,**新**)—— 这是"流式输出"的来源:

```python
@dataclass(frozen=True)
class ModelChunk:
    kind: str                            # "text_delta" | "final" | "error"
    text: str = ""                       # kind=text_delta
    tool_calls: list = ()                # kind=final
    finish_reason: str | None = None     # kind=final
    error_code: str | None = None; message: str | None = None   # kind=error

async def stream_model(run_id, audit_events, request: ModelRequest, *, settings, config_error_message) -> AsyncIterator[ModelChunk]:
    # 1) compaction(沿用 compact_messages)→ 可能重建 request.messages
    # 2) context_usage + audit "model.call.started"(沿用 harness_runtime 的逻辑)
    # 3) httpx 流式 POST(stream=True),读 SSE(沿用 stream_chat_text 的 SSE 解析):
    #      delta.content       → yield ModelChunk("text_delta", text=delta)
    #      delta.tool_calls[i]  → 累积 id / function.name / function.arguments 片段(OpenAI 流式工具调用是增量拼接)
    # 4) [DONE] → 组装 tool_calls;audit "model.call.completed";yield ModelChunk("final", tool_calls=..., finish_reason=...)
    #    出错 → audit "model.call.failed";yield ModelChunk("error", ...)
```
> 即:把既有**非流式** `call_model` 的治理(compaction/context_usage/audit)+ `stream_chat_text` 的**流式 SSE 读取**,合并,并补上 **tool_calls 增量累积**(stream_chat_text 现在忽略工具调用)。

**4.3 流式 Agent Loop**(`engine/agent_loop.py`)—— 对应 Andy `query_loop`,**async generator**:

```python
class AgentLoop:
    async def run(self, config, handler, deps, run_id, audit_events) -> AsyncIterator[dict]:
        request = handler.build_initial_request()
        state = RunState(messages=list(request.messages), turn_count=1, transition=None)
        tools = request.tools
        while True:
            assistant_text, tool_calls = "", []
            async for chunk in deps.stream_model(run_id, audit_events,
                    ModelRequest(messages=state.messages, tools=tools),
                    settings=config_settings, config_error_message=config.config_error_message):
                if chunk.kind == "text_delta":
                    assistant_text += chunk.text
                    yield {"type": "text_delta", "text": chunk.text}        # ← ReAct 过程中逐 token 流式输出
                elif chunk.kind == "error":
                    yield {"type": "error", "error_code": chunk.error_code, "message": chunk.message}; return
                elif chunk.kind == "final":
                    tool_calls = list(chunk.tool_calls)
            if not tool_calls:                                              # 唯一正常出口:模型不再调工具
                handler.on_assistant_final(assistant_text or None)
                yield {"type": "done", "turns": state.turn_count}; return
            try:
                observations = []
                for tc in tool_calls:
                    yield {"type": "tool_start", "name": tc.name}           # 工具步骤可见
                    observations.append(handler.dispatch_tool(tc))          # 治理+MCP+折叠领域结果
                    yield {"type": "tool_done", "name": tc.name}
            except CapabilityError as exc:
                yield {"type": "error", "error_code": exc.error_code, "message": exc.message}; return
            next_turn = state.turn_count + 1
            if config.max_turns and next_turn > config.max_turns:
                yield {"type": "exhausted", "turns": state.turn_count}; return
            state = replace(state,                                          # 整体重写
                messages=[*state.messages, assistant_tool_call_message(assistant_text, tool_calls), *observations],
                turn_count=next_turn, transition=Transition(reason="next_turn"))
```

**4.4 CapabilityHandler**(域插入的唯一接口,Anna 适配 —— 把各域 `_apply_model_response` 提炼):

```python
class CapabilityHandler(Protocol):
    def build_initial_request(self) -> ModelRequest: ...
    def dispatch_tool(self, tool_call) -> dict: ...        # assert_allowed + MCP + 折叠领域结果 + 返回 observation;失败抛 CapabilityError
    def on_assistant_final(self, assistant_message: str | None) -> None: ...
```

**4.5 QueryEngine**(`engine/query_engine.py`)= 薄装配:`build QueryConfig → 选 handler → async for x in AgentLoop.run(...): yield x`。SSE 路由直接转发这些 yield(`text_delta` / `tool_*` / `done` / `error`)→ 前端逐字渲染。

## 5. "平台稳"如何验证(完成定义)

**零业务接线 → 不能靠"打开 App 看一眼",只能靠平台单测:** 用 **fake `QueryDeps`(脚本化 `stream_model`:产 text_delta 序列 + 一个 final(含/不含 tool_calls))+ fake `CapabilityHandler`**:
1. **流式断言(核心)**:loop **逐个 yield `text_delta`**,且在 `done` 之前;断言收到的 delta 序列拼起来 = 模型文本。
2. 有 tool_calls 的 final → `dispatch_tool` 被调 → observation 折回 → 续轮;`messages` 正确累积;State **整体重写**(`transition.reason=="next_turn"`)。
3. 无 tool_calls 的 final → `on_assistant_final` 恰一次 + `done`。
4. `dispatch_tool` 抛 `CapabilityError` → `error`。
5. 超 `max_turns` → `exhausted`。
6. `stream_model` 产 `error`(model_not_configured)→ `error`。
7. compaction 仍在 `stream_model` 内生效。

完成 = 引擎建好 + 以上单测全绿 + **既有 377 不破** + 两段式评审过 + **零业务接线**。

## 6. 分期

- **本轮**:Config/State/Transition/Deps/**流式 stream_model**/**流式 AgentLoop**/CapabilityHandler/QueryEngine + fake 单测。
- **结构到位、实现推迟**:Andy 的 recovery ladder / token budget(留 `Transition` 扩展点)—— Anna 现在无 +500k,不实现。
- **下一轮(非本设计)**:域逐个把 `_advance_run` / `stream_run` 换成 `QueryEngine.run + 各自 CapabilityHandler`(chat 接入后**自然获得**统一流式;finance/报销/hiker 接入后**获得逐 token 流式**)。

## 7. 不在本轮范围

域 orchestrator、四个 surface、04 Tools 协议、Hooks/Memory/Eval/SystemPrompt、SQLite WAL。

## 8. 构建计划(T1–T6,plan→subagent,每步全套测试兜底)

| Task | 文件 | 验收 |
|---|---|---|
| T1 | `engine/run_state.py`、`engine/query_config.py` | 单测:不可变 + replace |
| T2 | `engine/capability.py`(协议 + CapabilityError + LoopOutcome + `ModelChunk`)| 单测:契约 |
| T3 | `engine/streaming_model.py`(`stream_model`:流 token + 累积 tool_calls + compaction/audit/context_usage)| 单测:fake httpx SSE,断言 text_delta 序列 + tool_calls 组装 + audit + compaction |
| T4 | `engine/query_deps.py`(`QueryDeps` + `production_deps`)| 单测:注入 fake |
| T5 | `engine/agent_loop.py`(`AgentLoop.run` async generator)| 单测:§5 全部路径(fake stream_model + handler)|
| T6 | `engine/query_engine.py` + 整分支回归 + 评审 | 377+ 全绿、零业务接线、评审过 |

*本设计是底层 Harness 平台引擎的替换基准(v2 流式修正)。域适配属后续轮次。*
