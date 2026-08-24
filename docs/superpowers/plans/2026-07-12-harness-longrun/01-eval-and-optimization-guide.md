# Harness Runtime · 长期优化方向与评测体系(北极星指导文档)

> 2026-07-12 · 本文回答四件事:**是什么 / 做什么 / 怎么做 / 什么时间做什么**
>
> **立场(不可违背)**:方向、指标、标准全部来自 Anthropic 官方工程内容与业界公认基准;Anna 只是被测系统(SUT)。本文不引用、不迁就任何 Anna 内部既有诊断与路线编号。把标准套到代码上照出的差距写进独立诊断文档,**不回写本文**——本文只随业界标准更新(新官方文章、新基准版本、新模型发布)。
>
> **已拍板决策**:双轨评测;参考模型固定 **Sonnet**;开发期用简单评测任务做验收 gate → 开发完成后启动正式评测并长期跟踪。

---

## 0. 一页总览

| 四问 | 回答 |
|---|---|
| **是什么(方向)** | 固定模型下,持续拉长 harness 支撑的**可靠自主工作时长**。顶层指标三个:task horizon(METR 口径)/ **pass^k**(可靠性)/ cost per outcome(经济性) |
| **是什么(评测)** | 双轨:**轨道 A 公开基准**(Terminal-Bench 2.0 主战场 + SWE-bench Verified + τ²-bench,固定 Sonnet,对外可比"拿分")+ **轨道 B 域套件**(按 Anthropic 官方 eval 方法学自建,测真实产品面) |
| **做什么** | 开发期:按五支柱 P1–P5 开发,每片配一个 smoke gate 做验收;开发完成:全量双轨首跑定基线 scorecard,此后每 release 重跑环比、红线把关 |
| **怎么做** | gate = 单任务/单次/代码判分/分钟级/进 CI;正式评测 = 隔离环境 + 每任务 k=5 + 三类 grader + judge 与执行者隔离 |
| **什么时间** | Phase 0 立标尺(~1 周)→ Phase 1 开发期(gate 卡合并)→ Phase 2 开发完成(首跑全量定基线,**评测跟踪自此正式开始**)→ Phase 3 长期(每 release 重跑;新模型发布重定基线) |

---

# Part I · 长期优化方向

## 1.1 是什么:北极星与三个顶层指标

**北极星(一句话)**:在参考模型不变的前提下,让 harness 支撑的**可靠自主任务时长**持续变长。

业界依据:METR《Measuring AI Ability to Complete Long Tasks》确立「任务时长地平线」(50% 成功率下能完成的最长任务时长)作为长跑能力的行业口径;Anthropic 2026 Agentic Coding Trends Report 指出 **harness 配置本身能让基准分摆动 5+ 个百分点**——harness 是模型之外拉这条曲线的第二根杠杆。且对 Claude Code 源码的量化研究(MBZUAI,2026-05)显示生产级 agent **约 98% 的代码是 harness 基础设施**(权限/上下文/沙箱/工具路由/恢复),仅约 2% 是模型决策——优化 harness 就是主线,不是外围。

三个顶层指标(一切工作最终对这三个数负责,其余皆诊断量):

| 顶层指标 | 定义 | 业界出处 | 目标方向 |
|---|---|---|---|
| **Task horizon** | 固定 Sonnet 下,50% 成功率能完成的最长任务时长 | METR 口径 | ↑ 逐版本变长 |
| **pass^k** | 同一任务 k 次独立运行**全部成功**的概率(取 k=5) | τ-bench 首创;Anthropic evals 文采纳 | ↑ 长跑第一指标 |
| **Cost per outcome** | 每个合格产出的 token / 时间 / 美元 | Anthropic harness design(2026-03)cost-quality tradeoff | ↓ 同质量下更省 |

## 1.2 做什么:五支柱能力模型(官方 canon)

长跑 harness 的能力构成,逐条出自 Anthropic 官方工程文章。**开发按这五条推进,每条有达标标准与观测指标**:

### P1 · 上下文治理 Context Management
- **官方定义**:compaction 让 agent「不撑爆上下文窗口地持续工作」(Effective harnesses, 2025-11)。
- **达标标准**:任意时长任务不因窗口耗尽失败;压缩后关键约束/事实不丢失。
- **指标**:窗口溢出失败率(→0)/ 压缩后 vs 不压缩的任务成功率差 / 压缩后关键事实留存率。

### P2 · 状态外置与持久化 State Externalization
- **官方定义**:结构化状态文件(feature-list JSON、progress 日志)+ git history 维持跨会话连续性;「零无文档进度、零半成品」(Effective harnesses)。
- **达标标准**:任何时刻冷重启,都能从外置状态恢复现场**继续**,而不是从头再来。
- **指标**:重启续跑成功率 / 状态丢失事故数(→0)/ 进度记录与真实环境(git/DB)一致率。

### P3 · 恢复力 Recovery
- **官方定义**:每次开工先读 progress + git log 判断上次卡点;「先修坏状态,再推进新工作」;features 只有经端到端验证才可标 passing(Effective harnesses)。
- **达标标准**:任意时点杀进程/断连接,任务不判死;恢复后最终完成率与不中断时相当。
- **指标**:注入中断后的最终完成率 / 恢复耗时 / 「中断即失败」事故数(→0)。

### P4 · 环境与工具中介 Environment & Tool Mediation
- **官方定义**:初始化环境、把被操作的应用**真实跑起来**、具备 e2e 自测通道;权限/沙箱/工具路由是 harness 基础设施的主体(98% 研究的枚举项)。
- **达标标准**:agent 能启动目标系统并验证真实状态变化;一切副作用过权限门;并行 run 之间状态隔离。
- **指标**:tool-call 正确率与冗余度(有没有绕路)/ 越权副作用数(=0)/ 并行任务串扰数(=0)。

### P5 · 在环评估 Evaluation-in-the-loop
- **官方定义**:planner / generator / evaluator 三角色分离(GAN 式);evaluator 用 Playwright 像真实用户一样操作 UI/API/DB,按 rubric + hard threshold 打分;sprint 合同(「怎样算完成」)须 evaluator 批准后才开工(Harness design, 2026-03)。
- **达标标准**:没有任何工作在未经**独立**验证时标记完成;evaluator 与执行者上下文隔离。
- **指标**:evaluator 对播种 bug 的捕获率 / grading loop 带来的质量增益(官方证据:仅加评分环 = **+10.1% 质量,零换模型**)。

**参照系(标准长什么样,对照即知)**:Claude Code 是这套标准的官方参考实现——auto-compact(P1);CLAUDE.md/memory + session resume(P2);checkpoints/后台任务(P3);permission modes + hooks + 沙箱(P4);subagents 隔离(P5 的机制底座)。

## 1.3 怎么做:开发纪律 + smoke gate

**四条演进元原则**(Harness design, 2026-03——官方对「harness 如何持续优化」的直接回答):

1. **Progressively simplify** —— 模型变强后拆掉不再承重的脚手架;增量验证,不激进重构。
2. **Right-size the evaluator** —— 按任务难度相对模型能力配 QA;模型基线内的任务不设防。
3. **Update assumptions** —— 每次新模型发布,重审全部脚手架,旧补偿逻辑可能已变纯开销。
4. **Tune specialized agents** —— 用 few-shot 样例校准 evaluator 的打分口味,对齐领域偏好。

**smoke gate 规格**(= 「开发过程中用一个简单评测任务做验收」的落地):

- 单任务、单次(k=1)、code-based 判分、二元通过、分钟级、进 CI。
- **通过 = 允许合并;通过 ≠ 达标**(达标由 Part II 全量评测判定)。
- 每支柱一个 gate,选该支柱**最小可证伪**场景:

| 支柱 | gate 任务 | 通过判据(全自动) |
|---|---|---|
| P1 | 喂一个必然超窗的长任务 | 无溢出错误 且 终态判分通过 |
| P2 | 跑到约 50% 时 kill 进程 → 重启 | 从断点续跑(产物含前半段工作)而非重来 |
| P3 | 注入坏状态(遗留半成品)再派新任务 | 日志先现诊断+修复,后推进新任务 |
| P4 | 要求启动被测应用并完成一次真实 e2e 操作 | 环境状态断言通过 且 越权动作数=0 |
| P5 | evaluator 评一份播种已知 bug 的产物 | 判 fail 且 指出 bug 具体位置 |

## 1.4 什么时间做什么(开发期)

| 时点 | 动作 |
|---|---|
| 每片开发**前** | 从 1.2 选定本片达标标准;**先写 gate,后写实现**(eval-first) |
| 每次合并**前** | 跑本支柱 gate + 已完成支柱 gate 子集(防退化) |
| 一个支柱**收口** | 跑域套件中该支柱相关任务(k=3)做小全量 |

---

# Part II · 正式评测方案(业界公认)

## 2.1 是什么:方法学底座(Demystifying evals, 2026-01)

**Eval harness 五要件**:提供指令与工具 / 并发跑任务 / 记录每一步 / 打分 / 聚合结果;且**每个 trial 用隔离干净环境**(防跨 trial 污染),行为等价于生产部署。

**指标口径**:pass@k(k 次至少 1 次成功=能力上限)/ **pass^k(k 次全部成功=可靠性,主指标)** / error rate / tool-call 数与序列 / turn 数 / token · cost · latency · TTFT。

**三类 grader**(按客观程度选用):

| grader | 手段 | 用途 |
|---|---|---|
| Code-based | 精确/正则/模糊匹配、二元测试、静态分析、**环境 outcome 验证**、tool-call 验证 | 一切客观判据 |
| Model-based | rubric 打分、自然语言断言、pairwise、多裁判共识 | 主观质量 |
| Human | SME 抽检、spot-check | 定期校准前两类 |

**judge 隔离(硬规则)**:评分者**不得看到执行者的推理过程**,只评产物本身。

## 2.2 做什么:轨道 A —— 公开基准(对外"拿分")

参考模型**固定 Sonnet**,所有轮次不变,保证跨时间可比;每基准回答「是什么/怎么跑/报什么」:

### ① Terminal-Bench 2.0 —— 主战场(P0)
- **是什么**:业界公认的 agentic 终端任务基准;任务在 Docker 容器内执行、隐藏测试判分;**leaderboard 按「harness + model」成对上榜**(Claude Code、Codex CLI、OpenHands、官方参考极简 agent Terminus 2 同榜)——是唯一为「比 harness」而生的主流榜,对 harness 产品是量身跑道。Opus 4.6 发布时即以该榜第一作核心宣传。
- **怎么跑**:用其官方运行框架(Harbor)写 Anna 的 agent adapter:容器内装 Anna runtime 的 headless 入口 → 领任务 → 执行 → 官方隐藏测试判分;全量任务、每任务多 trial。
- **报什么**:`Anna (Sonnet) = NN%`;对照同榜 `Terminus 2 (Sonnet)` 参考基线 → **harness 贡献 = +X pp**。这一行就是对外可引用的分数。

### ② SWE-bench Verified —— 编码面(P1)
- **是什么**:500 条人工核验的真实 GitHub issue 修复任务;模型发布必引的编码 agent 基准;指标 = **resolved %**。
- **怎么跑**:Anna 的 Code 管线在官方 Docker harness 内产出 patch → 官方测试判分。
- **报什么**:`resolved %`,对照公开发布的「Sonnet + 参考 scaffold」数值 → harness 贡献 pp。

### ③ τ²-bench —— 企业工具+政策面(P1,推荐增补)
- **是什么**:带用户模拟器与领域政策(airline/retail/telecom)的工具型 agent 基准;**pass^k 的发源地**;三榜中最贴近「企业流程+审批政策」形态。
- **怎么跑**:Anna runtime 驱动 agent 侧接其模拟环境;每任务 k 次。
- **报什么**:pass@1 均值 + pass^k 曲线(k 至少到 4)。

> 对照分数以各官方 leaderboard **当日数值**为准,首跑时记录快照存档——榜是活的,不在本文写死数字。

## 2.3 做什么:轨道 B —— 域套件(对内真实)

任务是产品自己的,但**方法完全用 2.1 官方方法学**(= 业界模型卡的「内部 eval」一节):

- **任务库**:从真实产品面抽 10–20 个代表性任务,长跑型为主,至少含:一个带审批门的端到端业务流、一个跨重启续跑、一个并发多 run;每任务写清 code-based 可判定终态。
- **采样**:每任务 **k=5**,报 pass@5 + **pass^5**。
- **打分**:客观项 code-based;产物质量 model-based 隔离 judge,rubric 用官方模板——全栈:`product depth / functionality / visual design / code quality`;前端:`design quality / originality / craft / functionality`;**hard threshold:任一维不达标,整任务判 fail**(不许平均分蒙混)。
- **evaluator**:以 Playwright 驱动真 UI,核 UI / API / DB 三层真实状态;few-shot 校准(元原则 4)。

## 2.4 怎么做:执行规程与产出

- **环境**:每 trial 全新隔离环境;全程逐步记录(轨迹落盘);并发执行。
- **对照**:每次全量同时跑 **harness-on**(Anna 全栈)与**参考基线**(公开榜用 Terminus 2 等参考 agent 的公开分;域套件用「裸模型循环」),报贡献 pp。
- **产出 scorecard**(像模型卡),固定字段:

```
scorecard-<date>          参考模型: Sonnet(固定)
── 轨道 A 公开基准
   Terminal-Bench 2.0 : NN%   (参考基线 MM% → harness +X pp)
   SWE-bench Verified : resolved NN%   (基线 MM% → +X pp)
   τ²-bench           : pass@1 NN% · pass^4 NN%
── 轨道 B 域套件(k=5)
   任务 | pass@5 | pass^5 | rubric(hard threshold 过/不过)
── 顶层指标
   Task horizon __ 分钟 · pass^5(全套件)__% · cost per outcome $__
── 环比
   Δpass^5 / Δhorizon / Δcost(vs 上一 scorecard)
```

- **回归红线**:pass^5 环比降幅 >2 pp,或任一支柱 gate 转红 → **阻塞发布**。依据:Anthropic 2026-04 事后分析,Claude Code 三次质量退化**全部来自 harness 层改动**(推理档默认值下调、缓存 bug 持续丢 thinking 历史、系统提示过度限长)——harness 改动会静默伤分,回归跟踪就是为抓它。

## 2.5 什么时间做什么(评测节奏)

| 时机 | 跑什么 |
|---|---|
| 每 PR / 合并 | smoke gates(分钟级,CI) |
| 每支柱收口 | 域套件相关子集,k=3 |
| **开发完成(里程碑)** | **首跑全量双轨 → scorecard v0 = 长期基线;评测跟踪自此正式开始** |
| 每 release | 全量双轨重跑 + 环比 + 红线检查 |
| 新模型发布 | 轨道 A 重定基线;按元原则 3 重审脚手架 |
| 每季度 | Human 抽检,校准 model judge |

---

# Part III · 时间轴总表(什么时间做什么,一表收拢)

| Phase | 时间 | 做什么 | 出口判据 |
|---|---|---|---|
| **0 · 立标尺** | 现在,约 1 周 | 建最小 eval runner(隔离+并发+记录+判分+聚合);P1–P5 五个 gate 进 CI;搭 Terminal-Bench Harbor adapter 骨架(跑通少量任务即可,不出分) | 五 gate 一键可跑;TB 任务端到端走通 ≥1 条 |
| **1 · 开发期** | 与长跑轮同行 | 按 P1→P5 开发;eval-first(先 gate 后实现);每合并跑 gate 防退化 | 五支柱 gate 全绿 |
| **2 · 定基线** | 开发完成时 | 全量双轨首跑;记录公开榜当日对照快照;发布 scorecard v0 | scorecard v0 出炉,含 harness 贡献 pp |
| **3 · 长期跟踪** | 每 release 循环 | 重跑全量、趋势环比、红线把关;新模型发布重定基线并重审脚手架 | 三顶层指标逐版本改善 |

---

## 附 A · 权威出处

- **Demystifying evals for AI agents** — Anthropic Engineering, 2026-01-09(五要件 / pass@k·pass^k / 三类 grader / judge 隔离)
- **Harness design for long-running application development** — Anthropic Engineering, 2026-03-24(GAN 式三角色 / rubric + hard threshold / 四条元原则 / cost-quality tradeoff)
- **Effective harnesses for long-running agents** — Anthropic Engineering, 2025-11-26(P1–P4 原始定义与失败模式表)
- **Anthropic 2026-04 Claude Code 质量退化事后分析**(三次退化全在 harness 层 → 回归红线的依据)
- **Anthropic 2026 Agentic Coding Trends Report**(harness 配置可摆动基准 5+ pp)
- **METR · Measuring AI Ability to Complete Long Tasks**(task horizon 口径)
- **Terminal-Bench 2.0 / SWE-bench Verified / τ²-bench** 官方仓库与 leaderboard
- **Claude Code 官方文档**(五支柱的参考实现)
- MBZUAI 2026-05 Claude Code 源码量化研究(~98% harness 基础设施)

## 附 B · 应用到被测系统的方法(全文唯一一处)

拿 **1.2 的达标标准**对当前代码做一次审计,差距清单即开发 backlog,按 P1→P5 顺序推进;审计产物写入独立诊断文档,不回写本文。本文只随业界标准更新。
