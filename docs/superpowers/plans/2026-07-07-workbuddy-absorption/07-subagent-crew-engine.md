# W7 — SubAgent(one-shot 委派)+ Crew 接真引擎

> 对照物:WorkBuddy 模式A 直接子代理(one-shot:单次调用/上下文隔离/结果经 agent-notification 以 user-role 注入主 Agent,主循环无需特殊处理)+ 最小工具集/模型分档;模式B persistent team **本轮明确不做**(Anna 的 Crew 黑板已覆盖协调语义,先把"格子里的 agent 真能干活"补上)。
> Anna 现状:主 agent 无法 spawn 子 agent(全域无 delegate 工具);Crew 看板真实(depends_on/assignee/状态机=黑板模式,方向与 WorkBuddy TaskList 一致)但 AI 执行是空壳——`agent_worker.py:88` 每次只做一次 `tools=[]` 无工具补全,不走 ReAct。依赖 W2(子 agent 模型分档)、W4(权限模式随委派下传)。

**目标效果**:① Chat 主 agent 可调用 `agent.delegate` 把子任务交给一个隔离上下文、最小工具集、可指定档位的一次性子 agent,结果以观察注入主循环并在 trace 中呈现为可折叠子块;② Crew 的 run-agent 走真 ReAct 引擎(带该角色工具集与 skill),任务卡可点开真实 run trace;③ max_turns/审计/权限模式全链路生效。

## 现状锚点

| 事实 | 位置 |
|---|---|
| 引擎入口(子 agent 复用它) | `services/runtime/app/engine/`(QueryEngine/AgentLoop/CapabilityHandler 协议)、`query_config.py:43`(max_turns) |
| 工具观察注入模式(=notification 语义) | `agent_loop.py:186-189, 253-262`(工具结果以 user-role 拼回历史——子 agent 结果走同一通道,主循环零特殊处理,与 WorkBuddy 设计意图一致) |
| Crew 空壳 worker | `services/crew/app/agent_worker.py:71-88`(_produce 新建最小 system+user,tools=[] :88;同进程复用 AnnaHarnessRuntime :35-37) |
| Crew 域模型/API | `services/crew/app/schemas.py:7-10(TaskStatus), 48-56(CrewProject)`;`services/api/app/routes/crew.py:162-170(POST run-agent 同步)` |
| 各域 capability(子 agent 的能力宿主) | `services/{chat,finance,hiker}/app/capability.py` |
| vendored 参考件 | `vendor/hermes-agent/tools/delegate_tool.py`(只读参考,不 import) |

## 契约

**delegate 模块**(引擎层,新建 `services/runtime/app/engine/delegate.py`):

```python
@dataclass
class SubagentResult:
    status: Literal["completed", "failed", "exhausted"]
    summary: str                    # 子 agent 最终文本(代码门:≤2000 字,超长截断+标记)
    turns_used: int
    audit_events: list[dict]        # 供父 run 折叠展示,不并入父模型上下文

def run_subagent(*, handler_factory: Callable[[], CapabilityHandler], prompt: str,
                 settings, max_turns: int = 6, tier: str = "default",
                 permission_mode: str = "readonly") -> SubagentResult:
    """新建独立 QueryEngine+handler(完全隔离,不继承父对话,仅传 prompt——WorkBuddy 模式1);
    v1 强制 permission_mode="readonly"(子 agent 不许写,防审批嵌套);同步执行(单层,不嵌套)。"""
```

**工具 `agent.delegate`**(v1 只注册在 chat registry;schema 模型可见):

```json
{ "name": "agent.delegate",
  "description": "把一个独立子任务委派给专职子代理执行(如跨域数据查询)。子代理只读、上下文隔离、只返回结论。",
  "input_schema": { "type":"object", "properties": {
      "agent": { "enum": ["finance", "hiker"] },
      "task":  { "type":"string", "maxLength": 500 } },
    "required": ["agent","task"] } }
```

v1 委派目标 = finance/hiker 两个只读域(handler_factory 用各自 capability 以 readonly 模式构造)。这直接兑现路线图里「跨系统富查询」诉求:Chat 一问,子 agent 各查各域,主 agent 汇总。**代码门**:并发委派 v1 不做(循环内串行);单 run 委派上限 3 次(计数器,超限返回工具错误);子 agent 内禁止再 delegate(registry 不含该工具,天然成立)。

**trace 呈现**:委派期间父 run 发 `step{phase:"tool", tool:"agent.delegate", intent:"已委派 finance 子代理:…"}`(W1 帧);子 agent 的 audit_events 挂在 tool_done 帧载荷 `subagent_trace` 字段,前端折叠子块渲染(复用 StageStepTrace 递归一层)。审计 `agent.delegated {agent, turns_used, status}`。

**Crew 真引擎**:`AgentWorkerExecutor._produce` 改为——按任务角色映射域(role→{finance,hiker,chat} 的 handler_factory,同 delegate 的映射表)→ `run_subagent(prompt=任务 subject+description+验收标准, max_turns=8, tier=角色配置档)` → summary 作为产出提交看板 + `run_ref` 存 RunStore(W3)供任务卡回看。

## 任务分解

### Task 1: run_subagent(TDD)

**Files:** Create `services/runtime/app/engine/delegate.py`;Test `tests/runtime/test_delegate.py`(fake handler:completed/exhausted/异常→failed;隔离性:父历史不进子请求;readonly 强制)。

- [ ] Step 1:失败测试 → 实现 → PASS。
- [ ] Step 2:commit `feat(harness): W7.T1 — one-shot subagent runner (isolated, readonly)`。

### Task 2: agent.delegate 工具接入 chat(TDD)

**Files:** Modify `chat_tool_registry.py`(+agent.delegate)、`services/chat/app/capability.py`(dispatch 分支:构造目标域 readonly handler→run_subagent→观察=summary;计数门)、orchestrator(审计+subagent_trace 载荷);Test `tests/chat/test_delegate_tool.py`(委派上限/观察注入/审计)。

- [ ] Step 1:失败测试 → 实现 → PASS;全量 pytest。
- [ ] Step 2:FE:tool_done 帧 subagent_trace 折叠子块(vitest 纯函数);Playwright:问「对比 ERP 应收与 Hiker 合同额」看到两次委派子块。
- [ ] Step 3:commit `feat: W7.T2 — chat agent.delegate + nested trace`。

### Task 3: Crew worker 接真引擎(TDD)

**Files:** Modify `services/crew/app/agent_worker.py`(_produce→run_subagent;role→域映射表)、`services/crew/app/service.py`(产出含 run_ref);Modify `services/api/app/routes/crew.py`(run-agent 响应含 run_ref);FE `CrewPage.tsx`(任务卡「查看执行过程」→ 打开 run trace 弹层,复用 StageStepTrace);Test `tests/crew/test_agent_worker_engine.py`(fake:产出来自引擎 final、失败任务落 blocked 而非假完成)。

- [ ] Step 1:失败测试 → 实现 → PASS(Crew 既有测试全绿)。
- [ ] Step 2:FE 接线+走查:建 Crew 项目→run-agent→看板产出+可点开 trace。
- [ ] Step 3:commit `feat(crew): W7.T3 — kanban agents run the real ReAct engine`。

## 调用方式汇总

- 模型侧:chat 内自然语言即可触发(工具 schema 可见);强制演示:「分别查 finance 和 hiker 后对比」。
- API:Crew 沿用 `POST /api/crew/projects/{id}/tasks/{tid}/run-agent`,响应新增 `run_ref`。
- 配置:role→tier 映射先硬编码映射表(worker 用 default);后续挂 AgentCenter 配置(不在本 W)。

## 验收门

四门全绿;委派链路走查(含 max_turns 耗尽与目标域故障两个失败路径:主 agent 收到失败观察后能继续作答而非崩);Crew 任务真跑出带工具调用的产出;子 agent 全程无写工具(审计核对)。

## 风险与明确不做

- 嵌套/并发委派、persistent team、SendMessage、fork 继承——**全部不做**,留待 Crew 异步化轮(架构记忆「异步无状态并发」是那一轮的主题)。
- 同步委派拖长响应:max_turns=6+readonly 域都是快查询;超时由子 engine 既有超时管;若实测 >30s,砍 max_turns 而不是加并发。
