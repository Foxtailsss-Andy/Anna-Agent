/**
 * Home Workbench UI · real HomePage (composer + WorkbenchChatPanel + useWorkbenchSession) in Chromium
 * against a deterministic fake Product Host behind page.route (CONTRACTS §1). No model/provider calls.
 *
 * Covers F2: streaming live output before completion → persisted answer, prompt rendered once,
 * incremental events (after_seq) and polling that stops when nothing is active; steer while running
 * posts to /steer with accepted / not-accepted feedback; Goal mode creates the Goal, keeps polling
 * between Runs, follows the Host continuation Run and updates the card through confirmation;
 * the 执行过程 drawer reads the Workbench trace route; the contained-write toggle reaches the Run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import * as esbuild from "esbuild";
import { chromium } from "playwright";

const WRITE_LABEL = "允许 Anna 在此工作目录内修改文件并运行命令（沙箱）";
let bundled;

async function harnessScript() {
  if (bundled) return bundled.script;
  mkdirSync(join(process.cwd(), ".tmp-tests"), { recursive: true });
  const outDir = mkdtempSync(join(process.cwd(), ".tmp-tests", "anna-home-workbench-"));
  const outFile = join(outDir, "home.js");
  await esbuild.build({
    stdin: {
      contents: [
        'import React from "react";',
        'import { createRoot } from "react-dom/client";',
        'import { HomePage } from "./apps/desktop/src/pages/home/HomePage";',
        'createRoot(document.getElementById("root")).render(React.createElement(HomePage, { displayName: "测试用户" }));',
      ].join("\n"),
      resolveDir: process.cwd(),
      sourcefile: "HomeWorkbenchHarness.tsx",
      loader: "tsx",
    },
    outfile: outFile,
    bundle: true,
    platform: "browser",
    format: "iife",
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".woff2": "empty", ".woff": "empty" },
    define: { "import.meta.env.VITE_ANNA_API_BASE": '""', __APP_VERSION__: '"test"' },
    logLevel: "silent",
  });
  bundled = { outDir, script: readFileSync(outFile, "utf8") };
  return bundled.script;
}

after(() => {
  if (bundled) rmSync(bundled.outDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (second) => `2026-10-08T00:00:${String(second).padStart(2, "0")}.000Z`;

function userMessage(runId, content) {
  return { run_id: runId, event_id: `${runId}:prompt`, seq: -1, role: "user", content };
}
function assistantMessage(runId, content, seq) {
  return { run_id: runId, event_id: `${runId}:answer:${seq}`, seq, role: "assistant", content };
}
function event(runId, seq, type) {
  return { run_id: runId, event_id: `${runId}:e${seq}`, type, seq, timestamp: at(seq) };
}

/** Deterministic Product Host: tests mutate `state`; every request is recorded. */
function fakeHost() {
  const state = {
    runs: [],
    messages: [],
    events: {},
    goal: undefined,
    workdirs: [],
    requests: [],
    runPosts: [],
    steer: () => ({ status: 202, body: { run_id: "r1", status: "running", accepted: true } }),
    goalCreate: undefined,
    goalAction: undefined,
    trace: undefined,
    onRunPost: (body) => {
      state.runs.push({ run_id: "r1", session_id: "s1", prompt: body.prompt, status: "queued", permission_mode: body.permission_mode ?? "readonly", trigger: "user" });
      state.messages.push(userMessage("r1", body.prompt));
      return { status: 202, body: { run_id: "r1", session_id: "s1", status: "queued" } };
    },
  };
  const run = (runId) => state.runs.find((candidate) => candidate.run_id === runId);
  const session = () => ({
    session_id: "s1",
    surface: "chat",
    runs: state.runs,
    messages: state.messages,
    ...(state.goal === undefined ? {} : { goal: state.goal }),
  });
  async function handle({ method, path, query, body }) {
    if (path === "/api/workdirs" && method === "GET") return { body: { workdirs: state.workdirs } };
    if (/^\/api\/workdirs\/[^/]+\/touch$/.test(path)) return { body: state.workdirs[0] ?? {} };
    if (path === "/api/workbench/sessions" && method === "POST") return { status: 201, body: { session_id: "s1", surface: "chat", runs: [], messages: [] } };
    if (path === "/api/workbench/sessions/s1" && method === "GET") return { body: session() };
    if (path === "/api/workbench/sessions/s1/runs" && method === "POST") {
      state.runPosts.push(body);
      return state.onRunPost(body);
    }
    if (path === "/api/workbench/sessions/s1/goal" && method === "POST") return state.goalCreate(body);
    const goalAction = path.match(/^\/api\/workbench\/sessions\/s1\/goal\/(pause|resume|stop|complete)$/);
    if (goalAction && method === "POST") return state.goalAction(goalAction[1], body);
    const runAction = path.match(/^\/api\/workbench\/runs\/([^/]+)\/(events|steer|trace|stop)$/);
    if (runAction) {
      const [, runId, action] = runAction;
      if (action === "events") {
        const afterSeq = Number(query.get("after_seq") ?? "-1");
        return { body: { run_id: runId, events: (state.events[runId] ?? []).filter((item) => item.seq > afterSeq) } };
      }
      if (action === "steer") return state.steer(runId, body);
      if (action === "trace") return state.trace(runId);
      if (action === "stop") {
        Object.assign(run(runId), { status: "cancelled" });
        return { status: 202, body: { run_id: runId, status: "cancelled" } };
      }
    }
    return undefined;
  }
  return { state, run, handle };
}

async function mountHome(host) {
  const script = await harnessScript();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw = request.postData();
    const entry = { method: request.method(), path: url.pathname, query: url.searchParams, body: raw ? JSON.parse(raw) : undefined };
    host.state.requests.push(entry);
    const fulfill = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/session/current") {
      return fulfill(200, { workspace_id: "workspace-1", user_id: "user-1", role: "owner", user_display_name: "测试用户", source: "token" });
    }
    const reply = await host.handle(entry);
    if (reply) return fulfill(reply.status ?? 200, reply.body);
    return fulfill(404, { code: "not_mocked" });
  });
  await page.goto("http://localhost/", { waitUntil: "commit" });
  await page.addScriptTag({ content: script });
  await page.locator(".hcp__input").waitFor();
  return { browser, page };
}

async function send(page, text) {
  await page.locator(".hcp__input").fill(text);
  await page.locator(".hcp__input").press("Enter");
}

const sessionGets = (host) => host.state.requests.filter((r) => r.method === "GET" && r.path === "/api/workbench/sessions/s1").length;

async function runSubmitted(host, runId) {
  for (let attempt = 0; attempt < 100 && host.run(runId) === undefined; attempt += 1) await sleep(25);
  assert.ok(host.run(runId), `Run ${runId} was submitted`);
  return host.run(runId);
}

test("streamed text appears before completion, the persisted answer replaces it, and polling stops", async () => {
  const host = fakeHost();
  const { browser, page } = await mountHome(host);
  try {
    await send(page, "请总结这份周报");
    await runSubmitted(host, "r1");
    await page.locator(".ir-workbench-chat__message--user").filter({ hasText: "请总结这份周报" }).waitFor();
    Object.assign(host.run("r1"), {
      status: "running",
      live_output: { text: "第一段 **要点**", reasoning_chars: 0, request_index: 1, updated_at: at(1) },
    });
    host.state.events.r1 = [event("r1", 0, "run.queued"), event("r1", 1, "run.started")];

    const live = page.locator(".ir-workbench-chat__message--live");
    await live.filter({ hasText: "第一段" }).waitFor();
    assert.equal(await live.locator("strong").textContent(), "要点");
    assert.equal(await page.locator(".ir-workbench-chat__message--assistant:not(.ir-workbench-chat__message--live)").count(), 0);
    await page.locator(".ir-workbench-chat__status").filter({ hasText: "正在生成" }).waitFor();

    host.run("r1").live_output = { text: "第一段 **要点**，第二段继续", reasoning_chars: 0, request_index: 1, updated_at: at(2) };
    await live.filter({ hasText: "第二段继续" }).waitFor();

    const final = "第一段 **要点**，第二段继续。最终答案";
    Object.assign(host.run("r1"), { status: "completed", live_output: undefined });
    delete host.run("r1").live_output;
    host.state.messages.push(assistantMessage("r1", final, 2));
    host.state.events.r1.push(event("r1", 2, "omp.transcript.message"), event("r1", 3, "run.completed"));

    await page.locator(".ir-workbench-chat__message--assistant").filter({ hasText: "最终答案" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".ir-workbench-chat__message--live").length === 0);
    assert.equal(await page.locator(".ir-workbench-chat__message--user").count(), 1);
    assert.equal(await page.locator(".ir-workbench-chat__message--optimistic").count(), 0);
    await page.locator(".ir-workbench-chat__status").filter({ hasText: "已办妥" }).waitFor();

    const cursors = host.state.requests.filter((r) => r.path === "/api/workbench/runs/r1/events").map((r) => Number(r.query.get("after_seq")));
    assert.equal(cursors[0], -1, "first read starts from the beginning");
    assert.ok(cursors.includes(1), `later reads continue after the last seen seq: ${cursors.join(",")}`);
    assert.equal(host.state.runPosts.length, 1);
    assert.equal("permission_mode" in host.state.runPosts[0], false, "readonly is the Host default and is not sent");

    const before = sessionGets(host);
    await sleep(1300);
    assert.ok(sessionGets(host) - before <= 1, "no polling once the Run is terminal and no Goal is active");
  } finally {
    await browser.close();
  }
});

test("steer while running posts to /steer and reports accepted and not-accepted outcomes", async () => {
  const host = fakeHost();
  const steerBodies = [];
  const replies = [true, false];
  host.state.steer = (runId, body) => {
    steerBodies.push({ runId, body });
    return { status: 202, body: { run_id: runId, status: "running", accepted: replies.shift() } };
  };
  const { browser, page } = await mountHome(host);
  try {
    await send(page, "分析华东和华北的销售");
    await runSubmitted(host, "r1");
    await page.locator(".ir-workbench-chat__message--user").waitFor();
    Object.assign(host.run("r1"), {
      status: "running",
      live_output: { text: "", reasoning_chars: 180, request_index: 1, updated_at: at(1) },
    });
    await page.locator(".ir-workbench-chat__status").filter({ hasText: "思考中……" }).waitFor();

    const steerButton = page.getByRole("button", { name: "补充说明" });
    await page.locator(".hcp__input").fill("只看华东区");
    await steerButton.click();
    await page.getByText("补充说明已交给正在运行的这次任务。").waitFor();
    assert.equal(await page.locator(".hcp__input").inputValue(), "");

    await page.locator(".hcp__input").fill("再加上环比");
    await steerButton.click();
    await page.getByText(/补充说明没能进入/).waitFor();
    assert.equal(await page.locator(".hcp__input").inputValue(), "再加上环比", "the rejected text returns to the composer");

    assert.deepEqual(steerBodies, [
      { runId: "r1", body: { text: "只看华东区" } },
      { runId: "r1", body: { text: "再加上环比" } },
    ]);
    assert.equal(host.state.runPosts.length, 1, "steer never starts a new Run");
  } finally {
    await browser.close();
  }
});

test("goal mode creates the Goal, keeps polling between Runs, follows the continuation and confirms completion", async () => {
  const host = fakeHost();
  const objective = "完成竞品调研报告";
  const goal = (patch) => ({
    goal_id: "goal-1", objective, status: "active", max_runs: 3, runs_used: 1, run_ids: ["g1"],
    permission_mode: "readonly", created_at: at(0), updated_at: at(1), ...patch,
  });
  const goalBodies = [];
  host.state.goalCreate = (body) => {
    goalBodies.push(body);
    host.state.goal = goal({});
    host.state.runs.push({ run_id: "g1", session_id: "s1", prompt: objective, status: "running", permission_mode: "readonly", goal_id: "goal-1", trigger: "user" });
    host.state.messages.push(userMessage("g1", objective));
    return { status: 201, body: { goal: host.state.goal, run_id: "g1" } };
  };
  const actions = [];
  host.state.goalAction = (action) => {
    actions.push(action);
    host.state.goal = goal({ ...host.state.goal, status: "completed", updated_at: at(9) });
    return { body: { goal: host.state.goal } };
  };
  const { browser, page } = await mountHome(host);
  try {
    await page.getByLabel("目标模式", { exact: true }).check();
    await page.getByLabel("目标模式最多轮数").selectOption("3");
    await send(page, objective);

    const card = page.locator(".ir-workbench-chat__goal");
    await card.filter({ hasText: "第 1/3 轮" }).waitFor();
    await card.filter({ hasText: "进行中" }).waitFor();
    assert.equal(goalBodies.length, 1);
    assert.equal(goalBodies[0].objective, objective);
    assert.equal(goalBodies[0].max_runs, 3);
    assert.match(goalBodies[0].source_event_id, /^desktop:chat:goal:/);
    assert.equal(host.state.runPosts.length, 0, "goal mode does not submit a plain Run");
    assert.equal(await page.getByLabel("目标模式", { exact: true }).isChecked(), false, "the toggle resets after the Goal is created");

    // g1 ends with an incomplete plan; the Goal stays active before the Host starts g2.
    Object.assign(host.run("g1"), { status: "completed" });
    host.state.messages.push(assistantMessage("g1", "第一轮：完成了大纲", 4));
    host.state.events.g1 = [event("g1", 0, "run.started"), event("g1", 4, "run.completed")];
    host.state.goal = goal({ last_reason: "plan_incomplete", plan_progress: { completed: 1, total: 3 } });
    await page.locator(".ir-workbench-chat__message--assistant").filter({ hasText: "第一轮" }).waitFor();
    const idleStart = sessionGets(host);
    await sleep(1100);
    assert.ok(sessionGets(host) - idleStart >= 1, "the session is still polled while the Goal is active");

    host.state.runs.push({
      run_id: "g2", session_id: "s1", prompt: "【目标续跑 2/3】请继续完成计划中未完成的任务", status: "running",
      permission_mode: "readonly", goal_id: "goal-1", trigger: "goal_continuation",
      live_output: { text: "续跑：正在整理表格", reasoning_chars: 0, request_index: 1, updated_at: at(5) },
    });
    host.state.messages.push(userMessage("g2", "【目标续跑 2/3】请继续完成计划中未完成的任务"));
    host.state.goal = goal({ runs_used: 2, run_ids: ["g1", "g2"], last_reason: "plan_incomplete", plan_progress: { completed: 1, total: 3 } });

    await page.locator(".ir-home__runhead-id").filter({ hasText: "run g2" }).waitFor();
    await page.getByText("目标续跑 · Host 自动").waitFor();
    await page.locator(".ir-workbench-chat__message--live").filter({ hasText: "续跑：正在整理表格" }).waitFor();
    await card.filter({ hasText: "第 2/3 轮" }).waitFor();
    await card.filter({ hasText: "计划 1/3" }).waitFor();
    await card.filter({ hasText: "计划未完成，继续下一轮" }).waitFor();
    assert.equal(await page.locator(".ir-workbench-chat__message--user").count(), 1, "the continuation prompt is not shown as user input");
    const g2Cursors = host.state.requests.filter((r) => r.path === "/api/workbench/runs/g2/events").map((r) => Number(r.query.get("after_seq")));
    assert.equal(g2Cursors[0], -1, "events of the followed Run are read from its beginning");

    Object.assign(host.run("g2"), { status: "completed" });
    delete host.run("g2").live_output;
    host.state.messages.push(assistantMessage("g2", "报告已完成，请确认", 6));
    host.state.goal = goal({ status: "awaiting_review", runs_used: 2, run_ids: ["g1", "g2"], last_reason: "plan_complete", plan_progress: { completed: 3, total: 3 } });

    await card.filter({ hasText: "待你确认" }).waitFor();
    await card.filter({ hasText: "计划 3/3" }).waitFor();
    await card.getByRole("button", { name: "确认完成" }).click();
    await card.filter({ hasText: "已完成" }).waitFor();
    assert.deepEqual(actions, ["complete"]);
    assert.equal(await card.getByRole("button").count(), 0, "a completed Goal offers no actions");
  } finally {
    await browser.close();
  }
});

test("执行过程 opens the TraceDrawer with spans from the Workbench trace route", async () => {
  const host = fakeHost();
  host.state.onRunPost = (body) => {
    host.state.runs.push({ run_id: "r1", session_id: "s1", prompt: body.prompt, status: "completed", permission_mode: "readonly" });
    host.state.messages.push(userMessage("r1", body.prompt), assistantMessage("r1", "已读取文件并给出结论", 3));
    return { status: 202, body: { run_id: "r1", session_id: "s1", status: "queued" } };
  };
  const traceRuns = [];
  host.state.trace = (runId) => {
    traceRuns.push(runId);
    return {
      body: {
        trace_id: runId,
        surface: "chat",
        spans: [
          { span_id: "a", parent_span_id: null, name: "invoke_agent anna.chat", kind: "agent", start_time: at(0), end_time: at(4), duration_ms: 4000, status: "ok", attributes: {}, events: [] },
          { span_id: "t1", parent_span_id: "a", name: "turn 1", kind: "turn", start_time: at(0), end_time: at(4), duration_ms: 4000, status: "ok", attributes: {}, events: [] },
          { span_id: "i1", parent_span_id: "t1", name: "chat fixture-model", kind: "inference", start_time: at(0), end_time: at(2), duration_ms: 2000, status: "ok", attributes: {}, events: [] },
          { span_id: "x1", parent_span_id: "t1", name: "execute_tool workdir.read_file", kind: "tool", start_time: at(2), end_time: at(3), duration_ms: 1000, status: "ok", attributes: {}, events: [] },
        ],
      },
    };
  };
  const { browser, page } = await mountHome(host);
  try {
    await send(page, "读一下 notes.md");
    await page.locator(".ir-workbench-chat__message--assistant").filter({ hasText: "已读取文件" }).waitFor();
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "执行过程" });
    await drawer.locator(".trace-row").first().waitFor();
    assert.equal(await drawer.locator(".trace-row").count(), 2);
    assert.match(await drawer.textContent(), /execute_tool workdir\.read_file/);
    assert.equal(traceRuns[0], "r1");
    assert.equal(host.state.requests.some((r) => r.path.startsWith("/api/chat/runs/")), false, "the legacy chat trace route is not used for Workbench Runs");
    await drawer.getByRole("button", { name: "关闭" }).click();
    await page.waitForFunction(() => !document.querySelector(".trace-drawer"));
  } finally {
    await browser.close();
  }
});

test("the contained-write toggle appears only with a bound workdir and reaches the Run with its sandbox badge", async () => {
  const host = fakeHost();
  host.state.workdirs = [{ id: "wd-1", name: "报告目录", path: "/tmp/report" }];
  host.state.onRunPost = (body) => {
    host.state.runs.push({
      run_id: "r1", session_id: "s1", prompt: body.prompt, status: "running", permission_mode: body.permission_mode ?? "readonly",
      sandbox: { kind: "macos-seatbelt", network: "denied", writable_roots: ["/tmp/report"] },
      tools: [{ call_id: "c1", name: "sandbox.exec", status: "succeeded", started_at: at(1), ended_at: at(2), summary: "exit 0 · 120 ms" }],
    });
    host.state.messages.push(userMessage("r1", body.prompt));
    return { status: 202, body: { run_id: "r1", session_id: "s1", status: "queued" } };
  };
  const { browser, page } = await mountHome(host);
  try {
    assert.equal(await page.getByLabel(WRITE_LABEL).count(), 0, "no write toggle without a workdir");
    await page.locator(".hcp__envchip").filter({ hasText: "工作空间" }).click();
    await page.locator(".hcp__wrow").filter({ hasText: "报告目录" }).click();
    const toggle = page.getByLabel(WRITE_LABEL);
    assert.equal(await toggle.isChecked(), false, "write permission is off by default");
    await toggle.check();
    await send(page, "整理目录并跑一下脚本");

    await page.getByText("沙箱 · macOS seatbelt · 无网络 · 仅工作目录可写").waitFor();
    await page.locator(".ir-workbench-chat__chip--write").filter({ hasText: "可修改工作目录" }).waitFor();
    await page.locator(".ir-workbench-chat__tool").filter({ hasText: "exit 0 · 120 ms" }).waitFor();
    assert.equal(host.state.runPosts.length, 1);
    assert.equal(host.state.runPosts[0].permission_mode, "contained-write");
    assert.deepEqual(host.state.runPosts[0].resource_refs, ["workdir:wd-1"]);
  } finally {
    await browser.close();
  }
});
