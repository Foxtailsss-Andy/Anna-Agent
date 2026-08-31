# Harness-first Preview Plan

目标：[HF-PREVIEW-1.0](../../../product/anna-harness-first-preview-goal-2026-08-31.md)。
基线：`f9f4e1ae06eb4fa54e6f5ebf2974de34ff341b64`。
分支：`codex/harness-first-preview-20260831`。

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| PV-01 | 默认 Desktop -> Harness Host -> OMP 的最小任务界面与 API | P1/P2；实际默认入口，不用测试专用旁路 |
| PV-02 | 工具/资源、停止、持久化历史与安全底线 | P3/P4/P5；四类 smoke，不扩完整故障矩阵 |
| PV-03 | 构建、审核、GitHub Preview 与社区任务 | P6；当前 SHA 与发布声明一致 |

Host 与 Desktop 可以按冻结 HTTP 契约并行开发；所有 Agent 执行仍只有一个 Host。
禁止把未迁移的业务请求转回旧 Python Agent。未知能力返回明确不可用。
现有 S3 工作树不编辑、不清理、不提交到这条预览线。

## 当前状态

- Goal 和最小 HTTP 契约已冻结。
- PV-01 代码已接通：正常 Electron 启动单一 Preview Host，实际 OMP 执行，未启动 Python；真实 Provider 的 P2 仍待用户配置。
- PV-02 已有实际 OMP + 本地 HTTPS fixture 的文件读取、停止与失败证据，继续最终状态重开和安全复验。
- PV-03 进入固定输入的 Sol 双轴审核；当前提交 CI、公开预览交付与 live P2 尚未完成。
- 证据边界与当前进度见 [Preview handoff](../../handoff/2026-08-31-harness-first-preview.md)。
