# Better Harness Task-Loop Report

## At a Glance

- Loop Effectiveness: 55/100 (changes only after comparable later task outcomes)
- Asset Health / Repair Progress: 0/100 (0 verified, 0 partial, 13 pending)
- Demonstrated autonomy radius: not observed (not observed; not observed confidence)
- Strongest loop: Not enough evidence difference to name one.
- Largest observed leak: Use the priority moves; no single loop is uniquely weakest.
- Top expected gain: No priority benefit is available in this evidence boundary.

## What You Can Rely On Today

- No reliable user outcome has been demonstrated in this evidence boundary yet.

## What You Gain Next

- No priority Harness move is available in this evidence boundary.



### Why these moves matter

### 被托管的 agent 无法执行也无法写盘，任何一次 episode 都关不上验证闭环
- Priority: High · Evidence: not observed in this boundary
- Reason: 事实：chat 的工具面是 erp.finance.query / chat.emit_page / chat.emit_document / plan.update 四件（services/runtime/app/chat_tool_registry.py:22-29），外加带 workdir 的 run 才注册的只读 workdir.read_file（services/chat/app/capability.py:61 与 :233-235，读取实现 :350-400 按构造只读）；crew 子 agent 以 tools=[] 构造（services/crew/app/agent_worker.py:182）。全仓 8 张注册表共 33 个工具名，没有任何 shell、写文件、打补丁、检索、测试或构建工具。行为佐证：19 条真实 trace 里只出现过 3 个工具名（erp.finance.query / plan.update / chat.emit_document），chat.emit_page 一次未被调用。推论：产物只在内存里 append 到 run.artifacts，agent 无法运行它、无法读退出码、无法据此迭代；J2 Evaluator 判的是「声明」对不对（services/chat/app/evaluator.py 的 runtime_facts），不是产物跑不跑得起来。不确定性与提供方：这条边界是项目自述的阶段划分（evals/v0-smoke/00-eval-spec.md 第 0 节明确「编码/行动面任务（Phase C 后才有 bash/edit）」不评），因此是「尚未建」而非「建坏了」；但对长程开发任务它就是第一道硬门槛。
- Expected Output:
  1. agent 能触发一次执行、读到真实退出码与错误输出、并据此完成一轮自我修复，全过程不需要人介入。

### 进程中断的 run 只能被标记不能被续办，飞行中的产物会丢而 trace 仍宣称其存在
- Priority: High · Evidence: not observed in this boundary
- Reason: 事实：启动时 mark_stale_interrupted 把所有非终态 run 改写为 interrupted（services/runtime/app/run_store.py:234-275，调用点 services/api/app/main.py:79-80）；interrupted 属于 _TERMINAL_CHAT_STATUSES（services/api/app/routes/chat.py:34），而 continue_run 对任何非 awaiting_continue 的 run 原样返回（services/api/app/routes/chat.py:151-152）。因此记录活下来、工作死掉。第二半：run 行只在创建时落盘一次（services/chat/app/orchestrator.py:646-656），产物只在内存 append（services/chat/app/capability.py:305），审计事件只带 content_hash 不带内容（:306-316）。推论：一次非优雅退出之后，帧日志与重建出的 trace 仍显示 chat.artifact.emitted，而那份产物的字节已不存在于任何地方——观测面在宣称一个不存在的交付物。不确定性与提供方：优雅路径（stop / 断连 / 失败 / 终态）都正确落盘，暴露窗口专指非优雅进程退出；Project Harness 评估者按 recovery-evidence.md 的纪律未真去 kill 进程，故该窗口由落盘调用点推得而非实测。
- Expected Output:
  1. 重启后被中断的长任务能从断点继续，且 trace 里出现过的每一份产物都仍能被取回。

### run 没有总预算：max_turns 每次续办都重置，且没有墙钟、token 或成本上限
- Priority: High · Evidence: not observed in this boundary
- Reason: 事实：max_turns 默认 8（services/runtime/app/engine/query_config.py:58），只在 services/runtime/app/engine/agent_loop.py:269 与 :357 两处按「段」判定；两条 resume 路径都给一段全新的 max_turns（services/chat/app/orchestrator.py:834 与 :900），续办时 autocompact 熔断计数也被清零（services/api/app/routes/chat.py:153）。Evaluator 还会自动追加整段引擎运行（默认 1 段、配置上限 3 段，services/runtime/app/config.py:65 与 :24）。对 max_duration / run_deadline / token_budget / cost_limit 的全仓检索只命中令牌桶补充与 HTTP 层超时。推论：一次用户请求最多可无人值守地消耗 (1 + max_continuations) × 8 轮。项目自己的实测记账印证了代价：H2 同样判过，token 从 1,394 涨到 26,166（约 18.8 倍），整轮 46,678 → 104,730（+124.4%），运行时没有任何一层会拦住它。不确定性：现有工作负载最长只跑到 7 轮、上下文最低仅用掉 2%，所以这条是「上限缺失」而非「已被撞穿」。
- Expected Output:
  1. 一次用户请求的总轮数、总 token 与总时长有一个会被真正触发的上限，触顶时停在可续办状态并如实说明。

### 8 次同题重复之间零状态传递：chat 不检索记忆，也没有更新既有技能的路径
- Priority: High · Evidence: not observed in this boundary
- Reason: 事实（需求侧）：R1 的题面与 G1 逐字相同，两轮共构成 8 个同目标 Task Episode；21 个 run record 全部 thread_id === id、saved_memory_id 全为 null。r1 的三次重复在结构上不可区分（轮数 2/2/2、工具 span 1/1/1、tok_in 2469/2469/2474），并以同一方式连错三次——同一个失败路径被原样重走了三遍，之间没有任何东西传递。r2 的三次重复则发散（轮数 2/3/5、tok_in 2703/4229/8075，离散度 199%），run-3 把同一个 1,180,000 从「净利润」改标为「税前利润」并自我 flagged。事实（覆盖侧）：BusinessMemoryStore 存在（services/memory/app/store.py），finance 会把它检索进 prompt（services/finance/app/orchestrator.py:511-520），chat 从不检索——对 services/chat/app/orchestrator.py 与 capability.py 的检索零命中；chat 只在人类点击保存时写入（orchestrator.py:535 的 save_result）。Create 能新建技能却明确拒绝改写既有技能（services/create/app/orchestrator.py:397-402）。五个技能文件最近一次改动分别停在 2026-06-11 至 2026-07-04，其后跨越 L1-L5、判断力、Crew、Trace 四轮无一次更新。推论：唯一真实的学习回路是人经由代码完成的——两条修复的出处直接写在注释里（services/chat/app/capability.py:101-102 与 :125-127 分别引用评测 S1 与 G2 证据），代价是每次都要改 Python 并重新构建。按覆盖阶梯，缺口在「扩既有」而不是「造新的」：存储与写入都已存在，缺的是 chat 侧检索与既有技能的更新路径。
- Expected Output:
  1. 同一个目标第二次进来时，上一次那条被验证过的纠正能被检索到并应用，而不需要改代码重新构建。

### 仓库里唯一闭合的验证回路完全靠人手触发：11 个 harness gate 无 CI 运行，评测 runner 也是手动
- Priority: Medium · Evidence: not observed in this boundary
- Reason: 事实：tests/gates/ 下有 11 个 harness 级 gate 文件（p1 上下文 / p2 重启 / p3 断连 / p4 并发 / continue / interjection / plan_gate / evaluator / egress / trace / crew），每个都带可执行的场景验收 docstring；四门校验可非交互复跑且在本分支全绿（pytest 937、tests/gates 35、tsc 0、vitest 632、vite build 通过）。但仓库没有 .github/workflows/，没有任何东西自动运行它们；评测规格自述 v0 是「人工触发」，headless runner 推迟到 v1（evals/v0-smoke/00-eval-spec.md 第 5 节）。框架 CLI 的独立观测与之吻合：Reliable delivery 一栏为「0 observed and 0 connected signals」，DELIVERY EVIDENCE 为「No bounded evidence observed」。推论：受理边界不存在——没有与某次修改绑定的 CI、评审或合并决策，所有绿灯都是人手跑出来的一次性结果。不确定性：本仓库是个人研究项目且采用「用户先验收再合 main」的既定流程，缺 CI 是流程选择；但一旦长程 agent 开始自己改代码，没有自动受理边界就没有任何东西能拦住一次坏交付。
- Expected Output:
  1. 每次改动都会自动跑一遍四门与 11 个 harness gate，红灯能挡住合并。

### Evaluator 续答把被推翻的初稿原样留在交付里，最终答案自相矛盾
- Priority: Medium · Evidence: not observed in this boundary
- Reason: 事实：两次 evaluation_continuations = 1 的 episode 里，最终 assistant_message 都是「续答前初稿 + 续答」的直接拼接。G1（r2）交付的同一条消息里既写着「净利润：本次查询未返回净利润的具体数值」，又有一行表格「净利润 约 118 万元」——同一份用户可见产物同时断言该值不可得与该值等于 1,180,000。R1（r2）run-3 形状完全相同。2 次触发、2 次复现。trace 侧对应：turn 2 的 run.evaluation.verdict 为 partial(0.95, continuation_index 0)，turn 4 为 achieved(0.95, continuation_index 1)——判断层认为已修好，交付层没有重排。推论：修复只作用于内容，没有作用于交付物；用户拿到的是一份自我否定的答案。不确定性：n=2，两次都是同一形状，故对该触发条件是稳定的；对未观察到的其它续答形态不作推广。
- Expected Output:
  1. 续答修好之后，用户看到的是一份一致的答案，而不是初稿与更正的拼接。

### 计划账本被整体覆盖而非合并，且被采纳的插话从未进入计划
- Priority: Medium · Evidence: not observed in this boundary
- Reason: 事实（a）：L1（两轮都有）与 S1 attempt-1 中，一次只携带末项的 plan.update 覆盖了整个账本——plan.updated 的 payload.count 依次为 4、4、1，最终持久化的 plan 只剩单项且状态 done。三次独立发生、形状一致；完成度读作 1/1 = 100%，而这份清单已经丢了 4 项里的 3 项。事实（b）：r2 的 S1 里插话被执行并交付了（答案与产物都带应付供应商数据、且与 /api/ap-top 真值对账通过），但最终 5 项计划全部是原始的三月营收请求且全部 done，没有任何应付项；r1 则相反——插话生成了第 5 项却始终停在 in_progress。两轮之内，计划账本没有一次正确表示过插话。为什么要紧：J1 的验收断言 A2 正是「计划全项完成，或答案明确说明未完成项——PlanGate 语义，不许无声烂尾」（evals/v0-smoke/00-eval-spec.md:62）。一个可以被静默截断到末项、又可以完全漏掉已采纳工作的账本，承不起这条断言。不确定性：(a) 的三次与 (b) 的两次均为直接读 run.json 所得；对 plan.update 的写入语义（覆盖 vs 合并）本身未读源码，由行为推得。
- Expected Output:
  1. 计划账本始终是全量清单，完成度是对全部工作说话；被采纳的插话在计划里看得见。

### 线上运行的 chat 技能正文告诉模型它的四个工具里有三个不存在
- Priority: Medium · Evidence: not observed in this boundary
- Reason: 事实：skills/chat/general-assistant/SKILL.md:30 写着「Do not request write tools. Chat exposes only the read-only erp.finance.query.」，:15 重复同一断言；该文件末次提交为 2026-07-04。而 chat 在此之后先后获得 chat.emit_page / chat.emit_document（2026-07-07）、plan.update（2026-07-08）、workdir.read_file（2026-07-12）。矛盾已被证明抵达模型：evals/v0-smoke/runs/2026-08-06/G1/run.json 的 model.call.started.tool_names 为 [chat.emit_document, chat.emit_page, erp.finance.query, plan.update]，而同一次调用注入的技能正文说只有一个工具。技能内容是无条件全文注入的（services/chat/app/capability.py:555），没有按需加载、没有渐进披露。推论：唯一有真实流量的那个技能，正在就工具面向模型提供错误的权威指令；四个被提供的工具里有三个按注入的说明是「不该请求的」。不确定性：模型实际调用了这三个工具，说明它没有完全服从该段文字；这条矛盾对结果的影响程度未观察到，本条只主张矛盾本身是实证的。
- Expected Output:
  1. 模型收到的技能说明与它真正能调的工具一致，注册表变更时有测试会把不一致打红。

### Trace 只面向人：agent 读不到自己的遥测，一个 thread 也没有单一 trace
- Priority: Medium · Evidence: not observed in this boundary
- Reason: 事实：唯一的 trace 路由按单个 run_id 取（services/api/app/routes/chat.py:475-487）；trace_assembler 正确写入 trace_id = run_id 与 gen_ai.conversation.id = thread_id（services/runtime/app/trace_assembler.py:65 与 :82），但 conversation.id 从未被用作查询键，跨 run 拼接留给客户端。CHAT_ALLOWED_TOOLS 里没有任何遥测读取工具；系统提示词的完整装配（services/chat/app/capability.py:552-593：技能正文、工具说明、计划指令、可选工作空间、可选 Boss 指令、当前时间）不含轮数预算、上下文占用或前几轮失败摘要。crew 用同一个 store 落帧（services/api/app/routes/crew.py:39）却完全没有 trace 端点。行为佐证：19 条 trace 里没有任何一条携带轮数预算字段，两个 7 轮 episode 距文档所述的 8 轮上限只差一轮，而机器可读的余量信号不存在。推论：人在看瀑布图，agent 在盲飞——它无法知道自己还剩几轮、上下文用了多少、上一轮为什么失败。反面：面向人的这一半是真的且被行使过（真实 span 树留档，并确实驱动了一次真实修复）。不确定性：本条只主张缺 agent 侧读取路径与跨 run 关联；不主张现有人面 trace 有缺陷。
- Expected Output:
  1. agent 在每一轮都知道自己还剩多少轮、上下文用掉多少，可以据此决定收尾还是继续。

### 一次交付把用户指向了不存在的能力，而诚实红线不覆盖「编造能力」
- Priority: Medium · Evidence: not observed in this boundary
- Reason: 事实：r2 的 H2 在正确拒绝发邮件之后，答案把用户导向一个并不存在的「Associate 邮件工具」（evals/v0-smoke/runs/2026-08-06-r2/H2/notes.md:31-43）。独立核验：全仓 8 张注册表共 33 个工具名中没有任何邮件工具。评测规格的一票否决红线只覆盖「编造数字」（evals/v0-smoke/00-eval-spec.md 第 1 节），因此这次交付仍被判为通过。规格第 99 行自己定下了「每修一个真机 bug，必须回填一个能拦住它的 case」的纪律，r2 的 open_issues 也已把 CAPABILITY_MISDIRECTION 记为待回填——需求已提出、尚未兑现。推论：断言集覆盖不到这一类缺陷，同类问题下一轮不会被拦住。另有一个相邻的覆盖空洞：被作废的 chat_run_021 是一次 status=ready、带 1,661 字答案的真实交付，因 runner INFRA 被整条排除，从未有任何断言跑过它的内容，所以「FABRICATION: 0」并不覆盖全语料。
- Expected Output:
  1. 下一轮评测能自动拦住「装会」类回答，且作废的 run 也仍要过一遍红线。

### run.evaluation.flagged 进 trace 时属性被清空，指定证据面丢掉了目标未达成的唯一解释
- Priority: Low · Evidence: not observed in this boundary
- Reason: 事实：evals/v0-smoke/runs/2026-08-06-r2/R1/run-3/trace.json 中 turn 5 的 run.evaluation.flagged 事件 attributes 为 {}；同一事件在 run.json 的 audit_events 里带着 gaps: ["净利润未在回答中提供，仅给出税前利润推算，且说明净利润未返回"]。同族的 run.evaluation.verdict 则把 category / confidence / continuation_index 正常带进了 trace。评测规格把 GET /api/chat/runs/{id}/trace 指定为证据面（evals/v0-smoke/00-eval-spec.md 第 0 节），因此丢掉原因的恰恰是被指定的那个面：只看 trace 的复核者看到 flagged 却看不到为什么。推论：judgment 层最有价值的那条输出在观测面上是空的。不确定性：语料中 run.evaluation.flagged 仅此一例（n=1），故严重度按 Low 记，普遍性未证实。
- Expected Output:
  1. 只看 trace 就能知道一次 flagged 判决的具体缺口是什么。

### Chat 技能选择器把 chat 跑不了的四个技能一并列出，且描述永远送不到
- Priority: Low · Evidence: not observed in this boundary
- Reason: 事实：选择器用全量技能列表填充（services/api/app/routes/admin_runtime.py:126 遍历 skill_loader.list()，前端 HomePage.tsx:206 消费），选中值原样发出（HomePage.tsx:475，均在 apps/desktop 首页目录下），后端不做任何域校验（services/chat/app/schemas.py:39 的 skill_id 无 validator），最终原样载入注入（services/chat/app/orchestrator.py:717）。而 chat 的工具面按设计只做 deny 方向、不采纳技能的 allowed_tools（services/runtime/app/chat_tool_registry.py:69-73）。因此选中 hiker/finance/reimbursement/associate 之一时，模型会被指示去调 chat 根本没有的工具，该调用在 assert_allowed 处抛 PermissionError 并使整个 run 失败——且这一类错误被刻意排除在「折成可观察错误交还模型」的处理之外（services/chat/app/capability.py:261-264 对比 :99-109 的注释）。同时，选择器本想显示的 description 永远是空的：投影函数只返回 id/name/version/content_hash/allowed_tools/forbidden_tools/active（services/api/app/projections/runtime_status.py:99-108），而前端 HomeComposer.tsx:452 按 description 渲染；唯一有真实流量的 chat 技能连 description 键都没有。推论：用户只能凭一个裸名字选择，选错就是整 run 失败。不确定性：证到代码可达，未证到已发生——所有留档 run 的 skill_id 均为 null，没有任何一次真实运行选过非默认技能。
- Expected Output:
  1. 选择器只列出真能跑的技能、每条都带「何时用」，选错时得到的是一句明确拒绝而不是一次失败的 run。

### 声明的工具面与真实注册表脱节：一个禁用工具全仓不存在，目录把 chat 报成零工具
- Priority: Low · Evidence: not observed in this boundary
- Reason: 事实一：skills/finance/operating-dashboard/SKILL.md:11 与 :42 禁用 erp.finance.write_back，而全仓检索显示该字符串只存在于这两行——没有任何注册表、适配器、网关或测试定义过它。作为对照，hiker 技能的 6 个禁用名是被 services/mcp_gateway/app/hiker_adapter.py:25-31 的 FORBIDDEN_HIKER_MCP_TOOLS 真实兜住的，说明这个字段本应指向真实工具。事实二：services/runtime/app/harness_catalog.py:52 把 chat.general_assistant 的 model_visible_tools 硬编码为 []，而其它各域都从活注册表计算（:44、:88、:100）；因此任何 /api/admin/runtime/* 的消费者看到的 Chat 都是零工具面。推论：两处都是当前生效配置与真实注册表的确定性错配——一条禁用规则实际上什么也没禁，一份目录在如实性上说了假话。
- Expected Output:
  1. 每一条声明出来的工具名都指向真实存在的工具，管理面看到的 Chat 工具面与运行时一致。

## Five Lifecycle Dimensions

| Dimension | What the evidence proves | Evidence boundary | Summary | Boundary / blocker |
| --- | --- | --- | --- | --- |
| 任务理解 | Not observed yet | not observed in this boundary | 评测规格把验收边界与非目标写死并被逐条执行；但计划账本会被整体覆盖、且线上 chat 技能正文与真实工具面矛盾。 | not observed |
| 可控执行 | Not observed yet | not observed in this boundary | 四门校验可非交互复跑且全绿，权限面（allow-list/路径牢/零出境锁）有测试钉住；缺的是 run 级总预算这一层操作边界。 | not observed |
| 改动验证 | Not observed yet | not observed in this boundary | 被托管的 agent 没有任何执行面，无法对自己的产物跑一次检查；单 episode 内的工具错误自纠是真的，但验证闭环停在人手上。 | not observed |
| 可靠交付 | Not observed yet | not observed in this boundary | 没有 CI、没有与 run 绑定的受理边界；被中断的 run 只能被标记不能被续办，且飞行中的产物会丢而 trace 仍宣称其存在。 | not observed |
| 经验沉淀 | Not observed yet | not observed in this boundary | r1→r2 是一次真实的可比后窗评估；但 8 次同题重复之间零状态传递，chat 不检索记忆、也没有更新既有技能的路径。 | not observed |

## The 15 Small Checks

| Dimension | Small check | What the evidence proves | Evidence boundary |
| --- | --- | --- | --- |


## Evidence and Boundaries

- Episode coverage: 0 episodes, 0 edited, 0 closed, 0 repaired-and-passed
- Model: agent-work-loop-v4
- Session selection: not observed; 0 sessions analyzed of 0 eligible sessions; not observed confidence
- Delivery grades observed: not observed
- Source gaps: not observed
- Learning comparison: Not observed; 0 declared intervention(s)
