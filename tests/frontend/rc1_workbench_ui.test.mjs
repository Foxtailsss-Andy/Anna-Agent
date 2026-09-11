import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { test } from "node:test";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const python = join(repositoryRoot, ".venv/bin/python");
const ompRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
const businessScript = String.raw`
import os
import uvicorn
from services.api.app.main import create_app
from services.business.harness_client import HarnessHostClient
from services.business.mode import BusinessModeConfig
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account, Membership
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore

state_db = os.environ["RC1_STATE_DB"]
service_token = os.environ["RC1_BUSINESS_TOKEN"]
store = SQLiteIdentityStore(state_db)
seed_demo_workspace(store)
config = BusinessModeConfig(enabled=True, host_origin=os.environ["RC1_HOST_ORIGIN"], service_token=service_token)
host = HarnessHostClient(config)
application = create_app(product_mode=True, business_mode_config=config, harness_client=host, identity_service=IdentityService(store))
uvicorn.run(application, host="127.0.0.1", port=int(os.environ["RC1_BUSINESS_PORT"]), log_level="error")
`;

test("RC1 Workbench UI uses the real Host/OMP fixture for answer, continuation and target stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-rc1-ui-"));
  const businessPort = await freePort();
  const hostPort = await freePort();
  const providerPort = await freePort();
  const businessToken = "rc1-business-token";
  const configPath = join(directory, "runtime.json");
  await mkdir(join(directory, "workspace"), { recursive: true });
  const certificatePath = join(directory, "provider.crt");
  const keyPath = join(directory, "provider.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: `https://127.0.0.1:${providerPort}/v1/chat/completions`,
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: ompRoot,
  }), "utf8");
  const provider = await startProvider(providerPort, certificatePath, keyPath);
  const business = spawn(python, ["-c", businessScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RC1_STATE_DB: join(directory, "business.sqlite3"),
      RC1_BUSINESS_TOKEN: businessToken,
      RC1_HOST_ORIGIN: `http://127.0.0.1:${hostPort}`,
      RC1_BUSINESS_PORT: String(businessPort),
      ANNA_STATE_DB_PATH: join(directory, "business.sqlite3"),
      ANNA_MEMORY_DB_PATH: join(directory, "memory.sqlite3"),
      ANNA_RUNS_DB_PATH: join(directory, "runs.sqlite3"),
      ANNA_RUNTIME_CONFIG_PATH: join(directory, "business-runtime.json"),
      ANNA_CREATE_WORKSPACE_ROOT: join(directory, "create-runs"),
      ANNA_WORKDIRS_PATH: join(directory, "workdirs.json"),
      ANNA_MODEL_ENDPOINT: "",
      ANNA_MODEL_API_KEY: "",
      ANNA_MODEL_NAME: "fixture-model",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  let host = spawnProductHost({ directory, hostPort, businessPort, businessToken, configPath });
  let browser;
  try {
    await waitForHttp(`http://127.0.0.1:${businessPort}/api/health`);
    await waitForProcessLine(host, "status");
    const login = await fetch(`http://127.0.0.1:${businessPort}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "boss@anna.demo", password: "crew-demo" }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(({ sessionToken }) => {
      window.localStorage.setItem("anna.session.token", sessionToken);
    }, { sessionToken: token });
    await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: "networkidle" });
    try {
      await page.locator(".hcp__input").waitFor({ timeout: 30_000 });
    } catch (error) {
      throw new Error(`Home composer did not mount: ${(await page.locator("body").innerText()).slice(0, 600)}; ${error}`);
    }
    await page.locator(".hcp__plus").click();
    await page.getByRole("menuitem", { name: /技能/ }).click();
    await page.locator(".hcp__srow").first().click();
    await page.locator(".hcp__input").fill("请回答一个普通问题");
    await page.locator(".hcp__input").press("Enter");
    try {
      await page.locator(".ir-workbench-chat__answer").waitFor({ timeout: 30_000 });
    } catch (error) {
      const workbenchSnapshot = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/sessions`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.text()).catch((cause) => String(cause));
      const runId = (await page.locator("body").innerText()).match(/run ([0-9a-f-]{36})/)?.[1];
      const workbenchEvents = runId === undefined ? "" : await fetch(`http://127.0.0.1:${hostPort}/api/workbench/runs/${runId}/events`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.text()).catch((cause) => String(cause));
      throw new Error(`Workbench answer did not render: ${(await page.locator("body").innerText()).slice(0, 1200)}; provider requests=${provider.requestCount()}; snapshot=${workbenchSnapshot.slice(0, 2000)}; events=${workbenchEvents.slice(0, 2000)}; host stderr=${host.__rc1Stderr ?? ""}; ${error}`);
    }
    assert.match(await page.locator(".ir-workbench-chat__answer").textContent(), /UI fixture answer/);
    await page.locator(".ir-workbench-chat__capability").first().waitFor({ timeout: 10_000 });

    await page.locator(".hcp__input").fill("继续补充一个限制");
    await page.locator(".hcp__input").press("Enter");
    await page.waitForFunction(() => document.querySelector(".ir-workbench-chat__answer")?.textContent?.includes("UI fixture second answer"), undefined, { timeout: 30_000 });
    assert.equal(await page.locator(".ir-workbench-chat__answer").count(), 1);
    assert.match(await page.locator(".ir-workbench-chat__answer").textContent(), /UI fixture second answer/);
    assert.ok(provider.requestBodies().slice(1).some((body) => JSON.stringify(body.messages ?? []).includes("请回答一个普通问题")));

    await page.locator(".hcp__input").fill("UI target long run");
    await page.waitForFunction(() => !document.querySelector(".hcp__send")?.hasAttribute("disabled"));
    await page.locator(".hcp__send").click();
    await page.getByText("UI target long run", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "停止此 Run" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "停止此 Run" }).click();
    try {
      await page.getByText("已停止").waitFor({ timeout: 30_000 });
    } catch (error) {
      throw new Error(`Target stop did not project: ${(await page.locator("body").innerText()).slice(0, 1600)}; ${error}`);
    }

    await page.reload({ waitUntil: "networkidle" });
    const historyResponse = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/sessions`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(historyResponse.status, 200);
    assert.ok((await historyResponse.json()).sessions.length > 0);
    const historyItem = page.locator(".ir-side__group").filter({ hasText: "历史对话" }).locator("button").first();
    await historyItem.click();
    await page.getByText("已停止").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "新建任务" }).click();
    await page.getByRole("tab", { name: "Create" }).click();
    await page.locator(".hcp__input").fill("普通 Create 问题");
    await page.locator(".hcp__input").press("Enter");
    await page.locator(".ir-workbench-chat__answer").waitFor({ timeout: 30_000 });

    await page.getByRole("button", { name: "新建任务" }).click();
    await page.getByRole("tab", { name: "Create" }).click();
    assert.equal(await page.locator(".ir-home__create-kind").count(), 3);
    await page.locator(".ir-home__create-kind").evaluateAll((buttons) => buttons.map((button) => button.textContent));
    const showcase = await fetch(`http://127.0.0.1:${hostPort}/api/crew/showcase/ensure`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(showcase.status, 200);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("Crew", { exact: true }).click();
    const projectButton = page.getByRole("button", { name: "项目" });
    await projectButton.waitFor({ timeout: 10_000 });
    await projectButton.click();
    const projectRow = page.locator(".ir-side__subrow").first();
    await projectRow.waitFor({ timeout: 10_000 });
    await projectRow.click();
    await page.getByText("周会行动项闭环", { exact: false }).first().waitFor({ timeout: 10_000 });
    const crewInput = page.locator(".ir-chan-composer__input");
    await crewInput.waitFor({ timeout: 10_000 });
    const crewProjects = await fetch(`http://127.0.0.1:${hostPort}/api/crew/projects`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const crewProject = crewProjects.projects.find((project) => String(project.goal_text ?? "").includes("周会行动项闭环"));
    const crewProjectId = crewProject?.id;
    assert.ok(crewProjectId);
    provider.setCrewProjectId(crewProjectId);
    const sessionsBeforeCrewAsk = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/sessions`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    assert.ok(sessionsBeforeCrewAsk.sessions.every((session) => session.surface !== "crew" || session.project_id === crewProjectId));
    await crewInput.fill("请结合当前项目和频道事实回答一个普通问题");
    await crewInput.press("Enter");
    try {
      await page.locator(".ir-crew-workbench__answer").waitFor({ timeout: 30_000 });
    } catch (error) {
      throw new Error(`Crew Workbench answer did not render: ${(await page.locator("body").innerText()).slice(0, 1600)}; provider=${JSON.stringify(provider.requestBodies().map((body) => ({ last: [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content?.slice(0, 80), tools: (body.tools ?? []).map((tool) => tool.function?.name), roles: (body.messages ?? []).map((message) => message.role).slice(-5) }))).slice(0, 5000)}; ${error}`);
    }
    const crewRun = await waitForSessionRun(hostPort, token, "请结合当前项目和频道事实回答一个普通问题");
    assert.ok(crewRun?.run_id);
    const crewRunEvents = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/runs/${crewRun.run_id}/events`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const crewToolDispatches = (crewRunEvents.events ?? []).filter((event) => event.type === "omp.tool.dispatch").map((event) => event.tool_name);
    const crewToolResponses = (crewRunEvents.events ?? []).filter((event) => event.type === "omp.tool.response");
    assert.deepEqual(crewToolDispatches, ["capabilities.search", "capabilities.load", "crew.project.read", "crew.channel.read"]);
    assert.equal(crewToolResponses.length, crewToolDispatches.length);
    assert.ok(crewToolResponses.every((event) => event.tool_status === "succeeded"));
    const crewMessages = provider.requestBodies().flatMap((body) => body.messages ?? []);
    assert.ok(crewMessages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("capabilities__search")));
    assert.ok(crewMessages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("capabilities__load")));
    assert.ok(crewMessages.some((message) => message.role === "tool" && message.tool_call_id === "crew-project-1"));
    assert.ok(crewMessages.some((message) => message.role === "tool" && message.tool_call_id === "crew-channel-1"));
    assert.ok(provider.requestBodies().some((body) => (body.tools ?? []).some((tool) => /crew__project__read/.test(JSON.stringify(tool)))));
    assert.ok(provider.requestBodies().some((body) => (body.tools ?? []).some((tool) => /crew__channel__read/.test(JSON.stringify(tool)))));
    const projectFact = [...provider.requestBodies()].reverse().map((body) => toolOutput(body, "crew-project-1")).find((output) => output !== undefined);
    const channelFact = [...provider.requestBodies()].reverse().map((body) => toolOutput(body, "crew-channel-1")).find((output) => output !== undefined);
    assert.equal(projectFact?.project?.id, crewProjectId);
    assert.equal(projectFact?.project?.goal_text, crewProject?.goal_text);
    assert.equal(projectFact?.project?.workspace_id, crewProject?.workspace_id);
    assert.equal(projectFact?.project?.source, "showcase");
    assert.equal(channelFact?.project_id, crewProjectId);
    assert.equal(channelFact?.channel_id, `crew_channel:${crewProjectId}`);
    assert.ok(Array.isArray(channelFact?.channel_messages));
    assert.equal(channelFact.channel_messages.length, 10);
    assert.ok(channelFact.channel_messages.every((message) => message.project_id === crewProjectId));
    assert.ok(channelFact.channel_messages.every((message) => message.workspace_id === crewProject.workspace_id));
    const seededChannelMessage = channelFact.channel_messages.find((message) => String(message.body ?? "").includes("周会行动项闭环案例"));
    assert.ok(seededChannelMessage?.body);
    const crewMarker = `UI crew facts answer: ${projectFact.project.id} · ${projectFact.project.goal_text} · ${seededChannelMessage.body}`;
    assert.match(await page.locator(".ir-crew-workbench__answer").textContent(), new RegExp(escapeRegExp(crewMarker)));
    const crewSessions = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/sessions?project_id=${encodeURIComponent(crewProjectId)}`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    assert.ok(crewSessions.sessions.some((session) => session.project_id === crewProjectId));
    await page.getByText("Cowork", { exact: true }).click();
    await page.getByText("Hiker", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "普通对话" }).click();
    await page.waitForTimeout(200);
    await page.locator(".ir-copilot--open .acp__input").fill("UI target Hiker ordinary");
    await page.locator(".ir-copilot--open .acp__send").click();
    await page.getByText("UI target Hiker ordinary", { exact: true }).waitFor({ timeout: 10_000 });
    const hikerSession = await waitForSessionRun(hostPort, token, "UI target Hiker ordinary");
    assert.ok(hikerSession?.run_id);
    assert.ok(["queued", "running"].includes(await readRunStatus(hostPort, hikerSession.run_id, token)));
    await page.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "刷新" }).click();
    await page.getByRole("button", { name: "普通对话" }).click();
    await page.locator(".acp__stop").click();
    await waitForRunStatus(hostPort, hikerSession.run_id, token, "cancelled");

    const screenshotDirectory = process.env.RC1_UI_SCREENSHOT_DIR ?? directory;
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: join(screenshotDirectory, "rc1-workbench-chat.png"), fullPage: true });
    await stopProcess(host);
    await writeFile(configPath, JSON.stringify({
      model_provider: "openai-compatible",
      model_name: "fixture-model",
      model_api_key: "",
      model_endpoint: "",
      harness_v2_kernel: "omp",
      harness_v2_omp_runtime_root: ompRoot,
    }), "utf8");
    host = spawnProductHost({ directory, hostPort, businessPort, businessToken, configPath });
    await waitForProcessLine(host, "status");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".hcp__input").fill("请在未配置模型时诚实提示");
    await page.locator(".hcp__input").press("Enter");
    await page.getByText("模型尚未配置").waitFor({ timeout: 10_000 });
  } finally {
    await browser?.close();
    await stopProcess(host);
    await stopProcess(business);
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function spawnProductHost({ directory, hostPort, businessPort, businessToken, configPath }) {
  const child = spawn(process.execPath, [join(repositoryRoot, "apps/harness-service/dist/main.js")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ANNA_HARNESS_HOST: "127.0.0.1",
      ANNA_HARNESS_HOST_PORT: String(hostPort),
      ANNA_HARNESS_SERVICE_TOKEN: "rc1-host-token",
      ANNA_HARNESS_BUSINESS_ORIGIN: `http://127.0.0.1:${businessPort}`,
      ANNA_HARNESS_BUSINESS_SERVICE_TOKEN: businessToken,
      ANNA_HARNESS_HOST_CONFIG_PATH: configPath,
      ANNA_RUNTIME_CONFIG_PATH: configPath,
      ANNA_HARNESS_HOST_EVENT_STORE_PATH: join(directory, "events.sqlite"),
      ANNA_HARNESS_HOST_WORKSPACE_ROOT: join(directory, "workspace"),
      ANNA_HARNESS_HOST_STATIC_ROOT: join(repositoryRoot, "dist"),
      ANNA_HARNESS_SESSION_STORE_PATH: join(directory, "sessions.json"),
      ANNA_HARNESS_OMP_RUNTIME_ROOT: ompRoot,
      NODE_EXTRA_CA_CERTS: join(directory, "provider.crt"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.__rc1Stderr = "";
  child.stderr.on("data", (chunk) => { child.__rc1Stderr += String(chunk); });
  return child;
}

async function startProvider(port, certificatePath, keyPath) {
  const requests = new Set();
  const requestBodies = [];
  let requestCount = 0;
  let crewProjectId = "";
  let releaseTarget;
  const targetReleased = new Promise((resolvePromise) => { releaseTarget = resolvePromise; });
  const server = createHttpsServer({ cert: await readFile(certificatePath), key: await readFile(keyPath) }, async (request, response) => {
    requestCount += 1;
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requestBodies.push(body);
    const latest = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    const isTarget = String(latest?.content ?? "").includes("UI target");
    const isCrew = String(latest?.content ?? "").includes("当前项目和频道事实")
      || (body.tools ?? []).some((tool) => /crew__project__read|crew__channel__read/.test(JSON.stringify(tool)));
    if (isTarget) {
      requests.add(request);
      await Promise.race([targetReleased, new Promise((resolvePromise) => request.once("aborted", resolvePromise))]);
      requests.delete(request);
      if (request.aborted) return;
    }
    const hasProjectFact = (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === "crew-project-1");
    const hasChannelFact = (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === "crew-channel-1");
    const hasCapabilitySearch = (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === "crew-search-1");
    const hasCapabilityLoad = (body.messages ?? []).some((message) => message.role === "tool" && message.tool_call_id === "crew-load-1");
    if (isCrew && !hasCapabilitySearch) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "crew-search-1", type: "function", function: { name: "capabilities__search", arguments: JSON.stringify({ query: "crew project channel" }) } }] } }] }));
      return;
    }
    if (isCrew && !hasCapabilityLoad) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "crew-load-1", type: "function", function: { name: "capabilities__load", arguments: JSON.stringify({ ids: ["crew.project.read", "crew.channel.read"] }) } }] } }] }));
      return;
    }
    if (isCrew && !hasProjectFact) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "crew-project-1", type: "function", function: { name: "crew__project__read", arguments: JSON.stringify({ project_id: crewProjectId }) } }] } }] }));
      return;
    }
    if (isCrew && !hasChannelFact) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "crew-channel-1", type: "function", function: { name: "crew__channel__read", arguments: JSON.stringify({ project_id: crewProjectId }) } }] } }] }));
      return;
    }
    let answer;
    if (isCrew) {
      const projectFact = toolOutput(body, "crew-project-1");
      const channelFact = toolOutput(body, "crew-channel-1");
      const project = projectFact?.project;
      const seededMessage = channelFact?.channel_messages?.find((message) => String(message.body ?? "").includes("周会行动项闭环案例"));
      if (!project || typeof project.id !== "string" || typeof project.goal_text !== "string" || !seededMessage || typeof seededMessage.body !== "string") {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "fixture requires parsed Crew Gateway outputs" }));
        return;
      }
      answer = `UI crew facts answer: ${project.id} · ${project.goal_text} · ${seededMessage.body}`;
    } else {
      answer = String(latest?.content ?? "").includes("继续补充") ? "UI fixture second answer" : "UI fixture answer";
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer } }] }));
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolvePromise); });
  return { requestCount: () => requestCount, requestBodies: () => requestBodies, setCrewProjectId: (id) => { crewProjectId = id; }, close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())) };
}

function toolOutput(body, toolCallId) {
  const message = (body.messages ?? []).find((candidate) => candidate.role === "tool" && candidate.tool_call_id === toolCallId);
  if (!message || typeof message.content !== "string") return undefined;
  try {
    return JSON.parse(message.content);
  } catch {
    return undefined;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* process is binding */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function waitForProcessLine(child, token) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += String(chunk);
      const line = output.split("\n").find((candidate) => candidate.includes(token));
      if (line) { child.stdout.off("data", onData); resolvePromise(line); }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`Host exited before ready: ${code}`)));
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 4_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

async function readRunStatus(hostPort, runId, token) {
  const response = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } });
  return (await response.json()).status;
}

async function waitForRunStatus(hostPort, runId, token, expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await readRunStatus(hostPort, runId, token) === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Run ${runId} did not reach ${expected}`);
}

async function waitForSessionRun(hostPort, token, prompt) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await fetch(`http://127.0.0.1:${hostPort}/api/workbench/sessions`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
    const run = body.sessions.flatMap((session) => session.runs ?? []).find((candidate) => candidate.prompt === prompt);
    if (run) return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return undefined;
}
