import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { defaultRuntimeInfoPath } from "./runtime-info-path.mjs";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";

export async function runLiveChatE2E(options = {}) {
  const apiBase = normalizeApiBase(resolveApiBase(options));
  const message = String(
    options.message ?? process.env.ANNA_LIVE_CHAT_MESSAGE ?? "",
  ).trim();
  const templateId = String(
    options.templateId ?? process.env.ANNA_LIVE_CHAT_TEMPLATE_ID ?? "summarize",
  ).trim();

  if (!message) {
    throw new Error("live_chat_message_required: set ANNA_LIVE_CHAT_MESSAGE");
  }
  const redactions = [message];

  const runtimeStatus = await requestJson(
    apiBase,
    "/api/admin/runtime/status",
    {},
    redactions,
  );
  if (runtimeStatus?.model?.configured !== true) {
    throw new Error(
      `model_not_configured: ${formatForOutput(
        {
          status: runtimeStatus?.model?.status,
          error_code: runtimeStatus?.model?.error_code ?? "model_not_configured",
          message: runtimeStatus?.model?.message,
        },
        redactions,
      )}`,
    );
  }

  const session = normalizeSession(
    await requestJson(apiBase, "/api/session/current", {}, redactions),
  );
  const headers = sessionHeaders(session);
  const templates = await requestJson(
    apiBase,
    "/api/chat/prompt-templates",
    { headers },
    redactions,
  );
  assertTemplateAvailable(templates, templateId);

  const run = await requestJson(
    apiBase,
    "/api/chat/runs",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: session.workspace_id,
        actor_user_id: session.user_id,
        message,
        template_id: templateId,
      }),
    },
    redactions,
  );
  assertChatRunEvidence(run, templateId);
  return summarizeChatRun(run);
}

function assertTemplateAvailable(response, templateId) {
  const templates = Array.isArray(response?.templates) ? response.templates : [];
  if (!templates.some((template) => template?.id === templateId)) {
    throw new Error(`chat_template_not_available: ${templateId}`);
  }
}

function assertChatRunEvidence(run, templateId) {
  if (run?.status !== "ready" || run.template_id !== templateId) {
    throw new Error(`chat_run_not_ready: ${formatForOutput(summarizeChatRun(run ?? {}))}`);
  }
  if (typeof run.assistant_message !== "string" || !run.assistant_message.trim()) {
    throw new Error(`chat_response_missing: ${formatForOutput(summarizeChatRun(run ?? {}))}`);
  }
  if (run.saved_memory_id) {
    throw new Error(`chat_result_was_saved: ${formatForOutput(summarizeChatRun(run))}`);
  }
  const events = auditEvents(run);
  const eventTypes = new Set(events.map((event) => event.type));
  const missing = [];
  for (const eventType of [
    "chat.run.created",
    "skill.loaded",
    "model.call.started",
    "model.call.completed",
    "chat.response.generated",
  ]) {
    if (!eventTypes.has(eventType)) {
      missing.push(eventType);
    }
  }
  const modelStarted = events.find((event) => event.type === "model.call.started");
  const modelCompleted = events.find((event) => event.type === "model.call.completed");
  const skillLoaded = events.find((event) => event.type === "skill.loaded");
  if (typeof skillLoaded?.payload?.skill_id !== "string" || !skillLoaded.payload.skill_id) {
    missing.push("skill.loaded:skill_id");
  }
  const toolNames = modelStarted?.payload?.tool_names;
  if (!Array.isArray(toolNames)) {
    missing.push("model.call.started:tool_names");
  }
  if ((modelCompleted?.payload?.tool_call_count ?? 0) !== 0) {
    throw new Error(
      `chat_model_tool_calls_detected: ${formatForOutput(
        { status: run.status, error_code: "tool_call_count_nonzero" },
      )}`,
    );
  }
  if (missing.length) {
    throw new Error(`chat_audit_evidence_incomplete: ${missing.join(", ")}`);
  }
}

function auditEvents(run) {
  return Array.isArray(run?.audit_events)
    ? run.audit_events.filter((event) => event && typeof event.type === "string")
    : [];
}

function summarizeChatRun(run) {
  const events = auditEvents(run);
  const skillLoaded = events.find((event) => event.type === "skill.loaded");
  const modelCompleted = events.find((event) => event.type === "model.call.completed");
  const toolCallCount = modelCompleted?.payload?.tool_call_count;
  return {
    run_id: run?.id ?? null,
    status: run?.status ?? null,
    template_id: run?.template_id ?? null,
    assistant_message_length:
      typeof run?.assistant_message === "string" ? run.assistant_message.length : 0,
    associate_goal_available:
      typeof run?.associate_goal_text === "string" && run.associate_goal_text.length > 0,
    saved_memory_id: run?.saved_memory_id ?? null,
    audit_event_types: [...new Set(events.map((event) => event.type))].sort(),
    audit_tool_call_count: typeof toolCallCount === "number" ? toolCallCount : null,
    audit_skill_id_present:
      typeof skillLoaded?.payload?.skill_id === "string"
      && skillLoaded.payload.skill_id.length > 0,
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
    if (/^(message|detail|assistant_message)$/i.test(parentKey)) {
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
  runLiveChatE2E()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
