# Anna 演示 MCP 连接器 (Demo MCP Connector)

一个**独立启动**的 MCP 服务器,讲 Anna 网关期望的真实 MCP JSON-RPC 协议。它**不是 Anna 产品运行时的一部分**(不在 `services/` 下),作用是:在没有真实报销系统或 Associate ERP seam 租户的情况下,把报销与回款任务的 `Skill → 模型 → MCP → 审批 → 写入 → 读回` 闭环端到端演示出来。

## 为什么这不违反"拒绝假数据"

- 它是一个**单独的进程**,通过真实的 HTTP + JSON-RPC 协议对外提供服务;
- Anna 的产品代码**完全不知道**它是演示连接器——连接方式与对接生产报销 MCP / 可选 Associate ERP MCP 服务器**完全一致**;
- 它返回的每一份数据都**明确标注为演示租户数据**(`演示数据` / `DEMO TENANT`),屏幕上不会与真实数据混淆;
- 它**默认不启用**:必须手动启动 + 在 `runtime.json` 里显式把 Anna 指向它。

产品链路是真的,只有连接器背后的数据是演示租户。Finance 经营看板与 Demo ERP sidecar 已退出正式主链路;本连接器只作为手动启动的外部 MCP 测试服务保留。

## 提供的工具

**报销端点** `POST /reimbursement/rpc`(6 个工具):
`reimbursement.get_capabilities` · `get_policy` · `validate_draft` · `create_draft` · `submit` · `get_status`

**Associate ERP 端点** `POST /erp/rpc`(3 个工具):
`erp.finance.get_receivables_aging` · `erp.collection_task.create_draft` · `erp.collection_task.get_status`

## 启动

```powershell
# 1. 启动演示连接器(独立进程,端口 8970)
.\.venv\Scripts\python.exe -m uvicorn tools.demo_mcp_connector.app:app --host 127.0.0.1 --port 8970
```

在 `.anna\runtime.json`(本地、已 gitignore)中把 Anna 指向它:

```json
{
  "reimbursement_mcp_server": "http://127.0.0.1:8970/reimbursement/rpc",
  "erp_mcp_server": "http://127.0.0.1:8970/erp/rpc"
}
```

```powershell
# 2. 重启 Anna 后端,Admin 里报销 / Associate ERP MCP 都会显示 connected
# 3. Cowork → Hiker → 报销助理可验证报销链路;Associate 可验证回款任务链路
```

## 契约测试

`tests/demo_connector/test_demo_mcp_connector.py` 用 Anna 真实的 `ReimbursementMcpGateway` / `ErpMcpGateway` 驱动本连接器,并把每个工具结果按真实 Pydantic schema 校验,确保演示连接器与生产契约一致。
