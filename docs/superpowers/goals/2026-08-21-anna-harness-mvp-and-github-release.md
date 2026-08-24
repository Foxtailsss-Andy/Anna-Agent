# Anna Harness MVP 基础开发与 GitHub 发布 Goal Prompt

> Goal 日期：2026-08-21
> 项目根目录：`<repo-root>`
> 当前分支：`rewrite/harness-v2`
> 当前提交 fixed point：`5aecdac8fc4f8bac1cfaa54a4f2b57a0fac2c936`
> 当前状态：工作区包含 T07 相关未提交变更；启动本 Goal 时必须先记录并保护这些变更。

## 可直接交给 `/goal` 的 Prompt

你负责把 Anna Harness v2 从当前 T06 后、T07 工作区状态推进到“可用 MVP + 可公开发布候选版本”。本 Goal 分两个阶段，必须按阶段验收，不得把计划中的能力、模拟 fixture 或未验证的上游代码描述成已完成。

### 阶段一：完成基础开发并证明 Anna Harness Run 可用

目标是让 Anna Harness Run 在本地 macOS developer preview 中稳定运行，完成经典评测任务，并完成 Review-to-Validated-Patch 的真实任务验证。

范围：

1. 先读取并遵守 `AGENTS.md`、`CONTEXT.md`、相关 ADR、Harness v2 spec、`00-plan.md`、T06→T07 handoff、T07 ticket 和当前工作区 diff。
2. 以当前工作区为输入，先划分 T07 已完成、T07 未完成、T08 尚未开始和与 Goal 无关的用户改动；不得 reset、clean、checkout、rebase、commit 或覆盖用户已有改动。
3. 以 T07 `Review-to-Validated-Patch` 为主线完成：隔离 worktree、PRD/UI approval gate、UI screenshot 来源校验、development patch、自动化测试、Trace/Eval、Memory Candidate confirmation、merge-ready summary；禁止 push、merge、deploy 和隔离 worktree 外写入。
4. 以 Anna Harness Run 的 canonical event、Run lifecycle、budget、ToolGateway、Skill、Memory、Eval、Sandbox、Trace、Scheduler 和 recovery 作为一个整体检查。发现缺失、错误、脆弱行为或 bug 时，先写能复现的 failing test，再做最小修复。
5. Pi Agent 是 Loop Kernel。保持 `pi-agent-core` / `pi-ai` 固定版本和 Pi-free domain boundary；Pi built-in tools 必须关闭，所有 Tool 只能经过 Anna ToolGateway。不得以 Pi 的 unfinished `AgentHarness v2` scaffold 作为生产依赖。
6. 对 Plugin、Tool、Skill、Memory、Eval、Sandbox 等能力先做缺口表：Anna 当前实现、Anna 测试证据、上游候选实现、许可证、依赖边界、迁移成本和安全影响。只有缺口被真实代码/测试证明，且上游实现与 Anna 约束兼容时，才允许轻改造复用。
7. 上游候选来源：
   - `https://github.com/openai/codex`
   - `https://github.com/can1357/oh-my-pi`
   先检查指定 commit/版本、源码、测试、许可证和依赖；不得依据 README 宣传或功能名称相似就直接采用。不得复制凭证、遥测、用户数据、默认宿主机权限、未经审计的 plugin 或 sandbox 代码。
8. 复用规则：优先提取小而稳定的算法/协议/测试思想；保持 Anna 的 Channel scope、Event Store、ToolGateway、approval、effect ledger、sandbox、trace、eval 和 no-fabrication 约束；每个复用点记录来源 commit、许可证、改造内容和保留的 Anna 边界。若上游实现会引入 Pi/旧 Python/宿主机任意权限/未审计网络，则停止复用并保留本地实现。
9. 经典评测必须使用固定 Smoke Set（4 个任务）、Dev Set（16 个任务）和已有 regression/badcase；报告 raw evidence、失败分类、首个 Trace divergence、工具轨迹、终态、延迟/成本（仅在真实 provider 报告时）和未验证项。不得用 fixture 通过代替真实任务证明。
10. 阶段一结束前，必须运行 Anna 的真实任务验证：至少一次真实 Chat/Run、一次 Tool/Skill/Memory/Eval 组合任务、一次 Review-to-Validated-Patch live canary；使用 disposable worktree 和真实本地运行时，保留可复核的 Trace、Artifact、测试命令和结果。

阶段一硬验收：

- `npm run typecheck` 通过；
- `npm test -- --reporter=dot` 通过；
- `./.venv/bin/python -m pytest -q` 通过；
- `npm run build` 通过；
- T07 fixture、相关 regression、真实 canary 和 package smoke 通过；
- 每个已修 bug 都有最小回归测试；
- 无 P0/P1 标准或规格问题；
- 运行中 Trace、Event Store、Artifact、Eval 和终态证据一致；
- 真实 Anna Run 没有把失败、缺失 token/cost、未执行 Tool、未验证结果或模拟输出显示为成功；
- 不宣称 T08 已完成，除非 Desktop cutover、legacy boundary 和对应验收确实完成。

### 阶段二：准备 GitHub 公开发布，确保 MVP 可用

阶段二只在阶段一硬验收通过后开始。目标是形成一个可审计、可复现、可公开说明的 MVP release candidate，不自动 push。

1. 建立发布 fixed point：整理 T07/T08 变更为逻辑清晰、可审计的提交；保留原始版本和对比依据；提交前再次确认没有用户无关改动混入。
2. 完成公开仓库最小文档：根目录 `README.md`、许可证/NOTICE、`CONTRIBUTING.md`、`SECURITY.md`、已知限制、架构和运行边界、配置与密钥说明、测试/构建/打包命令、MVP 支持矩阵、真实验证证据索引和发布说明。
3. 脱敏并审查 Git 历史和候选提交：本机用户名、绝对路径、真实客户/业务数据、会话/Trace/附件、模型 API key、MCP token、runtime SQLite、运行时 URL、内部仓库/公司信息和不可公开的设计材料均不得进入公开版本。保留可复现实验时使用合成数据和明确标注的 fixture。
4. 完成依赖与许可证审计：`npm audit`、Python 依赖审计、上游复用来源、传递依赖和许可证清单；high/critical 漏洞必须修复、隔离并记录理由，不能静默带入 release。
5. 完成 CI：至少覆盖 typecheck、Vitest、pytest、build、package smoke、无密钥启动和脱敏/路径门禁；CI 不得依赖本机 `.anna`、私有 MCP、模型凭证或未声明的服务。
6. 完成发布构建验证：macOS local developer preview 的 `.app`、ASAR smoke、Python runtime、health endpoint、签名完整性和首次启动后签名不被破坏；若发布 Windows，则必须在 Windows 环境验证 NSIS 安装包和关键 E2E，不得用 macOS 结果代替。
7. 更新版本号、tag 计划、变更说明、已知限制和“当前不是云端 Runtime/不是自动 push/merge/deploy”的边界。版本号必须与 package、Python metadata、发布文档和 Git tag 一致。
8. 最终独立只读复审按 Standards 与 Spec 两条轴进行，报告只保留可由代码、测试或构建直接证明的问题；任何未验证项必须列为发布阻断或明确的已知限制。

阶段二硬验收：

- 候选工作区干净，或所有未提交内容都有明确的发布/排除结论；
- public README、license、security、contributing 和 release notes 齐全；
- 无 secrets、隐私数据、绝对用户路径和未授权上游代码；
- CI 在干净环境可运行；
- 依赖 audit 无未处理 high/critical；
- package smoke 与签名/首次启动回归通过；
- release candidate 的版本、commit、tag、文档和证据链一致；
- GitHub remote、push 和创建正式 release 仍由用户明确决定，当前 Goal 不执行远程写入。

## 并行开发与 Agent 分工

使用独立分支 Session 和多个 SubAgent 并行开发，但所有 SubAgent 必须遵守同一个 fixed point、文件所有权和验收门：

- Sol xHigh：负责规划、缺口审计、上游源码/许可证审查、任务拆分、Standards/Spec review、最终验收；不直接大范围 coding。
- Terra xHigh：负责实现与测试，按文件所有权分工；每个 SubAgent 使用 TDD red → green → refactor，并在交接中报告 exact files、tests、commands、remaining evidence。
- 轨道 A：T07 Review-to-Validated-Patch、Artifact、worktree、approval 和 live canary。
- 轨道 B：Run/Tool/Skill/Memory/Eval/Sandbox/Trace 的缺口修复和回归测试。
- 轨道 C：经典 Smoke/Dev/regression 评测、真实 Anna Run 验证和证据整理。
- 轨道 D：GitHub 发布卫生、脱敏、许可证、依赖、CI、打包和签名回归。

每个 SubAgent 只能修改其分配文件；跨轨道契约变更先由 Sol xHigh 评审。完成后关闭/停止 SubAgent，避免残留进程和上下文污染。不得让多个 SubAgent 同时改同一文件。

## 工作协议

每个阶段和每个 ticket 都必须：

1. 记录 `HEAD`、分支、工作区状态和 fixed point；
2. 读取当前 handoff/spec，而不是沿用旧结论；
3. 先有可复现 failing test 或缺口证据，再实现最小改动；
4. 运行相关包测试和仓库四门验证；
5. 运行真实 Anna 任务验证，明确区分 fixture、fake provider、live canary 和生产能力；
6. 写入 handoff：完成项、改动文件、测试结果、审查结果、已知缺口和下一步；
7. 在固定点完成独立双轴 review 后再进入下一阶段；
8. 停在当前 Goal 边界，不 push、merge、deploy 或创建正式 GitHub Release。

## 禁止事项

- 不得把“有类似功能”当作“可安全复用”；
- 不得整仓复制 Codex 或 oh-my-pi；
- 不得引入未经审计的 plugin、任意 Bash、宿主机 home 写入、无限网络或跨 Channel Memory；
- 不得删除旧 Runtime 或修改 Crew 产品行为，除非 T08 的替代面和验收已明确通过；
- 不得修改、打印或提交 `.anna/`、凭证、SQLite、附件和本机运行状态；
- 不得为通过测试而弱化测试、放宽 scope、补造 token/cost/成功状态或跳过真实验证；
- 不得因为上游项目来自 OpenAI 就默认适合 Anna，必须保留 Anna 自己的安全、权限、Trace、Eval 和发布边界。

## 最终交付

在 Goal 结束时交付：

- 阶段一/阶段二 handoff；
- fixed point、分支、提交清单和工作区状态；
- changed files 与每个 SubAgent 的 ownership；
- 测试、评测、真实 Anna Run、live canary、package smoke 的原始结果索引；
- 上游复用清单（来源 commit、许可证、代码位置、改造和边界）；
- 发布阻断项、已知限制和未验证证据；
- 仅在用户后续明确授权后才执行 GitHub remote、push、tag 或 release。
