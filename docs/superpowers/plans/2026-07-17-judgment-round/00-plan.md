# 判断力轮（Judgment Round）· 终审判定 + 执行计划

> 2026-07-17 · Fable 5 终审 · 分支 `feat/judgment-round`（base = main f542a38，长跑轮已并入并四门重认证 709/146/0/build✓）
> 本文件是四轮学习材料的**唯一收敛出口**：WorkBuddy 三篇(8原则/六层/CC蒸馏实践) + Anthropic harness-design + Lilian Weng 自我进化阶梯 + Claude SDK loop 文档 + **Grok Build 全码解剖**(六域,证据到文件:行号) + 业界解读核对(Simon Willison/安全拆解)。接手人只读本文件即可开工。

## 0. 终审判定表（Judge & Check：每个候选优化的最终裁定）

**收敛尺**：①五源以上收敛的当定律；②coding-agent 特有的不迁移（Anna 是业务 AIOS，验证锚在业务数据不在测试套件）；③接线优先于新建；④与人格主线咬合的优先。

| 候选 | 来源 | 裁定 | 理由 |
|---|---|---|---|
| **Evaluator 判断层** | **五源收敛**(WorkBuddy #1/#6、Anthropic generator-evaluator、Weng 七瓶颈之首、CC 实践 verification subagent、GrokBuild laziness/skeptic) | **✅ 本轮 J2（核心）** | Anna 唯一的基石缺口；治"执行会出问题"的病根；= 评测北极星 P5 在环评估的运行时起点。**不抄 coding 判据**：锚 audit 链+业务数据 |
| **PlanGate** | GrokBuild TodoGate(实证) + WorkBuddy 任务管理规则 | **✅ 本轮 J1（先行小胜）** | run.plan 已有(W1)、引擎 nudge 钩子已有——纯接线,一天级,直接抬完成质量 |
| **Mid-run 插话** | GrokBuild pending_interjections(全套语义已验证) + SDK streaming input | **✅ 本轮 J3** | 长跑能力(L3)的产品补完:任务从"看着或杀掉"变"边跑边说";引擎改动=additive opt-in 钩子(同 suspend_on_exhaust 模式,已验证安全) |
| **Egress 出境治理** | GrokBuild 翻车实证(27,800×过度上传/.env 不脱敏/关不掉) | **✅ 本轮 J4（v1 披露版）** | 企业 AIOS 的信任护城河;Anna local-first 天然占位,先做诚实披露面,脱敏/开关后续 |
| SOUL/IDENTITY/USER 人格文件 | WorkBuddy 原则二 + 自我进化"冻结价值锚"推论 | ⏭ 下轮(记忆/人格轮) | 人格内容是用户的拍板件,不该由我代拟;J2 v1 判据先用客观完成纪律,SOUL 落地后接为判据 |
| 记忆三层+FTS5+衰减+Dream 蒸馏 | GrokBuild(最工程化蓝图)+WorkBuddy 原则三+Weng ACE | ⏭ R3 记忆轮(蓝图已升级并存记忆) | 差距最大域但独立成轮;FTS5 零新依赖已确认 |
| KV-cache 前缀稳定性 | GrokBuild 点名("no KV cache breaks")+CC 实践 | 📏 设计红线(本轮 J2/J3 实现时遵守:注入一律走消息不动系统提示) | 记录纪律,无独立工件 |
| 客户端便宜版 doom-loop(连续同参工具调用检测) | GrokBuild(服务端版) | ⏭ 后置 | J2 evaluator 的规则层可顺带覆盖一部分;完整版等真实案例出现 |
| auto-wake(后台完成唤醒) | GrokBuild | ⏭ 等通知体系(Crew 轮站内铃) | 依赖通知面,Crew 重规划轮已含 |
| MCP 延迟加载/工具搜索 | GrokBuild/CC | ❌ 不做 | Anna 单面 ≤11 工具,无上下文压力(三轮维持同一结论) |
| Windows OS 级沙箱提前 | — | ❌ 不提前 | **xAI 都是 no-op 且诚实降级**;维持 W9 里程碑,佐证已记 |
| hooks fail-open / 模型分档 / 分段 bash 检测 / worktree / 代码图 | GrokBuild | ❌ 不做/等 Code 模式 | fail-open 违背 Anna fail-closed 哲学;其余 coding 域特有 |

**与路线图关系**：本轮 = 评测文档 P5 支柱的运行时落地 + HANDOFF 遗留"可观测性严谨化"的判断力延伸;不与 R3(记忆)/Crew 重规划(等 Claude Design 返稿)/登录页冲突,并为 Crew 解除了"长跑轮合 main"前置。

## 1. 切片定义（J1→J4 严格串行，eval-first：gate 先行 RED）

**全局约束**（继承长跑轮）：帧契约只增不改;诚实红线;ADR-002(模型输出全过代码门);引擎改动必须 additive opt-in 且默认关字节等价(同 suspend_on_exhaust 先例);四门+gate 只增不减(基线 709/146/6 gates);非 chat surface 零行为变化。

### J1 · PlanGate（计划守门,一天级）
- **Gate** `tests/gates/test_gate_plan_gate.py`：fake 模型在 plan 有 pending 项时不再调工具想收尾 → 收到 nudge 强制续轮 → 完成计划项后 ready;顽固拒绝 → 第 2 次 nudge 后放行(诚实 fall-through),audit `plan.gate.exhausted`。
- **实现**：chat capability 实现引擎既有 `on_assistant_final` nudge 钩子(agent_loop 已支持,零引擎改动)——`run.plan` 存在 pending/in_progress 项且 fires<2 → 返回 nudge 「计划中还有未完成项:{titles}。请继续完成并用 plan.update 更新状态;若某项实际无法完成,请把它改为说明并更新计划。」(J1 复审后追认:实现措辞优于原文——显式导向 plan.update);audit `plan.gate.fired {pending_count, fire_index}`。
- **FE**：无(trace 的 event 帧自然显示)。

### J2 · Evaluator（判断层核心）
- **Gate** `tests/gates/test_gate_evaluator.py`：①fake 模型零工具调用却声称「已办妥」且 plan 有未完项 → 规则层直接 verdict=false_completion → nudge 注入 → 续跑一轮(fake 完成) → ready 且 audit 链含 `run.evaluation.verdict{category:achieved}`;②顽固不达 → 1 次续跑上限后 ready 但 audit `run.evaluation.flagged{gaps}`(诚实标注,不假成功不死循环);③judge 模型返回非法 JSON → 评估跳过(fail-open)、run 正常 ready、audit `run.evaluation.skipped`。
- **契约**：
  - 触发(便宜规则层,纯代码):run 终态前,①plan 有非 done 项,或②最终答案命中完成声称正则(「已完成|已办妥|done|completed」)但本 run 零 `tool_done` 审计。命中任一 → 进 LLM 法官;都未命中 → 直接 ready(零成本路径)。
  - LLM 法官(独立上下文,防续写——GrokBuild 蓝图):独立两条消息,system=法官提示(闭集分类 `{achieved, false_completion, partial, needs_user}` + confidence 0-1,只输出 JSON),user=`原始请求 + [runtime_facts](代码生成,agent 无法伪造:工具调用清单及成败/plan done÷total/artifacts 数/真实耗时/续跑次数) + 最终回答全文`。**不喂全 transcript**(v1 省成本);法官调用镜像 L4a `_build_summarize` 的独立 provider 单发模式(≤512 tokens,60s 超时,不进 stream_model——天然免疫压缩/并发闸递归)。
  - 代码门(ADR-002):JSON 解析+闭集校验+confidence∈[0,1];任何失败 → skipped(评估自身 fail-open,**永不阻塞 run 终态**)。
  - 裁定处理:`achieved`→ready;`false_completion|partial` 且 confidence≥0.7 且续跑数<1 → 复用 L4a 续跑机制(引擎 QueryConfig 新增 additive opt-in `carry_messages_on_complete: bool=False`,chat 开启,completed outcome 携带 messages——默认关字节等价,测试锁定)→ 注入 nudge user 消息「评估发现未达成:{gaps}。请补办;已完成部分不要重做。」→ 同 run_id/journal seq 连续(L4a 全套机制现成)→ 再评估;仍不达 → ready + `run.evaluation.flagged`(前端可见的诚实标注);`needs_user`→ready+flagged。
  - 配置 `runtime.json → evaluation: {enabled: true, max_continuations: 1}`;审计链 `run.evaluation.{started,verdict,flagged,skipped}`(= P5 数据源)。
- **FE**(小):trace 标签「评估:已达成/发现缺口·自动补办中/未完全达成(诚实标注)」;flagged 时答案区一行 muted 警示条(真数据才渲染)。

### J3 · Mid-run 插话（steering）
- **Gate** `tests/gates/test_gate_interjection.py`：event-gated fake 模型 3 轮任务;第 1 轮后 POST interject;断言第 2 轮模型请求含插话为独立 user 消息(在后续观察之前);终态 ready;`run.interjected` 事件帧在场且 seq 连续;对已终态 run 插话 → 409/幂等 `{status}`。
- **契约**：引擎 `AgentLoop` 新增 additive opt-in 钩子 `drain_interjections()`(getattr 模式,同 on_tool_batch 先例):每轮模型调用前调用,返回 list[str],非空则逐条作为独立 user 消息追加(**不并进 tool 观察**——压缩/回放把它当真 user turn,GrokBuild 同款语义);默认无钩子字节等价。chat 侧:per-run 线程安全 pending 队列(挂 BackgroundRunManager),`POST /api/chat/runs/{run_id}/interject {text}`(身份校验;仅 generating 态;audit `run.interjected {text_hash}` + 事件帧入 journal)。
- **FE**：运行中 composer 解锁,placeholder「补充指示,边跑边说…」,Ctrl+Enter 发插话(非新 run);气泡入对话流(独立样式);trace 行「已收到补充指示」。新建任务/打开历史清空插话态(L1b/L4b 同款 reset 纪律)。

### J4 · Egress 出境披露 v1（信任线起步,半天级）
- **Gate** `tests/gates/test_gate_egress.py`：投影返回全部已配置外部端点(模型 API+3 MCP),每项含 {destination, data_categories, configured, last_probe_status};未配置项 configured=false 不虚报;**零遥测/零上传断言**:grep 级测试锁定 services/ 无任何非用户配置端点的出站调用(防 GrokBuild 式翻车的回归门)。
- **实现**：`services/api/app/projections/egress.py`(读 settings 静态生成,复用既有连接探针状态);`GET /api/admin/egress`;设置页新分组「数据出境」——诚实文案:「Anna 只向以下你配置的端点发送数据:模型 API(对话内容/工具结果)、报销 MCP(报销单字段)、ERP MCP(查询参数)、Hiker MCP(查询参数)。无遥测,无训练回传,记忆全部本地。」v1 纯披露,不做计数/脱敏(后续轮)。

## 2. 协议（沿用长跑轮全套）
subagent-driven:Fable 出简报+验收把关,Opus 实施,每片两级复审(契约符合性+代码质量)+四门+gate+真流走查;严格串行 J1→J4;每片 1-2 commit `feat(runtime|home): J<n> — <名>`;ledger `.superpowers/sdd/progress.md` 随片更新;走查环境备忘见长跑轮 03-acceptance(RUNTIME_CONFIG_PATH/demo-erp 重启仪式/Ctrl+Enter)。

## 3. 本轮不做（防蔓延,判定表已裁定的不再重复）
SOUL 文件/记忆轮/Dream/通知体系/MCP 延迟加载/模型分档/沙箱提前/Cowork·Create 面改动/帧契约 v2/评估器进非 chat surface(推广等 v1 验证)。
