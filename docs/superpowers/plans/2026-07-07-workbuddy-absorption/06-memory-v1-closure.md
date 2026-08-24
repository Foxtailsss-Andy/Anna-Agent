# W6 — Memory v1 验收闭环 + memorySelector 预筛

> 对照物:WorkBuddy 三层记忆 + memorySelector(lite,零工具,每次查询预筛 ≤5 条,「不确定就不要选」宁漏勿误);哲学是「记忆越准越好」而非越多越好。
> Anna 现状:Business Memory 雏形已跑(SQLite store + admin 路由 + finance 注入),但**读写不对称**(chat 只写不读、finance 只读不写)、**无命中审计**(PRD v1.1 §4 验收要求「审计含 memory 命中记录」未达标,见 `docs/product/Anna_PRD_V1_1_Amendment.md:47`)、检索是 SQL LIKE+n-gram 无模型参与、无管理 UI(仅创建表单)。R3 的 Memory v1 就是本 W。依赖 W2(lite 档);W3 完成后价值更大(多轮里记忆可持续生效)。

**目标效果**:① chat 也读记忆(与 finance 同范式),回答能引用工作区沉淀;② finance 的确认结论也能沉淀;③ 每次命中产生审计 `memory.hits`,trace 显示「记忆命中 N 条」;④ 候选 >5 条时 lite 模型预筛,≤5 条注入;⑤ 设置页可列表/编辑/删除记忆。

## 现状锚点

| 事实 | 位置 |
|---|---|
| store + 检索(LIKE/n-gram) | `services/memory/app/store.py:10-134(表结构 116-127), 73-97(search), 154-183(fuzzy)`;schema `services/memory/app/schemas.py:8-26` |
| 装配与注入路径(finance 读) | `services/api/app/main.py:70-81,173-175`;`services/finance/app/orchestrator.py:511-521`(search limit=5);`services/finance/app/capability.py:203-204`(拼 user 消息)+ 防注入护栏 :210-213 |
| chat 写(只写不读) | `services/chat/app/orchestrator.py:261-268`(save_result → memory_type="chat_result") |
| admin 路由(仅 GET/POST) | `services/api/app/routes/admin_governance.py:148-183` |
| FE 仅创建表单 | `apps/desktop/src/features/admin/RuntimeStatusPage.tsx:665-703`(GovernancePanel) |
| lite 补全地基 | `services/runtime/app/aux_tasks.py`(W2 产物) |
| 库文件 | `.anna/state/anna-memory.sqlite3`(路径 config.py:56,358-363) |

## 契约

**memory.hits 审计事件**(读侧统一发,finance/chat 同):`{ memory_ids: [..], count, query_hash, selector: "sql" | "lite" }`。

**memorySelector**(aux_tasks 新函数,WorkBuddy MEMORY-SELECTOR-INSTRUCTIONS 同思路):

```python
def select_memories(settings, question: str,
                    candidates: list[tuple[str, str]]) -> list[str] | None:
    """candidates=[(id, title+content 首 80 字)]。lite 模型返回 {"selected_ids": [...]}。
    代码门:JSON 解析失败→None;ids 必须 ⊆ 候选集;上限 5;空数组合法(宁漏勿误)。
    None → 调用方回退 SQL 排序前 5(现状行为,永不因 selector 失败而丢功能)。"""
```

selector prompt 要点(常量进 aux_tasks):只按相关性选、不确定不选、只输出 JSON。触发条件:SQL 初筛候选 >5 条才调用(≤5 条直接用,省成本——WorkBuddy 同款「错误成本低」设计)。

**读写补全**:chat orchestrator 在 build 请求前照抄 finance 模式(search→selector→memory_context 传入 capability;chat capability 需新增 memory_context 参数与护栏段,照抄 `finance/app/capability.py:203-213`);finance 增加 `save_result` 沉淀(memory_type="finance_insight",仅当 run 正常完成且用户在 FE 点「存为记忆」——**显式动作,不自动全存**,防噪声)。

**管理路由补全**:`PUT /api/admin/memory/business/{id}`、`DELETE /api/admin/memory/business/{id}`(store 补 update/delete 方法)。

## 任务分解

### Task 1: memory.hits 审计 + chat 读接线(TDD)

**Files:** Modify `services/chat/app/{orchestrator,capability}.py`、`services/finance/app/orchestrator.py`(发事件);Test `tests/chat/test_memory_read.py`、`tests/finance/test_memory_hits_audit.py`。

- [ ] Step 1:失败测试——预置记忆→chat run 的模型请求含 memory 段+护栏;audit 含 memory.hits(两面)→ 实现 → PASS。
- [ ] Step 2:commit `feat(harness): W6.T1 — chat memory read + memory.hits audit`(PRD §4 验收闭环点)。

### Task 2: memorySelector 预筛(TDD)

**Files:** Modify `services/runtime/app/aux_tasks.py`(select_memories);Modify chat/finance orchestrator(>5 候选走 selector);Test `tests/runtime/test_memory_selector.py`(JSON 门/子集门/None 回退/≤5 不触发)。

- [ ] Step 1:失败测试 → 实现 → PASS;审计 selector 字段区分 sql/lite。
- [ ] Step 2:commit `feat(harness): W6.T2 — lite memorySelector prefilter`。

### Task 3: finance 沉淀 + 管理 UI(前后端)

**Files:** Modify `services/finance/app/orchestrator.py`+route(存为记忆端点)、`services/memory/app/store.py`(update/delete)、`admin_governance.py`(PUT/DELETE);FE:`RuntimeStatusPage.tsx` 记忆分组扩成列表(标题/类型/时间/编辑/删除)+ FinanceQa 答案卡「存为记忆」按钮;trace 标签:`memory.hits` → 「记忆命中 N 条」。Test:store 增删改 pytest + FE 纯函数 vitest。

- [ ] Step 1:后端 TDD → PASS;FE 接线走查。
- [ ] Step 2:commit `feat: W6.T3 — memory write path + management UI`。

## 调用方式汇总

- 读:自动(chat/finance 每 run);写:chat 自动沉淀结论(既有)+ finance 显式「存为记忆」+ Admin 手工。
- 管理:`GET/POST/PUT/DELETE /api/admin/memory/business[/{id}]`。
- 观测:trace「记忆命中」行;审计 memory.hits(PRD 验收凭据)。

## 验收门

四门全绿;走查:录入记忆「Q3 报销上限 5000」→ chat 问相关问题 → 回答引用且 trace 显示命中;>5 条候选时审计 selector="lite";删掉记忆后不再命中。PRD v1.1 §4 的 memory 验收条目逐条打勾。

## 风险

- 记忆污染回答(错误记忆被引用):护栏段已有;管理 UI 的删除就是止血阀;confidence 字段已存在,v1 注入时按 confidence DESC 排序即可,不做复杂衰减。
- selector 成本:仅 >5 候选触发 + lite 档 + max_tokens 128,可忽略。
