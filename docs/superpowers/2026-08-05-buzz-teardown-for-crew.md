# Buzz 拆解 · 对照 Anna Crew 的可借与不可借

> 2026-08-05 · 研究报告(不含代码改动)
> 对象:[block/buzz](https://github.com/block/buzz) —— Block 开源的自托管协作底座
> 目的:核验「Buzz 是 Crew 想要效果的一部分,但他没画图」这一判断,并提炼可借的思想

---

## 0. 一句话结论

**判断成立,而且比预期更彻底:Buzz 不但没有 DAG,连"任务"这个概念都没有,他们的审批门还是坏的。但这不重要——因为 Buzz 的赌注根本不在编排层,而在"Agent 用和人完全相同的接口干活"。那一条,Crew 输得很干净。**

Crew 的 Agent 拿着一个**空工具箱**,看不见频道,一次性吐出文档就完事。Buzz 的 Agent 拿着 shell,而 PATH 上有一个为 LLM 调用而设计的 CLI,于是它能像人一样在频道里说话、追问、回帖。

---

## 1. 事实层级声明(先说我核到什么程度)

这份报告的可信度不均匀,按下面三档读:

| 档 | 含义 | 覆盖内容 |
|---|---|---|
| **A · 源码核实** | 我读了 Buzz 仓库里的真实源文件 | `crates/buzz-acp/src/queue.rs` 的排队/批量/去重/回帖机制;28 个 crate 的真实目录树 |
| **B · 官方文档核实** | 读了仓库内 `ARCHITECTURE.md` / `VISION*.md`,内容具体到 kind 号、常量值、已知缺陷编号,与目录树互相印证 | 事件模型、workflow 引擎、crate 分层、Agent 会话模型 |
| **C · Crew 源码核实** | 本仓库代码逐行核对,每条论断附文件行号 | 第 4、5 章全部结论 |

**没做的**:没有 clone 编译 Buzz、没有跑起来实测。凡是 B 档结论,若将来要照着实现,应先对源码复核一遍。文档写"已建成"而代码没跟上,是这类项目的常见状态——Buzz 自己就有一处(见 §3.2)。

---

## 2. Buzz 是什么

### 2.1 一句话

一个跑在 **Nostr relay** 上的自托管工作区。聊天、代码评审、workflow 步骤、git 事件、审批——**全部是同一个签名事件日志里的条目**;人和 Agent 用同一种 keypair 签名,进同一个搜索索引。

官方原话:*"an event log with taste and a suspicious number of Rust crates."*

### 2.2 架构

28 个 Rust crate(已核实目录树),分层严格:

```
buzz-core            零 I/O —— 类型、验签、filter 匹配、kind 注册表
                     依赖里明令禁止 tokio / sqlx / redis / axum
   ├─ buzz-db        Postgres:事件、频道、workflow、审计
   ├─ buzz-auth      NIP-42 / NIP-98 / API token / scope
   ├─ buzz-pubsub    Redis:pub-sub、在场、正在输入
   ├─ buzz-search    Postgres FTS,走 generated search_tsv 列
   ├─ buzz-audit     哈希链,防篡改
   └─ buzz-workflow  YAML-as-code 自动化
buzz-relay           Axum 服务,唯一事实源,导入以上全部并协调
buzz-acp             把 @mention 桥接到 AI Agent(JSON-RPC over stdio)
buzz-agent           ACP 实现,≤8 并发 session,上下文满了自摘要续跑
buzz-dev-mcp         MCP server:shell / 文件编辑 / 搜索
buzz-cli             JSON in, JSON out —— 明确为 LLM tool call 设计
```

**最值得学的一条纪律**:*"子系统之间互相隔离:`buzz-workflow` 从不调用 `buzz-pubsub`,`buzz-search` 从不调用 `buzz-db`。跨子系统协调只经由 relay。"*

### 2.3 事件模型:kind 整数即一切

每个动作都是一个签名的 Nostr 事件,六个字段:`id` / `pubkey` / `kind` / `tags` / `content` / `sig`。

**分发的唯一机制是 `kind` 整数**。新功能 = 定义一个新 kind 号;*"现有客户端什么都看不见,也什么都不会坏。"*

| kind 区间 | 语义 |
|---|---|
| 0–9999 | 标准 Nostr(NIP-01 起) |
| 10000–19999 | 可替换(NIP-16) |
| 20000–29999 | 短暂事件(不存储、不审计) |
| 30000–39999 | 参数化可替换 |
| 40000–49999 | Buzz 自定义 |

已注册 **127 个 kind**,事实源在 `buzz-core/src/kind.rs` 的 `ALL_KINDS: &[u32]`。其中:`43001` = Agent 作业请求,`46001–46012` = workflow 执行事件,`20001` = 在场心跳(短暂)。

---

## 3. 核验你的假设:Buzz 有没有图?

### 3.1 没有,而且是设计上的没有

Buzz 的 workflow 是 **YAML 线性步骤表**:

```yaml
name: "Incident Triage"
trigger:
  on: message_posted           # 或 reaction_added / schedule / webhook
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message       # 共 7 种 action
    text: "P1 incident detected"
```

- **触发器 4 种**:`message_posted` / `reaction_added` / `schedule` / `webhook`
- **动作 7 种**:`send_message` / `send_dm` / `set_channel_topic` / `add_reaction` / `call_webhook`(防 SSRF、禁重定向、1 MiB 上限)/ `request_approval` / `delay`(≤300s)
- **条件**:`evalexpr`,100ms 超时,自定义函数只有 `str_contains` / `str_starts_with` / `str_ends_with` / `str_len`
- **并发**:`Arc<Semaphore>` 100 permit,`try_acquire()` —— 满了立刻返回 `CapacityExceeded`,**不排队**

**没有拓扑排序,没有环检测,没有图遍历。** 步骤间依赖只能靠模板变量隐式表达(`{{steps.ID.output.FIELD}}`),没有显式依赖声明。执行器就是按 YAML 列表顺序往下走,每步可选一个 `if:` 守卫。

结论:**线性序列 + 可选守卫,不是 DAG。**

### 3.2 而且他们的门是坏的

`request_approval` 本应挂起 run 进入 `WaitingApproval`。**但执行器在创建挂起态之前就拦截了,撞到审批门的 run 直接被标记为 failed。** 这是他们文档里自己标注的已知缺陷(🚧 WF-08)。

对照 Crew:门是真的,而且状态机是完整的——`submit` → `submitted`(待审)、门就绪条件 = 上游 ∈ {submitted, done}、`approve` 时 producer 才落 `done`、`reject` → `rework` 且驳回批注注入下一次重跑([00-master-plan.md:234](plans/2026-07-17-crew-build/00-master-plan.md))。

### 3.3 连"任务"都没有

查 `VISION_PROJECTS.md`:Buzz 的"项目"= 多 repo 分组(`kind:30621`),repo 本身是 `kind:30617`。工作单元是**分支**——*"a feature branch is a conversation"*,补丁、评审、CI、合并决策全在一条频道流里。

**没有 assignee、没有依赖、没有优先级、没有看板、没有 DAG 可视化。** 官方措辞:这个 forge 是**被搜索索引的事件流**,不是可查询的图数据库。

他们的定位句:*"Workflows orchestrate. Agents perform the compute."* —— 但 job 是短暂计算,不是持久追踪的任务。

> **小结**:在"把工作拆成有依赖、有状态、有门的结构"这件事上,Crew 全面领先,且领先不是一点半点。这部分**不要动**。

---

## 4. 转折:Buzz 真正领先的那一条

### 4.1 他们的赌注不在编排层

workflow 引擎是 Buzz 系统里最弱的部分。他们的赌注写在 `VISION.md` 里:

> **"Agent as colleague, not platform."** 人和 Agent 共享完全相同的原语——keypair、事件、频道、profile。relay 提供管道(事件存储、搜索、订阅);智能来自人和 Agent。
>
> **"Buzz is the pipe—not the brain."**

以及 README 里那句刀子:Agent 是**"房间里的一员,不是闹鬼的定时任务"**(*part of the room, not haunted cron jobs*)。

### 4.2 这句话在机械层面怎么落地(源码核实)

这是本次研究最有价值的发现。Buzz 的 Agent 能在频道里说话,不是靠专门的"Agent 发消息 API",而是靠一条**极其朴素的组合**:

```
① Agent 的工具集 = shell, str_replace, todo  (+ PATH 上有 rg / tree)
                        ↓
② PATH 上还有 buzz-cli —— JSON in, JSON out,明确「为 LLM tool call 设计」
                        ↓
③ 于是 Agent 能做任何人能用 CLI 做的事:发消息、串线程回帖、加表情、读频道
```

入站(人 → Agent)由 `buzz-acp` 处理;出站(Agent → 人)**根本没有专门机制**——`append_reply_instruction()` 只是往 prompt 里塞一句指令,告诉 Agent 回帖时用:

```
buzz messages send --reply-to <event_id>
```

配合 `resolve_reply_anchor()` 算出线程锚点。**没有新协议,没有新端点。人怎么说话,Agent 就怎么说话。**

`VISION_REMOTE_AGENTS.md` 把这个交互模型讲得最直白:

> 一切经由 relay:**你读 Agent 的消息来了解它干得怎么样,你 @ 它来纠正它。**

### 4.3 入站机制(源码核实,`buzz-acp/src/queue.rs`)

这部分工程细节做得很扎实,值得逐条记下来:

| 机制 | 实现 |
|---|---|
| 存储 | `HashMap<Uuid, VecDeque<QueuedEvent>>`,按频道 id 分桶 |
| 背压 | 每频道上限 `MAX_PENDING_PER_CHANNEL = 500`,超了丢最老的并告警 |
| 公平 | `flush_next()` 选**最老待处理事件所在的频道**(跨频道 FIFO 公平) |
| 批量 | 单次最多抽 `MAX_BATCH_EVENTS = 50` 条,合成**一个** prompt |
| 排序 | 按 `created_at` 时序重排(relay 回放是 newest-first,必须翻过来) |
| 在飞 | 频道进 `in_flight_channels`,带 deadline(约 7300s) |
| 去重 | 两种模式:**Drop(默认)**——在飞期间同频道新事件静默丢弃并 debug 日志;**Queue**——照常入队,等 `mark_complete()` 后随下一批 flush |
| 崩溃 | Agent 子进程崩溃自动重启;进程池 1–32 个(默认 1) |

**"Drop 为默认"是个有意思的产品取向**:人在等 Agent 干活时连发三条补充,Buzz 默认**全丢**,只认第一批。理由推测是防止 prompt 被中途污染,但代价是人的补充消息静默消失。这是一个值得我们警惕而非照抄的选择。

---

## 5. Crew 对照体检(全部附行号)

### 5.1 Crew 已经领先的

| 项 | 证据 |
|---|---|
| 真 DAG + 七态 + 评审门 | Work Graph 画布、`recompute_readiness`、门就绪 = 上游 ∈ {submitted, done} |
| 门状态机完整 | `submit → submitted`、`approve` 才落 `done`、`reject → rework`(Buzz 此处直接 failed) |
| 在飞去重 | [routes/crew.py:120,142-157](../../services/api/app/routes/crew.py) `_inflight_by_task`,双击/双标签页幂等 |
| 项目共识注入 + 命中审计 | `memory_hits` 落审计,前端 trace 可溯源 |
| 频道行 ↔ 审计双向可查 | `audit_ref = "#a" + seq`,每条编年史行都能点回审计条目 |
| 人 → Agent 的频道召唤 | [service.py:471](../../services/crew/app/service.py) `_redispatch_mentioned_agents`;`@Scribe 再改改` 直接重派其在办任务 |
| 意图确认卡 | [service.py:52](../../services/crew/app/service.py) `_INTENT_PATTERN` 零模型意图门控 → 草案卡 → 确认才建任务 |

### 5.2 三个真缺口

#### 缺口一:Agent 有一个空工具箱(最硬)

[agent_worker.py:142-186](../../services/crew/app/agent_worker.py) 的 `_ReadonlyAssistantHandler` 构造时 `tools=[]`;任何工具调用直接返回 `tool_not_allowed`([:156](../../services/crew/app/agent_worker.py))。

prompt 是**一次性**的([:326-356](../../services/crew/app/agent_worker.py)):项目目标 + 任务 + 说明 + 验收标准 + 返工批注 + 上游产物 + 项目共识,结尾一句「请直接产出该任务的交付物(markdown 可用),不要前言」。

于是方向是单向的:

| 方向 | 状态 |
|---|---|
| 人 → Agent(频道) | **已通** |
| Agent → 人(频道) | **完全没有**。Agent 只能用「交出产物」或「失败阻塞」两种方式说话 |

它**不能**提问、不能说"验收标准有歧义"、不能中途汇报进度、不能 @ 人要一份缺失的输入。遇到不确定,它只能猜——然后被驳回。

对照 Buzz 那句「你读 Agent 的消息来了解它干得怎么样」:**Crew 的 Agent 是哑的。**

#### 缺口二:频道对话对 Agent 完全不可见

`_build_prompt` 的输入清单里**没有频道**。全文件搜不到任何 `list_channel` / 频道消息读取。

后果:Boss 和 Andy 在频道里讨论了三轮"这次登录页别做深色",Agent 一个字都看不到。**唯一能传给 Agent 的人类意见,是被驳回时写进 `blocker` 的那一句话。**

Buzz 的模型正相反:频道流**就是**上下文。

#### 缺口三:返工历史是有损的

[schemas.py:44](../../services/crew/app/schemas.py) `blocker: str | None` —— **标量字段**。

`_build_prompt` 里 `if task.blocker:` 只读这一个值([:339](../../services/crew/app/agent_worker.py))。所以多轮返工时,**只有最近一次驳回意见进 prompt,前几轮的批注全部丢失**。

典型故障:v1 被驳"太长",v2 改短了但漏了合规段,v3 的 prompt 里只剩"漏了合规段"——Agent 补上合规段,又写长了。**在第 3 轮把第 1 轮的问题改回去。**

注意 `artifact_versions` 是有历史的(B4 已做),但**评审意见没有**。产物留了版本,批注没留。

---

## 6. 可借的四条(按性价比排序)

### ★ 1. 让 Agent 在频道里能说话

**借的是**:*Agent 与人同一套接口*。

**Buzz 的实现方式值得抄的地方在于它有多懒**——不发明新协议,只是把人用的入口交给 Agent。Crew 的等价物已经存在:`CrewService.say()`([service.py:443](../../services/crew/app/service.py))就是人发言的入口,它已经带 mention 过滤、通知派发、幂等。

最小切口不是"给 Agent 装一堆工具",而是:
- 打开 `_ReadonlyAssistantHandler` 的工具集,给一组**只写频道、不碰状态机**的动作(提问 / 记录 / 标歧义)
- `ChannelAuthorKind` 目前是 `"anna" | "member"`,Agent 发言的作者维度需要能诚实呈现(它不是 Anna,也不完全是普通 member)
- 前端频道加一族"Agent 提问卡",人回答后进入下一轮

**注意反作用力**:一旦 Agent 能提问,「一次性产出」的运行模型就要变成「可挂起、等人回答、再续跑」。Crew 已经有续办机制(长跑轮 L4),这不是从零开始,但也不是小改。

**代价**:中。**收益**:最高——它同时缓解缺口一和缺口二。

### ★ 2. 把频道对话喂进 prompt

**借的是**:*频道流即上下文*。

比第 1 条便宜得多:在 `_build_prompt` 里加一段"本任务相关的频道讨论",取该 task_id 锚定的消息 + 最近 N 条项目级讨论,照现有 `_UPSTREAM_ARTIFACT_CHARS` 的截断规矩处理。

**要小心的**:频道里有大量噪声和状态机自动生成的 event 行,无差别灌进去会稀释 prompt。需要一个筛选口径(只取 `say` 和 `review` 族?只取带该 task 锚点的?),这个口径本身是个产品决策。

**代价**:低。**收益**:高。**建议作为第 1 条的前置**——先让 Agent 能听见,再让它能说话。

### 3. 评审意见留全史

**借的不是 Buzz 的具体设计**(他们没有),而是他们"一切皆事件、不覆盖"的底座纪律,反照出 `blocker: str | None` 这个标量的问题。

把驳回批注升为与 `artifact_versions` 对齐的列表(每条带 version、reviewer、时间),prompt 里给 Agent 完整返工史。

**代价**:低(schema + prompt 组装)。**收益**:中,但**故障场景很具体**——第 3 轮改回第 1 轮的问题,是会真实发生并且很难 debug 的那类 bug。

### 4. 统一事件底座 + 跨面检索

**借的是**:*一条日志 + kind 分发,其余全是投影*。

Crew 现在是**四条平行日志**:`audit` / `channel_messages` / `notifications` / `frame_journal`。它们同源派生(都挂在 `_append_event` 那个 transition 点上,这个设计是对的),但分表存储。后果:**没有任何跨面检索**——搜不了"对话 + 产物 + run + 审批"。

Buzz 的做法是一条日志 + `kind`,频道/通知/图全是投影,于是一次搜完。他们的 kind 区间纪律(短暂事件 20000–29999 不存储不审计)也很值得学——`frame_journal` 的高频帧正好属于这一类。

**代价**:高,地基级重构,会碰 store / service / 前端全链。**收益**:高但不紧急。

> **建议序**:2 → 3 → 1 → 4。前两条便宜、独立、可单独验收;第 1 条是主菜但要动运行模型;第 4 条留给真有跨面检索需求的时候。

---

## 7. 明确不该借的

| 项 | 理由 |
|---|---|
| **workflow 引擎** | 线性 YAML,无拓扑排序无环检测,依赖靠模板变量隐式表达。**比 Crew 的 DAG 差一个量级** |
| **`request_approval` 门** | 他们自己的门是坏的(WF-08,撞门即 failed)。Crew 的门状态机完整 |
| **Drop 为默认的去重模式** | 人在 Agent 干活期间补充的消息被**静默丢弃**。Crew 的产品口径是零捏造 + 诚实呈现,静默丢消息与之冲突;若借这套队列,应默认 Queue,或至少让被丢弃的消息在频道里留痕 |
| **Nostr / keypair 身份模型** | Buzz 需要它是因为要做主权自托管和跨 relay 联邦。Anna 是本地桌面优先、单工作区,引入签名事件的复杂度换不来对应收益 |
| **`try_acquire` 立刻拒绝的并发闸** | Crew 已有 `concurrency.py`。Buzz 满了直接 `CapacityExceeded` 不排队,对一个"组织协同"产品来说是错的语义——任务应该排队,不应该消失 |

---

## 8. 一句话对照表

|  | Buzz | Anna Crew |
|---|---|---|
| **交互单元** | 消息 | 任务节点 |
| **Agent 怎么被叫醒** | @mention 入队,批量成 prompt | 派活 + 「执行」按钮;`@Agent 再改改` 重派 |
| **Agent 怎么回话** | `buzz messages send --reply-to`,和人同一个 CLI | 交出产物,或失败阻塞。**没有第三种** |
| **怎么纠正 Agent** | 再 @ 它一次,进下一批 prompt | 驳回 + 批注,注入下次重跑(只留最后一条) |
| **上下文来源** | 频道流 | 任务字段 + 上游产物 + 项目共识。**频道不可见** |
| **编排** | 线性 YAML,门是坏的 | 真 DAG,七态,门完整 |
| **工作结构** | 分支即对话,无任务无依赖无看板 | 任务/依赖/门/角色/验收标准齐备 |
| **底座** | 一条签名事件日志,kind 分发,跨面可搜 | 四条同源派生日志,无跨面检索 |

---

## 9. 收束

用户最初的判断——"Buzz 是 Crew 想实现效果的一部分,但他没开始画图"——**方向对,但落点需要修正**。

Buzz 不是"还没画图的 Crew"。他们**不打算画图**,因为他们赌的是另一件事:把 Agent 放进人的工作面,用人的接口、人的身份、人的日志。图对他们是多余的,因为他们眼里的工作单元是对话不是任务。

所以正确的问法不是"Buzz 什么时候会画图",而是:

> **我们的图已经能长出来了,但图上的 Agent 是哑的。**

Crew 的 DAG 是资产,不需要向 Buzz 学习。真正该学的是那句 *"part of the room, not haunted cron jobs"* ——目前 Crew 的 Agent,恰恰更像后者:被按钮唤醒,吐一份文档,消失。

---

## 附:核验清单

**Buzz 侧**
- 仓库目录树、28 个 crate 列表 —— GitHub API 实取
- `crates/buzz-acp/src/queue.rs` —— 源码实读(排队/批量/去重/回帖锚点)
- `ARCHITECTURE.md` / `VISION.md` / `VISION_AGENT.md` / `VISION_PROJECTS.md` / `VISION_REMOTE_AGENTS.md` / `README.md` —— 仓库内文档实读

**Crew 侧(本仓库,逐行核对)**
- `services/crew/app/agent_worker.py` —— 工具集、prompt 组装、上游产物、返工批注
- `services/crew/app/service.py` —— say / mention 过滤 / 重派 / 意图卡
- `services/crew/app/schemas.py` —— `blocker` 字段形态
- `services/api/app/routes/crew.py` —— run-agent 在飞去重
- `docs/superpowers/plans/2026-07-17-crew-build/00-master-plan.md` —— B4 门状态机契约

**核验中被推翻的初步猜测**:曾以为 run-agent 缺在飞去重(终审 #4),实际 `_inflight_by_task` 已实现,不是缺口——已从报告中剔除。
