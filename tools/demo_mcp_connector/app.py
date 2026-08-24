"""FastAPI serving layer for the Anna demo MCP connector.

Launch (real HTTP, real MCP JSON-RPC):

    .venv/Scripts/python -m uvicorn tools.demo_mcp_connector.app:app --port 8970

Then point Anna's runtime.json at it:

    "reimbursement_mcp_server": "http://127.0.0.1:8970/reimbursement/rpc",
    "erp_mcp_server":          "http://127.0.0.1:8970/erp/rpc"

Anna then talks to this process exactly as it would to a production ERP /
reimbursement MCP server. The data behind it is clearly-labeled demo-tenant
data; nothing in Anna's product runtime special-cases it.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request

from . import DEMO_TENANT_LABEL
from .connector import DemoMcpConnector

app = FastAPI(title="Anna Demo MCP Connector", description=DEMO_TENANT_LABEL)
_connector = DemoMcpConnector()


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "tenant": DEMO_TENANT_LABEL, "demo": True}


@app.post("/reimbursement/rpc")
async def reimbursement_rpc(request: Request) -> dict[str, Any]:
    body = await request.json()
    return _connector.handle_reimbursement(body)


@app.post("/erp/rpc")
async def erp_rpc(request: Request) -> dict[str, Any]:
    body = await request.json()
    return _connector.handle_erp(body)
