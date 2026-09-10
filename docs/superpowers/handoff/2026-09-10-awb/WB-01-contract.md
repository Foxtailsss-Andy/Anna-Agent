# WB-01 Session / Run 公共契约

状态：WB-01 契约经两轴审查与主控 D/O 验收通过；真实 Provider/MCP 的 L/M 子项仍 blocked，P not_run。Spec 1.2，R-03/15/17；AC-03/15 契约部分、AC-17a。

## 身份与范围

产品入口为 Node Product Host。Bearer 身份由真实 Python IdentityService 解析；未提供 Authorization 时沿用本地身份，提供无效 Authorization 时返回 401，不能回落本地身份。客户端的 x-anna 身份头不授予 Workbench 权限。

个人 Session 的 Channel 由可信服务派生；带 Project 的 Session 必须通过真实业务对象的 workspace 授权，并绑定其 Channel。一个 Project 可关联多个 Session；Session 私聊按 workspace、actor 和 Session 隔离。现有 Project 的 workspace 级业务可见规则保留，不能从项目可见推导另一个 actor 的私聊可见。

## 操作

| 方法与路径 | 请求 / 结果 |
| --- | --- |
| POST `/api/workbench/sessions` | `{surface?, project_id?}`；认证后生成 Session ID，持久化后 201 |
| GET `/api/workbench/sessions` | 当前身份可访问的 Session，可用 `project_id` 过滤 |
| GET `/api/workbench/sessions/{session_id}` | Session 元数据、有序用户/assistant 消息、关联 Run 及每 Run 水位 |
| POST `/api/workbench/sessions/{session_id}/runs` | `{prompt, source_event_id, surface?, parent_run_id?, resource_refs?, requested_artifact?}`；入场成功后 202 与 Host 生成的 Run ID |
| GET `/api/workbench/runs/{run_id}` | 当前 Run 的输入来源、Session 关联、接收信息与规范状态投影 |
| GET `/api/workbench/runs/{run_id}/events?after_seq=N` | 授权后的增量事件投影及原事件水位；不返回内部 checkpoint/模型上下文 |
| POST `/api/workbench/migrations/product-v1` | `{dry_run: boolean}`；仅针对当前认证身份的绑定旧来源，严格旧源与当前目标预检，dry-run 不写入 |

`surface` 取 chat/create/hiker/reimbursement/crew；更换显示入口不会产生新的 Session。`requested_artifact` 只接收 skill/prompt/python_tool；本卡保存请求契约，具体创建流程由对应业务实现验收。`resource_refs` 当前仅接收空数组，非空返回明确不支持；后续能力接入须增加真实解析，不把任意字符串当已授权资源。

正文不能设置 actor/workspace/channel、Run ID、system prompt、workdir、权限、模型凭据或工具 schema。`parent_run_id` 必须属于当前 Session；它只表达显式关联，不自动建立调度依赖。

## Session、Run 与消息来源

Session 元数据版本为 2，保留 session_id、workspace_id、actor_user_id、channel_id、可选 project_id、显示 surface 和时间。Run 保留自己的 ID、Session、输入事件、可选 parent、业务引用与执行快照。

输入事件幂等键为 Session + source_event_id。同内容重试返回原 Run；同键不同内容返回 409。并发相同请求共享入场结果，成功仅启动一次；首个入场失败不会让另一重复请求误报成功。失败后的新工作使用显式新的输入事件，保留原记录。

admission_status 表示入场接收信息，不能代替 Run 终态。没有规范 Run command 时公开状态为 not_started，并附接收失败/待处理原因；有规范执行事实时，以 Canonical events 为状态来源。只有同一 Run 的执行所有者更新规范终态。

用户消息来自已持久的原输入，assistant 消息来自实际规范 transcript 事件。每条保留所属 Run、输入或事件 ID 与 seq；模型内部装载的上下文不投影成用户新消息。Session 水位形状为 `{session_id, runs:[{run_id, event_id?, seq?}]}`，不把 Session ID 冒充 Run ID。

续聊按 Session 选取先前消息，并保存执行时的输入快照；显示 Surface 不过滤同 Session 历史。Project 关联不自动混入另一私聊。

## 旧来源与迁移约束

迁移来源为 Host 配置绑定的旧 ProductTask array，路径不由客户端提交。来源保持只读；新的任务快照写入 `{source}.tasks.v2.json`，Session/Run 关联写入 `{source}.v2.json`，均为版本化目标状态。旧 Canonical events 和业务库不复制、不重放；查询通过原 workspace/channel/run 归属读取。

映射键包含旧 workspace、actor、有效 Channel、conversation_source 类型与 conversation（无 conversation 时用 Run）。conversation 与 run_id_fallback 分别标记，防止同名标识误合并。有效 Channel 沿旧真实 `channel_id ?? conversation_id ?? product:{surface}:{workspace}` 规则；新显示入口不进入映射。旧 Create/Hiker/报销已经按 Run 派生的 conversation 原样保留，不根据文本相似性合并。

保留原 Run ID、conversation alias、源时间、source_event_id 与派生标记。缺失 source_event_id 时沿旧 Host 的 `product:source:{run_id}` fallback，明确标记为派生映射，不能称为新发生的模型事件。

仅导入当前认证 workspace/actor 的记录；Project 归属通过真实业务服务核对。公开 scope_source_sha256 / scope_source_bytes 只针对最终通过 actor/workspace/Project 授权的集合；其他 actor 或被拒绝 Project 的记录变化均不改变该用户的 dry-run 响应，不返回未获准记录的跳过计数。全文件摘要仅供受控完整性证据。dry-run 与 apply 共享目标冲突校验和新增计数，dry-run 不写目标或来源；apply 原子新增映射；重复 dry-run/apply 的新增数为零，不增加 Session/Run/effect。坏源或冲突明确失败，保留来源，修复后可重试。迁移后新 Run 继续也不得改写旧来源字节。

## 证据与当前边界

D 证明公共契约、认证、状态与迁移行为；实际 OMP worker 的固定外部 transport 另记 D+O。Session-only 的 Runtime 组装不冒充 worker 执行。真实 Provider/MCP 和桌面包分别保留 L/M/P 状态；验收及精确源码/构建身份以 WB-01 胶囊、审查与冻结证据为准。
