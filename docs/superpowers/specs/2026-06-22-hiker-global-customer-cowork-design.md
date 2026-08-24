# Cowork · Hiker 外部连接器接入设计

日期：2026-06-22
公开修订：2026-08-24
状态：Anna 侧集成已实现
Hiker 作者：[kc8zshnt6n-gif](https://github.com/kc8zshnt6n-gif)

## 1. 项目与许可边界

Hiker 是一个外部合作项目，目前未开源。本仓库不包含 Hiker 平台、服务端源码、部署信息、访问凭据或业务数据。

Anna 只维护自身的连接器、Runtime 编排、只读 Skill、API 路由和桌面 UI 集成。仓库中的 MIT License 仅覆盖这些 Anna 侧代码，不延伸至 Hiker。

## 2. 集成目标

Anna 的 Cowork 工作区提供一个 Hiker 客户与合同只读入口：

- 通过外部 MCP Connector 获取授权范围内的数据；
- 将连接状态、失败原因和数据来源显式展示；
- 把客户、合同、回款和风险摘要映射为只读看板；
- 支持通过 Anna 副驾发起受治理的只读查询；
- 保持 Hiker 在 Runtime 边缘，不把业务域逻辑写入 Harness 核心。

## 3. 公开实现范围

本仓库公开的 Anna 侧实现包括：

- `services/mcp_gateway/app/hiker_adapter.py`：外部 MCP 连接适配；
- `services/hiker/`：Anna 侧编排与公开投影 schema；
- `services/runtime/app/hiker_tool_registry.py`：工具白名单与治理边界；
- `services/api/app/routes/hiker.py`：Anna 桌面 Runtime API；
- `skills/hiker/global-customer/SKILL.md`：只读副驾指令；
- `apps/desktop/src/pages/cowork/HikerPage.tsx`：桌面看板与交互；
- 对应的 deterministic fake 与测试。

公开测试数据均为合成 fixture，不代表 Hiker 或任何真实客户、合同和经营数据。

## 4. 安全边界

- Connector 默认未配置并 fail closed；
- Endpoint、凭据和运行状态只进入本地 gitignored 配置；
- Anna 不提交真实 provider/MCP 响应、数据库或运行日志；
- 当前集成只允许明确列入白名单的只读操作；
- 外部服务的可用性、安全性和许可由其所有者独立管理。

## 5. 非目标

- 不复制或分发 Hiker 平台源码；
- 不公开 Hiker 的部署地址、凭据、内部实现或真实数据；
- 不声明 Hiker 已开源；
- 不声明 Anna 对 Hiker 拥有独立作者权；
- 不在未获得额外授权的情况下提供写入、管理或高风险工具。

## 6. 验收口径

1. 未配置 Hiker Connector 时，桌面显示明确的未连接状态且不生成演示业务结果；
2. 配置合法的外部 Connector 后，Anna 只渲染其返回的公开投影字段；
3. 工具调用经过 allowlist、身份映射、Trace 和错误归一化；
4. 任何发布文档都同时说明 Hiker 的作者归属和未开源状态；
5. 仓库扫描不包含 Hiker 的真实 endpoint、凭据或业务数据。
