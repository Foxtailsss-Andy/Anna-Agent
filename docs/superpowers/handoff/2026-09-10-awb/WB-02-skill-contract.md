# WB-02 Skill 发现与读取切片契约

状态：本切片实现、独立两轴、D/O契约及AC-18b增量已验收；精确代码提交与交接见胶囊及STATUS。整 WB-02 保持 in_progress。

- owner_task_id：`01a08b29-b7b5-74f0-8dec-848bea043f02`。
- 固定点：`857bba3bbf593c7b6bb268c56d3bb894a39d93f7`；沿用当前分支。
- Spec 1.2；R-04/15，AC-04/15 对应 Skill 发现、按需读取与权限部分；AC-18b 独立增量。其他 WB-02 能力继续待办。
- 核心 A 契约及失败限制见 [WB-02](WB-02.md) 和 [核心契约](WB-02-contract.md)。

## 用户可见结果与公共边界

用户从公开 Workbench Session/Run 提交工作；模型先发现已登记 Skill 的 ID、版本、来源、名称及依赖状态，按需读取指定方法。初始模型上下文不包含未选方法正文。成功读取后的下一次实际 OMP 模型请求包含该冻结版本正文与来源。工具读取成功只表示内容已取得；依赖缺失、方法执行与业务结果分别说明。

测试 seam：公开 Workbench API → 真实 Python 身份/业务范围 → Host/Gateway/EventStore → 实际 OMP Worker。允许固定外部模型 transport 与合成业务/Skill 文件；不 mock 内部身份、权限、持久状态或 Gateway。

## 已决定的语义

1. 沿用可发现能力与已加载工具集合；`skills.load` 是登记的只读能力，先通过现有 `capabilities.load` 载入工具定义，再按 canonical `skill_id` 取文档。`capabilities.search` 可返回单独的 Skill 元数据集合，不提前返回完整正文。
2. 已登记 Skill 文档、版本、来源和摘要作为入场快照的一部分持久保存并参与 RunProfile hash。运行/恢复读取原快照；当前注册表只供新 Run 使用。旧无 Skill 目录的快照保留原义。
3. 可信显式 `skillPath` 选定的 Run 限制继续进入原授权交集。按需阅读方法文档不选择新的 Run 权限策略；其 allowed/forbidden 声明原样返回，并明确列出在当前获准目录下不可用的依赖。方法正文和声明不能授予新工具，也不能改变现有显式限制。
4. 本切片不建立动态 Skill 权限/安装/执行编排，不把旧 Surface 方法默认注入普通会话，不把方法全文提升为系统授权指令。读取后仍由模型依当前目标决定是否采用方法与何时请求获准工具。
5. 复用正常 Gateway 调用与 OMP 工具结果持久记录作为加载证据；返回内容和 receipt 绑定同一 ID/版本/hash。没有独立授权变化，因此不新增可授予工具的 Skill 事件或第二套加载账本。
6. 每次 search/load/读取仍走当前真实 scope 校验。未知 ID、错误参数明确反馈；不可访问目录/本机路径不经错误或公开事件泄露。默认注册只读取可信固定来源，renderer 的 path/catalog/context 不成为注册源。

## 最小验收序列

- 第一个 RED：公开真实 OMP 会话发现固定登记 Skill，按需加载读取，下一次模型请求确有正文且初始没有；现状缺入口时失败。
- GREEN 后再逐条增加：无 Project 与有 Project 的相同授权、未知 ID/参数错误、正文声称额外工具仍不可加载、显式限制仍生效、恢复使用已存 Skill 版本且下一次新读取结果可核对。
- 受影响的核心 A cold 恢复与 omp-ready-abort 回归必须通过。历史目录 Gateway 集成仍只记 D，不扩大为历史 OMP 恢复。
- 唯一 fresh Luna xhigh writer；有效 RED/GREEN 日志按 issue 唯一名称排他创建；源码冻结后独立 Astra Standards/Spec 两轴，再由主控核验。
- 广泛交接前仓库四项、实际 OMP、独立 AC-18b 与公开证据扫描通过；L/M blocked、P not_run、usage unavailable 保留。

## 范围边界

本切片交付已登记 Skill 的发现/读取，不关闭 WB-07 的创建/验证/保存/新 Session 复用全闭环。公共搜索、URL、文件目录及剩余业务连接器由 WB-02 后续切片接续；原 UI 为 WB-03、问人/控制为 WB-04。用户保护输入仅 STATUS 可按授权更新，不夹带提交。

## 源码核对与最小实现取舍

- `packages/harness-v2/src/skill-catalog.ts` 已有真实文档 Loader，解析 ID、版本、原文 hash、来源与 allowed/forbidden 声明。复用它，不重新实现 Skill 格式。
- `production.ts` 已在启动时加载固定方法，显式选中项进入 RunProfile.skills；v2 默认取消预选。目前 `workbench-capabilities.ts` 仅注册两项 Crew 读取，没有 Skill 发现/读取入口。
- 部分现成方法描述旧 Surface 约束，因此只在模型请求后作为方法内容返回，不能重新成为默认 v2 系统限制。方法中提及的不可用依赖明确报告。
- `capabilities.load` 已能通过真实 OMP 公开工具更新机制载入任意获准定义；`skills.load` 可复用此路径。其返回正文通过已有正常 tool result 进入下一模型请求，持久响应与当前 Run 快照提供来源链。
- 初始动态工具筛选当前在无 Project 时直接返回全部；加入通用 Skill 能力后应按明确 capabilityPolicy 筛选，不能用 Project 是否存在代替加载事实。此处只改必要条件并保留 v1。
- 当前不改变 Capability/Session/Run 的领域含义，CONTEXT 保持原字节。新增 Skill 目录是已定义 Capability 概念下的可信读取来源，不作为新的执行所有者。

## Tracer 候选与下一组用例

首 writer 已停写。有效 RED 为 `issue-skill-tracer-red-003`：第二次真实 OMP 请求收到的 search 响应缺 Skill 目录，退出 1。前两次日志只见 bridge 失败，不单独用作定位证据。首 GREEN 为 1 test passed，完整 typecheck 退出 0；此时仍未验收。

下一 writer 从相同基准和 7 文件候选继续，逐条垂直测试：

1. skills.load 的 description/schema 必须消费持久 capabilityPolicy；不因其为 Skill 入口就用当前硬编码定义覆盖历史定义。历史定义 Gateway 集成与真正 OMP 恢复分开记账。
2. 显式 forbidden skills.load 时目录不将方法声明为可读取；正文要求的工具及其 allowed_tools 不能越过当前授权或显式 forbidden。读取正文成功不表示依赖或业务执行成功。
3. 错误参数与未知 ID 保留明确失败；模型可观察失败并继续正常工作。必要时在真实 public Gateway seam 证明 schema 拒绝，OMP 自身 schema 拒绝另计，不能混称。
4. 无 Project 与有 Project 的 chat/create/crew 均可读取同一登记方法；初始正文不预加载；成功结果绑定独立源 hash/版本与规范工具调用。
5. 按真实 OMP 捕获 checkpoint，关闭旧 Host 后用新 Host 恢复；注册源已变更时恢复后的新读取仍使用旧快照，新 Run 使用新版本。通过真实 loader 读取复制到临时根的固定注册文件实现版本/恶意正文输入；允许仅在可信 Host 构造参数中指定该注册根，renderer 无此字段。它是注册来源边界，不替换内部权限或存储事实。
6. 保留旧 v1/显式 Skill/核心 A cold/omp-ready-abort 回归；每个失败按来源单独记录。

证据继续扩展现有 capability evidence CLI：纳入新 Skill 源码、真实注册文档、新增用例和相关依赖的前后 hash，保留旧轮。只在边界缺陷用例之后修改证据代码，验证漏源/缺必需文件不会得到 pass。独立新 round，不改 WB-00 36 槽。

### Definition 回归的最小生产测试决定

首 tracer 已有真实公开 OMP 执行，因此直接捕获实际模型 tools 的 description/parameters，再与该 Run 从真实 EventStore 读回的持久 catalog 核对。旧硬编码描述与持久目录描述实际不同，可临时恢复该精确分支验证同一公开用例失败，修复后再次通过；此明确记为 mutation。无需为测试新增可任意注入能力 schema 的生产接口。

该用例证明当前生产加载使用同一持久定义；不会据此宣称已经跑过跨历史 schema 的完整 OMP 恢复。历史 schema 范围继续按核心 A 原记录保留。Skill 正文版本变化则必须通过本切片的真实冷恢复与恢复后新读取验证。


## r1 审查后的加载入口映射

每份可发现 Skill 元数据增加 `loader_capability_id: "skills.load"`。模型从 search 实际返回值取得该 canonical ID，经 capabilities.load 载入定义后，再按实际返回的 skill_id 读取。Skill 命中不依赖同一 query 恰好命中 loader 工具说明，也不要求模型猜测未见过的入口名称。此字段只说明现有获准加载路径，不授予权限；显式禁止 skills.load 时仍不返回可读方法目录。

搜索与读取共享同一份局部元数据投影；读取响应额外带 content。原 Host control description/schema 和能力定义保持，避免对旧 Run 恢复引入无关变化。
