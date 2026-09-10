# WB-02 设计与验收切片

状态：核心切片 A 的 D/O 契约与 AC-18b 增量已验收；整张 WB-02 仍在实施。下文保留各阶段设计与修正，最终状态/源码以 WB-02 胶囊及 STATUS 为准。Spec 1.2；R-01/04/05/15；AC-01/04/05/15 对应能力部分及 AC-18b。

- owner：`01a08a0b-f70a-7032-9f22-07e0df963ca5`，Astra xhigh；唯一状态源为 STATUS。
- 工作树：`Anna-Workbench-Plan-20260907`；分支 `codex/workbench-plan-20260907`。
- pre-change HEAD：`eec76df8cc7fc40d412f5f3e253fd15d0a4c07b1`。
- Spec SHA256：`d3ec39733a170e25e1d34a72e1b4b0d456572001acd414ba191eaace43e159e7`。
- 原 dirty：AGENTS、CONTEXT、docs/agents、AWB 规划；tracked diff SHA256 `5a5a75dad632d126dad8073c8548b44508804e4329dc52d54696697da6c4611b`。入场各文件 hash 保存于本地 `.tmp-tests/wb02/supervisor/pre-change.json`。
- 基线保持 WB-00 r5 / wb00-dataset-v1.1，36 槽 21 blocked / 15 not_run；WB-02 开独立增量轮。

## 派卡前五项判断

1. 用户结果：同等授权的用户从不同 Surface 进入同一 Session，可发现同类能力；模型根据真实工具观察决定下一步，普通问答允许直接结束。对应 R-01/04/05；调用前撤权拒绝对应 R-15。
2. 权限事实是认证 actor/workspace、Session 的 Channel/Project 绑定、真实业务可见性、可信 Worker/Channel 限制与显式 Skill 限制。默认 Surface 工具列表及预选默认 Skill 交集属于旧实现选择。正文、网页、Skill 内容均不授予权限。
3. 公共边界是 `/api/workbench/sessions/{id}/runs` → ProductTask v2 → `createLiveHarnessV2Runtime` → OMP → Gateway → Python 业务服务。现有 `production.ts` 的 `toolNamesForSurface/narrowProductProfile` 与 `run-profile.ts` 的 `skillAllowedTools` 在入场收窄；`worker.ts` 仅启动时注册所有代理；Gateway 仅检查冻结 allowedTools，没有即时业务撤权检查。WB-01 顶层 project/session 绑定应成为 v2 事实，不能回到任意 context catalog。
4. 复用 OMP 18.0.11 的公开 `agent.setTools` 与现有代理工具；继续让 Anna Gateway 承担权限、schema、effect、事件与 I/O。Worker 无网络，内置执行/MCP/扩展仍关闭；不替换 OMP、不建设插件框架。定义加载要通过明确受控协议，不能将任意工具返回正文解释为新授权。
5. 可失败用例：真实 Python 登录/业务数据、持久 EventStore 和真实 OMP 下，由固定外部模型 transport 在初轮发现工具，加载 A（项目读取）；一个项目观察充分而结束，另一观察需要频道事实时再加载 B（频道读取）。第二次模型请求实际定义与已加载 receipt 一致，换 chat/create/crew 仍有同类权限；在载入后撤销真实业务权限，后续业务读取前拒绝。模型 transport 是 D fixture，不能据此宣称 L。

## 切片 A：最小发现、加载、读取闭环

先以固定注册的 Crew 项目/频道读取贯穿真实 Run；注册现有配置允许的公共搜索作为目录输入。每个 Run 冻结可发现目录（canonical ID、schema、效果、来源、版本和 hash），与本轮已加载集合分开。初始仅给紧凑目录/发现加载工具，模型选择后下一轮实际可调用；错误显式回流。加载、实际发送定义与执行记录必须可追溯到同一 ID 与定义版本。

v2 基础能力不依赖默认 Skill 的 allowedTools；可信执行策略与显式限制仍求交。v1 保留明确版本语义，旧快照读取不改含义。Surface 保留背景但不强制 Artifact/Todo/流程。新授权在下一 Run 生效，已有快照不扩大；撤销在发现、加载和实际 I/O 前检查。目录/错误不暴露不可访问 Project。

唯一 Coding writer：fresh Luna xhigh。首张卡读 WB-01 胶囊/契约与本设计，逐个公共行为 RED→GREEN，保存完整命令/退出码与安全日志；先取得第一个公开入口 RED，再写对应实现。不 mock 内部 Runtime、身份、业务权限、EventStore 或 Gateway。重 OMP 测试串行；改 worker/协议后重新 materialize 并核验。

## 后续切片与退出

- 在切片 A 实证后补齐按需 Skill、固定连接器、公共搜索/URL 与文件读取所需目录和权限范围；具体最小实现按已确认 R/AC 推导，避免任意插件安装。
- WB-03 接原普通 UI、业务读取体验；WB-04 接控制。WB-02 不独占这些卡的完整验收，不扩大到 Sandbox、Memory、M2～M4。
- 每个冻结切片经 fresh Astra Standards / Spec 两轴只读审查；主控独立核查，广泛交接前运行仓库四项检查及实际 OMP/源码一致性检查。
- L/M 缺真实服务维持 blocked，P not_run。最终提交只含明确 owned 文件，保留旧失败轮与用户 dirty。
- 卡完成或形成可独立验收的大卡切片时，写胶囊、drain writers/processes，再依 SUPERVISOR 转交 fresh 主控；切片转交不得提前关闭 WB-02。

## OMP 原生发现机制核对

本树已物化 OMP 18.0.11 的 `pi-agent-core/src/types.ts` 定义 `loadMode: essential | discoverable`，只影响呈现，不授予能力。`pi-coding-agent/src/tools/index.ts` 当前 `xdevRequested = !restrictToolNames && settings.get("tools.xdev")`；原生 `xd://` 机制依赖 read/write 运输与其工具注册表，明确在受限子执行中关闭。Anna 的受管 worker 使用 `restrictToolNames: true`，只注册经过 Host Gateway 的代理；直接开启该整套机制会改变执行边界，不能由一个显示选项证明适用。

本切片因此继续复用公开 `agent.setTools`，由 Host 的获准快照与持久加载记录控制代理集合。保留原生机制为后续可比较实现，当前不为使用它而打开原生文件执行/扩展。上述为源码判断；真实协议/执行仍由切片 D+O 验证。四份锁定依赖源码 hash 保存于 `.tmp-tests/wb02/supervisor/omp-native-discovery-source.json`。

## 切片 A 的职责收口

首个公开 RED 已保存原始输出：`.tmp-tests/wb02/coding-a/red-001.raw.log`，Run 为 failed，目标为完成发现/加载/项目读取。早期测试草稿的固定全事件列表及短等待已纠正；首次手写摘要不能替代原始输出。尚无 GREEN。

主控中途收回一次写入权，核对到 WIP 将 productMode 当作 v2 策略、用 Profile 版本前缀开关 Skill 语义，并缺少合格目录快照与即时撤权。以下决定替换该 WIP 方向；未经验证的中间代码不作为契约：

- 仅可信 ProductTask.schema_version=2 进入 Workbench 能力策略；Product Host/OMP 启动模式不改变 v1。能力策略使用明确字段，缺省保留旧含义，不从任意版本字符串推导授权。
- 可发现目录写入已持久 RunProfile 快照并参与其 hash：ID、定义、版本、来源、效果和目录摘要。它与当前 loaded 集合分别表达；恢复使用已保存目录，不从更新后的注册表重新授予能力。
- v2 普通会话允许没有预选 Skill；Surface 背景进入指令，不复用“必须创建产物”的默认 Skill。显式 Skill 与可信 Worker/Channel 限制保留在对应授权交集中；本切片不假造 Skill 来绕过非空校验。
- capabilities.load 是 Host 固定注册的控制操作。加载成功记录必须同时符合该工具名、实际成功状态、原始调用参数与冻结目录，记录内容从 Host 快照生成，绑定 toolCallId/dispatchEventId/目录 hash。任意业务返回正文不产生加载事实。
- loaded 的内存集合仅为持久加载事件的投影；每次执行/恢复重新核对事件与冻结定义，失败关闭，不能静默丢弃坏记录后继续。每次模型请求保存实际定义和摘要，按当时合法加载前缀校验恢复；v1 固定定义校验保持原义。
- search/load/目标读取均检查当前可信账号、workspace、Project/Channel。Gateway 在动作前做当前范围检查；业务读取端也重新校验对象，避免预检与读取之间使用失效权限。查目录/未知 ID 不披露未获准对象。
- 首个 GREEN 只需上述最小项目读取 tracer，随后逐条增加两种观察、跨入口、撤权与恶意加载回归；不以这一个 tracer 关闭切片或 WB-02。

## A1 冻结检查与 A2 接力

首 Coding writer 已停止，测试/业务/OMP 进程已 drain。主控冻结 17 个实现/测试/证据入口文件于 `.tmp-tests/wb02/supervisor/tracer-freeze.json`，独立全仓 `npm run typecheck` 退出 0；`workbench-capability-loading.test.ts` 2 passed、退出 0，初末 17/17 hash 无漂移。日志为 `tracer-typecheck.log` 与 `tracer-tests.log`。

第一个测试证明公开 Workbench 提交、真实 Python 登录/项目、持久 EventStore、真实 OMP 的发现/加载/项目读取。第二个标题称“观察不足”，实际仅固定调用频道读取，没有先 A 后 B 或两观察分支；该通过只记单独频道加载，不记 AC-04 自主分支通过。A2 由 fresh Luna xhigh 纠正此用例并补跨入口/即时撤权，仍未关闭切片。

OMP 已重新 materialize，21,465 文件，规范 manifest `sha256:168da57a60493b094ea6b2525f312c3e05a6585ffc167cba2a7b9c5beb6719ec`；主控独立核对 worker/protocol/runtime lock 与本树源码一致。旧包保留在 `.tmp-tests/wb02/runtime-before`。后续改 worker/协议仍需重新物化。早期接口类型失败、提交 503 与 readiness 调试日志均保留；名为 green 的失败尝试实际退出 1，不计通过。最终相关定向类型检查与首 tracer 才通过；尚未做全套回归。

主控另外发现待 A3 复现的静态疑点：恢复对每轮工具定义目前仅验证 admitted subset，尚未按合法加载事件前缀证明当时 loaded 集合；loaded receipt 的 dispatch 字段存在性检查尚不等于验证关联真实 dispatch。旧 v1 恢复/Skill 兼容、参数错误、恶意业务 receipt、坏加载历史仍需公共行为用例。此为未验证疑点，不冒充已运行失败。

## A2 冻结检查与 A3 接力

A2 已完成同一 transport 根据两个真实 Project 的工具观察选择 A→结束或 A→B，并读回预先通过业务 API 写入的频道 marker；chat/create/crew 同授权的目录、加载和执行可达一致；普通文本 Create 可无工具、Todo、Artifact 完成。真实 Project workspace 迁移后，已加载工具在目标业务 I/O 前被拒，另一正常 Run 完成。pass-through fetch 仅记录实际请求并继续真实 HTTP，不替换业务权限/状态。

权限修复经过两次真实边界发现：恢复无 Authorization 的本地身份入场；同时允许可信 Host 以真实本地主体或登记账号重验。显式无效 Bearer 始终拒绝。首轮 Python 测试曾 mock 身份/业务，仅为探索，不计合格 D；已替换为完整 create_app、真实临时 IdentityStore、实际登录与公开本地身份查询，当前 5 个合同全部通过。

主控独立冻结 19 文件于 `.tmp-tests/wb02/supervisor/a2-freeze.json`（文件 SHA256 `1af476d9789ef4a65c090f667887cd78a478b8c9f1a3f1359edbdcbc4ad37cae`），并执行：两 TS 文件 4 passed、53.21 秒、退出 0；真实 Python 5 passed、退出 0；全仓 typecheck 退出 0；初末 19/19 hash 无漂移。证据在 `a2-ts.log`、`a2-python.log`、`a2-typecheck.log` 与 `a2-receipts/`。OMP 包和 worker/protocol 未再改变。

历史组合轮 `coding-a2/final-capability-tests-004.raw.log` 两个测试 120 秒超时、整轮 450.93 秒；具体慢层/因果未确定。省略初始 EventStore 游标与传 -1 在当前实现中同义，不能称为根因修复。005 和主控后续通过均单独记录；原失败仍保留。更早 001/003 的工具失败与本地主体分支提前拒绝登记账号相符，登记账号 Host 重验合同随后补齐；002 为不支持的 Vitest 参数错误，不计行为 RED。测试观察器现为 30 秒截止、公开游标和所有终态/挂起显式判定，不改产品预算。

A2 writer 与所有测试服务已 drain。A3 fresh Luna xhigh 接唯一写入权，先做合法加载恢复，再做坏加载关联/模型定义前缀与 v1 兼容；首个范围为新增恢复测试及 production、workbench-capabilities、omp-loop-kernel。产品两轴、最终全套回归、正式 AC-18b 能力轮、Skill/其余目录接入仍未验收；本记录不关闭 WB-02。
