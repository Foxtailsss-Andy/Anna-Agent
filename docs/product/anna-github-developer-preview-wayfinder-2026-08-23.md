# Anna GitHub Developer Preview · Wayfinder

> 日期：2026-08-23
> 状态：首发范围已固化，进入实施
> 目标：以最小可审计范围形成可公开发布的 GitHub Developer Preview。

## 1. Goal

在不破坏现有脏工作树的前提下，形成一个可复现、可解释、可公开说明的 Anna Developer Preview：

- GitHub 源码仓库；
- macOS 本地 Developer Preview；
- Harness v2 Runtime + Chat 主路径；
- 无密钥启动、类型检查、测试、构建、ASAR smoke 和 CI 门禁；
- 公开文档、许可证、安全说明、已知限制和证据索引。

本首发不执行 GitHub remote、push、tag 或正式 Release 写入。

## 2. Decisions

| 决策 | 首发选择 | 说明 |
| --- | --- | --- |
| 交付形态 | macOS Developer Preview + 源码 | 当前 macOS package/smoke 有证据；Windows 保留为后续验收 |
| 主叙事 | Harness v2 Runtime + Chat | 只承诺已能由代码、测试或 live evidence 证明的能力 |
| 工作树 | 独立发布边界 | 保留现有脏工作树；首发只纳入已审查文件 |
| 授权 | MIT | 依赖许可证另列清单；未经确认的素材不进入首发 |
| 门禁 | 核心门禁全绿 + 已知限制公开 | 不把 T07/T08 或签名状态伪装成完成 |
| 内容 | 公开、可复现、脱敏材料 | 排除 secrets、绝对本机路径、客户/财务数据和内部迁移包 |

## 3. Release claim

首发可以说：

> Anna is a local desktop Developer Preview for a channel-scoped AI agent runtime. The preview demonstrates durable Harness v2 Runs, streamed events, scoped tools, Trace/Eval evidence, and local Chat execution through a configured OpenAI-compatible provider.

首发不能说：

- production-ready 或 cloud runtime；
- T07 Review-to-Validated-Patch production canary 已完成；
- Cowork、Crew、Create、Hub 已完成 Legacy cutover；
- Windows 安装包、macOS 签名/notarization 已验收；
- WebSearch、真实 Owner approval 或跨进程外部恢复已被验证。

## 4. Design tree closure

### 首发必须关闭

1. 发布文件边界和脱敏规则；
2. README、许可证、安全、贡献、变更说明；
3. 无密钥启动与配置说明；
4. Node/Python/Build/Package smoke CI；
5. 当前桌面 smoke 的过时路径问题；
6. 版本、证据、已知限制的一致性。

### 后续迭代

1. T07 Review-to-Validated-Patch 真实 Owner canary；
2. T08 各业务域 Legacy cutover 与删除；
3. Windows NSIS 安装验收；
4. Developer ID 签名与 notarization；
5. 外部 WebSearch、Pi restore 和存储故障演练；
6. Python lockfile 和独立 Python 依赖审计。

## 5. Exit gate

只有以下条件全部满足，才称为“可公开 Developer Preview”：

- 发布范围文件清单可审查，未把 `.anna/`、`dist/`、`release/` 或 secrets 纳入；
- README、LICENSE、SECURITY、CONTRIBUTING、CHANGELOG 存在；
- CI 在无私有 provider/MCP/本机状态环境运行；
- typecheck、Vitest、pytest、build、package smoke 和 evidence verification 通过；
- 已知失败或未验证项在文档中显式列出；
- release candidate 的版本、HEAD、证据和限制一致。
