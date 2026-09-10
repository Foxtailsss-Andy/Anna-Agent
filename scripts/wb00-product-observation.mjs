/**
 * WB-00 product observation.
 *
 * This is a baseline recorder, not a product test harness.  It starts the
 * real Node Product Host and its managed model-less Python business peer,
 * drives the original React UI with Playwright, and preserves honest failures
 * when the local runtime has no model or connector configuration.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createDesktopRuntime } from "../apps/desktop/electron/runtime-service.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_ROOT = path.join(ROOT, ".tmp-tests", "wb00", "product");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = path.join(EVIDENCE_ROOT, RUN_ID);
const REDACTED = "[redacted]";
const CREATE_PROMPT = "请回答一个普通问题：Anna 的工作台是什么？";
const CREW_PROMPT = "@Anna 当前项目的进展和下一步是什么？";
const EXPECTED_OMP_MANIFEST_SHA256 = "d3ff0284f9d7a4489d66e78fb5b1d3819471a59f4c9dcd01d0e118b6994a241d";

const evidence = {
  spec_version: "1.2",
  requirement_ids: ["R-01", "R-02", "R-17", "R-18", "R-19"],
  acceptance_ids: ["AC-18a"],
  wb_ticket: "WB-00",
  evaluation_baseline_id: `wb00-product-${RUN_ID}`,
  platform: `${process.platform}-${process.arch}`,
  source_sha: null,
  runtime: {},
  commands: [],
  scenarios: [],
  cleanup: { host_stopped: false, business_stopped: false, browser_closed: false },
};

let runtime;
let browser;
let userDataPath;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function safePostData(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed.password) parsed.password = REDACTED;
    if (parsed.api_key) parsed.api_key = REDACTED;
    if (parsed.model_api_key) parsed.model_api_key = REDACTED;
    return parsed;
  } catch {
    return String(value).slice(0, 1200).replaceAll("crew-demo", REDACTED);
  }
}

function recordScenario(scenario) {
  evidence.scenarios.push({
    observed_at: new Date().toISOString(),
    ...scenario,
  });
}

async function responseSummary(response, maxChars = 3500) {
  if (!response) return null;
  let body = null;
  try {
    const text = (await response.text()).slice(0, maxChars);
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (error) {
    body = { read_error: String(error) };
  }
  return { status: response.status(), url: new URL(response.url()).pathname, body };
}

function attachNetworkJournal(page) {
  const requests = [];
  const responses = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    requests.push({
      method: request.method(),
      path: url.pathname,
      query: url.search || null,
      body: safePostData(request.postData()),
    });
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    // A future provider-backed stream can remain open; do not consume stream
    // bodies here. The baseline's finite streams are captured explicitly.
    if (url.pathname.endsWith("/stream")) {
    responses.push({
        method: response.request().method(),
        request_body: safePostData(response.request().postData()),
        status: response.status(),
        path: url.pathname,
        body: "stream-not-consumed",
      });
      return;
    }
    const summary = await responseSummary(response, 2500);
    if (summary) {
      responses.push({
        method: response.request().method(),
        request_body: safePostData(response.request().postData()),
        status: summary.status,
        path: summary.url,
        body: summary.body,
      });
    }
  });
  return { requests, responses };
}

async function login(page) {
  await page.goto(`${runtime.apiBase}/`, { waitUntil: "domcontentloaded" });
  const login = page.getByRole("button", { name: "登录", exact: true });
  const home = page.getByRole("tab", { name: "Home", exact: true });
  await Promise.race([
    login.waitFor({ state: "visible", timeout: 10000 }),
    home.waitFor({ state: "visible", timeout: 10000 }),
  ]).catch(() => {});
  if (await login.isVisible().catch(() => false)) {
    await login.click();
  }
  await home.waitFor({ state: "visible", timeout: 10000 });
}

async function activeTextarea(page, className) {
  const selector = className
    ? `textarea.${className}`
    : ".ir-shell__page:not(.ir-shell__page--hidden) textarea";
  return page.locator(selector).first();
}

async function capture(page, fileName) {
  const target = path.join(OUTPUT_DIR, fileName);
  await page.screenshot({ path: target, fullPage: true });
  return path.relative(ROOT, target);
}

async function runCreateObservation(page, journal) {
  await page.getByRole("tab", { name: "Create", exact: true }).click();
  const textarea = await activeTextarea(page);
  await textarea.fill(CREATE_PROMPT);
  const streamResponsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/create/runs/stream",
    { timeout: 10000 },
  ).catch(() => null);
  await textarea.press("Enter");
  const streamResponse = await streamResponsePromise;
  let streamBody = null;
  if (streamResponse) {
    try {
      streamBody = (await streamResponse.text()).slice(0, 5000);
    } catch (error) {
      streamBody = `stream_read_error: ${String(error)}`;
    }
  }
  await page.waitForTimeout(1200);
  const request = journal.requests.find(
    (item) => item.method === "POST" && item.path === "/api/create/runs/stream",
  );
  const response = streamResponse
    ? { status: streamResponse.status(), path: "/api/create/runs/stream", body: streamBody }
    : journal.responses.find((item) => item.path === "/api/create/runs/stream");
  const screenshot = await capture(page, "home-create-default-skill.png");
  const defaultKind = request?.body?.kind ?? null;
  recordScenario({
    id: "home-create-default-kind",
    case_id: "OBS-CREATE-DEFAULT-KIND",
    evidence_modes: ["D"],
    status: defaultKind === "skill" ? "fail" : "blocked",
    expected_outcome: "Home/Create ordinary input should not be forced to a Create kind.",
    actual_outcome: defaultKind === "skill"
      ? "Original React Create composer sent an ordinary prompt with kind=skill; the finite SSE receipt is preserved below."
      : "Create request was not observed.",
    request,
    response,
    screenshot,
    blocking_reason: defaultKind === "skill" ? "Observed current baseline behavior; AC-01/02 capability gap belongs to WB-02/03." : "ui_request_not_observed",
  });
}

async function runCrewObservation(page, journal) {
  await page.getByRole("tab", { name: "Crew", exact: true }).click();
  await page.waitForTimeout(900);
  const openShowcase = page.getByRole("button", { name: "打开完整案例", exact: true });
  if (await openShowcase.count()) await openShowcase.click();
  await page.getByText("项目频道", { exact: true }).waitFor({ state: "visible", timeout: 12000 });
  const projectRequest = journal.requests.find(
    (item) => item.method === "POST" && item.path === "/api/crew/showcase/ensure",
  );
  const projectResponse = journal.responses.find((item) => item.path === "/api/crew/showcase/ensure");
  const projectId = projectResponse?.body?.project?.id
    ?? journal.requests.find((item) => item.path.startsWith("/api/crew/projects/") && item.path.endsWith("/channel"))?.path.split("/")[4]
    ?? null;
  const textarea = page.locator("textarea.ir-chan-composer__input").first();
  await textarea.fill(CREW_PROMPT);
  await textarea.press("Escape");
  await textarea.press("Enter");
  await page.waitForTimeout(1400);
  const channelRequest = journal.requests.find(
    (item) => item.method === "POST" && item.path.match(/^\/api\/crew\/projects\/[^/]+\/channel$/),
  );
  const channelResponse = journal.responses.find(
    (item) => item.method === "POST"
      && item.path.match(/^\/api\/crew\/projects\/[^/]+\/channel$/)
      && item.status === 200,
  );
  const screenshot = await capture(page, "crew-project-context-entry.png");
  recordScenario({
    id: "crew-project-context-entry",
    case_id: "L-04",
    evidence_modes: ["D"],
    status: channelRequest && channelResponse ? "blocked" : "not_run",
    expected_outcome: "Crew project question should append to the same project channel and use project context.",
    actual_outcome: channelRequest && channelResponse
      ? "UI appended @Anna question through the real channel API; contextual Host answer could not be produced without a model."
      : "Crew contextual question was not observed.",
    project_id: projectId,
    project_request: projectRequest,
    project_response: projectResponse,
    channel_request: channelRequest,
    channel_response: channelResponse,
    screenshot,
    blocking_reason: channelRequest && channelResponse ? "EXT-PROVIDER: model_not_configured; no model output fabricated." : "crew_channel_request_not_observed",
  });
}

async function runCoworkObservation(page, journal) {
  await page.getByRole("tab", { name: "Cowork", exact: true }).click();
  await page.waitForTimeout(1400);
  const request = journal.requests.find(
    (item) => item.method === "POST" && item.path === "/api/cowork/hiker/dashboard/runs",
  );
  const response = journal.responses.find(
    (item) => item.method === "POST" && item.path === "/api/cowork/hiker/dashboard/runs",
  );
  const screenshot = await capture(page, "cowork-hiker-read.png");
  const businessHealth = await fetch(`${runtime.businessApiBase}/api/health`)
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
    .catch((error) => ({ error: String(error) }));
  const succeeded = response?.status === 200 && response.body?.status !== "failed";
  recordScenario({
    id: "cowork-board-independent-business-read",
    case_id: "L-06",
    evidence_modes: ["D"],
    status: succeeded ? "pass" : "blocked",
    expected_outcome: "Cowork Hiker local read completes independently of an Agent run, or exposes a real failure.",
    actual_outcome: succeeded
      ? "The Hiker dashboard read returned a non-failed snapshot."
      : `The Hiker dashboard request reached the real business adapter and returned ${response?.body?.status ?? "no response"}; no connector output was invented.`,
    request,
    response,
    business_health: businessHealth,
    screenshot,
    blocking_reason: succeeded ? null : "EXT-MCP-READ: Hiker connector is not configured in this baseline.",
  });
}

async function runRunningBehaviorObservation(page, journal) {
  // There is no configured provider in this baseline, so a real running Run
  // cannot be produced. We still exercise the visible navigation after the
  // failed Create request and explicitly leave the running seam unclaimed.
  const before = journal.requests.length;
  const newTask = page.getByRole("button", { name: "新建任务", exact: true });
  if (!(await newTask.count()) || !(await newTask.isVisible().catch(() => false))) {
    recordScenario({
      id: "running-page-switch-and-new-session",
      case_id: "OBS-RUNNING-CONTINUITY",
      evidence_modes: ["D"],
      status: "not_run",
      expected_outcome: "A genuinely running Run should survive page switching and a second Session should remain independent.",
      actual_outcome: "No provider-backed running Run existed; the active Cowork sidebar also did not expose New Task.",
      request_count_before_new_task: before,
      request_count_after_new_task: journal.requests.length,
      blocking_reason: "EXT-PROVIDER: no configured model; running overlap and independent Session behavior are not_run.",
    });
    return;
  }
  await newTask.click();
  await page.waitForTimeout(350);
  const active = await activeTextarea(page);
  const visible = await active.isVisible().catch(() => false);
  recordScenario({
    id: "running-page-switch-and-new-session",
    case_id: "L-03",
    evidence_modes: ["D"],
    status: "not_run",
    expected_outcome: "A genuinely running Run should survive page switching and a second Session should remain independent.",
    actual_outcome: visible
      ? "After the failed baseline run, UI New Task returned to a fresh Home composer. No provider-backed running Run existed to test continuity."
      : "New Task composer was not observed.",
    request_count_before_new_task: before,
    request_count_after_new_task: journal.requests.length,
    blocking_reason: "EXT-PROVIDER: no configured model; running overlap and independent Session behavior are not_run.",
  });
}

async function ompManifestEvidence() {
  const manifestPath = path.join(ROOT, "build", "omp-runtime", "darwin-arm64", "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return {
      path: manifestPath,
      declared_sha256: typeof manifest.sha256 === "string" ? manifest.sha256 : null,
      expected_sha256: EXPECTED_OMP_MANIFEST_SHA256,
      sha_match: manifest.sha256 === `sha256:${EXPECTED_OMP_MANIFEST_SHA256}`,
      schema_version: manifest.schemaVersion ?? null,
      file_count: Array.isArray(manifest.files) ? manifest.files.length : null,
      worker_execution_attempted: false,
    };
  } catch (error) {
    return { path: manifestPath, error: String(error), worker_execution_attempted: false };
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  evidence.source_sha = commandOutput("git", ["rev-parse", "HEAD"]);
  evidence.dirty_diff_digest = sha256(commandOutput("git", ["diff", "--no-ext-diff", "--binary"]) ?? "unavailable");
  evidence.commands.push("node scripts/wb00-product-observation.mjs");
  evidence.commands.push("real Node Product Host + managed Python business peer (createDesktopRuntime)");
  evidence.commands.push("Playwright Chromium headless original React UI");

  userDataPath = await mkdtemp(path.join(os.tmpdir(), "anna-wb00-product-"));
  // Keep launch state isolated from any desktop or legacy runtime variables.
  // The launcher creates host/business config, event store, and workspace under
  // this fresh userDataPath; only interpreter lookup and basic OS locale are
  // inherited.
  const env = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      ANNA_PYTHON_BIN: path.join(ROOT, ".venv", "bin", "python"),
      ANNA_HARNESS_BUSINESS_ENABLED: "1",
    }).filter(([, value]) => value !== undefined),
  );
  runtime = await createDesktopRuntime({
    projectRoot: ROOT,
    userDataPath,
    env,
    stdio: "pipe",
    healthTimeoutMs: 30000,
  });
  evidence.runtime = {
    host: runtime.apiBase,
    business: runtime.businessApiBase,
    host_pid: runtime.child?.pid ?? null,
    business_pid: runtime.businessChild?.pid ?? null,
    omp_runtime_root: runtime.ompRuntimeRoot,
    host_config_path: runtime.hostConfigPath,
    business_config_path: runtime.businessConfigPath,
    model_status: (await fetch(`${runtime.apiBase}/api/admin/runtime/status`).then((response) => response.json())).model,
    business_health: await fetch(`${runtime.businessApiBase}/api/health`).then((response) => response.json()),
    omp_manifest: await ompManifestEvidence(),
  };

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const journal = attachNetworkJournal(page);
  await login(page);
  await runCreateObservation(page, journal);
  await runCrewObservation(page, journal);
  await runCoworkObservation(page, journal);
  await runRunningBehaviorObservation(page, journal);
  evidence.network = {
    request_count: journal.requests.length,
    relevant_requests: journal.requests.filter((request) =>
      request.path.includes("/create/")
      || request.path.includes("/crew/")
      || request.path.includes("/cowork/")),
  };
  await writeFile(path.join(OUTPUT_DIR, "observation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "recorded", observation: path.join(OUTPUT_DIR, "observation.json"), scenarios: evidence.scenarios.map((item) => ({ id: item.id, status: item.status })) }, null, 2));
}

try {
  await main();
} catch (error) {
  evidence.fatal_error = String(error?.stack ?? error);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, "observation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close().catch(() => {});
    evidence.cleanup.browser_closed = true;
  }
  if (runtime) {
    const hostPid = runtime.child?.pid;
    const businessPid = runtime.businessChild?.pid;
    await runtime.stop().catch(() => {});
    const exited = (child) => !child || (
      (child.exitCode !== undefined && child.exitCode !== null)
      || (child.signalCode !== undefined && child.signalCode !== null)
    );
    evidence.cleanup.host_stopped = !hostPid || exited(runtime.child);
    evidence.cleanup.business_stopped = !businessPid || exited(runtime.businessChild);
  }
  if (userDataPath) await rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  // The evidence file is written again after cleanup so process state is clear.
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, "observation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => {});
}
