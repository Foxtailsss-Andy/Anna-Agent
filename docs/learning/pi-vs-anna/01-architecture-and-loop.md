# L1 · Pi 的定位、三层架构与 Agent Loop 解剖

> 2026-07-24。对应书 ch01-03。源码基准:`Desktop\pi` 克隆(main, depth 1)。

## 1. 定位(ch01)

- README 官方自称 **"Pi Agent Harness"**。三包:`pi-ai`(统一多 provider LLM API)/ `pi-agent-core`(runtime,核心 6 文件 ~2200 行)/ `pi-coding-agent`(产品 CLI)。另有 `pi-tui`(差分渲染终端 UI)、`pi-server`(实验性)。
- **Pi 无内置权限系统**(README:"does not include a built-in permission system…"),隔离靠容器化(Gondolin micro-VM / Docker / OpenShell)。⇒ Pi 的 harness 边界 = 循环 + 工具 + 上下文;治理不在内。与 Anna(治理层自有,ADR-001)是立场级差异。
- 仓库根有 `.pi/`(extensions/prompts/skills)⇒ 自扩展("self extensible coding agent"),产品层特性,L4 展开。

## 2. 三层架构(ch02)

```
coding-agent(产品:tools、session、compaction、extensions、TUI)
    ↓ 依赖
agent-core(运行时:agent-loop.ts、agent.ts、types.ts、harness/)
    ↓ 依赖
ai(模型:provider 适配、model catalog、流式事件协议)
```

- 分层判据 = **类型的进出方向**:`ai` 定义 `Model/Context/Message/AssistantMessageEventStream`;`agent-core` 消费之并定义 `AgentMessage/AgentEvent/AgentLoopConfig`;`coding-agent` 把工具、持久化、压缩**注入**运行时。
- 运行时不知道产品存在 = **控制反转(IoC)**,注入载体是 `AgentLoopConfig`。Anna 对应物 = `CapabilityHandler`(L2 精读)。

## 3. Agent Loop 解剖(ch03 主干)

### 3.1 定义

Agent Loop = 迭代控制流:组装 Context → 调用模型 → assistant 消息含 toolCall 则执行工具、ToolResultMessage 追加回 Context → 再调模型 → 直到停止条件。

`agent-loop.ts:1-4` 文件头即设计立场:

```ts
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
```

全程富类型 `AgentMessage`,仅在模型调用边界降级为 `Message[]` —— 允许应用在 transcript 里保留 LLM 不认识的自定义消息(UI 通知等),在边界处过滤/降级。

### 3.2 双层嵌套循环(`runLoop`,agent-loop.ts:155-275)

```
外层 while(true):agent 将停时轮询 follow-up 队列,有则续
  内层 while (hasMoreToolCalls || pendingMessages.length > 0):一次迭代 = 一个 turn
    turn_start
    ① 注入 pending steering 消息(下一次模型调用前)
    ② streamAssistantResponse() → AssistantMessage
    ③ stopReason error/aborted → turn_end + agent_end,返回
    ④ 提取 toolCall;stopReason "length" → 全判失败不执行;否则 executeToolCalls()
    ⑤ ToolResult 追加进 context;turn_end
    ⑥ prepareNextTurn 钩子:可换 context/model/thinkingLevel
    ⑦ shouldStopAfterTurn 钩子:true → agent_end
    ⑧ 轮询 getSteeringMessages() → pendingMessages
  内层退出后:getFollowUpMessages() 非空 → continue;否则 break
agent_end
```

**Turn 的规范定义**(types.ts:426 注释):"a turn is one assistant response + any tool calls/results"。

**停止条件全枚举**:
1. 无 toolCall 且两队列空(内层条件 + :263-271)
2. `stopReason === "error"|"aborted"`(:196-200)
3. 工具批次全部 `terminate: true`(`shouldTerminateToolBatch` :582-584)
4. `shouldStopAfterTurn` 返回 true(:247-257)

**入口**:`agentLoop(prompts, context, config, signal, streamFn)` 新起;`agentLoopContinue(context, …)` 续跑(重试/恢复),前置条件 = context 末条消息不能是 assistant(:70-76)。两者都返回 `EventStream<AgentEvent, AgentMessage[]>`,生产者 fire-and-forget 推事件(:40-51)。

### 3.3 事件协议(types.ts:422-437,10 种)

```
agent_start                                   运行级
└─ turn_start                                 回合级
   ├─ message_start/message_end               (user prompt,成对立即闭合)
   ├─ message_start → message_update ×N → message_end   (assistant,流式)
   ├─ tool_execution_start → _update ×N → _end          工具级(每 toolCall)
   ├─ message_start/message_end               (toolResult 消息)
   └─ turn_end { message, toolResults }
agent_end { messages }
```

协议不变量:
1. **闭合性** —— 每个 `*_start` 必有 `*_end`,error/abort 路径也先闭合再退(:196-199)。
2. **统一消息生命周期** —— 所有 role 共用 message_start/end 形态,消费端不按 role 分支。

⇒ Anna 三级披露与此同构:L1=运行/回合级,L2=工具级,L3=args/result 原始载荷;前端 `reduceTurns` = 对事件流做折叠(fold)。

### 3.4 模型调用边界:两段变换(`streamAssistantResponse`,:281-372)

```
context.messages: AgentMessage[]
  → transformContext()  // AgentMessage[]→AgentMessage[],剪枝/注入(压缩挂载点,ch08-09)
  → convertToLlm()      // AgentMessage[]→Message[],降级/过滤(必选)
  → { systemPrompt, messages, tools } → streamFn
```

细节:流式期间 partial assistant 消息**已在 transcript 内**(:321 push,:337 每 delta 原地替换)——状态与流是同一份数据。`getApiKey` 每次请求前解析(短时 OAuth token 场景,:305-306)。

### 3.5 工具执行管线:五段式

```
tool_execution_start
→ prepare  : 查找工具 → prepareArguments 垫片 → validateToolArguments 校验
             → beforeToolCall 钩子(可 {block:true} 拦截)      (:600-664)
→ execute  : tool.execute(id, args, signal, onUpdate)          (:666-707)
→ finalize : afterToolCall 钩子(可覆写 content/details/isError/terminate)(:709-754)
→ tool_execution_end + ToolResultMessage(message_start/end 成对)
```

- 编排两模式(types.ts:42):`sequential` / `parallel`(默认);任一工具 `executionMode:"sequential"` 把整批降为串行(:419-424)。parallel 模式下 `tool_execution_end` 按完成序,tool-result 消息按 assistant 源序(types.ts:35-41)。
- **防御性范例**(:374-406):`stopReason==="length"` ⇒ 全部 toolCall 判失败不执行。注释:流式参数以 best-effort JSON 修复收尾,截断参数可能"通过校验但静默不完整"。= ADR-002「模型负责想、代码负责管」的实例。

### 3.6 错误即值(errors as values)

`StreamFn` 契约(types.ts:22-27):不许 throw/reject;失败必须编码进返回流(协议事件 + 终态 AssistantMessage `stopReason:"error"|"aborted"` + `errorMessage`)。全部钩子 docstring 同契约("must not throw or reject")。⇒ 失败以数据形态在事件流中流动,循环主体无 try/catch 包模型调用。代价:文档约定而非运行时强制(:40-51 无 `.catch`),违约钩子 = unhandled rejection。

### 3.7 扩展点:`AgentLoopConfig` 10 成员(types.ts:144-287)

| 成员 | 时机 | 用途 |
|---|---|---|
| `model` | 每次请求 | 当前模型(prepareNextTurn 可换) |
| `convertToLlm` **必选** | 请求前 | AgentMessage[]→Message[] |
| `transformContext` | convertToLlm 前 | 剪枝/注入 |
| `getApiKey` | 请求前 | 动态密钥 |
| `getSteeringMessages` | 每 turn 后 | **运行中插话** |
| `getFollowUpMessages` | agent 将停时 | 排队追问续跑 |
| `prepareNextTurn` | turn_end 后 | 换 context/model/thinkingLevel |
| `shouldStopAfterTurn` | 其后 | 优雅停 |
| `beforeToolCall` | 校验后 | 拦截(权限门挂载点) |
| `afterToolCall` | 执行后 | 覆写结果(脱敏/审计挂载点) |

另:`QueueMode`(types.ts:50)= 队列注入粒度 "all" / "one-at-a-time"。

## 4. 本课要点(供复述自检)

1. Pi 官方定位就是 **Agent Harness**;治理不在其 harness 边界内,Anna 在。
2. 三层 = ai / agent-core / coding-agent,依赖单向向下;产品行为经 `AgentLoopConfig` **注入**(IoC)。
3. 一个 turn = 一次 assistant 响应 + 其工具调用/结果;双层循环:内层管 turn,外层管 follow-up 续跑。
4. 循环唯一输出 = 10 种类型化事件;闭合性 + 统一消息生命周期;UI = 对事件流的 fold。
5. 模型边界两段变换 `transformContext → convertToLlm`;全程 `AgentMessage`,边界才降级。
6. 工具五段管线 prepare→execute→finalize,before/after 钩子是权限与审计的挂载点。
7. 错误即值:失败编码为 `stopReason`,不抛异常;契约靠文档不靠 runtime。
8. 插话(steering)与追问(follow-up)是循环一等公民 —— J3 的参考实现形态。
