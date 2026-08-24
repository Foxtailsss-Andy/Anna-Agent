// Reimbursement MCP server conformance probe.
//
// Validates that a candidate reimbursement MCP server matches the exact contract
// Anna's ReimbursementMcpGateway expects (see docs/integration/reimbursement-mcp-server-spec.md).
// Zero dependencies — uses built-in fetch (Node 18+).
//
// Usage:
//   node scripts/probe-reimbursement-mcp.mjs <url> [token]            # read-only checks
//   node scripts/probe-reimbursement-mcp.mjs <url> [token] --write    # + full create/submit/get_status (writes one draft!)
//
// Exit code 0 = all required checks passed; 1 = at least one failed.

const REQUIRED_TOOLS = [
  "reimbursement.get_capabilities",
  "reimbursement.get_policy",
  "reimbursement.validate_draft",
  "reimbursement.create_draft",
  "reimbursement.submit",
  "reimbursement.get_status",
];

const ALLOWED_DRAFT_FIELDS = new Set([
  "category", "amount", "currency", "expense_date", "merchant",
  "reason", "department_id", "cost_center_id", "project_id", "attachments",
]);

// A sample draft used for the read-only validate probe and the optional write cycle.
// Adjust to one your sandbox tenant will accept as valid + complete.
const SAMPLE_DRAFT = {
  category: "travel",
  amount: 188.5,
  currency: "CNY",
  expense_date: "2026-06-10",
  merchant: "示例出租车公司",
  reason: "客户拜访交通费",
  department_id: "DEPT-001",
  cost_center_id: "CC-001",
};

const WORKSPACE_ID = "probe-workspace";
const ACTOR_USER_ID = "probe-user";

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  return { url: positional[0], token: positional[1], write: flags.has("--write") };
}

let idCounter = 0;
async function rpc(url, token, method, params) {
  const id = `probe-${++idCounter}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  // Mirror Anna's envelope validation exactly.
  if (body.jsonrpc !== "2.0") throw new Error(`jsonrpc must be "2.0", got ${JSON.stringify(body.jsonrpc)}`);
  if (body.id !== id) throw new Error(`id not echoed: sent ${id}, got ${JSON.stringify(body.id)}`);
  if (body.error) {
    const e = body.error;
    throw new Error(`tool error code=${e.code} message=${e.message} retryable=${e.retryable}`);
  }
  if (!body.result || typeof body.result !== "object") throw new Error("result is not an object");
  return body.result;
}

function payloadOf(result) {
  // Same extraction order as Anna's _extract_tool_payload.
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        try { const d = JSON.parse(item.text); if (d && typeof d === "object") return d; } catch {}
      }
    }
  }
  if (result.result && typeof result.result === "object") return result.result;
  return result;
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => results.push({ name, ok: true, detail: detail || "" }))
    .catch((err) => results.push({ name, ok: false, detail: err.message }));
}

async function main() {
  const { url, token, write } = parseArgs(process.argv);
  if (!url) {
    console.error("usage: node scripts/probe-reimbursement-mcp.mjs <url> [token] [--write]");
    process.exit(2);
  }
  console.log(`Probing reimbursement MCP server: ${url}`);
  console.log(`Auth: ${token ? "Bearer token provided" : "no token"} | mode: ${write ? "READ+WRITE" : "read-only"}\n`);

  let toolsList = null;

  await check("tools/list returns all 6 required tools", async () => {
    const result = await rpc(url, token, "tools/list", {});
    const tools = Array.isArray(result.tools) ? result.tools : [];
    toolsList = tools;
    const names = tools.map((t) => t?.name).filter((n) => typeof n === "string");
    const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
    return `found ${names.length} tools`;
  });

  await check("submit declares inputSchema with snapshot fields (hidden gate A)", async () => {
    const submit = (toolsList || []).find((t) => t?.name === "reimbursement.submit");
    if (!submit) throw new Error("reimbursement.submit not in tools/list");
    const schema = submit.inputSchema || submit.input_schema;
    const props = schema?.properties;
    if (!props || typeof props !== "object") throw new Error("submit.inputSchema.properties missing");
    const need = ["expected_draft_snapshot", "expected_draft_snapshot_hash"];
    const missing = need.filter((f) => !(f in props));
    if (missing.length) throw new Error(`submit.inputSchema missing properties: ${missing.join(", ")}`);
    return "expected_draft_snapshot + expected_draft_snapshot_hash declared";
  });

  await check("validate_draft / create_draft do not require unknown draft fields (hidden gate B)", async () => {
    const offenders = [];
    for (const t of toolsList || []) {
      if (!["reimbursement.validate_draft", "reimbursement.create_draft"].includes(t?.name)) continue;
      const schema = t.inputSchema || t.input_schema;
      const draftSchema = schema?.properties?.draft;
      const required = Array.isArray(draftSchema?.required) ? draftSchema.required : [];
      for (const f of required) if (!ALLOWED_DRAFT_FIELDS.has(f)) offenders.push(`${t.name}:${f}`);
    }
    if (offenders.length) throw new Error(`unsupported required draft fields: ${offenders.join(", ")}`);
    return "no unsupported required draft fields";
  });

  await check("get_capabilities returns an object", async () => {
    const result = await rpc(url, token, "tools/call", {
      name: "reimbursement.get_capabilities",
      arguments: { workspace_id: WORKSPACE_ID, actor_user_id: ACTOR_USER_ID },
    });
    const p = payloadOf(result);
    if (!p || typeof p !== "object") throw new Error("payload is not an object");
    return "ok";
  });

  await check("validate_draft accepts SAMPLE_DRAFT (valid, no missing fields)", async () => {
    const result = await rpc(url, token, "tools/call", {
      name: "reimbursement.validate_draft",
      arguments: { workspace_id: WORKSPACE_ID, actor_user_id: ACTOR_USER_ID, draft: SAMPLE_DRAFT },
    });
    const p = payloadOf(result);
    if (p.valid !== true) throw new Error(`valid !== true (got ${JSON.stringify(p.valid)})`);
    if (p.blocked === true) throw new Error("blocked === true");
    if (Array.isArray(p.missing_fields) && p.missing_fields.length) {
      throw new Error(`missing_fields: ${p.missing_fields.join(", ")} — adjust SAMPLE_DRAFT to a complete one`);
    }
    if (typeof p.policy_summary !== "string") throw new Error("policy_summary missing/not a string");
    if (typeof p.risk_level !== "string") throw new Error("risk_level missing/not a string");
    return `risk_level=${p.risk_level}`;
  });

  if (write) {
    let externalId = null;
    let submittedStatus = null;

    await check("create_draft returns non-empty external_reimbursement_id (WRITE)", async () => {
      const result = await rpc(url, token, "tools/call", {
        name: "reimbursement.create_draft",
        arguments: {
          workspace_id: WORKSPACE_ID, actor_user_id: ACTOR_USER_ID,
          source: "Anna", source_run_id: "probe-run-1",
          idempotency_key: "probe-create-1", draft: SAMPLE_DRAFT,
        },
      });
      const p = payloadOf(result);
      if (!p.external_reimbursement_id) throw new Error("external_reimbursement_id empty");
      externalId = p.external_reimbursement_id;
      return `external_reimbursement_id=${externalId} status=${p.external_status}`;
    });

    await check("submit returns external_reimbursement_id + external_status (WRITE)", async () => {
      if (!externalId) throw new Error("skipped: no draft id");
      const result = await rpc(url, token, "tools/call", {
        name: "reimbursement.submit",
        arguments: {
          workspace_id: WORKSPACE_ID, actor_user_id: ACTOR_USER_ID,
          source: "Anna", source_run_id: "probe-run-1", confirmation_id: "probe-approval-1",
          idempotency_key: "probe-submit-1", external_reimbursement_id: externalId,
          expected_draft_snapshot: SAMPLE_DRAFT, expected_draft_snapshot_hash: "probe-hash",
        },
      });
      const p = payloadOf(result);
      if (!p.external_reimbursement_id) throw new Error("external_reimbursement_id missing");
      if (!p.external_status) throw new Error("external_status missing");
      submittedStatus = p.external_status;
      return `external_status=${submittedStatus}`;
    });

    await check("get_status echoes id + matching status (WRITE)", async () => {
      if (!externalId) throw new Error("skipped: no draft id");
      const result = await rpc(url, token, "tools/call", {
        name: "reimbursement.get_status",
        arguments: { workspace_id: WORKSPACE_ID, actor_user_id: ACTOR_USER_ID, external_reimbursement_id: externalId },
      });
      const p = payloadOf(result);
      if (p.external_reimbursement_id !== externalId) {
        throw new Error(`id mismatch: ${p.external_reimbursement_id} !== ${externalId}`);
      }
      if (p.external_status !== submittedStatus) {
        throw new Error(`status mismatch: get_status='${p.external_status}' vs submit='${submittedStatus}' — Anna would stay verify_pending`);
      }
      return `verified status=${p.external_status}`;
    });
  }

  // Report
  console.log("Results:");
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  if (!write) console.log("(read-only mode — rerun with --write against a sandbox tenant for the full create/submit/get_status cycle.)");
  // Set exitCode (not process.exit) and let the loop drain — abruptly exiting
  // while undici keep-alive sockets are closing triggers a libuv assertion on Windows.
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("probe crashed:", err.message);
  process.exitCode = 1;
});
