# R6 · 报销(审批卡 confirm/supplement + 附件 + 审计)

**目标:** 报销全链路真跑:输入(+真附件上传)→ SSE 流 → LoopCard;`awaiting_approval` → ApprovalCard(confirm 对账)→ approve/stream 续办;`missing_fields`(collecting)→ ApprovalCard(supplement 补录)→ answers/stream 续办;reject、verify 重试、查看审计全接真端点。这是 W4「审批卡通用化」的第一个真实落位。
**边界:** Associate 节点审批不做(A1 §2);审批风险 chip 用后端 `risk_level` 真值。

**前置:** R4(useRunStream/LoopCard 接线模式)。**读 CLAUDE-CODE-INSTRUCTIONS §1(awaiting_approval 行)+ §6 ApprovalCard + ACCEPTANCE §I;端点细节 A1 §2 报销节。**

**Files:**
- Create: `apps/desktop/src/pages/cowork/ReimbursementPage.tsx`+`.css`、`approvalView.ts`(+`.test.ts`)、`AttachmentPicker.tsx`(并入页面 css)
- Modify: `useRunStream.ts`(加 `append` 续流选项)、`App.tsx`

**Interfaces:**
- Consumes: reimbursement.ts 全函数(R2)、`ApprovalCard/LoopCard/StateNote/AgentComposer`
- Produces: `useRunStream.start(open, { append?: boolean })`——append 时不清 frames(同一 run 的多段流拼成一条时间线;normalizer 沿用同实例)

## Task 1: useRunStream 续流支持(TDD)

- [ ] **Step 1:** `start(open, { append: true })`:保留 frames 与 normalizer 上下文,新段帧追加 → reduceTurns 得到完整旅程(创建段 + 审批恢复段在一张卡上)。测试:两段合成流(第一段止于 awaiting_approval+done(waiting_confirmation),append 第二段 done(succeeded))→ tree.state 依次 awaiting → done,turns 累计不重置。
- [ ] **Step 2:** 跑测 PASS;`npx tsc --noEmit`。

## Task 2: approvalView(帧/run → ApprovalCard props,TDD 纯函数)

- [ ] **Step 1: `approvalView.ts`**

```ts
// confirm 变体(awaiting_approval 后从 done{run}.approval 取全量,detail 只有 approval_id):
//   ApprovalRequest{id,action_type,risk_level,status,payload,draft_snapshot,...}(schemas 出处 A2 §2.2)
//   fields = draft_snapshot 关键字段呈现映射(单据号/金额+币种/事由/日期;金额 mono;
//     字段名以真 snapshot key 为准,实施第一步先跑一条真 run 检视)
//   risk = risk_level(low/medium/high 直通)
//   payloadText = JSON.stringify(payload, null, 2)(帧原文,一字不改)
// supplement 变体(run.status === "collecting"):
//   missing 字段清单从 run 上的缺失字段结构取(先检视真 run;老审计帧 reimbursement.missing_fields.requested 亦可作源)
//   type 映射:金额类→number,日期类→date,其余→text;发票附件→file(虚线站位,上传走页面级 AttachmentPicker)
export function confirmProps(run): ApprovalCardProps | null
export function supplementProps(run): ApprovalCardProps | null
```

  测试:waiting_confirmation run → confirm props(risk 直通/payload 原文);collecting run → supplement props;succeeded → 双 null。
- [ ] **Step 2:** 实现 → PASS。

## Task 3: 页面拼装与四条通路

- [ ] **Step 1: 布局**:Cowork 报销子页 = 页头(眉题 COWORK · 报销)+ 新单区(AgentComposer:placeholder「把报销事项告诉 Anna,可附发票」+ **附件真控件** AttachmentPicker)+ LoopCard + 审批卡槽 + 历史 run 列表(listRuns 倒序,状态点 + 摘要;点击 → getRun 回看,复用 R4 historyFrames 思路——报销 run 的审计走 `getAudit(runId)` 取)。
- [ ] **Step 2: AttachmentPicker**:文件选择 → `uploadAttachment(name, blob)` → 得 `{name,uri}` chips 列在 composer 上方(可删);发送时 attachments 数组进 `streamReimbursementRun(inputText, attachments)`。上传失败 = `StateNote kind="error"` 行内。
- [ ] **Step 3: 审批通路**(状态由帧驱动,tree.state + 最新 run 对象共同裁决):
  - `awaiting` → LoopCard `approvalSlot={<ApprovalCard {...confirmProps(run)} onConfirm={} onRevise={} />}`;**确认提交** → `start(() => streamApprove(approvalId), { append: true })`(RESUME 流,无模型在环,审计帧+done);**返回修改**(拼装决策 D-R6-1)→ `rejectApproval(approvalId)` 后 composer 回填原 input_text 聚焦,原卡收为回看态(reject 是真动作,界面明示「已驳回,可修改后重新提交」)。
  - `collecting`(done{run.status:"collecting"},非 awaiting)→ 卡外 ApprovalCard supplement;提交 → `start(() => streamAnswers(runId, values), { append: true })`。
  - 失败 → LoopCard failure:报销**有**审计端点 → 传 `onAudit`(打开审计面板:getAudit 事件列表 mono 时间线,`{type,created_at,payload}` 原文);verify 类失败另给页面级「重试回读校验」tinted 按钮(`POST .../verify` 后 getRun 刷新)。onResume 仍不传(无断点续跑通道;补录/审批已各有真通路)。
  - 成功 → 礼成条(usageText 真报才显)+ 单据号/状态正文。
- [ ] **Step 4: 状态提示语**(语体 §3):awaiting =「提交前需要您确认」;collecting =「请您补充」;审批通过流完成 =「都办妥了。单据已提交,回读校验通过。」——仅在对应真值状态出现。

## Task 4: 验收 + commit

- [ ] 四门全绿(新增 2 测试文件)。
- [ ] Playwright 实跑(报销 MCP 已连,或用本地 contract server):①发起含缺字段的报销 → collecting → supplement 卡真输入 → 补录续流;②走到 awaiting → confirm 卡:琥珀书脊/风险 chip 真值/字段 mono/▸ 原始 payload 掀开 240ms 原文一字不差;③确认 → 恢复流 → 礼成;④另起一单走驳回 → composer 回填;⑤查看审计面板事件原文;⑥MCP 未连 → 整面 offline 态。截图对照 preview S4。
- [ ] commit ×2:`feat(fe): R6 — 报销流与附件上传` / `feat(fe): R6 — 审批卡 confirm/supplement 真通路`

## 风险

- **approve/stream 是遗留路径**(仅审计帧,无 step/tool 帧,A2 §1.1):恢复段时间线只有系统步——如实呈现,B1 收敛后自动变富。
- **detail 只有 approval_id**:confirm 卡字段必须等 done{run} 到手后从 run.approval 取——awaiting 帧到 done 帧之间(毫秒级)卡可先渲染骨架标题,禁放假字段。
- **collecting 与 awaiting 并存判定**:以最新 run 对象 status 为准,单一来源裁决,别双卡同屏。
