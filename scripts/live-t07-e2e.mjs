import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const required = [
  "ANNA_T07_LIVE_SOURCE",
  "ANNA_T07_LIVE_HEAD",
  "ANNA_T07_LIVE_BACKEND_ORIGIN",
  "ANNA_T07_LIVE_OWNER_ID",
  "ANNA_T07_LIVE_PROVIDER",
  "ANNA_T07_LIVE_APPROVAL_ORIGIN",
  "ANNA_T07_LIVE_EVIDENCE_DIR",
];

function evidenceMetadata() {
  return {
    schemaVersion: 1,
    caseId: "t07-live",
    evidenceMode: "live-preflight",
    provider: process.env.ANNA_T07_LIVE_PROVIDER ?? "unverified",
    owner: process.env.ANNA_T07_LIVE_OWNER_ID ?? "unverified",
  };
}

async function writePreflight(evidenceDir, checks, failure) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, "preflight.json"),
    `${JSON.stringify({ ...evidenceMetadata(), checks, failure }, null, 2)}\n`,
    "utf8",
  );
}

async function finalizeEvidence(evidenceDir, evidenceMode = "live-preflight") {
  const root = resolve(process.cwd());
  const env = {
    ...process.env,
    ANNA_EVIDENCE_CASE_ID: "t07-live",
    ANNA_EVIDENCE_MODE: evidenceMode,
    ANNA_EVIDENCE_PROVIDER: process.env.ANNA_T07_LIVE_PROVIDER ?? "unverified",
    ANNA_EVIDENCE_GIT_HEAD: process.env.ANNA_T07_LIVE_HEAD ?? null,
  };
  await execFileAsync(process.execPath, [join(root, "scripts", "build-evidence-manifest.mjs"), evidenceDir], {
    cwd: root,
    env,
  });
  await execFileAsync(process.execPath, [join(root, "scripts", "verify-evidence-manifest.mjs"), join(evidenceDir, "manifest.json")], {
    cwd: root,
    env,
  });
}

async function fail(code, details = {}, checks = {}) {
  const configuredEvidenceDir = process.env.ANNA_T07_LIVE_EVIDENCE_DIR;
  const evidenceDir = configuredEvidenceDir === undefined
    ? undefined
    : resolve(configuredEvidenceDir);
  if (evidenceDir) {
    try {
      await writePreflight(evidenceDir, checks, { code, ...details });
      await finalizeEvidence(evidenceDir);
    } catch {
      // Keep the stable operator result even if evidence storage is unavailable.
    }
  }
  process.stderr.write(`${JSON.stringify({ ok: false, code, ...details })}\n`);
  return 2;
}

async function requestJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`request_failed:${response.status}`);
  return body;
}

async function main() {
  const missing = required.filter((name) => !String(process.env[name] ?? "").trim());
  if (missing.length > 0) return fail("t07_live_operator_input_required", { missing });
  if (process.platform !== "darwin") return fail("t07_live_macos_required", { platform: process.platform });

  const source = resolve(process.env.ANNA_T07_LIVE_SOURCE);
  const expectedHead = process.env.ANNA_T07_LIVE_HEAD;
  const backendOrigin = String(process.env.ANNA_T07_LIVE_BACKEND_ORIGIN).replace(/\/+$/, "");
  const approvalOrigin = String(process.env.ANNA_T07_LIVE_APPROVAL_ORIGIN).replace(/\/+$/, "");
  const evidenceDir = resolve(process.env.ANNA_T07_LIVE_EVIDENCE_DIR);
  const checks = {
    source_clean: false,
    head_matches: false,
    backend_healthy: false,
    provider_configured: false,
    review_gate_ready: false,
    owner_ready: false,
  };

  try {
    await access(source);
  } catch {
    return fail("t07_live_source_unavailable", {}, checks);
  }

  let status;
  let head;
  try {
    status = await execFileAsync("git", ["-C", source, "status", "--porcelain"]);
    head = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]);
  } catch {
    return fail("t07_live_source_not_git_repository", {}, checks);
  }
  if (status.stdout.trim() !== "") return fail("t07_live_source_not_clean", {}, checks);
  checks.source_clean = true;
  const actualHead = head.stdout.trim();
  checks.source_head = actualHead;
  if (actualHead !== expectedHead) return fail("t07_live_head_mismatch", { expectedHead, actualHead }, checks);
  checks.head_matches = true;

  let health;
  let runtime;
  let capabilities;
  let approval;
  try {
    health = await requestJson(`${backendOrigin}/api/health`);
    runtime = await requestJson(`${backendOrigin}/api/admin/runtime/status`);
    capabilities = await requestJson(`${backendOrigin}/api/harness/v2/capabilities`);
    approval = await requestJson(`${approvalOrigin}/status`);
  } catch {
    return fail("t07_live_backend_or_approval_origin_unreachable", {}, checks);
  }

  checks.backend_healthy = health?.status === "ok";
  checks.provider_configured = runtime?.model?.configured === true;
  checks.review_gate_ready = capabilities?.review_gate?.status === "ready";
  checks.owner_ready = approval?.status === "ready"
    && approval?.owner_id === process.env.ANNA_T07_LIVE_OWNER_ID
    && approval?.decision_endpoint === "ready"
    && approval?.durability === "durable";
  if (!checks.backend_healthy) {
    return fail("t07_live_backend_unhealthy", { health: { status: health?.status } }, checks);
  }
  if (!checks.provider_configured) {
    return fail("t07_live_provider_not_ready", {
      provider: process.env.ANNA_T07_LIVE_PROVIDER,
      runtime: { model: runtime?.model?.status, error_code: runtime?.model?.error_code },
    }, checks);
  }
  if (!checks.review_gate_ready) return fail("t07_live_review_bridge_not_ready", { review_gate: capabilities?.review_gate }, checks);
  if (!checks.owner_ready) {
    return fail("t07_live_owner_bridge_not_ready", {
      owner_id: process.env.ANNA_T07_LIVE_OWNER_ID,
      approval: {
        status: approval?.status,
        owner_id: approval?.owner_id,
        decision_endpoint: approval?.decision_endpoint,
        durability: approval?.durability,
      },
    }, checks);
  }

  try {
    await execFileAsync(
      "npm",
      ["run", "test", "--workspace=@anna/harness-v2", "--", "--run", "test/live-t07-production.test.ts"],
      {
        cwd: source,
        env: {
          ...process.env,
          ANNA_T07_LIVE_EVIDENCE_DIR: evidenceDir,
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    try {
      await finalizeEvidence(evidenceDir, "live");
    } catch {
      // Preserve the stable runner result even if evidence finalization fails.
    }
    process.stderr.write(`${JSON.stringify({ ok: false, code: "t07_live_real_runner_failed" })}\n`);
    return 2;
  }

  try {
    await finalizeEvidence(evidenceDir, "live");
    process.stdout.write(`${JSON.stringify({ ok: true, code: "t07_live_completed" })}\n`);
    return 0;
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, code: "t07_live_evidence_manifest_failed" })}\n`);
    return 2;
  }
}

main()
  .then((code) => {
    if (code !== undefined) process.exitCode = code;
  })
  .catch(() => {
    process.stderr.write(JSON.stringify({ ok: false, code: "t07_live_runner_failed" }) + "\n");
    process.exitCode = 2;
  });
