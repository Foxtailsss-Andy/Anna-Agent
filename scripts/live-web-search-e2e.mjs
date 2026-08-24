import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const terminalTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
]);

export const requiredOperatorInputs = [
  "ANNA_WEB_SEARCH_LIVE_BACKEND_ORIGIN",
  "ANNA_WEB_SEARCH_LIVE_PROVIDER",
  "ANNA_WEB_SEARCH_LIVE_WORKSPACE_ID",
  "ANNA_WEB_SEARCH_LIVE_CHANNEL_ID",
  "ANNA_WEB_SEARCH_LIVE_QUERY",
  "ANNA_WEB_SEARCH_LIVE_EVIDENCE_DIR",
];

export function missingOperatorInputs(env) {
  return requiredOperatorInputs.filter((name) => !String(env[name] ?? "").trim());
}

export function summarizeWebSearchRun(events, provider) {
  const toolEvents = events.filter((event) =>
    event.type === "run.tool.completed"
    && record(event.payload)?.tool === "web_search",
  );
  const terminal = events.findLast((event) => terminalTypes.has(event.type))?.type;
  const sequence = events.map((event) => event.seq);
  const evalPassed = events.some((event) =>
    event.type === "run.eval.contract" && record(event.payload)?.passed === true,
  );
  const webSearchFailures = toolEvents.filter((event) =>
    record(event.payload)?.outcome === "failed",
  ).length;
  const createArtifactEvents = events.filter((event) => event.type === "create.artifact.created").length;
  const createValidationEvents = events.filter((event) => event.type === "create.artifact.validated").length;

  return {
    provider,
    eventCount: events.length,
    sequence,
    terminal: terminal ?? null,
    webSearchToolCalls: toolEvents.length,
    webSearchFailures,
    createArtifactEvents,
    createValidationEvents,
    evalPassed,
    evidenceSufficient: terminal === "run.completed"
      && sequence.every((seq, index) => seq === index)
      && toolEvents.length > 0
      && webSearchFailures === 0
      && createArtifactEvents > 0
      && createValidationEvents > 0
      && evalPassed,
    eventIndex: events.map(redactedEventIndex),
  };
}

function redactedEventIndex(event) {
  const payload = record(event.payload);
  return {
    seq: event.seq,
    type: event.type,
    ...(typeof payload?.tool === "string" ? { tool: payload.tool } : {}),
    ...(typeof payload?.outcome === "string" ? { outcome: payload.outcome } : {}),
  };
}

async function main() {
  const env = process.env;
  const missing = missingOperatorInputs(env);
  if (missing.length > 0) {
    return fail("web_search_live_operator_input_required", { missing });
  }

  const evidenceDir = resolve(env.ANNA_WEB_SEARCH_LIVE_EVIDENCE_DIR);
  try {
    await mkdir(evidenceDir, { recursive: true });
    if ((await readdir(evidenceDir)).length > 0) {
      return fail("web_search_live_evidence_dir_not_empty");
    }
  } catch {
    return fail("web_search_live_evidence_dir_unavailable");
  }

  const backendOrigin = env.ANNA_WEB_SEARCH_LIVE_BACKEND_ORIGIN.replace(/\/+$/, "");
  const workspaceId = env.ANNA_WEB_SEARCH_LIVE_WORKSPACE_ID;
  const channelId = env.ANNA_WEB_SEARCH_LIVE_CHANNEL_ID;
  const provider = env.ANNA_WEB_SEARCH_LIVE_PROVIDER;
  const query = env.ANNA_WEB_SEARCH_LIVE_QUERY.trim();
  const checks = {
    backend_healthy: false,
    create_available: false,
    web_search_available: false,
  };

  try {
    const health = await requestJson(`${backendOrigin}/health`);
    checks.backend_healthy = health?.status === "ok";
    const capabilities = await requestJson(`${backendOrigin}/capabilities`);
    checks.create_available = capabilities?.surfaces?.some(
      (surface) => surface.id === "create" && surface.status === "available",
    ) === true;
    checks.web_search_available = capabilities?.unsupported_capabilities?.web_search?.status === "available";
  } catch {
    return fail("web_search_live_backend_unreachable", {}, checks, evidenceDir);
  }
  await writeJson(evidenceDir, "preflight.json", {
    schemaVersion: 1,
    caseId: "web-search-live",
    evidenceMode: "live-preflight",
    provider,
    checks,
  });
  if (!checks.backend_healthy || !checks.create_available || !checks.web_search_available) {
    return fail("web_search_live_capability_not_ready", {}, checks, evidenceDir);
  }

  let runId;
  try {
    const started = await requestJson(`${backendOrigin}/v2/surfaces/create/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        channel_id: channelId,
        command_id: `web-search-live:${Date.now()}`,
        source_event_id: `web-search-live:source:${Date.now()}`,
        goal: `Use the configured web_search Tool exactly once for this query: ${query}. `
          + "Then create one valid Skill artifact named websearch_canary with the bounded result summary in its description. "
          + "Do not claim activation.",
      }),
    });
    runId = typeof started?.run_id === "string" ? started.run_id : undefined;
  } catch {
    return fail("web_search_live_run_start_failed", {}, checks, evidenceDir);
  }
  if (runId === undefined) return fail("web_search_live_run_id_missing", {}, checks, evidenceDir);

  const eventsUrl = `${backendOrigin}/v2/runs/${encodeURIComponent(runId)}/events`
    + `?workspace_id=${encodeURIComponent(workspaceId)}`
    + `&channel_id=${encodeURIComponent(channelId)}`;
  let events = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const body = await requestJson(eventsUrl);
      events = Array.isArray(body?.events) ? body.events : [];
    } catch {
      return fail("web_search_live_event_reader_failed", {}, checks, evidenceDir);
    }
    if (events.some((event) => terminalTypes.has(event.type))) break;
    await new Promise((wait) => setTimeout(wait, 500));
  }

  const summary = {
    schemaVersion: 1,
    caseId: "web-search-live",
    evidenceMode: "live",
    provider,
    runId,
    query: {
      sha256: createHash("sha256").update(query, "utf8").digest("hex"),
      length: query.length,
    },
    run: summarizeWebSearchRun(events, provider),
  };
  await writeJson(evidenceDir, "summary.json", summary);
  try {
    await finalizeEvidence(evidenceDir);
  } catch {
    process.stderr.write(JSON.stringify({ ok: false, code: "web_search_live_manifest_failed" }) + "\n");
    return 2;
  }
  if (!summary.run.evidenceSufficient) {
    process.stderr.write(JSON.stringify({ ok: false, code: "web_search_live_evidence_incomplete" }) + "\n");
    return 2;
  }
  process.stdout.write(JSON.stringify({ ok: true, code: "web_search_live_completed" }) + "\n");
  return 0;
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`request_failed:${response.status}`);
  return body;
}

async function fail(code, details = {}, checks, evidenceDir) {
  if (evidenceDir !== undefined) {
    await writeJson(evidenceDir, "failure.json", {
      schemaVersion: 1,
      caseId: "web-search-live",
      evidenceMode: "live-preflight",
      provider: process.env.ANNA_WEB_SEARCH_LIVE_PROVIDER ?? "unverified",
      ...(checks === undefined ? {} : { checks }),
      failure: { code, ...details },
    }).catch(() => {});
    await finalizeEvidence(evidenceDir).catch(() => {});
  }
  process.stderr.write(JSON.stringify({ ok: false, code, ...details }) + "\n");
  return 2;
}

async function writeJson(directory, name, value) {
  await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function finalizeEvidence(evidenceDir) {
  const env = {
    ...process.env,
    ANNA_EVIDENCE_CASE_ID: "web-search-live",
    ANNA_EVIDENCE_MODE: "live",
    ANNA_EVIDENCE_PROVIDER: process.env.ANNA_WEB_SEARCH_LIVE_PROVIDER ?? "unverified",
  };
  await execFileAsync(process.execPath, [
    join(repositoryRoot, "scripts", "build-evidence-manifest.mjs"),
    evidenceDir,
  ], { cwd: repositoryRoot, env });
  await execFileAsync(process.execPath, [
    join(repositoryRoot, "scripts", "verify-evidence-manifest.mjs"),
    join(evidenceDir, "manifest.json"),
  ], { cwd: repositoryRoot, env });
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write(JSON.stringify({ ok: false, code: "web_search_live_runner_failed" }) + "\n");
    process.exitCode = 2;
  });
}
