# Anna Harness-first Preview Goal

版本：HF-PREVIEW-1.0

日期：2026-08-31

状态：当前执行目标；上线前仍需逐项验收。

基线：`f9f4e1ae06eb4fa54e6f5ebf2974de34ff341b64`。

## 唯一目标

发布一版默认由 Anna Harness Host + 实际 Oh-my-Pi 执行的 Developer Preview。
用户从正常 Desktop 入口配置模型、提交任务、观察流式输出和工具过程、停止任务、查看持久化历史。
这条用户路径全程由 Harness 拥有 Run、Context/Memory、Skill、Tool 和终态，默认启动不再运行 Python Agent 服务。

本目标依据用户“先尽快完成 Harness 替换和上线、细节测试交给社区”的要求，替代此前完整迁移 Goal 的执行范围和排序。
[HF-SPEC-1.0](anna-harness-first-spec-2026-08-30.md) 保留为长期产品方向；不得用本 Preview 完成宣称全业务、多平台或 SWE-bench 已完成。

## 首发范围

- 正常 Desktop 启动直接管理 Node Harness Host，Oh-my-Pi 是默认执行内核。不可自动回退 Pi 或 Python。
- 首发界面聚焦任务输入、运行过程、停止、历史和最小模型/工作区设置；复用现有 UI 与代码模式。
- 通用文本任务和已准入的只读工作区工具真实可用；至少验证一次实际文件读取，不把模型文本当工具结果。
- 复用已有 Host Memory 读取、固定 Skill/Profile、ToolGateway、SQLite 与 Contract Eval。不开新 Memory 框架。
- 目前未完成迁移的业务入口不在首发界面开放，也不能隐藏调用旧 Python Agent。
- GitHub 发布可运行源码、当前平台预览构建、启动说明、已验证能力与明确限制。

本次验证平台为当前可实测的 macOS arm64。Windows 仍是长期主要分发目标，但本版不宣称已经支持。
“上线”在此指 GitHub Developer Preview；不包含业务生产环境部署或正式稳定版发布。

## 六项硬验收

| ID | 必须成立的结果 | 最小证据 |
| --- | --- | --- |
| P1 默认入口替换 | 正常 Desktop 命令启动 Harness Host；默认 Chat/任务不请求旧 Python Agent API；OMP 不可用时明确失败 | 启动集成测试、实际进程检查、浏览器/Electron 网络检查 |
| P2 真实任务闭环 | 从首发 UI 发起真实 Provider 请求，经实际 OMP Loop 返回结果；无配置时可以进入设置，不让整个应用启动失败 | 一次真实 Provider smoke、UI 流程截图、对应 Run 事件 |
| P3 真实资源与工具 | 已准入 Skill/Memory 在模型前加载；至少一个真实 ToolGateway 文件读取；越界读取被拒绝 | 当前代码的针对性集成测试、真实文件结果与工具事件 |
| P4 生命周期底线 | 提交/流式展示/停止/历史可用；停止能终止当前模型/Worker；重开应用能查看已完成记录；重连不创建重复 Run | 正常、停止、失败、重开四类 smoke；单 Run/单终态与 Eval 顺序断言 |
| P5 安全与数据底线 | 密钥不进入日志/公开材料；Run/工作区作用域受检查；本版不开未经确认的写操作；原有数据不删除、不双写 | 秘密扫描、越界/重复提交负例、独立新状态目录及回退说明 |
| P6 可发布 | 当前提交能按文档安装、构建和启动；源码/预览构建可获取；明确 Developer Preview 能力边界；最终审核不存在破坏 P1-P5 的未关闭问题 | 当前 SHA 的关键检查/CI、Sol 审核、发布说明与公开入口 |

没有真实 Provider 凭据时，先完成代码和本地确定性验证，在 P2 明确请求配置；不得用 fake transport 充当真实验收。
旧 Python 数据保留原位，预览使用独立 Harness 状态路径。历史数据导入不在本次范围内。

## 可以上线后继续的工作

详见 [社区 Backlog](anna-harness-first-community-backlog-2026-08-31.md)。以下不再阻塞本 Preview：

- steer/ask_human 的全部中断点、ACK 丢失组合和高并发恢复矩阵。
- 所有 Provider、操作系统、安装路径的笛卡尔积测试和性能调优。
- Windows/Linux 分发与更强隔离，完整 coding tools、官方 SWE-bench 和性能成绩。
- Hiker/MCP 业务全流程、审批写入回读、Create/Crew/Hub 全量迁移。
- Memory 提议/Owner 接受的完整 UI、历史数据导入、Skill/Plugin 市场与高级 Router。

这些能力在验证前保持禁用或明确未支持。放宽测试范围不放宽已开放能力的权限、停止、数据与执行正确性。

## 执行纪律

1. 先让真实默认入口走通，再处理阻塞该路径的缺陷。禁止继续以底层单元测试数量代替入口替换进度。
2. 只新增覆盖 P1-P6 的强集成测试；已发现的真实安全/数据问题必须修复，非阻断性细节记录为社区任务。
3. GPT-5.6-Luna Max 主编码，GPT-5.6-Sol Ultra 最终把关。每阶段最多一轮完整审核；后续只复核修改项。
4. 沿用 Matt Pocock 的小纵切面、先 RED 后 GREEN、固定输入审核原则，不扩展成新的通用控制框架。
5. 原 `codex/harness-first-20260830` 的 S3 WIP 完整保留；预览工作树从已验证 S2 基线开始，不删除或重置旧工作。
6. 不自动合并默认分支、不强推、不部署业务生产环境、不发布正式稳定版标签。

## 交付顺序

1. **默认入口闭环**：Host 的最小 Chat/设置/历史接口与 Desktop 单 Host 启动同步接通。
2. **真实 smoke 与最小修正**：实际 OMP/Provider/文件工具、停止、重开历史、作用域与秘密扫描。
3. **Developer Preview 发布**：构建、最终审核、当前 SHA CI、发布说明与社区 Backlog。

完成条件只有一个：P1-P6 的当前版本证据齐备，并且公开交付物与声明一致。
