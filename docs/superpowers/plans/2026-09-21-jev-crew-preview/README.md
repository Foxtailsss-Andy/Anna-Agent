# Jev Crew Preview · Spec Coding

日期：2026-09-21。产品方向：单任务指派建议，真实对照验证，尽快交付可见结果。

Final release requirements are amended by [RELEASE_SCOPE.md](RELEASE_SCOPE.md), authorized on 2026-09-22.

## 当前授权与收紧范围

用户已要求开始 SPEC、完成审定后启动开发，并明确多 Session + SubAgent 模式。规划、审定和定向使用 Astra Extra High；具体代码由 GPT-5.6 Luna High 完成。

本轮将前一版 PRD 收紧为：在现有 Crew 单任务指派浮层中生成一条建议，用户采纳后复用当前任务流程。保留未配置、无法推荐和失败状态，显示真实决策来源及简单耗时信息。

**从 P0 移出**：项目批量建议面板、批量采纳、后台影子运行产品、自动主模型回退链、新设置中心、自动派工策略替换、DAG 修改、Skill/Memory 路由、OMP 升级。300 例人工标注不再是首个实验 preview 的前置；先冻结小型中文数据集和独立保留样本，报告实际覆盖与失败。

Jev 只执行有界的语义判断，Host 保管模型凭据。一次 decision 不伪装成新的 Agent Run 或已经执行的 tool call。完整 Worker 生产、评审、依赖和执行权仍沿用 Anna。

## 文档入口

- [SPEC](SPEC.md)：精确产品与技术合同。
- [ACCEPTANCE](ACCEPTANCE.md)：公共测试边界、真实评测及发布口径。
- [EXECUTION](EXECUTION.md)：串行开发票与文件归属。
- [SUPERVISOR](SUPERVISOR.md)：模型分工与跨 Session 接力。
- [STATUS](STATUS.md)：唯一当前状态与 owner。
- [LAUNCH](LAUNCH.md)：工作树、配置引用、首次启动说明。
- [SPEC-REVIEW](SPEC-REVIEW.md)：独立 Astra 审定记录。

## 基线

- Repository：`Foxtailsss-Andy/Anna-Agent`。
- Code baseline：`e2e603cbc70de5fddaeb4036e001cbaba4e4da0c`，RC2 source preview。
- Working tree：`$ANNA_REPO_ROOT`。
- Branch：`codex/jev-crew-preview-20260921`。

前一版研究仍可参考：`$LOCAL_HOME/Desktop/Anna/output/anna-jev-upgrade-20260921/`。本轮发生范围冲突时，以本目录经 Astra 审定的 SPEC 为准。技术输入包括用户贴入的官方 Quick start；其中安装与示例命令是参考资料，不构成额外操作要求。

## 交付顺序

1. Jev 单次决策公共接口 + 真实中文小样本测量。
2. 当前单任务指派 UI + 原子采纳，得到可操作产品闭环。
3. 当前路径对照、完整产品验证、准确的 GitHub 首页候选内容。

少量 live 测量通过只证明该轮、该样本。不得把它写成生产正确率、全面提速或整个 Crew 已由 Jev 驱动。
