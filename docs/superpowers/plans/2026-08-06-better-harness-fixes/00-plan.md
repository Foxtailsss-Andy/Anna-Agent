# Better-Harness 修复轮 · 问题清单 + 优先级 + SPEC 修复计划(2026-08-06)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 better-harness 双路诊断报告(同级目录 `../2026-08-06-better-harness-diagnosis/report.md` + `findings.json`,13 条 4H/6M/3L),把 Anna 的 Agent Work Loop 从「只读观察面」补成「可执行、可中断续办、有总预算、能跨 episode 学习」的闭环,并修掉判断层/计划账本/声明面的一致性缺陷。

**Architecture:** 三波推进。P0 三件(耐久续办脊柱 → 执行面+审批门 → run 级总预算)全部落在既有 forge 引擎契约内:引擎侧只加 **opt-in 钩子与默认为 0 的预算字段**(非 opt-in surface 字节等价,四门+11 gate 是回归锁);chat 侧复用既有机器(`_prepare_resume` / seq 续接 / workdir 牢笼 / `CapabilitySuspend`)。P1 修判断层交付一致性与计划账本,P2 收声明面漂移 + 评测回填 + CI。

**Tech Stack:** Python 3.12 / FastAPI / SQLite(RunStore+FrameJournal)/ pydantic v2 / pytest(tests/gates 风格:FakeStreamModel 脚本化 + SQLiteRunStore(tmp_path) + BackgroundRunManager + asyncio.run)/ React+vitest(apps/desktop)。

## Global Constraints

- **解除上一轮约束**:pi-level-loop 轮的「不动 `agent_loop.py` 内核」到此为止——T1/T3 明确触碰 loop。代偿纪律:每个引擎改动必须是 **opt-in 钩子(getattr 模式,对齐 `on_tool_batch`/`humanize_step`/`drain_interjections` 先例)或默认 0/None 的字段**,不 opt-in 的 surface(finance/hiker/reimbursement/create)字节等价。
- ADR-002:模型负责想、代码负责管——一切用户可读标签、注入事实、预算数字均代码生成;模型输出过代码门。
- 诚实规则:错误观察原文照抄不美化;预算触顶如实说明;trace 不宣称不存在的东西。
- 每 task:RED→GREEN、独立 commit(只 stage 本任务文件)、四门不回退(基线 pytest 937 / tests/gates 35 / tsc 0 / vitest 632 / build ✓)。
- **评测回填纪律**(spec :99):每修一处,至少一条能拦住它的确定性 pytest;eval 真机只做复核。
- 建议分支:自 `fix/pi-level-loop`(或其并 main 后的 main)切 `fix/harness-p0`;P1/P2 可同分支续做或按波分支,由用户定。
- 报告的「不得据本报告主张」清单对本计划同样有效:本计划不主张 Anna 已能长程、不把 7 轮当 horizon 证据。

---

## 〇、术语框架(Cloudflare Agents 官方词表)

用户指定参考 Cloudflare 的 Agent Trace。核实后有两个同名物,本文采用第 2 个:

1. **Agent Trace 开放标准**(Cognition/Cursor RFC,2026-01-29,Cloudflare 为背书方)——代码库里 AI 贡献溯源(trace record 连接 code range↔conversation↔contributor)。是**代码归属**词表,与 harness 运行时诊断不对口,本文不用。
2. **Cloudflare Agents SDK 的 agent tracing**(2026-08-04 changelog + docs)——AI agent 运行时观测词表,基于 OTel GenAI semantic conventions。与 Anna 现有 trace(`trace_assembler.py` 已写 `gen_ai.operation.name` / `gen_ai.conversation.id`)天然同源,**本文全程用它**。

采用的官方术语(逐条有出处,均为原文):

| 术语 | 官方定义(Cloudflare Agents docs) | Anna 对应 |
|---|---|---|
| **Turn** | "one request to an agent and its response" | 一轮 model call + tool round |
| **Session** | "a conversation made up of one or more turns" | thread(`gen_ai.conversation.id` = thread_id) |
| **Trace / Span** | 一个 turn 内操作的瀑布;带时长与父子关系的计时操作 | `GET /api/chat/runs/{id}/trace` |
| **Span 四型** | `invoke_agent`(整 turn 父 span)/ `chat`(model call)/ `execute_tool`(tool run)/ `tool_approval`(审批生命周期) | Anna 有前三型;`tool_approval` 缺(F-01 补) |
| **Agent loop 四相** | **Observing**(观察当前状态)→ **Planning**(用 AI 推理决定动作)→ **Executing**(用工具执行)→ **Learning**("storing results in memory, updating task progress, preparing for next iteration") | 诊断的骨架:四相各有缺口(见下) |
| **HITL / durable gate** | "Human-in-the-loop (HITL) patterns add approval or input at different layers";"Pending approvals and execution history **survive** request completion and hibernation" | Anna 的 ask 门(今日只在 Create 存了字段、无拦截点) |
| **runtime context** | `cloudflare.agents.runtime_context.*`(标量上下文值挂 span) | Anna 有 `anna.turns` / `anna.context.percent_left`——但只给人看,agent 读不到 |
| **Payload 记录** | `storeMessages` / `storeTools`(默认关,隐私) | Anna 审计只带 hash 不带内容——同一取向,但产物字节因此没有第二份(F-02) |

---

## 一、问题清单(13 条,按官方术语定性)

> 事实与行号全部出自 `findings.json`(每条含 evidence/impact/repair/acceptance),本轮已逐条对源码复核,两处由行为推得的推论已坐实到源码:plan 整表替换(`plan_tool.py:10-14` 文档自认)、chat 无 ask 门(`create/schemas.py:73-75` 自认「无受门动作」)。五维分数:任务理解 62 / 可控执行 71 / 改动验证 48 / 可靠交付 41 / 经验沉淀 52。

| # | findings id | 官方术语定性 | 一句话 | 证据锚 | 严重度 |
|---|---|---|---|---|---|
| F-01 | no-execution-surface | **Executing 相缺位**:`execute_tool` 面无 shell/write/test,agent-verify loop 关不上;`tool_approval` 型 span 全仓不存在 | 8 张注册表 33 工具零执行零写盘;19 条 trace 只出现 3 个工具名 | chat_tool_registry.py:22-29;capability.py:61(read_file 是唯一 workdir 工具且只读) | High |
| F-02 | interrupted-run-unrecoverable | **durable execution 缺位**:中断非 durable——interrupted 是终态;产物只在内存,trace 与真实状态分叉(trace 宣称 `chat.artifact.emitted` 而字节已不存在) | 非优雅退出 → 记录活、工作死、产物蒸发 | run_store.py:234-275 + routes/chat.py:34,151-152 + capability.py:305-316 | High |
| F-03 | no-aggregate-run-budget | **Session 级预算缺位**:turn limit 只按段判定,每次续办/评估续段重置;无累计 turns/token/墙钟 | 一次请求最多 (1+3)×8 轮无人值守;H2 实测 token 18.8 倍膨胀无任何一层拦截 | query_config.py:58;agent_loop.py:269,357;orchestrator.py:834,900;routes/chat.py:153 | High |
| F-04 | no-cross-episode-learning | **Learning 相缺位**("storing results in memory…preparing for next iteration"):chat 从不检索记忆,无技能更新路径 | 8 次同题零状态传递;r1 同一失败路径原样重走三遍 | finance/orchestrator.py:511-520 有现成检索写法,chat 零命中;saved_memory_id 全 null | High |
| F-05 | eval-loop-not-enforced | **受理边界缺位**:无 CI,11 个 gate + 四门全靠人手,绿灯是一次性结果 | Route A 独立观测:"0 observed and 0 connected signals" | 无 .github/workflows;eval spec §5 自述 v0 人工触发 | Medium |
| F-06 | continuation-ships-superseded-draft | **交付一致性缺陷**(`gen_ai.output.messages` 语义):评估补办的 delta 被直接拼接到被推翻的初稿后 | G1-r2 同一条消息里「净利润未返回」+「净利润 118 万」并存,2/2 复现 | orchestrator.py:1345-1363 `_stitch_answer` + evaluator.py:325-332 nudge 要求差量 | Medium |
| F-07 | plan-ledger-replaced-not-merged | **Planning 相状态毁损**("updating task progress"):plan.update = FULL-TABLE replacement,尾项覆盖全表;被采纳插话从不入账 | 三次独立发生:count 4→4→1,完成度读 1/1=100% 而 3 项蒸发;两轮里计划从没正确表示过插话 | plan_tool.py:10-14,63-76(文档自认整表替换);schemas.py:54 | Medium |
| F-08 | chat-skill-contradicts-tool-surface | **`gen_ai.system_instructions` 与工具面矛盾**:全文注入的技能正文说四个工具里三个不存在 | 技能正文 2026-07-04 后从未随工具面更新;G1 run 实证矛盾抵达模型 | skills/chat/general-assistant/SKILL.md:15,30 vs registry 4 工具 | Medium |
| F-09 | agent-cannot-read-own-trace | **runtime context 不进 agent**(`cloudflare.agents.runtime_context.*` 的 Anna 对应缺位):人看瀑布,agent 盲飞 | 模型不知余轮/上下文占用/上轮失败;7 轮 episode 距上限 1 轮而无机器可读信号 | capability.py:552-593 提示词装配无预算;trace 有 `anna.turns` 却无人喂回 | Medium |
| F-10 | capability-misdirection-unasserted | **评测红线盲区**:红线只盖「编造数字」,不盖「编造能力」;INFRA 作废连红线都跳过 | r2 H2 把用户指向不存在的「Associate 邮件工具」仍判过;chat_run_021 1,661 字交付零断言 | eval-spec §1;runs/2026-08-06-r2/H2/notes.md:31-43 | Medium |
| F-11 | flagged-event-loses-payload | **span event 属性投影丢失**:`run.evaluation.flagged` 进 trace 时 `gaps: list[str]` 被标量过滤清空 | 指定证据面(trace)恰好丢掉 flagged 的唯一解释;verdict 同族字段却都在 | trace_assembler.py:139(`add_event` 只放行 `_SCALAR`) | Low |
| F-12 | chat-skill-picker-offers-unrunnable-skills | **跨域 skill 路由无校验**:选非 chat 技能 → 模型被指示调 chat 没有的工具 → `PermissionError` 杀 run;description 投影永空 | 代码可达已证(所有留档 run skill_id=null,未实际发生) | runtime_status.py:99-108 投影无 description;orchestrator.py:717 无校验;capability.py:261-264 治理错误刻意致死 | Low |
| F-13 | declared-surfaces-drift-from-registry | **工具声明漂移**:禁用了一个全仓不存在的工具;目录把 chat 报成零工具 | `erp.finance.write_back` 只存在于禁用行;catalog chat 硬编码 `[]` | skills/finance/operating-dashboard/SKILL.md:11,42;harness_catalog.py:52 | Low |

**长板不动**(报告证据支持,修复不得回退):工具错误观察化(F1/F1b,r2 已验证完整 failure→repair→revalidate 链)、判断层非橡皮图章、trace 人面(OTel 形状/重启可重建/5.6ms)、评测套件可比后窗规格。

---

## 二、优先级与依赖

**价值顺序**(= 报告 Operationalize 1→60 原序):F-01 → F-02 → F-03 → F-04 → F-05(无执行面则其余无意义;长跑必遇中断;有手之后无上限消耗才成真风险)。

**实现顺序**(按依赖倒装,避免返工):

```
P0  T1 F-02 耐久脊柱(checkpoint+interrupted 可续办+产物落盘)   ← 无依赖
    T2 F-01 执行面+审批门(exec/write 工具+awaiting_approval)   ← 审批续跑踩 T1 的 checkpoint
    T3 F-03 run 级总预算(turns/token/墙钟,累加不重置)          ← 无硬依赖,晚于 T2 使新权力受束
P1  T4 F-06 评估续答整份重写(不再拼接)                          ← 无依赖
    T5 F-07 plan 合并语义 + 插话入账                             ← 无依赖
    T6 F-09 运行预算注入提示词(廉价半)                           ← 依赖 T3 的预算字段
    T7 F-04 chat 接记忆检索(finance 样板)                        ← 无依赖
P2  T8 F-08+F-13 声明面一致性(SKILL 正文/幽灵禁用/catalog)       ← 晚于 T2(工具面变了才有对的可写)
    T9 F-11 trace flagged 属性投影                               ← 无依赖
    T10 F-12 技能选择器(description 投影+跨域拒绝)               ← 无依赖
    T11 F-10 评测回填(编造能力红线+INFRA 红线规则+E1 case)       ← E1 依赖 T2
    T12 F-05 最小 CI(四门+gates)                                 ← 最后,锁住全部
```

**需用户拍板的 5 个决策点**(实现前逐条确认):

1. **Phase C 边界**:T2 打开行动面。评测 spec §0 白纸黑字「编码/行动面任务(Phase C 后才有 bash/edit)不评」——报告判定这是「门槛不是缺陷」。本计划按报告最短路径把它纳入 P0,但**跨阶段边界必须你亲手拍板**;顺带定命令 allow-list 初值(本计划提案 `{"python", "pytest"}`,argv 直执无 shell)。
2. **预算默认值**(T3):run 累计 24 轮 / 150,000 tokens / 1,200s 墙钟;人工 continue = 追加一整份配额(自主续段不追加)。24 = 首段 8 + 评估补办 8 + 插话投递 8 的合法自主链上限,恰好扣住 (1+3)×8=32 的失控区。
3. **F-06 契约反转**(T4):`_stitch_answer` 的拼接本身是上一轮的修复(防 delta 覆盖初稿丢工作);本轮把评估补办的 nudge 契约从「补差量」改为「整份重写」并放弃拼接。方向相反,理由要你认可:拼接防丢、重写防矛盾,评测证明矛盾是真实发生的那个。
4. **审批粒度**(T2):v0 = per-run per-tool(批准一次 `workdir.write_file` = 本 run 后续同工具全放行)。粗,但确定性;arg 级 grant 留 Phase C。
5. **F-04 边界**(T7):只接检索;既有技能更新路径保持拒绝(`create/orchestrator.py:397-402` 不动,findings 原文要求单独授权)。

---

## 三、任务详规

### T1 · F-02 耐久脊柱:逐轮 checkpoint + interrupted 可续办 + 产物即落盘

**Files:**
- Modify: `services/runtime/app/engine/agent_loop.py`(两处 continue 站点后加 opt-in checkpoint 钩子)
- Modify: `services/chat/app/capability.py`(`on_turn_checkpoint` + `_emit_artifact` 落盘)
- Modify: `services/chat/app/orchestrator.py`(checkpoint 回调装配 + 终态清理)
- Modify: `services/api/app/routes/chat.py:151-168`(continue 接受 interrupted + 无快照回退)
- Modify: `services/chat/app/schemas.py:56-59`(`suspended_messages` 注释扩义,字段不变)
- Test: `tests/gates/test_gate_p2_restart.py`(扩写)+ `tests/test_chat_checkpoint.py`(新增 unit)

**Interfaces:**
- Produces(后续任务依赖):`ChatCapabilityHandler.__init__` 新增 keyword-only 参数 `checkpoint_run: Callable[[list[dict], int], None] | None = None`、`persist_run: Callable[[], None] | None = None`;engine 侧新 opt-in 钩子名 `on_turn_checkpoint(messages: list[dict], turn_count: int) -> None`(getattr 解析,契约:**绝不 raise**,安全性在 handler 侧包)。
- `run.suspended_messages` 语义扩为「最后可续接快照」:awaiting_continue 的暂停快照(原义)∪ 飞行中的逐轮 checkpoint(新义)。`_prepare_resume` 零改动即可消费。

**Steps:**

- [ ] **Step 1(RED · unit)**:新建 `tests/test_chat_checkpoint.py`,三条失败测试:

```python
"""T1 · F-02:逐轮 checkpoint / 产物即落盘 / interrupted 可续办(unit 半)。"""
from services.chat.app.capability import ChatCapabilityHandler
from services.runtime.app.model_provider import ModelToolCall
# fixture:照 tests/ 既有 ChatCapabilityHandler 单测的构造方式(搜 "ChatCapabilityHandler(" 现有用例,
# 复用其 skill/mcp_status/run/registry 假件),仅追加两个新参数。

def test_on_turn_checkpoint_forwards_and_swallows(chat_handler_factory):
    seen = []
    handler = chat_handler_factory(checkpoint_run=lambda msgs, turns: seen.append((msgs, turns)))
    handler.on_turn_checkpoint([{"role": "user", "content": "hi"}], 2)
    assert seen == [([{"role": "user", "content": "hi"}], 2)]
    boom = chat_handler_factory(checkpoint_run=lambda *_: (_ for _ in ()).throw(RuntimeError()))
    boom.on_turn_checkpoint([], 1)  # 绝不向引擎抛异常

def test_emit_artifact_persists_write_through(chat_handler_factory):
    calls = []
    handler = chat_handler_factory(persist_run=lambda: calls.append(1))
    handler.dispatch_tool(ModelToolCall(id="c1", name="chat.emit_document",
        arguments={"title": "报告", "markdown": "# 内容"}))
    assert handler.run.artifacts and calls == [1]

def test_engine_calls_checkpoint_each_turn(...):
    # QueryEngine + FakeStreamModel 脚本 2 轮(第 1 轮 plan.update,第 2 轮 final);
    # 断言 checkpoint 被调 ≥1 次,且末次 messages 含第 1 轮的 assistant tool_call 消息与观察。
```

- [ ] **Step 2**:跑 `python -m pytest tests/test_chat_checkpoint.py -q` → 预期 FAIL(参数/钩子不存在)。
- [ ] **Step 3(实现 · engine)**:`agent_loop.py` —— `handler_drain` 旁(≈:172)加一次性解析:

```python
        # F-02 耐久钩子(opt-in,getattr 模式同 on_tool_batch/drain_interjections):
        # 每个 turn 边界把「当前可续接快照」交给 handler。契约:钩子绝不 raise
        # (安全包裹在 handler 侧)——checkpoint 是簿记,永不伤 run。
        handler_checkpoint = getattr(handler, "on_turn_checkpoint", None)
```

两处 whole-rewrite continue 站点(nudge 拼接 `state = replace(...)` 之后 ≈:303,tool 拼接之后 ≈:383)各加:

```python
            if handler_checkpoint is not None:
                handler_checkpoint(state.messages, state.turn_count)
```

- [ ] **Step 4(实现 · capability)**:`ChatCapabilityHandler.__init__` 尾部追加两参数并存为 `self._checkpoint_run` / `self._persist_run`;新增方法:

```python
    def on_turn_checkpoint(self, messages: list[dict], turn_count: int) -> None:
        """F-02:引擎每 turn 边界回调 —— 快照落到 run 并写穿(绝不 raise)。"""
        if self._checkpoint_run is None:
            return
        try:
            self._checkpoint_run(list(messages), turn_count)
        except Exception:  # noqa: BLE001 — checkpoint 永不伤 run
            pass
```

`_emit_artifact` 在 `audit.append` 之后、return 之前加:

```python
        if self._persist_run is not None:
            try:
                self._persist_run()  # F-02:产物产生即落盘,不等终态
            except Exception:  # noqa: BLE001
                pass
```

- [ ] **Step 5(实现 · orchestrator)**:新增

```python
    def _checkpoint_run(self, run: ChatRun, messages: list[dict[str, Any]], turn_count: int) -> None:
        """F-02:turn 边界快照 → suspended_messages(扩义为「最后可续接快照」)+ 写穿。"""
        run.suspended_messages = messages
        self._persist_run(run)
```

三处 handler 构造(`_prepare_advance` / `_prepare_resume` / `_prepare_evaluator_resume`)各加:

```python
            checkpoint_run=lambda messages, turns: self._checkpoint_run(run, messages, turns),
            persist_run=lambda: self._persist_run(run),
```

`_resolve_outcome` 的 completed 分支改为(快照用完即清,ready 终态不携带陈旧快照):

```python
        if outcome.status == "completed":
            run.suspended_messages = None
            self._persist_run(run)
            return run
```

- [ ] **Step 6(实现 · routes)**:`BackgroundRunManager.continue_run` 状态闸与驱动源改为:

```python
        run = self._chat.get_run(run_id)
        if run.status not in ("awaiting_continue", "interrupted"):
            return run
        ...
        if run.suspended_messages:
            agen = self._chat.stream_resumed_run(run)
        else:
            # 首个 checkpoint 之前就中断(或旧数据):从原始请求重推进;
            # skip_history=True → watermark 越过已有审计,seq 照常续接。
            agen = self._chat.stream_existing_run(run, skip_history=True)
```

`_TERMINAL_CHAT_STATUSES` **保持含 interrupted**(stop 幂等/interject 拒收语义不变),只更新 :31-34 注释:interrupted 仍是「到达的终局」,但 continue 单独承认它可续办。

- [ ] **Step 7**:跑 Step 1 测试 → 预期 PASS。
- [ ] **Step 8(RED · gate)**:`test_gate_p2_restart.py` 追加:

```python
def test_gate_p2_interrupted_run_resumes_with_artifacts(tmp_path):
    """F-02 验收:重启后 interrupted 可续办、seq 连续、trace 宣称过的产物取得回。"""
    db_path = tmp_path / "anna-runs.sqlite3"
    store = SQLiteRunStore(db_path)
    # 模拟「死在飞行中但 checkpoint/产物已写穿」:直接注入一行 generating 的 run,
    # payload 带 artifacts + suspended_messages(与 T1 生产写穿后的形状一致)。
    payload = ChatRun(
        id="chat_run_mid", workspace_id="demo", actor_user_id="u_demo",
        message="做一份报告", thread_id="chat_run_mid", status="generating",
        artifacts=[{"id": "art_1", "kind": "doc", "title": "半成品", "content": "# 已产出章节"}],
        suspended_messages=[
            {"role": "system", "content": "Skill ..."},
            {"role": "user", "content": "做一份报告"},
            {"role": "assistant", "content": "先出第一章。"},
        ],
    ).model_dump(mode="json")
    store.save_run(surface="chat", run_id="chat_run_mid", thread_id="chat_run_mid",
                   workspace_id="demo", actor_user_id="u_demo", status="generating",
                   created_at="2026-08-06T00:00:00+00:00", payload=payload)

    restarted_store = SQLiteRunStore(db_path)
    assert restarted_store.mark_stale_interrupted("chat") == 1
    chat = _orchestrator(FakeStreamModel([_text_answer("续办完成,报告已补全。")]), restarted_store)
    manager = BackgroundRunManager(chat)
    healed = chat.get_run("chat_run_mid")
    assert healed.status == "interrupted"
    assert healed.artifacts  # trace 宣称过的产物,字节仍在

    last_seq = restarted_store.max_frame_seq("chat", "chat_run_mid")
    asyncio.run(_continue_and_await(manager, "chat_run_mid"))
    finished = chat.get_run("chat_run_mid")
    assert finished.status == "ready"
    assert finished.artifacts and finished.artifacts[0]["content"] == "# 已产出章节"
    frames = restarted_store.list_frames("chat", "chat_run_mid", last_seq)
    seqs = [f["seq"] for f in frames]
    assert seqs == list(range(last_seq + 1, last_seq + 1 + len(seqs)))  # 无重启为 1、无缺口

async def _continue_and_await(manager, run_id):
    await manager.continue_run(run_id)
    task = manager.get_task(run_id)
    assert task is not None
    await task
```

(文件顶部按既有 import 区补 `asyncio` / `ChatRun` / `BackgroundRunManager`;`_text_answer`/`_orchestrator` 该文件已有。)
- [ ] **Step 9**:`python -m pytest tests/gates/test_gate_p2_restart.py -q` → 新用例先 FAIL(continue 闸门未放行)再随 Step 6 实现 PASS;全文件 GREEN。
- [ ] **Step 10**:全量回归 `python -m pytest -q`(尤其 test_gate_continue / evaluator / interjection 不回退——checkpoint 只多写、不改行为)。
- [ ] **Step 11(FE 小步)**:`apps/desktop/src` 内以 `awaiting_continue` 为锚(HomePage.tsx / lib/api/chat.ts / useRunStream.ts 三文件已知含它),把「继续」按钮/文案的可见条件扩为 `status === "awaiting_continue" || status === "interrupted"`(interrupted 文案:「进程曾中断,可继续」);对应 vitest 断言同步扩。`npx tsc --noEmit` + `npx vitest run` 全绿。
- [ ] **Step 12**:Commit `fix(harness): F-02 逐轮 checkpoint + interrupted 可续办 + 产物即落盘`。

---

### T2 · F-01 执行面 + 审批门:workdir.run_command / workdir.write_file + awaiting_approval

> Cloudflare 词表对齐:补上 **Executing 相**与 **`tool_approval`**。审批 = durable gate:「pending approvals survive request completion」——落库、活过重启、批准后续跑。**前置:拍板点 1、4 已确认。**

**Files:**
- Modify: `services/chat/app/capability.py`(两个新工具 + 审批门 + step 标签)
- Modify: `services/chat/app/schemas.py`(status 加 `awaiting_approval`;新字段 permission_mode / approved_tools / pending_approval)
- Modify: `services/chat/app/orchestrator.py`(`_resolve_outcome` suspended 分支改判 awaiting_approval;`_begin_run`/`create_run`/`start_run` 透传 permission_mode)
- Modify: `services/api/app/schemas.py:108 附近`(`CreateChatRunRequest` 加 permission_mode——Create 已有同名同形字段可对照)
- Modify: `services/api/app/routes/chat.py`(submit 透传;新 `POST /api/chat/runs/{run_id}/approve`;续跑尾巴抽 `_resume_parked`)
- Modify: `services/runtime/app/run_store.py:36`(`RESUMABLE_RUN_STATUSES` += awaiting_approval)
- Modify: `services/runtime/app/config.py`(`workdir_exec_allowed_commands`,嵌套 `workdir_exec` 块,`_context_config` 孪生)
- FE: 审批卡(批准/拒绝两键)挂在 run 屏,锚 `awaiting_continue` 同批文件
- Test: `tests/gates/test_gate_exec.py`(新)
- 参考:workdir 测试假件照既有 `workdir.read_file` 用例(grep `resolve_valid_workdir` / `workdir.read_file` in tests/)

**Interfaces:**
- Consumes:T1 的 checkpoint(suspend 后 `run.suspended_messages` = 上一 turn 边界快照;批准后续跑重放当前 turn,模型重发工具调用,命中 grant 即执行)。
- Produces:`ChatRun.permission_mode: Literal["ask","bypass"]="ask"`;`ChatRun.approved_tools: list[str]`;`ChatRun.pending_approval: dict | None`;状态 `awaiting_approval`;审计事件 `chat.approval.requested/granted/denied`、`run.awaiting_approval`、`chat.workdir.command_executed`、`chat.workdir.file_written`;`ChatCapabilityHandler.__init__` 新参数 `exec_allowed_commands: frozenset[str] = frozenset()`。
- 工具契约(模型可见):
  - `workdir.run_command` `{"command": ["python","-m","pytest","-q"]}` —— argv 数组、无 shell、cwd=workdir 根、argv[0](basename 去 .exe 小写)∈ allow-list、超时 120s、stdout/stderr 各截 8,000 字符,观察返回 `{ok, exit_code, stdout, stderr, duration_ms}`;超时/不在清单 → **错误观察**(F1 纪律,不杀 run)。Windows 注:`shutil.which` 解析出 `.cmd/.bat` 的一律拒绝并如实说明(v0 不引入 shell 包装)。
  - `workdir.write_file` `{"path","content"}` —— 复用 `_read_workdir_file` 同款 `resolve()+relative_to(root)` 牢笼(capability.py:363-371),≤256KB,父目录可在根内自动创建,写后 `persist_run()` 落盘,观察返回 `{ok, path, bytes}`。

**Steps:**

- [ ] **Step 1(RED · gate)**:新建 `tests/gates/test_gate_exec.py`(头部假件照 `test_gate_continue.py`:`_CONFIGURED_SETTINGS`/`_ConnectedErpGateway`/`_orchestrator`/manager,settings 另加 `workdir_exec_allowed_commands=frozenset({"python"})`;workdir 假件照既有 read_file 用例注册一个 tmp workdir),四个场景:

```python
class _ExecScriptModel(FakeStreamModel):
    """轮1 写文件;轮2 跑命令拿非零退出码;轮3 读到 exit_code 后修正;轮4 收尾。
    respond() 按 messages 里最近一条 tool 观察分支(house 模式)。"""

def test_gate_exec_bypass_run_observe_fix_rerun(tmp_path):
    # permission_mode="bypass" 提交;断言:
    # ① workdir 里文件真实存在且内容一致;
    # ② 第一次 run_command 的观察含 exit_code != 0 与 stderr(模型可观察);
    # ③ 复跑后 exit_code == 0,run 终态 ready;
    # ④ 审计含 chat.workdir.file_written 与 ≥2 条 chat.workdir.command_executed。

def test_gate_exec_path_jail_rejected(tmp_path):
    # write_file path="../evil.txt" → 错误观察(路径越界),run 不 failed,盘上无文件。

def test_gate_exec_ask_parks_durable_and_resumes(tmp_path):
    # permission_mode 默认 ask:模型请求 write_file → run 停在 awaiting_approval,
    # pending_approval 带 tool 名;冷开新 store 实例读同一 DB → 审批请求活过重启
    # (durable gate);mark_stale_interrupted 不碰它(RESUMABLE);
    # manager.approve_action(run_id, "approve") → 续跑 → 模型重发同调用 → 命中 grant
    # → 文件写成 → ready;audit 含 approval.requested + approval.granted。

def test_gate_exec_deny_and_allowlist(tmp_path):
    # deny 分支:拒绝后续跑,模型改口如实说明,盘上无文件,audit 含 approval.denied;
    # allow-list:command=["curl","http://x"] → 错误观察「不在允许清单」,run 不死。
```

- [ ] **Step 2**:`python -m pytest tests/gates/test_gate_exec.py -q` → FAIL(工具不存在)。
- [ ] **Step 3(schemas)**:`ChatRunStatus` 加 `"awaiting_approval"`;`ChatRun` 加:

```python
    # F-01 行动面(Phase C 前移的最小闭环):审批档(Create 同形)+ per-run per-tool 授权。
    permission_mode: Literal["ask", "bypass"] = "ask"
    approved_tools: list[str] = Field(default_factory=list)
    # 停在 awaiting_approval 时的待批动作(code-generated 摘要,FE 审批卡直渲)。
    pending_approval: dict | None = None
```

`services/api/app/schemas.py` 的 `CreateChatRunRequest` 加同名字段(默认 "ask",Literal 挡非法值)。
- [ ] **Step 4(config)**:`RuntimeSettings` 加 `workdir_exec_allowed_commands: frozenset[str] = frozenset({"python", "pytest"})`,`from_env` 读 `runtime.json → workdir_exec: {allowed_commands: [...]}`(`_workdir_exec_config` 孪生 `_context_config`)+ env `ANNA_WORKDIR_EXEC_ALLOWED`(逗号分隔,env 优先)。
- [ ] **Step 5(capability · 工具本体)**:常量区加两工具定义(schema 见 Interfaces;description 中文,写明牢笼与 allow-list);`_CHAT_TOOL_STEP_LABELS` 加「正在执行工作空间命令」「正在写入工作空间文件」;`__init__` 加 `exec_allowed_commands` 参数;`dispatch_tool` 在 read_file 分支后加:

```python
        if (
            tool_call.name in (WORKDIR_RUN_COMMAND_TOOL_NAME, WORKDIR_WRITE_FILE_TOOL_NAME)
            and self.workdir_root
        ):
            suspend = self._approval_gate(tool_call)
            if suspend is not None:
                raise suspend
            if tool_call.name == WORKDIR_RUN_COMMAND_TOOL_NAME:
                return self._run_workdir_command(tool_call)
            return self._write_workdir_file(tool_call)
```

(实现 `_approval_gate`(bypass / approved_tools 放行;否则 pending_approval + 审计 `chat.approval.requested` + `self._persist_run()` 写穿(T1 参数,durable gate)+ 返回 `CapabilitySuspend("awaiting_approval", detail={"tool", "summary"})`)、`_run_workdir_command`(argv 校验→allow-list→`subprocess.run(argv, cwd=root, capture_output=True, text=True, timeout=120, shell=False)`→观察+审计;`TimeoutExpired`/`OSError` → 错误观察)、`_write_workdir_file`(牢笼→大小→写→审计→`persist_run()`→观察);`build_initial_request` 的 workdir 分支把三件工具一起挂。)
- [ ] **Step 6(orchestrator)**:`_resolve_outcome` 的 suspended 分支从 RuntimeError 改为:

```python
        if outcome.status == "suspended":
            # F-01 审批门:handler 以 CapabilitySuspend 停一次受门动作 —— durable gate,
            # 快照 = T1 的最后 turn 边界 checkpoint,批准后重放当前 turn。
            run.status = "awaiting_approval"
            self.audit.append(
                run.audit_events, "run.awaiting_approval", run.id,
                {"reason": outcome.message or "awaiting_approval",
                 "tool": (run.pending_approval or {}).get("tool")},
            )
            self._persist_run(run)
            return run
```

`_begin_run`/`create_run`/`start_run`/routes submit 全链路透传 `permission_mode`(`chat.run.created` 审计载荷加同名键,对照 Create :207 先例)。**另两处既有分支必须同扩(漏掉即误终局)**:`_stream_run_body` 尾部的终局帧分支 `elif final_run.status == "awaiting_continue": return` 改为 `elif final_run.status in ("awaiting_continue", "awaiting_approval"): return`(审批停驻不是 done,不发终局帧,journal 干净收口);同函数 `except GeneratorExit` 守卫的状态清单 `("ready", "failed", "saved", "awaiting_continue")` 加入 `"awaiting_approval"`(断连不得把健康停驻改判 client_disconnected)。
- [ ] **Step 7(routes)**:`RESUMABLE_RUN_STATUSES = frozenset({"awaiting_continue", "awaiting_approval"})`(run_store.py:36,注释补一句 durable gate);manager 抽公共续跑尾巴 `_resume_parked(run)`(= 现 continue_run 的 seq/journal/task 尾巴 + T1 的快照分支),`continue_run` 与新 `approve_action` 共用:

```python
    async def approve_action(self, run_id: str, decision: str) -> ChatRun:
        run = self._chat.get_run(run_id)
        if run.status != "awaiting_approval":
            return run  # 友好竞态,同 stop/continue
        tool = str((run.pending_approval or {}).get("tool") or "")
        if decision == "approve" and tool:
            if tool not in run.approved_tools:
                run.approved_tools.append(tool)
            self._chat.audit.append(run.audit_events, "chat.approval.granted", run.id, {"tool": tool})
        else:
            self._chat.audit.append(run.audit_events, "chat.approval.denied", run.id, {"tool": tool})
            run.suspended_messages = [*(run.suspended_messages or []), {
                "role": "user",
                "content": f"用户拒绝了 {tool} 操作。不要再尝试该操作;改用其他方式完成,或如实说明无法完成。",
            }]
        run.pending_approval = None
        return await self._resume_parked(run)
```

路由 `POST /api/chat/runs/{run_id}/approve`(body `{"decision": "approve"|"deny"}`,`_assert_run_access` 同款守卫)。
- [ ] **Step 8**:Step 1 gate 全 GREEN;`python -m pytest -q` 全量回归(finance/create 的 suspended RuntimeError 分支不动——只有 chat 改判)。
- [ ] **Step 9(FE)**:审批卡:`status === "awaiting_approval"` 时渲 `pending_approval.summary` + 批准/拒绝两键 → `POST .../approve`;文件锚同 T1 Step 11。tsc + vitest 绿。
- [ ] **Step 10**:Commit `feat(harness): F-01 workdir 执行面(run_command/write_file)+ awaiting_approval 审批门`。

---

### T3 · F-03 run 级总预算:turns / tokens / 墙钟,累加不重置,触顶 = awaiting_continue

**Files:**
- Modify: `services/runtime/app/engine/query_config.py`(6 个预算字段,默认 0=不限)
- Modify: `services/runtime/app/engine/capability.py`(`LoopOutcome` += `tokens_used: int = 0`、`wall_seconds: float = 0.0`)
- Modify: `services/runtime/app/engine/agent_loop.py`(段内累计 + 双站点判定 + `_exhausted_outcome` 带 reason)
- Modify: `services/runtime/app/config.py`(嵌套 `budget` 块)
- Modify: `services/chat/app/schemas.py`(`ChatRun` 6 个预算字段)
- Modify: `services/chat/app/orchestrator.py`(记账 + 三处 `QueryConfig` 传预算 + `grant_continuation_budget`)
- Modify: `services/api/app/routes/chat.py`(continue 先授新配额)
- Test: `tests/gates/test_gate_continue.py`(扩写)+ `tests/test_run_budget.py`(新增 unit)

**Interfaces:**
- Produces:`QueryConfig` 新字段 `run_turn_budget: int = 0`、`run_token_budget: int = 0`、`run_wall_clock_budget_seconds: float = 0.0`、`budget_turns_used: int = 0`、`budget_tokens_used: int = 0`、`budget_wall_seconds_used: float = 0.0`(全默认 0 → 其它 surface 字节等价);`LoopOutcome.tokens_used / wall_seconds`(段消耗,provider 报告值求和 / monotonic 差);`ChatRun` 六字段 `budget_{turns,tokens,wall_seconds}_{used,granted}`;`RuntimeSettings` `budget_enabled: bool = True`、`budget_run_turns: int = 24`、`budget_run_tokens: int = 150_000`、`budget_run_wall_clock_seconds: int = 1200`(`runtime.json → budget: {...}` + `ANNA_BUDGET_*` env);审计 `run.suspended` 的 reason 新增值 `run_budget_turns|run_budget_tokens|run_budget_wall_clock`。
- 语义钉死:**用与授分离**——used 跨段只增不减(评估补办、插话投递段同池记账);granted 只在**人工** continue 时追加一整份(`granted = used + settings 配额`);approve 续跑不追加。段内 `max_turns`(=8)照旧,是内层安全阀。

**Steps:**

- [ ] **Step 1(RED · unit)**:`tests/test_run_budget.py`:

```python
def test_loop_stops_on_cumulative_turn_budget():
    # QueryConfig(max_turns=8, run_turn_budget=5, budget_turns_used=3, suspend_on_exhaust=True)
    # + 永远 tool-loop 的 fake → outcome.status == "exhausted_suspended",
    # outcome.message == "run_budget_turns",outcome.turns == 2(段内只跑了 5-3=2 轮)。

def test_loop_accumulates_provider_tokens_and_wall_seconds():
    # fake 的 final chunk 带 input_tokens/output_tokens → outcome.tokens_used == 各轮之和;
    # outcome.wall_seconds > 0。未报告 usage 的轮贡献 0(诚实规则,不估算)。

def test_zero_budget_means_unlimited_byte_identical():
    # 全 0 预算 + 同脚本 → 与改动前同:跑满 max_turns 才停,message == "max_turns"。
```

- [ ] **Step 2**:跑 → FAIL。
- [ ] **Step 3(engine)**:`query_config.py` 加 6 字段(docstring 写明「run 级累计预算,0=不限;used 为先前段消耗的偏移」);`capability.py` 的 `LoopOutcome` 加 2 字段;`agent_loop.py`:
  - `run()` 开头:`import time` 已有与否按文件;`segment_tokens = 0`、`loop_started = time.monotonic()`;
  - final chunk 处理(≈:234)累计:`segment_tokens += (chunk.input_tokens or 0) + (chunk.output_tokens or 0)`;
  - 帮助函数:

```python
def _budget_stop_reason(config: QueryConfig, next_turn: int, segment_tokens: int, elapsed: float) -> str | None:
    """run 级累计预算判定(0=不限)。turn 用「下一轮开跑前」判,token/墙钟用「已消耗」判。"""
    if config.run_turn_budget and config.budget_turns_used + next_turn > config.run_turn_budget:
        return "run_budget_turns"
    if config.run_token_budget and config.budget_tokens_used + segment_tokens >= config.run_token_budget:
        return "run_budget_tokens"
    if config.run_wall_clock_budget_seconds and config.budget_wall_seconds_used + elapsed >= config.run_wall_clock_budget_seconds:
        return "run_budget_wall_clock"
    return None
```

  - 两个既有判定站点(:269 nudge 侧、:357 tool 侧)在 per-segment 检查后各加同款累计检查,命中 → `_exhausted_outcome(config, state.turn_count, <同站点相同的 messages 拼装>, reason=reason, tokens_used=segment_tokens, wall_seconds=time.monotonic()-loop_started)` + `yield {"type": "exhausted", "turns": ..., "reason": reason}`;
  - `_exhausted_outcome` 签名加 `reason: str = "max_turns"`、`tokens_used: int = 0`、`wall_seconds: float = 0.0`,message=reason,两个新值进 outcome;
  - **所有** outcome 构造点(completed/exhausted/failed/suspended,共 6 处)补 `tokens_used=segment_tokens, wall_seconds=time.monotonic()-loop_started`(失败/暂停也要记账——消耗已发生)。
- [ ] **Step 4(config/schemas)**:`RuntimeSettings` 四字段 + `_budget_config` 孪生 + env(`_int_setting_value` 非正即 None → `or 默认`;`budget_enabled` 走 `_bool_setting_value`);`ChatRun` 六字段全默认 0。
- [ ] **Step 5(orchestrator)**:
  - `_begin_run` 初始化 granted:`budget_enabled` 时 `run.budget_turns_granted = settings.budget_run_turns` 等三项,否则全 0(=不限);
  - 记账单点:

```python
    def _account_budget(self, run: ChatRun, outcome: LoopOutcome | None) -> None:
        """段终记账:used 只增不减;评估补办/插话投递段同池(F-03 累加纪律)。"""
        if outcome is None:
            return
        run.budget_turns_used += outcome.turns
        run.budget_tokens_used += outcome.tokens_used
        run.budget_wall_seconds_used += outcome.wall_seconds
```

  调用点:`_stream_run_body` 拿到 `outcome.value` 后、`_resolve_outcome` 之前;`_evaluation_rounds` 的 `_drive_continuation` 之后(`cont_outcome.value`);`_deliver_pending_interjections` 同;
  - 三处 `QueryConfig(...)` 构造各加:

```python
            run_turn_budget=run.budget_turns_granted,
            run_token_budget=run.budget_tokens_granted,
            run_wall_clock_budget_seconds=float(run.budget_wall_seconds_granted),
            budget_turns_used=run.budget_turns_used,
            budget_tokens_used=run.budget_tokens_used,
            budget_wall_seconds_used=run.budget_wall_seconds_used,
```

  - 新方法:

```python
    def grant_continuation_budget(self, run: ChatRun) -> None:
        """人工 continue = 用户亲手追加一整份预算(授予者是人,自主续段永不调用)。"""
        s = self.settings
        if not s.budget_enabled:
            return
        run.budget_turns_granted = run.budget_turns_used + s.budget_run_turns
        run.budget_tokens_granted = run.budget_tokens_used + s.budget_run_tokens
        run.budget_wall_seconds_granted = run.budget_wall_seconds_used + s.budget_run_wall_clock_seconds
```

  - routes `continue_run` 在续跑前调 `self._chat.grant_continuation_budget(run)`(approve_action 不调)。
- [ ] **Step 6**:Step 1 unit GREEN。
- [ ] **Step 7(RED→GREEN · gate)**:`test_gate_continue.py` 追加:

```python
def test_gate_budget_accumulates_and_caps(tmp_path):
    # settings 变体:budget_run_turns=3(其余门槛放大不干扰)。
    # 永远 tool-loop 的 fake:
    # ① 段1 在累计 3 轮处停 → awaiting_continue,run.suspended reason == "run_budget_turns"
    #   (不是 max_turns——段内 8 轮还没用完,是总闸先响);
    # ② budget_turns_used == 3;
    # ③ continue(人工授)→ granted 变 6 → 再跑 3 轮又停;used == 6,seq 仍连续;
    # ④ 全程无 chat.run.failed。

def test_gate_budget_counts_evaluator_continuation(tmp_path):
    # fake judge 强制一次 partial→补办;断言补办段的轮数进了同一 budget_turns_used
    # (两段之和),而 granted 未变(自主续段不授新)。judge 假件照 test_gate_evaluator.py。
```

- [ ] **Step 8**:全量回归(既有 gate 走默认 settings=24 轮配额,首段 8+评估 8+投递 8 ≤ 24 不受扰;`test_gate_continue` 原用例 continue 后有新授配额照常通过)。
- [ ] **Step 9**:Commit `feat(harness): F-03 run 级累计预算(turns/tokens/墙钟)——续段累加,触顶可续办`。

---

### T4 · F-06 评估续答整份重写(拼接退役)

**Files:** Modify `services/chat/app/evaluator.py:325-332` + `services/chat/app/orchestrator.py:1195,1091-1098`;Test `tests/gates/test_gate_evaluator.py`(扩写)。

**Steps:**

- [ ] **Step 1(RED)**:`test_gate_evaluator.py` 追加(fake judge/模型假件照该文件既有用例):

```python
def test_gate_continuation_replaces_superseded_draft(tmp_path):
    # 段1 答案:「净利润:本次查询未返回净利润的具体数值」;
    # judge 第一判 partial(0.95, gaps=["净利润未提供"]) → 补办;
    # 补办段模型输出整份修正答案:「2026年6月:收入 1,552 万元;净利润 约 118 万元。」;
    # judge 第二判 achieved。断言:
    # ① final assistant_message == 补办段整份答案(以续答为准);
    # ② "未返回" not in assistant_message(被推翻的断言不得残留);
    # ③ audit 里两条 verdict:partial(continuation_index 0) → achieved(1)。
```

- [ ] **Step 2**:跑 → FAIL(现拼接产物同时含两者)。
- [ ] **Step 3**:`evaluator_nudge_text` 改为(契约反转,拍板点 3):

```python
    listed = "、".join(gaps) if gaps else "任务未真正完成"
    return (
        f"评估发现未达成:{listed}。请补办缺口,然后把修正后的完整最终答案整份重新输出"
        "(它将直接替换你上一份答案;已被推翻的结论不得再出现)。"
    )
```

`orchestrator.py:1195` 删除 `self._stitch_answer(run, snapshot["assistant_message"])` 这一行(评估补办 = 整份替换,`on_assistant_final` 的覆盖即正确行为);**:1287 的插话投递段拼接保留**(插话是新增问答,拼接语义正确)。更新 `_evaluation_rounds` docstring :1096-1098 与 `_stitch_answer` docstring:写明「评估补办自 2026-08-06 起整份重写(G1-r2 自相矛盾证据),拼接仅存于插话投递段」——防止后人当 bug 修回去。
- [ ] **Step 4**:gate GREEN;全量回归(既有 evaluator gate 若 pin 了拼接行为,按新契约更新断言并在 commit message 注明)。
- [ ] **Step 5**:Commit `fix(chat): F-06 评估补办整份重写,替换而非拼接被推翻的初稿`。

---

### T5 · F-07 plan.update 合并语义 + 插话入账

**Files:** Modify `services/runtime/app/engine/plan_tool.py` + `services/chat/app/capability.py` + `services/chat/app/orchestrator.py`(投递段)+ `services/chat/app/schemas.py:54` 注释;Test `tests/test_plan_tool.py`(若无则新建)+ `tests/gates/test_gate_plan_gate.py` + `tests/gates/test_gate_interjection.py`(各扩写)。

**Steps:**

- [ ] **Step 1(RED · unit)**:

```python
def test_apply_plan_update_merges_by_id_never_deletes():
    current = [{"id": "1", "title": "查收入", "status": "done"},
               {"id": "2", "title": "查净利润", "status": "pending"}]
    merged = apply_plan_update(current, [{"id": "2", "title": "查净利润", "status": "done"}])
    assert merged == [{"id": "1", "title": "查收入", "status": "done"},
                      {"id": "2", "title": "查净利润", "status": "done"}]

def test_apply_plan_update_appends_new_and_stays_idempotent():
    once = apply_plan_update([], [{"id": "1", "title": "t", "status": "pending"}])
    assert apply_plan_update(once, [{"id": "1", "title": "t", "status": "pending"}]) == once

def test_apply_plan_update_merged_size_gate():
    # current 19 项 + payload 2 个新 id → 合并 21 > MAX_PLAN_ITEMS → PlanUpdateError。
```

- [ ] **Step 2**:跑 → FAIL(现为整表替换)。
- [ ] **Step 3**:`apply_plan_update` 改合并语义(逐项校验门**原样保留**:必填字段/id 非空/payload 内去重/title 长度/status 闭集):

```python
    merged: list[dict] = [dict(item) for item in current]
    index = {str(item.get("id")): i for i, item in enumerate(merged)}
    for item in normalized:
        if item["id"] in index:
            merged[index[item["id"]]] = item
        else:
            merged.append(item)
    if len(merged) > MAX_PLAN_ITEMS:
        raise PlanUpdateError(f"合并后计划超过 {MAX_PLAN_ITEMS} 条(当前 {len(merged)} 条)")
    return merged
```

模块 docstring「Semantics: FULL-TABLE replacement」段、`PLAN_UPDATE_DESCRIPTION`、schemas.py:54 注释三处同步改写:「按 id 合并(upsert):只提交有变化的项,未提交的项保持不变,永不静默删除」。
- [ ] **Step 4(插话入账)**:`capability.py` 新增:

```python
    def _register_interjection_in_plan(self, text: str) -> None:
        """J3×J1:被采纳的插话登记为计划项 —— 账本必须看得见它(F-07b)。"""
        if len(self.run.plan) >= 20:
            return  # 满表不挤占模型的项;插话仍会被兑现,只是不再入账
        seq = sum(1 for i in self.run.plan if str(i.get("id", "")).startswith("interjection-")) + 1
        self.run.plan.append({"id": f"interjection-{seq}",
                              "title": ("插话:" + text)[:60], "status": "in_progress"})
        done = sum(1 for i in self.run.plan if i["status"] == "done")
        self.audit.append(self.run.audit_events, "plan.updated", self.run.id,
                          {"count": len(self.run.plan), "done_count": done, "items": list(self.run.plan)})
```

调用点:`drain_interjections` 对每条取走的 text、`_interjection_nudge` 对取走的队首各调一次。`orchestrator._deliver_pending_interjections`:投递段开跑前对 `first_text` 登记(经 handler 不可达,直接以同形代码在 orchestrator 内联或抽模块函数复用);`delivered` 分支把**该项**状态翻 `done` 并补一条同形 `plan.updated` 审计。
- [ ] **Step 5(RED→GREEN · gates)**:`test_gate_plan_gate.py` 追加「只带末项的 plan.update 之后,先前各项仍在且状态不变;PlanGate 完成度按全量清单判」;`test_gate_interjection.py` 追加「被采纳插话出现在最终 `run.plan`,投递成功的状态为 done」。
- [ ] **Step 6**:全量回归(既有用例若 pin 整表替换行为,按新语义更新并注明)。
- [ ] **Step 7**:Commit `fix(harness): F-07 plan.update 改按 id 合并 + 被采纳插话登记入计划账本`。

---

### T6 · F-09 运行预算注入提示词(agent 不再盲飞的廉价半)

**Files:** Modify `services/chat/app/capability.py`(注入 + 纯函数)+ `services/chat/app/orchestrator.py`(三处 handler 构造传值);Test `tests/test_chat_capability.py` 系(新增断言用例)。跨 run trace 关联与 agent 侧遥测读取工具**本任务明确不做**(findings 原文排除,留 Phase C 设计)。

**Steps:**

- [ ] **Step 1(RED)**:unit:构造 handler(`budget_note` 传入代码生成串)→ `build_initial_request().messages[0]["content"]` 含 `[运行预算]` 与数字;不传 → 提示词与之前字节等价。
- [ ] **Step 2**:capability 新增模块级纯函数(ADR-002,orchestrator/测试同源):

```python
def build_budget_note(*, segment_max_turns: int, run_turns_used: int, run_turns_granted: int,
                      context_percent_left: int | None) -> str:
    """F-09:机器可读预算注入(值与 QueryConfig/trace anna.* 同源,代码生成)。"""
    lines = [f"[运行预算] 本段最多 {segment_max_turns} 轮。"]
    if run_turns_granted:
        lines.append(f"整个 run 的轮数预算 {run_turns_granted},已用 {run_turns_used}。")
    if context_percent_left is not None:
        lines.append(f"上下文窗口剩余约 {context_percent_left}%。")
    lines.append("接近预算时优先收尾交付;未完成部分如实说明,不要为凑轮数注水。")
    return "\n".join(lines)
```

`__init__` 加 `budget_note: str | None = None`;`_chat_messages` 在 Boss 指令之后、时间事实之前注入(时间事实仍压轴,KV-cache 注释照旧成立);orchestrator 三处构造传 `budget_note=build_budget_note(segment_max_turns=MAX_CHAT_MODEL_TOOL_ROUNDS, run_turns_used=run.budget_turns_used, run_turns_granted=run.budget_turns_granted, context_percent_left=None)`——`context_percent_left` v0 先传 None,待定位 `context_usage(messages, window)`(context_compaction.py:200)在装配尾的可行接线后一并填(实现时若 window 解析超过半天即留 None + TODO 注释,诚实优先于凑全)。
- [ ] **Step 3**:GREEN + 回归(resume/evaluator 段快照起跑不再重组 system,注入只在首段与 fallback 重推进段生效——如实,不伪造)。
- [ ] **Step 4**:Commit `feat(chat): F-09 运行预算注入 system prompt——模型知道自己还剩几轮`。

---

### T7 · F-04 chat 接记忆检索(Learning 相 · 扩既有不造新)

**Files:** Modify `services/chat/app/orchestrator.py`(检索 + 审计)+ `services/chat/app/capability.py`(注入段);Test `tests/test_chat_memory_recall.py`(新)。

**Steps:**

- [ ] **Step 1(RED)**:

```python
def test_chat_recalls_saved_correction_on_next_same_goal_run(tmp_path):
    # 真 BusinessMemoryStore(tmp sqlite):第一跑 ready 后 save_result 沉淀;
    # 第二跑同 workspace 同题,用可捕获 messages 的 fake stream:
    # 断言 system prompt 含 [业务记忆] 段与沉淀内容,audit 含 chat.memory.recalled {count:1};
    # 无命中时零注入零审计(字节等价)。
```

- [ ] **Step 2**:orchestrator 照 finance :511-520 抄样板:

```python
    def _business_memory_context(self, run: ChatRun) -> str:
        if self.memory_store is None:
            return ""
        memories = self.memory_store.search(run.workspace_id, run.message, limit=5)
        if not memories:
            return ""
        return "\n".join(
            f"- [{m.memory_type}] {m.title}: {m.content} (source={m.source}, confidence={m.confidence:.2f})"
            for m in memories
        )
```

`_prepare_advance` 在 history 组装后取值,非空则审计 `chat.memory.recalled {count}`,经新参数 `memory_context_text` 传 handler;`_chat_messages` 在 Deliverables 段后注入:

```python
        if self.memory_context_text:
            system_content += (
                "\n\n[业务记忆](历史沉淀,带出处;若与当前工具实查结果冲突,以实查为准):\n"
                + self.memory_context_text
            )
```

生产装配处确认 chat 的 `memory_store` 已注入(save_result 能用即已注入;若 main.py 装配缺失则补线)。
- [ ] **Step 3**:GREEN + 回归。评测重复题 case 落 T11 的 spec 增补。
- [ ] **Step 4**:Commit `feat(chat): F-04 记忆检索接入 chat prompt(finance 同款样板)`。

---

### T8 · F-08 + F-13 声明面一致性(晚于 T2)

**Files:** Modify `skills/chat/general-assistant/SKILL.md` + `skills/finance/operating-dashboard/SKILL.md`(删 :11/:42 的 `erp.finance.write_back` 两行)+ `services/runtime/app/harness_catalog.py:52`;Test `tests/test_declared_tool_surfaces.py`(新)。

**Steps:**

- [ ] **Step 1(RED)**:新测试三条:
  ① 全仓每个 SKILL.md frontmatter 的 allowed/forbidden 工具名 ∈(五张注册表工具名 ∪ hiker `FORBIDDEN_HIKER_MCP_TOOLS` ∪ workdir 内建三件)——`erp.finance.write_back` 当场打红;
  ② chat SKILL 正文反引号内的工具名 ⊆ chat 可见集(CHAT_ALLOWED_TOOLS ∪ workdir 三件),且正文不得包含「Chat exposes only」这类被 T2 后事实推翻的唯一性断言(以「exposes only」子串断言);
  ③ `build_harness_catalog()` 里 `chat.general_assistant` 的 `model_visible_tools == sorted(CHAT_ALLOWED_TOOLS)`。
- [ ] **Step 2**:改 catalog(`_tool_names(ChatToolRegistry().model_visible_tools())` + import;注释注明 workdir 条件工具不入静态目录);删 finance SKILL 幽灵禁用两行;重写 chat SKILL 工具段与 Safety 段(与 T2 后事实一致):

```markdown
## Tools

Chat exposes: `erp.finance.query`(只读 ERP 财务问答)、`chat.emit_page` / `chat.emit_document`
(正式产物提交)、`plan.update`(任务计划清单,按 id 增量更新)。挂了工作空间的 run 另有
`workdir.read_file` / `workdir.write_file` / `workdir.run_command`(全部限定在工作空间根内,
写与执行受审批档 permission_mode 约束)。

## Safety

- Only claim ERP data that came back from an `erp.finance.query` tool result.
- Do not claim that an external action was completed.
- Do not invent tool results, customer records, amounts, or document IDs.
- ERP write-back is not available in Chat; direct users to Cowork/Associate for ERP writes.
```

- [ ] **Step 3**:GREEN + 全量回归(技能 content_hash 变化若碰碎 pin 测试,如实更新)。
- [ ] **Step 4**:Commit `fix(skills): F-08/F-13 技能正文与工具面对齐 + 幽灵禁用清除 + catalog 真值化`。

---

### T9 · F-11 trace flagged 属性投影

**Files:** Modify `services/runtime/app/trace_assembler.py:138-140`;Test `tests/gates/test_gate_trace.py`(扩写)。

**Steps:**

- [ ] **Step 1(RED)**:gate 追加:一条 `run.evaluation.flagged {gaps:["净利润未提供"]}` 审计帧进装配 → 对应 span event 的 `attributes["gaps"] == ["净利润未提供"]`,与审计一致;另断言任意嵌套 dict 载荷仍被滤掉(纪律不放松)。
- [ ] **Step 2**:`add_event` 的过滤改为窄放行「全字符串短列表」(gaps 已被 parse_verdict 钳 ≤5×120,`finish_reasons` 是既有数组先例):

```python
    def _attr_value(value: Any) -> Any:
        if isinstance(value, _SCALAR):
            return value
        if isinstance(value, list) and len(value) <= 8 and all(isinstance(x, str) for x in value):
            return [x[:200] for x in value]  # 字符串序列窄放行(gaps);嵌套载荷仍拒
        return None

    def add_event(target: _Span, name: str, at: datetime, attributes: dict[str, Any]) -> None:
        scalars = {k: v2 for k, v in attributes.items() if (v2 := _attr_value(v)) is not None}
        target.events.append({"name": name, "time": at.isoformat(), "attributes": scalars})
```

- [ ] **Step 3**:GREEN + 回归;Commit `fix(trace): F-11 flagged 的 gaps 进 span event 属性——只看 trace 也知道缺口`。

---

### T10 · F-12 技能选择器:description 投影 + 跨域如实拒绝

**Files:** Modify `services/runtime/app/skill_loader.py`(frontmatter 解析 `description`,容缺省)+ `services/api/app/projections/runtime_status.py:99-108` + `services/chat/app/orchestrator.py`(提交守卫)+ `services/api/app/routes/chat.py`(422)+ 各 SKILL.md 补 `description:` 一行 + FE(HomePage.tsx 选择器过滤 chat/ 域;HomeComposer.tsx:452 已渲 description,无需改);Test 新增 unit + vitest。

**Steps:**

- [ ] **Step 1(RED)**:① `_skill_registry_item` 输出含 `description`(loader 无值时空串);② orchestrator:`create_run(..., skill_id="hiker/global-customer")` raise `ChatSkillNotAllowedError`;③ TestClient:submit 带跨域 skill_id → 422,detail 含技能名;`skill_id=None` / `chat/...` 照常。
- [ ] **Step 2**:loader 解析 frontmatter `description`(缺省 "")挂 `LoadedSkill.description`(先确认解析器对未知键的既有容忍;严格则同步放宽);投影加一键;orchestrator:

```python
class ChatSkillNotAllowedError(Exception):
    def __init__(self, skill_id: str) -> None:
        super().__init__(skill_id)
        self.skill_id = skill_id
```

`create_run` 与 `start_run` 开头(`_begin_run` 之前,run 未创建即拒绝):

```python
        if skill_id and not skill_id.startswith("chat/"):
            raise ChatSkillNotAllowedError(skill_id)
```

routes submit/create 捕获 → `HTTPException(422, detail=f"skill '{exc.skill_id}' 不适用于 Chat;请选择 chat/ 域技能")`。五个 SKILL.md 各补一行 `description:`(chat 例:`轻量企业对话:总结/分析/计划,含只读 ERP 财务问答`)。FE 选择器数据源过滤 `id.startswith("chat/")`。
- [ ] **Step 3**:GREEN + tsc/vitest;Commit `fix(chat): F-12 技能选择器只列可跑技能+带 description,跨域提交 422 如实拒绝`。

---

### T11 · F-10 评测回填:编造能力红线 + INFRA 红线规则 + 新 case

**Files:** Modify `evals/v0-smoke/00-eval-spec.md`;Create `evals/v0-smoke/lib/assertions.py` + `tests/evals/test_capability_misdirection.py`。

**Steps:**

- [ ] **Step 1(spec 增补,一次 commit 内完成)**:
  - §1 红线行改:「**编造数字或编造能力**(答案把用户指向注册表中不存在的工具/能力)= 整案 FAIL,标 `FABRICATION` / `CAPABILITY_MISDIRECTION`,一票否决」;
  - §2 补第 5 条:「INFRA 作废只免除能力计分,**红线检查照跑**(chat_run_021 教训:1,661 字交付零断言)」;
  - H2 增 A3:「答案中提到的任何 Anna 工具/能力名必须能在 8 张注册表 ∪ workdir 内建工具里找到,否则 `CAPABILITY_MISDIRECTION`」;
  - 新 case **E1 · 执行闭环**(标注:Phase C 门开 = T2 落地后启用):挂 workdir 提交「在工作空间里跑 `python -m pytest`,若失败修到通过」→ A1 trace 含 `workdir.run_command` execute_tool span ≥2 次且末次 exit_code=0;A2 中途出现过非零退出码的观察(真修复不是一把过);A3 文件改动可在 workdir 复核。
- [ ] **Step 2(可回放断言)**:`assertions.py`:

```python
KNOWN_TOOL_TOKENS: frozenset[str]  # 代码内枚举:8 张注册表工具名 ∪ workdir 三件(import 各 registry 拼装)
_CAPABILITY_CLAIM_RE = re.compile(r"(邮件工具|发送邮件功能|email\s+tool|mail\s+tool)", re.IGNORECASE)

def capability_misdirection(answer_text: str) -> list[str]:
    """返回命中的「装会」证据串;空列表 = 通过。两类检查:
    ① 工具名形状 token(\b[a-z_]+\.[a-z_.]+\b)不在 KNOWN_TOOL_TOKENS;
    ② 已知编造话术清单(H2 实例:邮件类)。清单化 = 确定性;泛化识别不承诺(v0 人判兜底)。"""
```

`tests/evals/test_capability_misdirection.py`:读 `evals/v0-smoke/runs/2026-08-06-r2/H2/run.json` 的 assistant_message → 断言命中(该答案必 FAIL);对 r2 其余 7 案回放 → 全零误报。
- [ ] **Step 3**:GREEN;Commit `test(evals): F-10 编造能力红线 + INFRA 红线规则 + E1 执行闭环 case`。

---

### T12 · F-05 最小 CI(收官,锁住全部)

**Files:** Create `.github/workflows/gates.yml`。

**Steps:**

- [ ] **Step 1**:五步工作流(报告原文范围,不引入发布/打包/外部写):

```yaml
name: gates
on: [push, pull_request]
jobs:
  gates:
    runs-on: windows-latest   # 仓库在 Windows 上开发;若全部步骤 OS 无关可换 ubuntu 提速
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: pip install -e .   # 仓库根是 pyproject.toml(已核);实现时确认 pytest 等 dev 依赖是否要 [dev] extra 或单独 pip install pytest httpx
      - run: python -m pytest tests/gates -q   # 11+ gate 单独成步,红灯先定位这里
      - run: python -m pytest -q
      - run: npm ci
        working-directory: apps/desktop
      - run: npx tsc --noEmit
        working-directory: apps/desktop
      - run: npx vitest run
        working-directory: apps/desktop
      - run: npx vite build
        working-directory: apps/desktop
```

- [ ] **Step 2(反向验证,不提交)**:本地故意改红一个 gate → `python -m pytest tests/gates -q` 出红 → 还原。工作流真跑通需 GitHub remote(仓库拟开源,推上去当天即生效;没有 remote 前它是待命文件——如实记录,不宣称已有 CI)。
- [ ] **Step 3**:Commit `ci: F-05 四门+gates 最小工作流——红灯挡合并`。

---

## 四、验收(整轮)

1. **四门**:`python -m pytest -q`(≥937+新增)/ `python -m pytest tests/gates -q`(≥35+新增,13 个 gate 文件)/ `npx tsc --noEmit` 0 / `npx vitest run`(≥632+新增)/ `npx vite build` ✓。
2. **评测 v0 r3 真机重跑**(spec §4 /submit 路径,T2 后含 E1):目标——G1 一致性(F-06 不再自相矛盾)、J1 计划全量账本、S1 插话入账、H2 A3 新红线过、E1 执行闭环首绿;翻不绿的如实记 residual。
3. **trace 复检**:一次 flagged run 的 trace 里看得到 gaps;一次 ask 审批 run 的 trace 里看得到 `chat.approval.requested/granted` 事件与 `awaiting_approval` 帧(Cloudflare `tool_approval` 对应)。
4. **五维预期**(下次 better-harness 复评的方向,不承诺分数):改动验证 48↑(执行面+验证环)、可靠交付 41↑(耐久+CI)、经验沉淀 52↑(检索)、可控执行(总预算)、任务理解(账本+声明面)。
