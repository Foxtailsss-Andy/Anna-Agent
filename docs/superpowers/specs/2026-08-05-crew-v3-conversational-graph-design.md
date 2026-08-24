# Crew v3 · 对话式规划(对话 × 图 × 申请单)设计 spec

> 2026-08-05 · 设计文档(不含实现)
> 前置研究:`docs/superpowers/2026-08-05-buzz-teardown-for-crew.md`(block/buzz 拆解)
> 建造前提:Agent 重定位轮 harness 三缺口(行动面零 / 同步派发 / 断流不可恢复)修复后,E2 起搭车落地;E1 无此依赖

---

## 0. 一句话

**对话是规划持续发生的现场;图是已签批共识的台账;Agent 是持申请单的频道公民。**

这是 ADR-002「模型只写申请单,执行永远在 harness 代码侧」从 Chat 到 Crew 的推广:Agent 的每一次**结构性**发言都是申请单,人(或授权规则)签批,图是签批后的台账。零捏造不破反强——图上每个节点、每次状态变化,都能溯源到一次被确认的发言或一次审计过的 transition。

## 1. 背景:v2 没设计的两件事

Crew v1/v2 把图和频道建成了**人看的两面**(图管结构、频道当编年史),两轮可用性收束修的全是"人怎么操作图"。没设计的是:

1. **Agent 在对话里的位置。** `_ReadonlyAssistantHandler` 工具集为空,Agent 只能用「交产物」或「失败阻塞」说话;不能提问、不能标歧义、不能提议。返工环的最大来源就是 Agent 哑着猜。
2. **计划在开工之后的生命。** 图是立项快照,现实偏离后纠偏只能靠人手动做图形手术;频道里的人类讨论对 Agent 完全不可见,评审批注只留最后一条(`blocker` 标量),多轮返工会把早轮问题改回去。

Buzz 的启发(见拆解报告 §4):Agent 与人同接口、频道流即上下文。Buzz 的反面教材(§7):无界 shell、Drop 队列、无结构。v3 取其膜,守己之骨。

## 2. 设计总则

三层:**对话层**(规划与协商发生地)/ **契约层**(图 = 已确认共识的投影)/ **执行层**(runtime 派发、挂起、恢复)。

三原则:

- **图是对话的投影,不是对话的替代。** 一切图变更可溯源到一次确认(人类命令卡、Agent 草稿卡、SOP 模板),`created_from_message_id` 血缘从人类扩展到 Agent。
- **Agent 是频道公民,但发言有界。** 与 Buzz 的关键分歧:Buzz 给 Agent 无界人类接口(shell + CLI);Crew 给**有类型的发言行为**——每种带一张卡、一个状态后果、一个签批档。因为 Crew 有状态机和零捏造要守,无界发言会让 Agent 在台账之外改变现实。
- **挂起是一等状态。** 运行模型从「点火 → 交付|失败」扩展为「点火 → (交付 | 提问挂起 | 提议继续 | 失败)」。挂起落盘、可恢复、诚实可见、不烂尾。

## 3. 发言行为契约(v1 工具集 = 三件)

Crew worker 的工具集从 `[]` 变为以下三件。**工具只写申请单**:每次调用经 harness 落为 transition / 频道行 / 挂起状态,绝不直接改状态机之外的任何现实。readonly 铁律不变——没有任何工具能写 ERP、文件或状态机本体。

| 工具 | 用途 | 状态后果 | 每 run 上限 | 签批 |
|---|---|---|---|---|
| `ask_human(question, options?)` | 硬歧义:缺输入、验收标准冲突 | run 挂起 → 任务入「等待澄清」;答后续跑 | 2(超限得到 tool error,指示改用假设或如实受阻) | 免批(问不需要批) |
| `note_assumption(assumption)` | 软歧义:不值得堵路的小事 | 无挂起;注记入频道 + run 终帧 `assumptions[]` | 5 | 免批 |
| `propose_change(kind="add_node", title, role, depends_on_titles, acceptance, reason)` | 发现计划与现实偏差 | **零**(草稿卡 + 画布幽灵节点);采纳才 transition | 2 | Boss 确认(沿 B3 既有确认门) |

**问 vs 假设的分档即智能所在**:大事问,小事标注假设继续干。prompt 契约写明分档标准;J2 Evaluator 挂质量钩(评「该问没问 / 不该问乱问」)。

**裁定 D2**:自由汇报 `post_note` **退 P2**——运行中存在感已由 R2 状态层(活动行/流光/帧)覆盖,自由文本汇报信噪比存疑,v1 不给。

## 4. 状态机与运行时增量

### 4.1 lifecycle 新迁移(审计同源)

- `await_input(task_id, question_ref)`:running → **awaiting_input(等待澄清,新态)**。由 harness 在 `ask_human` 时触发。
- `resume_input(task_id, answer_ref)`:awaiting_input → running。由人作答的端点触发。

两个迁移都走 `_append_event` 挂点 → 审计 + 频道行 + 通知**同源派生**(零捏造证明:工具调用 → harness → transition → 一个挂点出三面,与 v2 事件桥同构)。

**裁定 D1**:等待澄清是状态机层新态(run 未死,不是 blocked——blocked 语义 = 受阻需人工重启;等待澄清 = 正常流程中的轮到人)。视觉表达(第八章 or 执行中子徽记)**交设计轮裁定**,工程契约只保证数据可区分。

### 4.2 运行时纪律

1. **挂起释放并发闸位,恢复重占**——防 N 个等答案的 Agent 饿死池子。
2. **挂起态落盘**(帧 + 待答问题 + 恢复点),进程重启后可恢复——即重定位轮「断流不可恢复」缺口的 Crew 验收场。
3. **超时收敛**:24h 无答 → 通知升级(再提醒);**7 天无答 → run 收敛为 blocked**(blocker=「等待澄清超时:{question}」),诚实可见永不僵尸。人事后作答仍有效:答案在线程里,重跑经线程进 prompt(E1 是 E2 的兜底层)。
4. **答案注入双路**:run 存活 → resume 注入为 `ask_human` 的 tool result;run 已收敛 → 重跑时经节点线程进 prompt。

### 4.3 幂等

- question 行 id 确定性:`{run_ref}:q{n}`;
- 一问一答:answered 后再答 409;
- **作答权**:workspace 成员皆可答(与评审端点同口径,沿 F3 ⑥「与 Andy 同审」裁定);通知发任务 owner 与被 @ 者;
- propose 卡按 `{run_ref}:{title}` 幂等;
- 在飞去重沿 `_inflight_by_task` 不变,awaiting_input 计入在飞(不可重复点火)。

## 5. 数据契约增量

### 5.1 ChannelMessage

kind 家族 `event|artifact|review|say|command` **+ `question` + `answer`**:

- `question`:payload `{run_ref, question, options?, status:"open"|"answered"|"expired"}`,锚定 task_id,派生自 `await_input`;
- `answer`:payload `{question_id, answer, saved_as_consensus:bool}`,派生自 `resume_input`;前端把问答渲染为一张合并卡。

### 5.2 评审批注全史(修 v2 有损缺口)

Task + `review_notes: list[{version:int, reviewer_member_id:str, note:str, verdict:"rejected"|"approved", created_at:str}]`——每次门判追加。`blocker` 标量保留(= 最新一条,向后兼容)。prompt 给全史。

### 5.3 Notification

NotificationKind + `question`(「Agent·Scribe 有一个问题等你」,深链到卡)。

### 5.4 prompt 组装 v2(E1 落地)

```
项目目标 / 任务 / 说明 / 验收标准            (既有)
返工全史:review_notes 全列表,每条 ≤300 字     (新,修「v3 改回 v1 问题」)
上游产物                                    (既有,截断规矩不变)
节点线程:最近 10 行(kind ∈ say|question|answer|review,anchored task_id),每行 ≤200 字   (新)
项目共识                                    (既有 B1b)
结尾指令 + 问/假设分档契约                    (新)
```

**裁定 D8**:上下文喂**节点锚定线程**,不喂整条频道——整条频道是噪声与 token 黑洞,线程才是信号。项目级讨论若需进入 Agent 视野,路径是 ☑ 沉淀为共识,不是灌频道。

## 6. 交互与 UI 落点(全部落在现成构件上)

| 构件 | 增量 |
|---|---|
| 频道 | 两族新卡:**Agent 提问卡**(问题 + 答复框 + 「☑ 记为项目共识」勾选——**仅 Boss 答题时显示**,沿 B1b Boss-only 写契约;kind 默认口径,可改约束/决策)、**改图草稿卡**(C3 监察卡同族,origin=agent_proposal 徽记 + 幽灵预览链接);假设注记 = 轻量注记行 |
| 画布 | 「等待澄清」态(视觉交设计轮)+ **幽灵节点**(虚线、不参与调度、不占布局主流) |
| 该你了向导条 | 新动作档「回答 Agent 提问」,**排序:澄清 > 返工 > 门评审 > 提交 > 开工**(Agent 在挂起等待,每小时沉默都是墙钟损失) |
| 任务抽屉 | 线程页(该节点问答 + 评审全史 + 假设注记) |
| 收件箱 | 提问入 todo 组(或新组,设计轮定) |
| 通知铃 | question kind 沿既有分组/深链机制 |

**边界声明**:本 spec 钉数据与行为契约;卡族/画布态的视觉规格沿项目惯例出 DESIGN-BRIEF 交 Claude Design,E2 开建前完成。

## 7. 时序

### S2 · 澄清环(主环)

```
Agent·Scribe 在跑「PRD 起草」(running,占一个闸位)
 │ 撞硬歧义:简报要六大节,验收标准写「一页纸」
 ├─ ask_human ────────────► run 挂起(闸位释放,帧落盘)
 │                          lifecycle.await_input → 审计 + 提问卡 + 通知(单挂点三面)
 │                          节点 → 等待澄清;「该你了」置顶
 │    (人两小时后才来也不烂尾:24h 升级提醒;7 天收敛 blocked)
 人在卡上作答:「以简报为准」 ☑ 记为项目共识(口径)
 │                          共识 +1(B1b 管道);lifecycle.resume_input
 ├─ resume(答案注入 tool result)────► 复跑(重占闸位)
 └─ 交付 v1 → submit → 门活跃(批注自此留全史)
```

### S3 · Agent 提议改图

```
Agent·Design 跑「设计稿」→ 发现实施缺「API 契约」前置
 ├─ propose_change ► 频道:改图草稿卡(origin=agent_proposal)
 │                  画布:幽灵节点(虚线,不调度)
 │                  Agent 本人不停,继续交付原任务(提议 ≠ 阻塞)
 Boss 采纳 → 真节点入图(created_from_message_id 血缘)→ recompute → auto_pilot 接管
      拒绝 → 卡记未采纳;Agent 若声明过硬依赖 → 其任务照实 blocked
```

### S1 · 立项对话(E4)

```
人:「登录页重设计,保留 terracotta,周五前」
Anna 追问 ≤3 问(范围 / 评审人 / 外部依赖)
 → 草稿图卡 + 画布草稿态渲染(虚线,未确认)
人用自然语言改(「设计评审双审」「实施拆前后端」)→ 卡 diff 更新
确认 → 图 v1 落地,auto_pilot 派发 ready 节点
```

PlanGate(J1)的 Crew 形态:先签批,后执行。

### S4 · 评审对话化(E1+E2 合流)

提交 vN → 门活跃 → 评审卡(既有)→ 驳回批注入全史 → Agent 重跑拿全史不回退早轮问题;E2 后 Agent 可在门线程 `ask_human` 追问批注含义。

## 8. 智能四环(「智能的规划」从哪来)

1. **规划智能**:一次成图 → 追问后成图。图带着理由出生(E4)。
2. **执行智能**:猜 → 问/假设。歧义在源头解决;grounding 修跑题已证明喂对上下文质量立变(E1+E2)。
3. **演化智能**:开工快照 → 活图。谁发现偏差谁提议,包括 Agent;图始终等于现实(E3)。
4. **积累智能**:答过的问题 ☑ 进共识 → 注入后续所有 run。**同一个歧义,整个组织只问一次。** 复利最高,管道(B1b 注入 + memory_hits 审计)现成(E2)。

## 9. 权限谱

三档方向:**免批**(说话类:问 / 假设)→ **单人确认**(加叶节点、拆自己的任务)→ **Boss**(动门、动验收标准、删节点、跨任务改派)。

**裁定 D6**:v1 一切 propose 走既有 Boss 确认门(B3 双层校验复用);分档实装推 E3。auto_pilot 已是「transition 上的授权自动化」先例——谱系是补完,不是新发明。从架构层做,不靠 Rule。

## 10. 演进分期

| 期 | 内容 | 依赖 | 验收草图 |
|---|---|---|---|
| **E1** | review_notes 全史 + 节点线程进 prompt(§5.2/5.4) | **无**(不动运行模型,随时可开) | gate:v1 驳「太长」、v2 驳「缺合规」,v3 prompt 断言同含两条;task 锚定 say 行进 prompt 断言 |
| **E2** | 三工具 + awaiting_input + 挂起/恢复 + 该你了接提问 + ☑ 沉淀共识 | 重定位轮 harness 三缺口(见下表) | fake-model 剧本:ask → 挂起 + 卡 + 置顶 → 答 ☑ 共识 → resume → 交付;**进程重启后 resume 仍可用**;闸位释放断言 |
| **E3** | propose 草稿卡 + 幽灵节点 + 权限谱分档 | E2 | propose → 幽灵 → 采纳 → 血缘 + recompute + auto_pilot;拒绝路径;门变更 Boss-only |
| **E4** | 立项对话 + 草稿图协商 | 独立(仅确认机械 + 画布草稿态) | 三问 → 草稿图 → 自然语言 diff → 确认落图 |

**E2 依赖 ↔ 重定位轮缺口映射**(Crew v3 = harness 能力的产品验收场):

| Crew v3 需要 | 重定位轮已诊断缺口 | 既有半成品 |
|---|---|---|
| Agent 有工具能发言 | 行动面零 | J3 已做人→Agent 运行中插话;本轮补 Agent→人,同一对话运行时的两半 |
| run 挂起等人、异步续跑 | 同步派发 | 长跑轮 L4 续办/暂停 |
| 挂起态落盘、重启恢复 | 断流不可恢复 | frame_journal + run_store |

**裁定 D9**:E4 默认垫后(模板已把立项覆盖到「够用」;在飞缺口才是返工环的病根)。若立项质量成为主要痛点可提前——它不依赖 E2/E3。

## 11. 非目标与不采纳(Buzz 反面清单)

- **不做** Nostr / keypair 身份(本地桌面单工作区,签名事件复杂度换不来收益);
- **不给**无界 shell / CLI 工具(有界发言行为是 v3 的立身之本);
- **不抄** Drop 队列(Agent 在飞时人的消息静默丢弃,违零捏造;Crew 的插话/线程语义已优于此);
- **不喂**整条频道进 prompt(D8);
- **不做** Agent 互答(v1):Agent 对 Agent 讲的口径未经确认,传播即污染共识;澄清必须过人,成熟后再议;
- **不做**自由汇报(D2,退 P2);
- **不并入**统一事件底座重构(teardown 报告建议 4,独立 P2 轮,与本 spec 解耦——四日志同源派生的现状足以支撑 v3)。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 提问风暴(每 run 都挂起) | 上限 2/run + 问/假设分档契约进 prompt + J2 Evaluator 评提问质量 |
| 图碎片化(提议过多) | 提议是草稿卡,人确认才入图;上限 2/run;auto_pilot 对草稿零动作 |
| 挂起积压 | 该你了置顶 + 健康条计数 + 24h 提醒 + 7 天收敛 blocked(永不僵尸) |
| token 增长 | 线程 10 行 × 200 字 + 批注 300 字/条 + 共识本就精选;总量与上游产物截断同一量级 |
| IME / 多端重复作答 | 一问一答 409;答案行幂等 |

## 13. 裁定记录

| # | 裁定 |
|---|---|
| D1 | 等待澄清 = 状态机新态 awaiting_input;视觉表达交设计轮 |
| D2 | v1 工具三件(ask / assume / propose);自由汇报退 P2 |
| D3 | 上限:ask 2 / assume 5 / propose 2(每 run) |
| D4 | 挂起 24h 提醒、7 天收敛 blocked;答案双路注入(resume / 线程兜底) |
| D5 | v1 propose 只做 add_node(拆任务、加依赖为其组合,E3 扩) |
| D6 | v1 签批全走 Boss 确认门;权限谱分档 E3 实装 |
| D7 | Agent 互答 v1 不做 |
| D8 | prompt 喂节点锚定线程(10 行),不喂整频道 |
| D9 | E4 垫后,独立可提前 |
| D10 | 作答权 = workspace 成员(与评审同口径);☑ 沉淀共识仅 Boss 可勾(B1b Boss-only 写契约不破) |

---

*关联:`2026-08-05-buzz-teardown-for-crew.md`(研究)· `docs/product/Anna_Crew_PRD_V1_0.md`(v1 功能事实源)· `plans/2026-07-17-crew-build/00-master-plan.md`(v2 建造台账)· 重定位轮 Phase A-E 草案(harness 前提)*
