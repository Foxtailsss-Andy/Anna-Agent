# WB-01 设计与验收切片

状态：A/B 实现、两轴审查与 WB-01 契约验收完成；历史阶段记录保留，最终范围和证据见 WB-01 胶囊。Spec 1.2；R-03/15/17，AC-03/15 契约部分、AC-17a、AC-18b。

- owner：`01a08965-d562-7340-ada4-8456ba110690`，Astra xhigh。
- pre-change：`cfe0731700268fd466b588a65641c1d162487443`；工作分支 `codex/workbench-plan-20260907`。
- 工作树：Anna 外层容器内的 `Anna-Workbench-Plan-20260907`。
- Spec SHA256：`d3ec39733a170e25e1d34a72e1b4b0d456572001acd414ba191eaace43e159e7`。
- 起始 dirty：用户 AGENTS、CONTEXT、docs/agents 与规划目录；完整 hash/diff 留在本地 `.tmp-tests/wb01/supervisor/pre-change.json` 与 `.patch`，不夹带提交。
- 基线：WB-00 r5 / dataset v1.1；历史轮不改写。D/O 与 L/M/P 分开。

## 派卡前五项判断

1. 用户结果：一段 Session 可以包含多个 Run，更换显示入口后仍能续聊；同 Project 的另一段私聊独立；重启后 ID/来源稳定。对应 R-03；越权失败对应 R-15；旧历史可读对应 R-17。
2. 必须保留：可信身份、Project 的现有 workspace 授权、Channel 共同事实边界、用户数据和唯一 Run 执行所有者。按 Surface 过滤对话、每 Run 派生 Create conversation、旧 store 命名都属于迁移输入。
3. 公共边界：当前 Host 只有 service-token 保护的 `/_harness/runs`；用户提交经 Python 产品适配。`ProductSessionStore` 以 Run 索引；`withConversationContext` 按 Surface/actor/channel/conversation 过滤。新产品 API 需要在真实认证后解析稳定 Session。
4. 复用：当前 OMP 执行、Canonical EventStore、Python IdentityService 与 CrewService。新增 Session 关联记录；Run 结果/终态继续由规范事件投影，不引入另一套 Agent Loop 或终态存储。
5. 可失败用例：通过公开 HTTP 创建 Session、提交两轮、在第二轮真实 OMP 的外部 transport 中观察首轮约束；换入口与重启后查询同 ID；另一私聊不出现该约束；越权读取和冒充提交拒绝。

## 切片 A：正式 Session/Run 契约

公开操作：`/api/workbench/sessions` 创建/列表、Session 详情、Session 下提交 Run、Run 详情和事件查询。服务生成 Session/Run 身份；输入事件 ID 用于幂等，重复正文命中原 Run，冲突正文返回明确错误。入口 surface 是显示/背景信息，不参与 Session 身份。

可信范围由受 service-token 保护的 Python scope 接口解析：有 Authorization 时必须解析有效身份，无 Authorization 时可沿用既有本地身份；无效 token 不回落本地。Project 必须真实存在且属于认证 workspace；Channel 由业务关联派生，客户端正文不能授予 actor/channel/workdir/system prompt 权限。每次列表、读取与提交重新检查 scope。同 Project 不自动授权读取其他 actor 的私聊，也不自动混合不同 Session。

Session 记录仅保存身份、关联、输入来源和 Run 引用。用户消息及执行结果以持久输入/规范事件投影，带来源 Run/event/seq 水位。正式 schema 与最终存储形状在实现后记录；本切片不能只新增未被实际入口调用的类。

开发模型为 fresh Luna xhigh；唯一 writer `wb01_session_contract`。范围：Host product-session/product-facade、可新增 workbench-session；Python business scope route/main wiring；新增公共契约/隔离测试及 fixture。主控独立维护此设计与 STATUS。扩文件前由主控核对必要性。

## 切片 B：旧历史迁移（初始设计）

基于可信旧 ProductTask 的 workspace、actor、Channel、conversation/Run 归属确定性建立 Session 映射。Create/Hiker/报销旧 conversation 已按 Run 派生时保留可核对来源，不凭 prompt 相似性猜测合并。Crew 旧 project/channel 归属需经既有业务事实核对。迁移 dry-run 不写入；重复迁移不增加 Session/Run/effect；失败不得覆盖来源数据，重试必须可解释。

迁移测试通过公开产品查询验证历史可读，旧格式 fixture 是输入文件；不得绕过内部授权或通过直接查询目标数据库代替产品查询。兼容旧 API 只用于现存产品适配，WB-03 逐步接入新普通对话入口；不永久维护第二条执行链。

## 验证与退出

- 垂直 RED→GREEN：公共产品 HTTP + 真实 OMP worker + 真实临时 EventStore/业务持久数据；允许固定外部模型 transport。
- 当前聚焦测试与 typecheck；交接前按仓库要求 JS/Python 全套与 build；worker/协议变化则重新 materialize。
- fresh Astra xhigh Standards 与 Spec 独立只读审查，剩余阻断项为零后由主控独立核查。
- AC-18b 记录本卡增量、源码/构建身份、实际命令与失败；L/M 缺配置仍 blocked，P 未执行。WB-00 旧 readiness timeout 保留，不能假设此轮全绿。
- WB-01 验收后收回 writer/进程，保存胶囊，再新建 Astra xhigh 主控接 WB-02。若单卡形成独立验收切片需换上下文，按 SUPERVISOR 保留 WB-01 剩余项，不能提前关闭整卡。

## 首轮验证纪律核对

Coding 首次 Node 命令因 workspace 内路径错误得到 No test files found；随后假的 Runtime/空 EventStore tracer 得到 404。这两项仅属探索，均不计 WB-01 的行为验收。Coding 报告 Python scope 接口在实现前返回 405、最小实现后 1 passed；当时日志未持久留存且测试业务状态隔离仍需补齐，主控尚未据此关闭验收。

主控已短暂收回 writer 核对上述事实，再恢复同一 writer，要求先完成真实认证/持久化/OMP 组装的单个 Session 创建与重启 tracer。新增 Run/store 模块先于该 tracer 完整 RED 写入，最终交接须如实保留这一顺序，不能称所有实现均为严格 test-first。所有后续测试必须保存实际命令/退出码，并隔离配置、身份、业务状态、Memory、Run 与工作目录；不删除既有本地状态。

## 切片 A 冻结核查与切片 B 派卡

切片 A 与证据 Coding 已停止写入；暂无活动测试服务。主控在 11 个冻结产品/测试文件上独立执行：四个 workbench 聚焦 TS 文件共 4 passed，Python scope 1 passed，全仓 `npm run typecheck` 退出 0；日志位于 `.tmp-tests/wb01/supervisor/`。冻结清单为 `slice-a-scope.json`，清单摘要 `bf20c22712e2318c0ab10a6abe53b7d16c62e014eb8cd08da237961a473b5a0f`。该结果不是两轴审查或 WB-01 验收。

已覆盖真实认证、跨显示入口模型输入连续性、多轮与重启水位、同 Project 私聊隔离、跨 actor/workspace 读取拒绝、同 source 并发单执行。外部 transport 为合成测试，实际模型质量 L 保持 blocked。入场失败重复返回原错误与损坏 v2 状态拒绝已覆盖；主控进一步指出失败入场缺少 Run command 时列表/详情仍可能 500，及 Canonical 事件优先的剩余边界。

切片 B 已交给 fresh Luna `wb01_migration`，唯一产品 writer。批准的迁移入口为 `POST /api/workbench/migrations/product-v1`，只接收 dry_run 布尔值；来源为 Host 绑定的旧文件，认证后的当前 workspace/actor 仅迁移自己的记录，Project 仍由真实业务服务核对。旧 array 源保持只读，新任务快照使用独立版本化持久文件；现有 Canonical events 不复制、不重放。首次先通过真实公开查询复现入场失败的状态读取问题，再逐条执行迁移 RED/GREEN。

迁移目标 Session ID 按 workspace/actor/原有效 Channel/conversation 或 Run 确定性派生，忽略显示 Surface；保留原 conversation alias、Run ID、来源 fallback 的派生标记和事件水位。dry-run 不写；apply 原子增量；重复不新增身份；坏源/冲突失败不修改来源；新 Run 继续也不能覆盖旧文件。

AC-18b 的轻量 CLI/CI 入口已独立实现，源码 pre/post hash、失败/not_run 与 manifest 分开记录。诊断轮 `wb01-evidence-source-scope` 保留一项产品测试 RED 和 migration not_run；`wb01-evidence-source-scope-final` 是后续独立诊断轮，不能覆盖前轮。早期被 Coding 清理的临时诊断只保留明确摘要，不伪造原始日志。最终验收使用代码冻结后的新轮。
