# WB-02 能力核心切片契约

状态：能力核心切片 A 的 D/O 契约验收通过，最终源码身份见 WB-02 胶囊及 STATUS。本文件不关闭整张 WB-02、全部 AC-05 或 M1。

Spec 1.2；R-01/04/05/15；AC-01 的无强制产物、AC-04 的按需加载、AC-15 的当前范围检查，以及 AC-18b 的本卡增量证据。真实模型与连接器子项另记。

## 可信输入与版本

入口沿用 WB-01 的公开 Workbench Session/Run API，身份、workspace、Project/Channel 来自可信 Host 和 Python 业务范围校验。Renderer 不能提交授权目录、工具 schema、system prompt 或任意 workdir。

只有可信 `ProductTask.schema_version=2` 在新 Run 组装时使用 Workbench 能力策略。已持久 `RunProfile.capabilityPolicy.version=workbench-capabilities-1` 明确表达运行/恢复语义；不使用 Surface、productMode 或任意 Profile 版本字符串推导授权。v1 不带此策略，保留旧固定工具含义。

v2 默认不预选 Skill。显式配置的 Skill 条目及限制保留在快照；其 forbidden 最后收窄。发现/加载是 Host 基础控制工具，仍受显式 forbidden 和 Channel/Worker/Run 的有效权限限制。普通 Create 问答可以无工具、Todo、Artifact 完成。按需读取/加载 Skill 不在本切片内。

## 目录、加载与执行

当前固定能力只有 `crew.project.read` 与 `crew.channel.read`，均为 read/safe，需要当前 Session 绑定真实 Project。无 Project 的本切片会话只有控制工具，可直接文本完成，目录中没有业务读取能力。

| 工具 | 输入 | 已实现结果 |
| --- | --- | --- |
| `capabilities.search` | `{query: string}` | 当前获准目录中的 ID、版本、说明、来源、效果、schema、定义 hash 和 loaded/available 状态 |
| `capabilities.load` | `{ids: string[]}`，非空 | 全部 ID 获准才加载；返回已选定义与加载 receipt；未知或不获准 ID 返回 capability_not_available |
| `crew.project.read` | `{project_id: string}` | 经真实业务服务读取当前绑定 Project |
| `crew.channel.read` | `{project_id: string}` | 经真实业务服务读取该 Project 的 Channel 消息 |

可发现目录与已加载集合分离。初始模型定义只有获准的 search/load；模型选择 load 后，通过 OMP 公开 `agent.setTools` 更新下一次请求的实际代理定义。加载不授予目录外权限。真正 I/O 仍由 Host Gateway 和 Python 业务服务执行，Worker 的内置网络、文件执行、扩展/MCP 限制保持。

每个 Run 的目录快照持久保存 canonical ID、说明、输入 schema、效果、重放策略、来源、版本和 hash，并参与 RunProfile hash。生产中的模型定义、Gateway schema 与 controller 均消费该持久快照。当前注册表只用于组装新 Run，不把新版目录灌入旧 Run。

search、load 与目标动作均通过当前真实账号/workspace/Project 范围重验；业务读取端再次校验对象。真实撤权后，已加载能力也不能继续 I/O。新的授权在下一 Run 生效，已开始 Run 的快照不扩大。

## 持久事实与恢复

`capability.loaded` 绑定实际模型工具调用、原始 load 参数、dispatchEventId、目录摘要和成功的工具响应；只接受 Host 固定 load 操作形成的记录。任意业务正文中的 receipt 不产生加载事实。内存 loaded 集合是这些事实的投影，Run 结束后清理。

恢复重新检查调用、dispatch、输入、响应与快照的一致性，并按每次模型请求之前的合法加载记录计算当时实际可见工具。坏关联、输入与能力定义不符、提前暴露能力、v2 缺定义或错误摘要均须拒绝；不会丢弃坏记录后继续。v1 的历史缺字段兼容仅适用于 v1。

三类摘要含义不同，不互相替代：

- 能力定义 `hash`（search 当前字段名 `schema_hash`）：带 `sha256:` 前缀，覆盖 ID/版本/说明/来源/effect/replayPolicy/inputSchema。
- 目录 `catalog.hash`：带 `sha256:` 前缀，覆盖完整有序目录。
- 模型请求 `toolDefinitionHashes`：裸 hex，逐项覆盖实际 OMP 定义的 name/description/parameters；与当次实际定义及顺序对应。`inputDigest` 另覆盖 systemPrompt、messages 和当次工具定义。

公开 Workbench 事件只投影模型工具名称/hash、加载 ID/定义 hash/关联、dispatch 名称/input digest、响应状态和失败原因。完整模型上下文、私密凭据与工具业务正文不因本切片而直接公开。

## 验证边界与下一切片

真实 Python 身份/业务持久层、Node Host/Gateway/EventStore 和实际 OMP Worker 用于核心执行回归；模型 transport 使用明确的固定 fixture。两种真实 Project 观察分别驱动 A→结束和 A→B，证明调用分支随观察变化，不证明真实模型质量。

冷恢复测试从真实执行捕获 command/events/context projection，关闭原 Host，再在隔离 checkpoint store 中恢复。它验证持久协议和新执行，不声称进行了 OS crash。历史目录版本变化用真实 Gateway/Python 集成测试核对，为 D 证据；它不单独证明跨历史版本 OMP 的完整恢复。具体通过与未验证项以胶囊和原始记录为准。

余下 WB-02 要补按需 Skill、已有固定连接器、公共搜索/URL/文件读取及相应参数错误与缺配置事实。原普通 UI 接入属于 WB-03，问人/控制属于 WB-04；Sandbox/Memory/WB-05～09 不在当前切片。L/M 缺真实配置保持 blocked，P not_run。
