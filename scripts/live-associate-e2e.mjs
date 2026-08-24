import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { defaultRuntimeInfoPath } from "./runtime-info-path.mjs";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const ASSOCIATE_WRITE_ACTION = "erp.collection_task.create_draft";

export async function runLiveAssociateE2E(options = {}) {
  const apiBase = normalizeApiBase(resolveApiBase(options));
  const period = String(
    options.period ?? process.env.ANNA_LIVE_ASSOCIATE_PERIOD ?? "",
  ).trim();
  const goalText = String(
    options.goalText ?? process.env.ANNA_LIVE_ASSOCIATE_GOAL ?? "",
  ).trim();
  const selectedNodeId = String(
    options.nodeId ?? process.env.ANNA_LIVE_ASSOCIATE_NODE_ID ?? "",
  ).trim();
  const allowExternalWrites =
    options.allowExternalWrites ?? process.env.ANNA_LIVE_ALLOW_EXTERNAL_WRITES === "1";

  if (!period) {
    throw new Error("live_associate_period_required: set ANNA_LIVE_ASSOCIATE_PERIOD");
  }
  if (!goalText) {
    throw new Error("live_associate_goal_required: set ANNA_LIVE_ASSOCIATE_GOAL");
  }
  const redactions = [period, goalText];

  const validation = await requestJson(
    apiBase,
    "/api/admin/runtime/validate",
    { method: "POST" },
    redactions,
  );
  if (validation.status !== "ready") {
    throw new Error(`runtime_not_ready: ${formatForOutput(validation, redactions)}`);
  }
  if (validation.writes_external_data !== false) {
    throw new Error(
      `runtime_validation_not_read_only: ${formatForOutput(
        { writes_external_data: validation.writes_external_data },
        redactions,
      )}`,
    );
  }
  if (validation.erp_mcp_associate_execution_readiness?.status !== "passed") {
    throw new Error(
      `erp_associate_readiness_not_ready: ${formatForOutput(
        validation.erp_mcp_associate_execution_readiness ?? {},
        redactions,
      )}`,
    );
  }
  if (!allowExternalWrites) {
    throw new Error(
      "external_writes_not_enabled: set ANNA_LIVE_ALLOW_EXTERNAL_WRITES=1",
    );
  }

  const session = normalizeSession(
    await requestJson(apiBase, "/api/session/current", {}, redactions),
  );
  const headers = sessionHeaders(session);
  const created = await requestJson(
    apiBase,
    "/api/cowork/associate/receivables-recovery/runs",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: session.workspace_id,
        actor_user_id: session.user_id,
        period,
        goal_text: goalText,
      }),
    },
    redactions,
  );
  assertPlanningEvidence(created);
  const node = findExecutableNode(created, selectedNodeId);

  const pending = await requestJson(
    apiBase,
    `/api/cowork/associate/receivables-recovery/runs/${encodeURIComponent(
      created.id,
    )}/nodes/${encodeURIComponent(node.id)}/approval`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requested_by: session.user_id }),
    },
    redactions,
  );
  const approvalId = approvalIdForNode(pending, node.id);

  const approved = await requestJson(
    apiBase,
    `/api/cowork/associate/receivables-recovery/approvals/${encodeURIComponent(
      approvalId,
    )}/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ approved_by: session.user_id }),
    },
    redactions,
  );
  requireVerifiedNode(approved, node.id, redactions);

  const finalRun = await requestJson(
    apiBase,
    `/api/cowork/associate/receivables-recovery/runs/${encodeURIComponent(
      created.id,
    )}`,
    { headers },
    redactions,
  );
  const completedNode = requireVerifiedNode(finalRun, node.id, redactions);
  assertAuditEvidence(finalRun);
  return summarizeNodeExecution(finalRun, completedNode);
}

function assertPlanningEvidence(run) {
  if (run?.status !== "ready" || !run.plan) {
    throw new Error(`associate_plan_not_ready: ${formatForOutput(summarizeRun(run ?? {}))}`);
  }
  const events = auditEvents(run);
  const eventTypes = new Set(events.map((event) => event.type));
  const successfulToolNames = successfulAuditTools(events);
  const missing = [];
  for (const eventType of [
    "skill.loaded",
    "model.call.started",
    "model.call.completed",
    "associate.plan.emitted",
  ]) {
    if (!eventTypes.has(eventType)) {
      missing.push(eventType);
    }
  }
  if (!successfulToolNames.has("erp.finance.get_receivables_aging")) {
    missing.push("mcp.tool.called:erp.finance.get_receivables_aging");
  }
  if (missing.length) {
    throw new Error(`associate_plan_audit_evidence_incomplete: ${missing.join(", ")}`);
  }
}

function findExecutableNode(run, selectedNodeId = "") {
  const nodes = Array.isArray(run?.plan?.nodes) ? run.plan.nodes : [];
  const eligibleNodes = nodes.filter(
    (item) =>
      item?.write_intent?.action_type === ASSOCIATE_WRITE_ACTION &&
      !item?.write_action,
  );
  if (selectedNodeId) {
    const selected = eligibleNodes.find((item) => item?.id === selectedNodeId);
    if (!selected?.id) {
      throw new Error(
        `associate_node_id_not_eligible: ${formatForOutput(summarizeRun(run ?? {}))}`,
      );
    }
    return selected;
  }
  if (eligibleNodes.length > 1) {
    throw new Error(
      "associate_node_id_required: set ANNA_LIVE_ASSOCIATE_NODE_ID for multiple write-intent nodes",
    );
  }
  const node = eligibleNodes[0];
  if (!node?.id) {
    throw new Error(
      `associate_write_intent_missing: ${formatForOutput(summarizeRun(run ?? {}))}`,
    );
  }
  return node;
}

function approvalIdForNode(run, nodeId) {
  const nodes = Array.isArray(run?.plan?.nodes) ? run.plan.nodes : [];
  const node = nodes.find((item) => item?.id === nodeId);
  if (!node?.approval?.id || node.approval.status !== "pending") {
    throw new Error(
      `associate_approval_not_ready: ${formatForOutput(summarizeRun(run ?? {}))}`,
    );
  }
  return node.approval.id;
}

function requireVerifiedNode(run, nodeId, redactions = []) {
  const nodes = Array.isArray(run?.plan?.nodes) ? run.plan.nodes : [];
  const node = nodes.find((item) => item?.id === nodeId);
  const summary = summarizeNodeExecution(run ?? {}, node ?? {});
  if (!node?.write_action || node.approval?.status !== "approved") {
    throw new Error(`associate_execution_incomplete: ${formatForOutput(summary, redactions)}`);
  }
  if (node.write_action.verify_status !== "verified" || node.status !== "completed") {
    throw new Error(
      `associate_readback_not_verified: ${formatForOutput(summary, redactions)}`,
    );
  }
  if (!node.write_action.external_task_id || !node.write_action.external_status) {
    throw new Error(`associate_execution_evidence_incomplete: ${formatForOutput(summary)}`);
  }
  return node;
}

function assertAuditEvidence(run) {
  const events = auditEvents(run);
  const eventTypes = new Set(events.map((event) => event.type));
  const successfulToolNames = successfulAuditTools(events);
  const missing = [];
  for (const eventType of [
    "skill.loaded",
    "model.call.started",
    "model.call.completed",
    "associate.plan.emitted",
    "associate.node.approval.requested",
    "associate.node.approval.approved",
    "associate.node.verified",
  ]) {
    if (!eventTypes.has(eventType)) {
      missing.push(eventType);
    }
  }
  for (const toolName of [
    "erp.finance.get_receivables_aging",
    "erp.collection_task.create_draft",
    "erp.collection_task.get_status",
  ]) {
    if (!successfulToolNames.has(toolName)) {
      missing.push(`mcp.tool.called:${toolName}`);
    }
  }
  if (missing.length) {
    throw new Error(`associate_audit_evidence_incomplete: ${missing.join(", ")}`);
  }
}

function auditEvents(run) {
  return Array.isArray(run?.audit_events)
    ? run.audit_events.filter((event) => event && typeof event.type === "string")
    : [];
}

function successfulAuditTools(events) {
  return new Set(
    events
      .filter(
        (event) =>
          event.type === "mcp.tool.called" &&
          event.payload?.status === "success" &&
          typeof event.payload.tool_name === "string",
      )
      .map((event) => event.payload.tool_name),
  );
}

function summarizeRun(run) {
  return {
    run_id: run?.id ?? null,
    status: run?.status ?? null,
    node_count: Array.isArray(run?.plan?.nodes) ? run.plan.nodes.length : 0,
  };
}

function summarizeNodeExecution(run, node) {
  return {
    run_id: run?.id ?? null,
    node_id: node?.id ?? null,
    approval_id: node?.approval?.id ?? null,
    write_action_id: node?.write_action?.id ?? null,
    status: node?.status ?? null,
    verify_status: node?.write_action?.verify_status ?? null,
    external_task_id: node?.write_action?.external_task_id ?? null,
    external_status: node?.write_action?.external_status ?? null,
  };
}

async function requestJson(apiBase, path, init = {}, redactions = []) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (!response.ok) {
        throw new Error(
          `request_failed: ${response.status} ${formatForOutput(text, redactions)}`,
        );
      }
      throw new Error(
        `response_not_json: ${response.status} ${formatForOutput(text, redactions)}`,
      );
    }
  }
  if (!response.ok) {
    throw new Error(
      `request_failed: ${response.status} ${formatForOutput(body ?? text, redactions)}`,
    );
  }
  return body;
}

function normalizeSession(session) {
  if (
    !session ||
    typeof session !== "object" ||
    !isValidSessionText(session.workspace_id) ||
    !isValidSessionText(session.user_id)
  ) {
    throw new Error("session_identity_invalid: workspace_id and user_id are required");
  }
  return {
    ...session,
    workspace_id: session.workspace_id.trim(),
    user_id: session.user_id.trim(),
  };
}

function sessionHeaders(session) {
  return {
    "X-Anna-Workspace-ID": session.workspace_id,
    "X-Anna-User-ID": session.user_id,
  };
}

function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function resolveApiBase(options = {}) {
  return (
    options.apiBase ??
    process.env.ANNA_API_BASE ??
    apiBaseFromRuntimeInfo(
      options.runtimeInfoPath ??
        process.env.ANNA_RUNTIME_INFO_PATH ??
        defaultRuntimeInfoPath(),
    ) ??
    DEFAULT_API_BASE
  );
}

function apiBaseFromRuntimeInfo(runtimeInfoPath) {
  if (!runtimeInfoPath || !existsSync(runtimeInfoPath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(runtimeInfoPath, "utf8"));
  } catch {
    throw new Error("runtime_info_invalid: runtime info must be valid JSON");
  }
  if (!parsed || typeof parsed.apiBase !== "string" || !parsed.apiBase.trim()) {
    throw new Error("runtime_info_invalid: apiBase is required");
  }
  return parsed.apiBase;
}

function isValidSessionText(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function formatForOutput(value, redactions = []) {
  return JSON.stringify(redactForOutput(value, redactions));
}

function redactForOutput(value, redactions = [], parentKey = "") {
  if (Array.isArray(value)) {
    return `[redacted-array:${value.length}]`;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => isSafeDiagnosticKey(key))
        .map(([key, item]) => [
          key,
          isSensitiveKey(key)
            ? "[redacted]"
            : redactForOutput(item, redactions, key),
        ]),
    );
  }
  if (typeof value === "string") {
    if (/^(message|detail)$/i.test(parentKey)) {
      return "[redacted-message]";
    }
    return redactOperatorInputs(value, redactions)
      .replace(
        /(api[_-]?key|apikey|access[_-]?token|accesstoken|client[_-]?secret|clientsecret|token|secret|password)=([^&\s]+)/gi,
        "$1=[redacted]",
      )
      .replace(
        /(api[_-]?key|apikey|access[_-]?token|accesstoken|client[_-]?secret|clientsecret|token|secret|password)\s*:\s*([^&\s]+)/gi,
        "$1: [redacted]",
      )
      .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]@")
      .replace(/(authorization:\s*bearer\s+)[^\s"',}]+/gi, "$1[redacted]")
      .replace(/(bearer\s+)[^\s"',}]+/gi, "$1[redacted]");
  }
  return value;
}

function isSafeDiagnosticKey(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /^(status|error|error_code|code|message|detail|retryable|writes_external_data)$/.test(
    normalized,
  );
}

function redactOperatorInputs(value, redactions = []) {
  return redactions.reduce((current, redaction) => {
    const text = String(redaction ?? "");
    if (!text) {
      return current;
    }
    return current.split(text).join("[redacted-input]");
  }, value);
}

function isSensitiveKey(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /(^|[_-])(api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password|authorization|credential|bearer)($|[_-])/i.test(
    normalized,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveAssociateE2E()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
