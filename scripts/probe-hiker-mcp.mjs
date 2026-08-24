const REQUIRED_TOOLS = [
  "hiker.system.list_capabilities",
  "hiker.system.get_current_user_context",
  "hiker.master_data.search",
  "hiker.master_data.get_detail",
  "hiker.contract.list_contracts",
  "hiker.contract.get_contract_detail",
  "hiker.contract.get_business_chain",
  "hiker.report.get_dashboard_summary",
  "hiker.report.get_collection_summary",
  "hiker.report.get_invoice_summary",
  "hiker.report.get_po_receivable_summary",
];

const FORBIDDEN_TOOLS = ["hiker.execute_sql", "hiker.call_api", "hiker.update_record", "hiker.delete_record"];

function parseArgs(argv) {
  return { url: argv[2], token: argv[3] };
}

let idCounter = 0;

async function rpc(url, token, method, params = {}) {
  const id = `probe-${++idCounter}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.jsonrpc !== "2.0") throw new Error(`jsonrpc mismatch: ${body.jsonrpc}`);
  if (body.id !== id) throw new Error(`id mismatch: ${body.id} !== ${id}`);
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  if (!body.result || typeof body.result !== "object") throw new Error("result missing");
  return body.result;
}

function payloadOf(result) {
  return result.structuredContent || result;
}

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || "" });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  const { url, token } = parseArgs(process.argv);
  if (!url || !token) {
    console.error("usage: node scripts/probe-hiker-mcp.mjs <url> <token>");
    process.exitCode = 2;
    return;
  }

  let tools = [];
  await check("no token is rejected with HTTP 401", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "no-token", method: "tools/list", params: {} }),
    });
    if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
    return "HTTP 401";
  });

  await check("tools/list returns required tools", async () => {
    const result = await rpc(url, token, "tools/list", {});
    tools = Array.isArray(result.tools) ? result.tools : [];
    const names = tools.map((tool) => tool.name);
    const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
    if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
    return `found ${tools.length} tools`;
  });

  await check("tools/list omits forbidden tools", async () => {
    const names = tools.map((tool) => tool.name);
    const found = FORBIDDEN_TOOLS.filter((name) => names.includes(name));
    if (found.length) throw new Error(`forbidden tools exposed: ${found.join(", ")}`);
    return "ok";
  });

  await check("all tools expose risk metadata", async () => {
    const bad = tools.filter((tool) => tool.risk_level !== "L1" || tool.is_write_operation !== false);
    if (bad.length) throw new Error(`bad metadata: ${bad.map((tool) => tool.name).join(", ")}`);
    return "ok";
  });

  await check("system capabilities returns structuredContent", async () => {
    const result = await rpc(url, token, "tools/call", {
      name: "hiker.system.list_capabilities",
      arguments: {},
    });
    const payload = payloadOf(result);
    if (payload.tool_name !== "hiker.system.list_capabilities") throw new Error("wrong tool_name");
    if (!payload.data || payload.data.system !== "hiker") throw new Error("missing hiker system payload");
    return "ok";
  });

  await check("dashboard summary returns KPI object", async () => {
    const result = await rpc(url, token, "tools/call", {
      name: "hiker.report.get_dashboard_summary",
      arguments: {},
    });
    const data = payloadOf(result).data;
    if (typeof data.contract_count !== "number") throw new Error("contract_count missing");
    if (typeof data.contract_amount !== "string") throw new Error("contract_amount missing");
    return `contract_count=${data.contract_count}`;
  });

  await check("contract list returns an array", async () => {
    const result = await rpc(url, token, "tools/call", {
      name: "hiker.contract.list_contracts",
      arguments: { limit: 5 },
    });
    const data = payloadOf(result).data;
    if (!Array.isArray(data.contracts)) throw new Error("contracts is not an array");
    return `contracts=${data.contracts.length}`;
  });

  let failed = 0;
  for (const result of results) {
    console.log(`${result.ok ? "✓" : "✗"} ${result.name}${result.detail ? ` - ${result.detail}` : ""}`);
    if (!result.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
