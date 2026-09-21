# 多 Session + SubAgent 开发协议

适用于 Jev Crew Preview，2026-09-21 用户新指示。此协议不恢复其他 Workbench 里程碑。

## 1. 模型分工

| 角色 | 必须使用 | 责任 |
| --- | --- | --- |
| Supervisor / Planner | `gpt-6-astra`，`xhigh` | 定向、SPEC、任务拆分、取舍、验收、交接 |
| Coding SubAgent | `gpt-5.6-luna`，`high` | 产品代码、测试、评测工具和相关技术实现 |
| Standards Reviewer | `gpt-6-astra`，`xhigh` | 独立只读规范与代码审查 |
| Spec Reviewer | `gpt-6-astra`，`xhigh` | 独立只读合同、范围和证据审查 |

不能把旧文档中的 Luna `xhigh` 延用到此计划。每次启动 coding/reviewer 使用 `fork_turns=none`，明确模型与 effort。配置不可用就报告事实，不能静默改用别的模型。开发模型配置与 Anna 产品使用的 Jev/生成模型无关。

## 2. 唯一 owner

`STATUS.md` 是唯一当前进度与 owner。只有 owner 可以派实现任务、整合及更新卡状态。子 Agent 只在授权文件写入；评审人不修代码。默认一名 Luna writer；只有两个文件集合和合同真正独立时才并行实现。

本研究任务完成 SPEC 审定后创建首个新的开发 Supervisor Session。创建时先只读核验，不马上派工；旧 owner 写入新 owner ID，再发送交接授权。旧 owner 随即停止修改产品工作树。

每张开发票验收后创建下一张票的全新 Supervisor Session。不要把所有票塞进一个 Session，也不要为每个小函数创建用户任务；细分实现使用 SubAgent。

## 3. 每次派工必须携带

- 工作树绝对路径、分支、pre-change SHA、SPEC 版本。
- 当前票、对应 R/AC、固定允许的公共测试边界。
- 仅该 Agent 可以修改的文件/目录与明确禁止触及的路径。
- 已定合同、依赖、预期输出、RED/GREEN 验证方式。
- 实测预算与凭据引用的获取方式；提示词中绝不含秘密值。
- 完成后汇报实际 diff、命令/退出码、未验证项；不得自行宣布验收。

## 4. 工程循环

1. Astra 从实际调用点确定最小切片，核对上一卡证据。
2. Luna 按已批准 seam 逐个执行 RED→GREEN；避免镜像实现的测试和全量先写测试。
3. Luna 交回文件权，Astra 核对变更与测试证据。
4. 按 `code-review` 技能启动两个独立 Astra，分别审 Standards/Spec。记录基线、提交与未提交新增文件，不能拿空 diff 当通过。
5. Luna 修复必要发现；Astra 复核后按票关账。
6. 只提交本票 owned 文件；公开证据先脱敏。全量仓库回归在最终集成时运行一次，中间以相关检查为主，除非新变化或失败需要扩大检查。

测试结果要区分 deterministic、真实 Host/business、真实 Jev、真实原 Provider 和完整 Worker。规则直达没有 Jev 调用；模拟响应没有模型质量证据。

## 5. 跨 Session 接力步骤

1. Drain 本票 writer/reviewer 和本票启动的测试进程；不能杀其他任务或用户服务。
2. 写 `handoff/JEV-0N.md`：准确 SHA、dirty 状态、文件 hash、测试、live轮次、问题和下一动作。
3. 更新 STATUS 为 `handoff_pending`，记录新任务的唯一接管范围。
4. 通过 Codex `list_projects` 确认 Anna 项目，再创建 `gpt-6-astra/xhigh` 的新任务。当前保存的 Anna 项目是非 Git 外层目录，因此使用 local，提示词显式指定本工作树。若项目配置漂移，按实际 `isGitRepository` 选择环境，不能生成第二个代码分叉后遗失当前改动。
5. 新任务先只读核验；旧 owner 将 STATUS owner 改为返回的真实 threadId，再发送接管消息。clientThreadId 不能冒充 threadId。
6. 新 owner 核对 owner ID、工作树、SPEC 与现场，进入下一票。旧 owner 停止写入及派工。

每次成功创建新任务，调用者最终回复应包含 `created-thread` 展示标记。若创建失败则保留当前 owner，可重试同一交接，不能宣布已移交。

## 6. 交接胶囊

```text
ticket / status / owner / successor
worktree / branch / HEAD / dirty and owned file hashes
SPEC version / exact R and AC
accepted design decisions / rejected scope additions
actual commands / exit codes / evidence paths / live model versions
Standards findings / Spec findings / unresolved limitations
live spend / request counts / remaining budget
writers and processes drained
next concrete task / exit condition
```

胶囊只记事实和必要定位，不复制原始对话、模型回复全文或凭据。

## 7. 授权与停止边界

用户已授权此计划的多 Session 开发和内部子任务接力，不需要逐票重新请求“是否继续”。预算到限停止付费调用，继续无需外部调用的工作；服务不可用时保持 live 未通过，不能伪造结果。

用户暂停优先：立即停止新派工、收回写入并保存状态，后续 Session 不能绕过暂停。范围内的局部修复由 Astra 直接审定；新增自动派工、DAG 改写、权限策略或长期后台任务不属于本期。

首轮开发目标是本地功能、实测和可发布首页内容。可以在本分支形成可审阅提交；远程合并与 Release 不由本协议自动触发。存在有效 GitHub 发布请求时，仍需以最终候选证据完成发布流程，不以“新任务已启动”代替交付。
