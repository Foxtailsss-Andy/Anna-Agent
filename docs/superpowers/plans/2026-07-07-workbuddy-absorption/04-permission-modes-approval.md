# W4 — 权限模式 + 审批通用化 + composer 权限选择器

> 对照物:WorkBuddy 权限四模式(plan/acceptEdits/bypassPermissions/default)在 Spawn 时设定,决定 Execute 阶段每个工具调用是否需审批;composer 底条常驻权限选择器(「默认权限」,运行中红色「允许完全访问」);本质=分级信任——读自动、写审批、危险人工确认。
> Anna 现状:引擎级审批门(`CapabilitySuspend`→`awaiting_approval`)是**通用机制**但全仓只有 reimbursement 触发;审批 UI 只在报销页;无权限模式概念。这是 Anna「企业级治理」定位的招牌能力,机制成熟度高(纯接线+抽组件),优先级排 W4。

**目标效果**:① composer 底条出现权限 pill:默认(写需审批)/ 只读 / 放行(bypass,红色警示);② readonly 下模型看不到写工具;③ default 下任何 surface 的高危写都会暂停出通用审批卡,批准后续跑;④ bypass 全程放行但审计打 `permission.bypass` 标记;⑤ 报销页迁移到通用审批卡,行为不变。

## 现状锚点

| 事实 | 位置 |
|---|---|
| 引擎暂停/恢复(通用,勿改语义) | `services/runtime/app/engine/agent_loop.py:214-229`(CapabilitySuspend→awaiting_approval) |
| 唯一触发者 | `services/reimbursement/app/capability.py`(raise CapabilitySuspend;on_tool_batch 批门 :133) |
| 审批 id 通用底座 | `services/*/app/base_orchestrator.py:36,73-80`(`_approval_id_prefix`/`_next_approval_id`) |
| 工具风险分级投影(写工具判定数据源) | `services/api/app/projections/tool_registry.py:78-139`(风险分级/确认要求;backend-only 写工具 126-139) |
| 报销审批 UI(要抽通用) | `apps/desktop/src/features/reimbursement/ReimbursementPage.tsx:225-234, 314-333`(waiting_confirmation + ApprovalActionCard) |
| 各面工具白名单(readonly 过滤点) | `services/runtime/app/{chat,finance,hiker,associate,create}_tool_registry.py`、`toolset.py` |

## 契约

**run 级字段** `permission_mode: "default" | "readonly" | "bypass"`(缺省 "default";五面 schemas+routes 透传;v1 不做 plan 模式)。

**写工具分类**:单一事实源放 `services/runtime/app/tool_risk.py`(新建):

```python
WRITE_TOOLS: frozenset[str] = frozenset({
    "reimbursement.submit_intent", "reimbursement.approve_intent", "reimbursement.reject_intent",
    "chat.emit_page", "chat.emit_document",          # 产出型=低危写,default 下不暂停、readonly 下隐藏
    "create.emit_skill_draft", "create.emit_prompt_draft", "create.emit_python_tool_draft",
    "associate.emit_goal_plan",
})
HIGH_RISK_TOOLS: frozenset[str] = frozenset({"reimbursement.submit_intent"})  # default 模式必暂停
def is_write(tool: str) -> bool; def needs_approval(tool: str, mode: str) -> bool
# needs_approval: mode=="bypass"→False;mode=="default"→tool in HIGH_RISK_TOOLS;readonly 下写工具根本不可见
```

维护规则:新增写工具必须同步此表(测试锁定:registry 里名字含 emit/submit/approve/reject/create 的工具必须出现在 WRITE_TOOLS,防漏)。

**引擎接线**:capability 侧统一走一个 mixin/helper(`services/runtime/app/permission_gate.py`):`gate_tool_call(mode, tool, raise_suspend)` ——default+高危 → raise CapabilitySuspend(复用现有 approval_id 机制);bypass → 记审计 `permission.bypass {tool}` 后放行。registry 侧:`_model_visible_tool_names` 组装时按 mode 过滤(readonly 剔除 WRITE_TOOLS)。

**通用审批卡**:`apps/desktop/src/features/agentic/ApprovalCard.tsx`——props `{ approval: {id, tool, summary, payload_digest}, onApprove(), onReject() }`;审批路由通用化:各面已有 approve 端点的沿用;chat/finance 等新增 `POST /api/<surface>/runs/{run_id}/approvals/{approval_id}` (approve|reject)照报销模式。

## 任务分解

### Task 1: tool_risk 单一事实源 + permission_gate(TDD)

**Files:** Create `services/runtime/app/tool_risk.py`、`services/runtime/app/permission_gate.py`;Test `tests/runtime/test_tool_risk.py`(含防漏测试)。

- [ ] Step 1:失败测试(needs_approval 三模式矩阵/防漏扫描各 registry)→ 实现 → PASS。
- [ ] Step 2:commit `feat(harness): W4.T1 — tool risk source of truth + permission gate`。

### Task 2: 五面接 permission_mode(TDD)

**Files:** Modify 五面 schemas/routes/orchestrator(透传 mode)+ 各 registry(readonly 过滤)+ 各 capability(dispatch 前过 gate);报销 capability 改为经 gate 触发(行为等价,原直接 raise 改为 gate 判定,default 模式下结果不变);Test:每面 readonly 隐藏写工具断言 + chat 在 default 模式 emit 不暂停 + bypass 审计标记。

- [ ] Step 1:失败测试 → 接线 → PASS;全量 pytest(报销既有审批测试必须原样全绿——回归红线)。
- [ ] Step 2:commit `wire(harness): W4.T2 — permission_mode across surfaces`。

### Task 3: 通用审批卡 + composer 权限 pill(FE)

**Files:** Create `apps/desktop/src/features/agentic/ApprovalCard.tsx`;Modify `ReimbursementPage.tsx`(迁移复用,删本地实现);Modify `useChatStream.ts`/各面页(awaiting_approval 状态渲染 ApprovalCard);Modify `ChatComposer.tsx` 等(权限 pill 下拉:默认/只读/放行,放行红色警示,选中值随 run 请求发送);Test:vitest ApprovalCard 状态纯函数 + pill 状态。

- [ ] Step 1:抽组件+报销迁移,报销 Playwright 走查原有审批流不变。
- [ ] Step 2:pill 三态接到五面 composer;chat 造一次高危演示(临时把某工具标 HIGH_RISK 走全流程)后还原。
- [ ] Step 3:commit `feat(fe): W4.T3 — generic ApprovalCard + composer permission pill`。

## 调用方式汇总

- 请求:五面 run 创建体 += `permission_mode`;审批:`POST /api/<surface>/runs/{run_id}/approvals/{approval_id}` body `{action:"approve"|"reject"}`。
- 判定逻辑集中在 `tool_risk.py`,产品讨论「哪个工具要审批」=改这一个文件+测试。
- 审计:`permission.bypass` / 既有 `awaiting_approval` 事件链不变。

## 验收门

四门全绿;矩阵走查:readonly 下 chat 的 emit 工具从工具列表消失且模型无法产出产物(回答说明原因);default 下报销提交照旧暂停;bypass 下暂停消失且审计有标记;非报销 surface 出现过至少一次通用审批卡(演示用)。

## 风险

- 把 emit 类低危写误设为必审 → 体验倒退:v1 仅 HIGH_RISK_TOOLS 暂停,名单从窄开始,宁少勿多。
- 报销回归:T2 明确要求既有报销测试零改动全绿;任何需要改旧测试的实现方案都视为破坏契约,打回。
