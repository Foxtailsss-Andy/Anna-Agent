"""Anna demo MCP connector.

A standalone, separately-launched MCP server that speaks the real MCP
JSON-RPC protocol Anna's gateways expect. It is NOT part of Anna's product
runtime (`services/`); it exists so the full Skill -> model -> MCP ->
approval -> write -> readback loop can be demonstrated end-to-end without an
external ERP tenant.

Every payload it returns is clearly-labeled demo-tenant data. Anna's product
code has no knowledge that this connector is a demo: it connects over the
wire exactly as it would to a production ERP/reimbursement MCP server.
"""

DEMO_TENANT_LABEL = "演示租户 (DEMO TENANT)"
