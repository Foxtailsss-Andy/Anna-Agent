import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { defaultRuntimeInfoPath } from "./runtime-info-path.mjs";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";

export async function runLiveCreateE2E(options = {}) {
  const apiBase = normalizeApiBase(resolveApiBase(options));
  const skillBrief = String(
    options.skillBrief ?? process.env.ANNA_LIVE_CREATE_SKILL_BRIEF ?? "",
  ).trim();
  const promptBrief = String(
    options.promptBrief ?? process.env.ANNA_LIVE_CREATE_PROMPT_BRIEF ?? "",
  ).trim();
  const pythonToolBrief = String(
    options.pythonToolBrief ?? process.env.ANNA_LIVE_CREATE_PYTHON_TOOL_BRIEF ?? "",
  ).trim();
  const allowCreateDrafts =
    options.allowCreateDrafts ?? process.env.ANNA_LIVE_CREATE_DRAFTS === "1";

  if (!skillBrief) {
    throw new Error("live_create_skill_brief_required: set ANNA_LIVE_CREATE_SKILL_BRIEF");
  }
  if (!promptBrief) {
    throw new Error("live_create_prompt_brief_required: set ANNA_LIVE_CREATE_PROMPT_BRIEF");
  }
  if (!pythonToolBrief) {
    throw new Error(
      "live_create_python_tool_brief_required: set ANNA_LIVE_CREATE_PYTHON_TOOL_BRIEF",
    );
  }
  if (!allowCreateDrafts) {
    throw new Error("live_create_drafts_not_enabled: set ANNA_LIVE_CREATE_DRAFTS=1");
  }
  const redactions = [skillBrief, promptBrief, pythonToolBrief];

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

  const sandboxProbe = await requestJson(
    apiBase,
    "/api/admin/sandbox/probe",
    { method: "POST" },
    redactions,
  );
  assertSandboxProbeReady(sandboxProbe, redactions);

  const session = normalizeSession(
    await requestJson(apiBase, "/api/session/current", {}, redactions),
  );
  const headers = sessionHeaders(session);
  const skill = await createDraft(apiBase, headers, session, {
    kind: "skill",
    prompt: skillBrief,
    redactions,
  });
  assertCreateEvidence(skill, "skill");

  const prompt = await createDraft(apiBase, headers, session, {
    kind: "prompt",
    prompt: promptBrief,
    redactions,
  });
  assertCreateEvidence(prompt, "prompt");

  const pythonTool = await createDraft(apiBase, headers, session, {
    kind: "python_tool",
    prompt: pythonToolBrief,
    redactions,
  });
  assertCreateEvidence(pythonTool, "python_tool");

  return {
    skill: summarizeSkill(skill),
    prompt: summarizePrompt(prompt),
    python_tool: summarizePythonTool(pythonTool),
  };
}

async function createDraft(apiBase, headers, session, { kind, prompt, redactions }) {
  return requestJson(
    apiBase,
    "/api/create/drafts",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: session.workspace_id,
        actor_user_id: session.user_id,
        kind,
        prompt,
      }),
    },
    redactions,
  );
}

function assertCreateEvidence(run, kind) {
  if (run?.kind !== kind || run.status !== "ready_for_review" || !run.artifact) {
    throw new Error(
      `create_${kind}_not_ready: ${formatForOutput(summarizeBase(run ?? {}))}`,
    );
  }
  if (run.validation?.valid !== true) {
    throw new Error(
      `create_${kind}_validation_failed: ${formatForOutput(summarizeBase(run ?? {}))}`,
    );
  }
  const events = auditEvents(run);
  const eventTypes = new Set(events.map((event) => event.type));
  const missing = [];
  for (const eventType of [
    `create.${kind}.run.created`,
    "model.call.started",
    "model.call.completed",
    `create.${kind}.generated`,
  ]) {
    if (!eventTypes.has(eventType)) {
      missing.push(eventType);
    }
  }
  if (kind === "python_tool") {
    if (!eventTypes.has("create.python_tool.fixture_ran")) {
      missing.push("create.python_tool.fixture_ran");
    }
    assertPythonSandboxEvidence(run, missing);
  } else if (!eventTypes.has(`create.${kind}.validated`)) {
    missing.push(`create.${kind}.validated`);
  }
  if (missing.length) {
    throw new Error(`create_${kind}_evidence_incomplete: ${missing.join(", ")}`);
  }
}

function assertSandboxProbeReady(probe, redactions = []) {
  const checks = Array.isArray(probe?.checks) ? probe.checks : [];
  const failedChecks = checks
    .filter((check) => check?.status !== "passed")
    .map((check) => String(check?.name || "unknown_check"));
  if (
    probe?.status !== "passed" ||
    probe?.writes_external_data !== false ||
    probe?.production_secrets_injected !== false ||
    probe?.preflight_policy !== "ast_import_and_side_effect_preflight" ||
    probe?.timeout_enforced !== true ||
    probe?.output_limited !== true ||
    failedChecks.length
  ) {
    throw new Error(
      `sandbox_probe_not_ready: ${formatForOutput(
        {
          status: probe?.status,
          writes_external_data: probe?.writes_external_data,
          error_code: failedChecks.join(",") || "sandbox_probe_failed",
        },
        redactions,
      )}`,
    );
  }
}

function assertPythonSandboxEvidence(run, missing) {
  const result = run?.sandbox_result;
  if (result?.passed !== true) {
    missing.push("sandbox_result.passed");
  }
  for (const key of [
    "preflight_policy",
    "timeout_seconds",
    "max_output_bytes",
    "env_allowlist",
    "secret_boundary",
  ]) {
    if (result?.[key] === undefined || result?.[key] === null) {
      missing.push(`sandbox_result.${key}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `create_python_tool_sandbox_evidence_incomplete: ${missing.join(", ")}`,
    );
  }
}

function auditEvents(run) {
  return Array.isArray(run?.audit_events)
    ? run.audit_events.filter((event) => event && typeof event.type === "string")
    : [];
}

function summarizeBase(run) {
  return {
    run_id: run?.id ?? null,
    status: run?.status ?? null,
    validation_valid: run?.validation?.valid ?? null,
  };
}

function summarizeSkill(run) {
  return {
    ...summarizeBase(run),
    skill_id: run?.artifact?.skill_id ?? null,
    allowed_tool_count: run?.validation?.allowed_tools?.length ?? 0,
    forbidden_tool_count: run?.validation?.forbidden_tools?.length ?? 0,
  };
}

function summarizePrompt(run) {
  return {
    ...summarizeBase(run),
    prompt_id: run?.artifact?.prompt_id ?? null,
  };
}

function summarizePythonTool(run) {
  const sandbox = run?.sandbox_result ?? {};
  return {
    ...summarizeBase(run),
    tool_id: run?.artifact?.tool_id ?? null,
    sandbox_passed: sandbox.passed === true,
    preflight_policy: sandbox.preflight_policy ?? null,
    timeout_seconds: sandbox.timeout_seconds ?? null,
    max_output_bytes: sandbox.max_output_bytes ?? null,
    env_allowlist: Array.isArray(sandbox.env_allowlist)
      ? sandbox.env_allowlist
      : [],
    secret_boundary: sandbox.secret_boundary ?? null,
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
  runLiveCreateE2E()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
