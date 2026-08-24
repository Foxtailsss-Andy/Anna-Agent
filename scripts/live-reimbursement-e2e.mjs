import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { defaultRuntimeInfoPath } from "./runtime-info-path.mjs";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";

export async function runLiveReimbursementE2E(options = {}) {
  const apiBase = normalizeApiBase(resolveApiBase(options));
  const inputText = String(
    options.inputText ?? process.env.ANNA_LIVE_REIMBURSEMENT_INPUT ?? "",
  ).trim();
  const allowExternalWrites =
    options.allowExternalWrites ?? process.env.ANNA_LIVE_ALLOW_EXTERNAL_WRITES === "1";

  if (!inputText) {
    throw new Error("live_input_required: set ANNA_LIVE_REIMBURSEMENT_INPUT");
  }

  const validation = await requestJson(apiBase, "/api/admin/runtime/validate", {
    method: "POST",
  });
  if (validation.status !== "ready") {
    throw new Error(
      `runtime_not_ready: ${formatForOutput(validation)}`,
    );
  }
  if (validation.writes_external_data !== false) {
    throw new Error(
      `runtime_validation_not_read_only: ${formatForOutput({
        writes_external_data: validation.writes_external_data,
      })}`,
    );
  }
  if (!allowExternalWrites) {
    throw new Error(
      "external_writes_not_enabled: set ANNA_LIVE_ALLOW_EXTERNAL_WRITES=1",
    );
  }

  const session = normalizeSession(await requestJson(apiBase, "/api/session/current"));
  const headers = sessionHeaders(session);
  const importedAttachments = await importAttachmentPaths(
    apiBase,
    headers,
    attachmentPathsFromOptions(options),
  );
  const created = await requestJson(apiBase, "/api/cowork/reimbursements/runs", {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspace_id: session.workspace_id,
      actor_user_id: session.user_id,
      input_text: inputText,
    }),
  });

  const readyRun = await satisfyMissingFields(apiBase, headers, created, {
    ...options,
    importedAttachments,
  });
  if (readyRun.missing_fields?.length) {
    throw new Error(
      `missing_fields_still_required: ${readyRun.missing_fields
        .map(redactFieldName)
        .join(", ")}`,
    );
  }
  if (readyRun.status !== "waiting_confirmation" || !readyRun.approval?.id) {
    throw new Error(
      `approval_not_ready: ${JSON.stringify(summarizeRun(readyRun))}`,
    );
  }

  const approved = await requestJson(
    apiBase,
    `/api/cowork/reimbursements/approvals/${encodeURIComponent(
      readyRun.approval.id,
    )}/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ approved_by: session.user_id }),
    },
  );
  if (approved.status !== "completed") {
    throw new Error(`submit_not_completed: ${JSON.stringify(summarizeRun(approved))}`);
  }
  assertSubmitEvidence(approved);
  const audit = await requestJson(
    apiBase,
    `/api/admin/audit/reimbursement/runs/${encodeURIComponent(approved.id)}`,
    { headers },
  );
  assertAuditEvidence(audit);
  return summarizeRun(approved);
}

async function satisfyMissingFields(apiBase, headers, run, options = {}) {
  if (!run.missing_fields?.length) {
    return run;
  }
  const answers = answersForRun(run, options);
  if (!answers) {
    throw new Error(
      `missing_fields_required: ${run.missing_fields.map(redactFieldName).join(", ")}`,
    );
  }
  return requestJson(apiBase, `/api/cowork/reimbursements/runs/${run.id}/answers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ answers }),
  });
}

async function importAttachmentPaths(apiBase, headers, attachmentPaths) {
  const files = readAttachmentFiles(attachmentPaths);
  const imported = [];
  for (const [index, file] of files.entries()) {
    const attachment = await requestJson(apiBase, "/api/cowork/reimbursements/attachments", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Anna-Attachment-Name": file.name,
      },
      body: file.content,
    });
    imported.push(validateImportedAttachment(attachment, index));
  }
  return imported;
}

function readAttachmentFiles(attachmentPaths) {
  return attachmentPaths.map((attachmentPath, index) => {
    const attachmentName = safeAttachmentOutputName(basename(attachmentPath));
    try {
      return {
        name: attachmentName,
        content: readFileSync(attachmentPath),
      };
    } catch (error) {
      throw new Error(`attachment_file_unreadable: attachment ${index + 1}`);
    }
  });
}

function validateImportedAttachment(attachment, index) {
  if (
    !attachment ||
    typeof attachment !== "object" ||
    typeof attachment.name !== "string" ||
    typeof attachment.uri !== "string" ||
    !attachment.uri.startsWith("anna://attachment/")
  ) {
    throw new Error(`attachment_import_invalid: attachment ${index + 1}`);
  }
  return attachment;
}

function attachmentPathsFromOptions(options = {}) {
  if (options.attachmentPaths !== undefined) {
    return validateAttachmentPaths(options.attachmentPaths);
  }
  const raw = process.env.ANNA_LIVE_REIMBURSEMENT_ATTACHMENT_PATHS_JSON;
  if (!raw) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("live_attachment_paths_invalid: paths must be valid JSON");
  }
  return validateAttachmentPaths(parsed);
}

function validateAttachmentPaths(paths) {
  if (!Array.isArray(paths)) {
    throw new Error("live_attachment_paths_invalid: paths must be a JSON array");
  }
  return paths.map((path) => {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("live_attachment_paths_invalid: each path must be a string");
    }
    return path.trim();
  });
}

function answersForRun(run, options = {}) {
  const answers = parseAnswers(options);
  const importedAttachments = options.importedAttachments ?? [];
  if (
    !run.missing_fields?.includes("attachments") ||
    !importedAttachments.length
  ) {
    return answers;
  }
  const merged = answers ? { ...answers } : {};
  if (
    merged.attachments !== undefined &&
    !Array.isArray(merged.attachments)
  ) {
    throw new Error("live_answers_invalid: attachments must be an array");
  }
  merged.attachments = [
    ...(merged.attachments ?? []),
    ...importedAttachments,
  ];
  return merged;
}

function parseAnswers(options = {}) {
  if (options.answers !== undefined) {
    return validateAnswers(options.answers);
  }
  const raw = process.env.ANNA_LIVE_REIMBURSEMENT_ANSWERS_JSON;
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("live_answers_invalid: answers must be valid JSON");
  }
  return validateAnswers(parsed);
}

function validateAnswers(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("live_answers_invalid: answers must be a JSON object");
  }
  return parsed;
}

function summarizeRun(run) {
  return {
    status: run.status,
    run_id: run.id,
    approval_id: run.approval?.id ?? null,
    write_action_id: run.write_action?.id ?? null,
    external_reimbursement_id: run.draft?.external_reimbursement_id ?? null,
    external_status: run.draft?.external_status ?? null,
    verify_status: run.write_action?.verify_status ?? null,
  };
}

async function requestJson(apiBase, path, init = {}) {
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
          `request_failed: ${response.status} ${formatForOutput(text)}`,
        );
      }
      throw new Error(
        `response_not_json: ${response.status} ${formatForOutput(text)}`,
      );
    }
  }
  if (!response.ok) {
    throw new Error(
      `request_failed: ${response.status} ${formatForOutput(body ?? text)}`,
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

function assertSubmitEvidence(run) {
  const summary = summarizeRun(run);
  const missing = [];
  if (!summary.approval_id) {
    missing.push("approval_id");
  }
  if (!summary.write_action_id) {
    missing.push("write_action_id");
  }
  if (!summary.external_reimbursement_id) {
    missing.push("external_reimbursement_id");
  }
  if (!summary.external_status) {
    missing.push("external_status");
  }
  if (summary.verify_status !== "verified") {
    missing.push("verify_status=verified");
  }
  if (missing.length) {
    throw new Error(
      `submit_evidence_incomplete: ${missing.join(", ")} ${JSON.stringify(summary)}`,
    );
  }
}

function assertAuditEvidence(audit) {
  const events = Array.isArray(audit?.audit_events) ? audit.audit_events : [];
  const eventTypes = new Set(
    events
      .map((event) => event?.type)
      .filter((type) => typeof type === "string"),
  );
  const successfulToolNames = new Set(
    events
      .filter(
        (event) =>
          event?.type === "mcp.tool.called" &&
          event?.payload?.status === "success" &&
          typeof event.payload.tool_name === "string",
      )
      .map((event) => event.payload.tool_name),
  );
  const missing = [];
  for (const eventType of [
    "skill.loaded",
    "model.call.started",
    "model.call.completed",
    "approval.approved",
    "reimbursement.submitted",
    "reimbursement.verified",
  ]) {
    if (!eventTypes.has(eventType)) {
      missing.push(eventType);
    }
  }
  for (const toolName of [
    "reimbursement.validate_draft",
    "reimbursement.create_draft",
    "reimbursement.submit",
    "reimbursement.get_status",
  ]) {
    if (!successfulToolNames.has(toolName)) {
      missing.push(`mcp.tool.called:${toolName}`);
    }
  }
  if (missing.length) {
    throw new Error(`audit_evidence_incomplete: ${missing.join(", ")}`);
  }
}

function isValidSessionText(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function formatForOutput(value) {
  return JSON.stringify(redactForOutput(value));
}

function redactForOutput(value) {
  if (Array.isArray(value)) {
    return value.map(redactForOutput);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[redacted]" : redactForOutput(item),
      ]),
    );
  }
  if (typeof value === "string") {
    return value
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

function redactFieldName(fieldName) {
  const text = String(fieldName);
  return isSensitiveKey(text) ? "[redacted-field]" : text;
}

function safeAttachmentOutputName(name) {
  const safeName = String(name || "attachment").replace(/[\u0000-\u001f\u007f]/g, "_");
  return safeName || "attachment";
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
  runLiveReimbursementE2E()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
