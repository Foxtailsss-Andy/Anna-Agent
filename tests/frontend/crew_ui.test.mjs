// Crew UI behaviour in a real browser (esbuild bundle of the real components + page.route mocks;
// prior art: tests/frontend/jev_member_picker.test.mjs). Deterministic fixtures only — no Host,
// no model/provider calls. Covers F1: Enter routing (@member → Channel, else Anna), no silent
// parallel Anna runs, Crew Anna session restore on remount, the in-app template dialog, and the
// readable GFM table layout in the narrow Crew card.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as esbuild from "esbuild";
import { chromium } from "playwright";

// localhost is a secure context (the Workbench hook uses crypto.randomUUID, as in the Electron app);
// every request is fulfilled by page.route, nothing listens on this port.
const ORIGIN = "http://localhost:47901";
const IDENTITY = { workspace_id: "ws1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" };

async function bundleHarness() {
  mkdirSync(join(process.cwd(), ".tmp-tests"), { recursive: true });
  const outDir = mkdtempSync(join(process.cwd(), ".tmp-tests", "anna-crew-ui-"));
  const outFile = join(outDir, "crew-ui.js");
  await esbuild.build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import "./apps/desktop/src/styles/tokens.css";
        import { AnnaShell, useShellBus } from "./apps/desktop/src/components/shell/AnnaShell";
        import { ChannelColumn } from "./apps/desktop/src/pages/crew/channel/ChannelColumn";
        import { Composer } from "./apps/desktop/src/pages/crew/channel/Composer";
        import { CrewTemplatesPage } from "./apps/desktop/src/pages/crew/CrewTemplatesPage";
        import { CrewMarkdown } from "./apps/desktop/src/pages/crew/CrewMarkdown";

        const members = [
          { id: "acc_andy", workspace_id: "ws1", email: "andy@example.test", display_name: "Andy", role: "工程", kind: "human" },
          { id: "acc_copy", workspace_id: "ws1", email: "copy@example.test", display_name: "Agent·Copy", role: "文案", kind: "agent" },
        ];
        const project = { id: "p1", workspace_id: "ws1", owner_user_id: "owner-1", goal_text: "登录页重设计", sop_template_id: "tpl_1", status: "active", tasks: [] };

        function ChannelHarness() {
          const [mounted, setMounted] = useState(true);
          const [tasks, setTasks] = useState(window.__CREW_TASKS__ ?? []);
          const [channel, setChannel] = useState(window.__CREW_CHANNEL__ ?? []);
          return React.createElement("div", null,
            React.createElement("button", { id: "toggle", onClick: () => setMounted((m) => !m) }, "toggle"),
            React.createElement("div", { style: { width: 328, height: 720, display: "flex" } },
              mounted && React.createElement(ChannelColumn, {
                key: "p1", projectId: "p1", project: { ...project, tasks }, channel, members, isOwner: true,
                onRefresh: (next) => { if (next) setTasks(next.tasks ?? []); setChannel([...(window.__CREW_CHANNEL__ ?? [])]); },
              })));
        }

        // Composer alone with a running Anna Run and a steer handler.
        function ComposerHarness() {
          const [steered, setSteered] = useState([]);
          const [asked, setAsked] = useState([]);
          return React.createElement("div", { style: { width: 328 } },
            React.createElement(Composer, {
              projectId: "p1", members, onRefresh: () => {}, annaRunning: true,
              onAskAnna: async (text) => { setAsked((a) => [...a, text]); return { ok: true }; },
              onSteerAnna: async (text) => {
                setSteered((s) => [...s, text]);
                return window.__STEER_FAIL__ ? { ok: false, error: "这次运行已经结束，补充说明没能进入。" } : { ok: true, queued: window.__STEER_QUEUED__ };
              },
            }),
            React.createElement("output", { id: "steered" }, JSON.stringify(steered)),
            React.createElement("output", { id: "asked" }, JSON.stringify(asked)));
        }

        function GoTemplates() {
          const bus = useShellBus();
          return React.createElement("button", { id: "go-templates", onClick: () => bus.navigate("crew", undefined, "templates") }, "去模板库");
        }
        function TemplatesHarness() {
          return React.createElement(AnnaShell, {
            identity: null,
            onLogout: () => {},
            renderSection: (section, _cw, crewItem, crewProjectId) => {
              if (section === "crew" && crewItem === "templates") return React.createElement(CrewTemplatesPage);
              if (section === "crew" && crewItem === "project") return React.createElement("output", { id: "opened-project" }, crewProjectId);
              return React.createElement(GoTemplates);
            },
          });
        }

        const TABLE = [
          "| 任务 | 负责人 | 状态 | 截止日期 | 备注 |",
          "| --- | --- | --- | --- | --- |",
          "| 登录页重设计 | Andy | 进行中 | 2026-10-12 | 依赖设计评审结论后再排期 |",
          "| 文案撰写 | Agent·Copy | 待开始 | 2026-10-15 | 需要先确认品牌语气和关键卖点 |",
        ].join("\\n");
        function MarkdownHarness() {
          return React.createElement("div", { id: "box", style: { width: 234 } },
            React.createElement("div", { className: "ir-crew-workbench__message ir-crew-workbench__message--assistant" },
              React.createElement(CrewMarkdown, { source: "进度表：\\n\\n" + TABLE })));
        }

        const mode = window.__CREW_HARNESS__;
        const Root = mode === "templates" ? TemplatesHarness : mode === "markdown" ? MarkdownHarness : mode === "composer" ? ComposerHarness : ChannelHarness;
        createRoot(document.getElementById("root")).render(React.createElement(Root));
      `,
      resolveDir: process.cwd(),
      sourcefile: "CrewUiHarness.tsx",
      loader: "tsx",
    },
    outfile: outFile,
    bundle: true,
    platform: "browser",
    format: "iife",
    loader: { ".css": "css" },
    define: { "import.meta.env.VITE_ANNA_API_BASE": '""', __APP_VERSION__: '"test"' },
    logLevel: "silent",
  });
  return {
    outDir,
    script: readFileSync(outFile, "utf8"),
    css: readFileSync(join(outDir, "crew-ui.css"), "utf8"),
  };
}

let bundle;
let browser;

before(async () => {
  bundle = await bundleHarness();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (bundle) rmSync(bundle.outDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Opens a harness page; every /api/* call is recorded and answered by `handler` (undefined → 404). */
async function openHarness(mode, handler, globals = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(3000);
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.route(`${ORIGIN}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw = request.postData();
    const call = { method: request.method(), path: url.pathname, search: url.search, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    if (call.path === "/api/session/current") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(IDENTITY) });
      return;
    }
    const result = await handler(call);
    if (result === undefined) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "not_found" }) });
      return;
    }
    await route.fulfill({ status: result.status ?? 200, contentType: "application/json", body: JSON.stringify(result.body) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });
  await page.addStyleTag({ content: bundle.css });
  await page.evaluate(({ m, g }) => {
    window.__CREW_HARNESS__ = m;
    Object.assign(window, g);
  }, { m: mode, g: globals });
  await page.addScriptTag({ content: bundle.script });
  return { page, calls, errors };
}

/** Deterministic stand-in for the Product Host Workbench routes used by the Crew channel. */
function workbenchHost() {
  const state = { sessions: [], listGate: null, clock: Date.parse("2026-10-08T02:00:00Z") };
  const stamp = () => new Date((state.clock += 1000)).toISOString();
  const find = (id) => state.sessions.find((session) => session.session_id === id);
  const handle = async (call) => {
    if (call.path === "/api/workbench/sessions" && call.method === "GET") {
      if (state.listGate) await state.listGate;
      return { body: { sessions: structuredClone(state.sessions) } };
    }
    if (call.path === "/api/workbench/sessions" && call.method === "POST") {
      const at = stamp();
      const session = { session_id: `s${state.sessions.length + 1}`, surface: call.body.surface, project_id: call.body.project_id, created_at: at, updated_at: at, runs: [], messages: [] };
      state.sessions.push(session);
      return { status: 201, body: structuredClone(session) };
    }
    const runsMatch = call.path.match(/^\/api\/workbench\/sessions\/([^/]+)\/runs$/);
    if (runsMatch && call.method === "POST") {
      const session = find(runsMatch[1]);
      const runId = `r${state.sessions.reduce((n, s) => n + s.runs.length, 0) + 1}`;
      const run = { run_id: runId, session_id: session.session_id, surface: "crew", prompt: call.body.prompt, status: "running" };
      session.runs.push(run);
      session.messages.push({ run_id: runId, event_id: `${runId}-user`, seq: session.messages.length, role: "user", content: call.body.prompt });
      session.updated_at = stamp();
      return { status: 202, body: structuredClone(run) };
    }
    const sessionMatch = call.path.match(/^\/api\/workbench\/sessions\/([^/]+)$/);
    if (sessionMatch && call.method === "GET") {
      const session = find(sessionMatch[1]);
      return session ? { body: structuredClone(session) } : undefined;
    }
    const eventsMatch = call.path.match(/^\/api\/workbench\/runs\/([^/]+)\/events$/);
    if (eventsMatch && call.method === "GET") return { body: { run_id: eventsMatch[1], events: [] } };
    return undefined;
  };
  const complete = (runId, answer) => {
    for (const session of state.sessions) {
      const run = session.runs.find((candidate) => candidate.run_id === runId);
      if (!run) continue;
      run.status = "completed";
      session.messages.push({ run_id: runId, event_id: `${runId}-assistant`, seq: session.messages.length, role: "assistant", content: answer });
      session.updated_at = stamp();
    }
  };
  return { state, handle, complete };
}

const workbenchPosts = (calls) => calls.filter((call) => call.method === "POST" && call.path.startsWith("/api/workbench"));
const channelPosts = (calls) => calls.filter((call) => call.method === "POST" && call.path === "/api/crew/projects/p1/channel");

test("Enter with a picked @Andy posts to the Channel with Andy's id and starts no Anna run", async () => {
  const host = workbenchHost();
  const { page, calls, errors } = await openHarness("channel", async (call) => {
    if (call.method === "POST" && call.path === "/api/crew/projects/p1/channel") {
      return { status: 201, body: { id: "msg_1", project_id: "p1", kind: "say", body: call.body.body, mentions: call.body.mentions } };
    }
    return host.handle(call);
  });
  try {
    const input = page.locator(".ir-chan-composer__input");
    await input.waitFor();
    assert.match(await input.getAttribute("placeholder"), /Enter：@成员 → 发频道；否则问 Anna/);
    await input.click();
    await page.keyboard.type("@And");
    await page.getByRole("listbox", { name: "选择协调者或成员" }).waitFor();
    await page.keyboard.press("Enter"); // picks Andy (does not send)
    await page.waitForFunction(() => document.querySelector(".ir-chan-composer__input")?.value === "@Andy ");
    // the picker restores the caret on the next animation frame; type after it
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.type("看一下登录页");
    await page.keyboard.press("Enter");
    await until(() => channelPosts(calls).length === 1, "channel post");
    assert.deepEqual(channelPosts(calls)[0].body, { body: "@Andy 看一下登录页", mentions: ["acc_andy"] });
    await page.waitForFunction(() => document.querySelector(".ir-chan-composer__input")?.value === "");
    await sleep(100);
    assert.deepEqual(workbenchPosts(calls), []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("picking a member then immediately pressing Enter sends the completed mention once", async () => {
  const host = workbenchHost();
  const { page, calls, errors } = await openHarness("channel", async (call) => {
    if (call.method === "POST" && call.path === "/api/crew/projects/p1/channel") {
      return { status: 201, body: { id: "msg_fast", project_id: "p1", kind: "say", ...call.body } };
    }
    return host.handle(call);
  });
  try {
    const input = page.locator(".ir-chan-composer__input");
    await input.fill("@And");
    await page.getByRole("listbox", { name: "选择协调者或成员" }).waitFor();
    // A busy/background renderer can delay the caret-restoring animation frame.
    await page.evaluate(() => {
      const nextFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = (callback) => nextFrame((time) => setTimeout(() => callback(time), 250));
    });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await until(() => channelPosts(calls).length === 1, "immediate channel post");
    assert.deepEqual(channelPosts(calls)[0].body, { body: "@Andy", mentions: ["acc_andy"] });
    assert.deepEqual(workbenchPosts(calls), []);
    await sleep(300);
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Enter without a member mention asks Anna; a second Enter while it runs does not start a parallel run", async () => {
  const host = workbenchHost();
  const { page, calls, errors } = await openHarness("channel", (call) => {
    if (call.method === "POST" && call.path === "/api/workbench/runs/r1/steer") {
      return { status: 202, body: { accepted: true, consumed: true } };
    }
    return host.handle(call);
  });
  try {
    const input = page.locator(".ir-chan-composer__input");
    await input.fill("这个项目现在卡在哪？");
    await input.press("Enter");
    await until(() => calls.some((call) => call.method === "POST" && /\/runs$/.test(call.path)), "run submission");
    const sessionCreate = calls.find((call) => call.method === "POST" && call.path === "/api/workbench/sessions");
    assert.deepEqual(sessionCreate.body, { surface: "crew", project_id: "p1" });
    const runSubmit = calls.find((call) => call.method === "POST" && /\/runs$/.test(call.path));
    assert.equal(runSubmit.path, "/api/workbench/sessions/s1/runs");
    assert.equal(runSubmit.body.prompt, "这个项目现在卡在哪？");
    assert.deepEqual(channelPosts(calls), []);
    await page.locator(".ir-crew-workbench").getByText("Anna · running").waitFor();

    await input.fill("再补充一句");
    await input.press("Enter");
    await until(() => calls.some((call) => call.path === "/api/workbench/runs/r1/steer"), "steer submission");
    await page.waitForFunction(() => document.querySelector(".ir-chan-composer__input")?.value === "");
    await sleep(150);
    assert.equal(calls.filter((call) => call.method === "POST" && /\/runs$/.test(call.path)).length, 1);
    assert.deepEqual(calls.find((call) => call.path === "/api/workbench/runs/r1/steer").body, { text: "再补充一句" });

    host.complete("r1", "卡在设计评审。");
    await page.locator(".ir-crew-workbench").getByText("卡在设计评审。").waitFor();
    await page.waitForFunction(() => !document.querySelector(".ir-chan-composer__notice"));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("while Anna runs, a plain Enter is steered into the run ('补充给 Anna'); @member messages still go to the Channel", async () => {
  const { page, calls, errors } = await openHarness("composer", async (call) => {
    if (call.method === "POST" && call.path === "/api/crew/projects/p1/channel") {
      return { status: 201, body: { id: "msg_2", project_id: "p1", kind: "say", body: call.body.body, mentions: call.body.mentions } };
    }
    return undefined;
  });
  try {
    const input = page.locator(".ir-chan-composer__input");
    await input.waitFor();
    assert.match(await input.getAttribute("placeholder"), /否则补充给 Anna/);
    await page.getByRole("button", { name: "补充给 Anna", exact: true }).waitFor();
    await input.fill("先看文案部分");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("#steered")?.textContent === JSON.stringify(["先看文案部分"]));
    assert.equal(await page.locator("#asked").textContent(), "[]");
    assert.equal(await input.inputValue(), "");

    await input.fill("@Andy 文案你来改");
    await input.press("Enter");
    await until(() => channelPosts(calls).length === 1, "channel post");
    assert.deepEqual(channelPosts(calls)[0].body, { body: "@Andy 文案你来改", mentions: ["acc_andy"] });
    assert.equal(await page.locator("#steered").textContent(), JSON.stringify(["先看文案部分"]));

    await page.evaluate(() => { window.__STEER_QUEUED__ = true; });
    await input.fill("等待下一轮补充");
    await input.press("Enter");
    await page.locator(".ir-chan-composer__notice").getByText("补充说明已排队", { exact: false }).waitFor();
    assert.equal(await input.inputValue(), "");

    await page.evaluate(() => { window.__STEER_FAIL__ = true; });
    await input.fill("再补一句");
    await page.getByRole("button", { name: "补充给 Anna", exact: true }).click();
    await page.locator(".ir-chan-composer__err").getByText("这次运行已经结束，补充说明没能进入。").waitFor();
    assert.equal(await input.inputValue(), "再补一句");
    assert.equal(await page.locator("#asked").textContent(), "[]");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("remounting the channel restores the latest Crew Anna session card with its full history", async () => {
  const host = workbenchHost();
  const { page, calls, errors } = await openHarness("channel", host.handle);
  try {
    const input = page.locator(".ir-chan-composer__input");
    await input.fill("这个项目现在卡在哪？");
    await input.press("Enter");
    await until(() => calls.some((call) => call.method === "POST" && /\/runs$/.test(call.path)), "run submission");
    host.complete("r1", "## 结论\n\n卡在**设计评审**。");
    await page.locator(".ir-crew-workbench h2").getByText("结论").waitFor();

    // A chat session and an older crew session of another project must not win.
    host.state.sessions.push(
      { session_id: "chat-9", surface: "chat", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", runs: [], messages: [{ run_id: "x", event_id: "x", seq: 0, role: "user", content: "家里的事" }] },
      { session_id: "crew-other", surface: "crew", project_id: "p2", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", runs: [], messages: [{ run_id: "y", event_id: "y", seq: 0, role: "user", content: "别的项目" }] },
    );

    await page.locator("#toggle").click();
    await page.waitForFunction(() => !document.querySelector(".ir-crew-channel"));
    await page.locator("#toggle").click();

    const card = page.locator(".ir-crew-workbench");
    await card.getByText("Anna · completed").waitFor();
    const history = await card.locator(".ir-crew-workbench__message").allInnerTexts();
    assert.deepEqual(history.map((text) => text.trim().replace(/\s+/g, " ")), ["这个项目现在卡在哪？", "结论 卡在设计评审。"]);
    const lists = calls.filter((call) => call.method === "GET" && call.path === "/api/workbench/sessions");
    assert.equal(lists.length, 2);
    assert.ok(lists.every((call) => call.search === "?project_id=p1"));
    assert.ok(calls.some((call) => call.method === "GET" && call.path === "/api/workbench/sessions/s1"));
    assert.ok(!calls.some((call) => call.path === "/api/workbench/sessions/chat-9" || call.path === "/api/workbench/sessions/crew-other"));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("posting a picked mention and starting another Anna Run retain channel and session history", async () => {
  const host = workbenchHost();
  host.state.sessions.push({
    session_id: "s1", surface: "crew", project_id: "p1", created_at: "2026-10-08T01:00:00Z", updated_at: "2026-10-08T01:10:00Z",
    runs: [{ run_id: "r1", session_id: "s1", surface: "crew", prompt: "之前的问题", status: "completed" }],
    messages: [
      { run_id: "r1", event_id: "e1", seq: 0, role: "user", content: "之前的问题" },
      { run_id: "r1", event_id: "e2", seq: 1, role: "assistant", content: "之前的回答" },
    ],
  });
  const earlier = {
    id: "msg_old", project_id: "p1", workspace_id: "ws1", seq: 1, author_kind: "human", author_member_id: "acc_andy",
    kind: "say", body: "之前的频道消息", task_id: null, run_ref: null, mentions: [], audit_ref: "", created_at: "2026-10-08T01:00:00Z",
  };
  const harness = await openHarness("channel", async (call) => {
    if (call.method === "POST" && call.path === "/api/crew/projects/p1/channel") {
      const posted = { ...earlier, id: "msg_new", seq: 2, ...call.body };
      await harness.page.evaluate((message) => window.__CREW_CHANNEL__.push(message), posted);
      return { status: 201, body: posted };
    }
    return host.handle(call);
  }, { __CREW_CHANNEL__: [earlier] });
  const { page, calls, errors } = harness;
  try {
    await page.getByText("之前的回答", { exact: true }).waitFor();
    const input = page.locator(".ir-chan-composer__input");
    await input.fill("@And");
    await page.getByRole("listbox", { name: "选择协调者或成员" }).waitFor();
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("请你查看新消息");
    await page.keyboard.press("Enter");
    await until(() => channelPosts(calls).length === 1, "member message");
    assert.deepEqual(channelPosts(calls)[0].body, { body: "@Andy 请你查看新消息", mentions: ["acc_andy"] });
    await page.locator(".ir-chan-say__body").getByText("请你查看新消息", { exact: false }).waitFor();
    assert.equal(await page.getByText("之前的频道消息", { exact: true }).count(), 1);
    assert.equal(await page.getByText("之前的回答", { exact: true }).count(), 1);

    await input.fill("继续分析");
    await input.press("Enter");
    await until(() => calls.some((call) => call.method === "POST" && /\/runs$/.test(call.path)), "new Anna run");
    host.complete("r2", "新的回答");
    await page.getByText("新的回答", { exact: true }).waitFor();
    await page.locator("#toggle").click();
    await page.locator("#toggle").click();
    await page.getByText("新的回答", { exact: true }).waitFor();
    const history = await page.locator(".ir-crew-workbench__message").allInnerTexts();
    assert.deepEqual(history, ["之前的问题", "之前的回答", "继续分析", "新的回答"]);
    assert.equal(await page.getByText("之前的频道消息", { exact: true }).count(), 1);
    assert.equal(await page.locator(".ir-chan-say__body").filter({ hasText: "请你查看新消息" }).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a session list that arrives after the channel unmounted does not restore anything", async () => {
  const host = workbenchHost();
  host.state.sessions.push({
    session_id: "s-old",
    surface: "crew",
    project_id: "p1",
    created_at: "2026-10-07T00:00:00Z",
    updated_at: "2026-10-07T00:00:00Z",
    runs: [{ run_id: "r-old", session_id: "s-old", surface: "crew", prompt: "旧问题", status: "completed" }],
    messages: [
      { run_id: "r-old", event_id: "e1", seq: 0, role: "user", content: "旧问题" },
      { run_id: "r-old", event_id: "e2", seq: 1, role: "assistant", content: "旧回答" },
    ],
  });
  let release;
  host.state.listGate = new Promise((resolve) => { release = resolve; });
  const { page, calls, errors } = await openHarness("channel", host.handle);
  try {
    await until(() => calls.some((call) => call.method === "GET" && call.path === "/api/workbench/sessions"), "session list request");
    await page.locator("#toggle").click();
    await page.waitForFunction(() => !document.querySelector(".ir-crew-channel"));
    release();
    await sleep(200);
    assert.ok(!calls.some((call) => call.path === "/api/workbench/sessions/s-old"));

    host.state.listGate = null;
    await page.locator("#toggle").click();
    await page.locator(".ir-crew-workbench").getByText("旧回答").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("Coordination Proposal card adopts only the checked drafts and assignments through the confirm endpoint", async () => {
  const host = workbenchHost();
  const confirms = [];
  const proposal = {
    id: "cmd_prop", project_id: "p1", workspace_id: "ws1", seq: 4, author_kind: "anna", author_member_id: null,
    kind: "command", body: "Anna 提议：先做竞品调研再写文案", task_id: null, run_ref: null, mentions: [], audit_ref: "",
    created_at: "2026-10-08T02:10:00Z",
    payload: {
      drafts: [
        { title: "竞品调研", role: "设计", depends_on: [], insert_before: ["文案撰写"], acceptance: "列出 3 个竞品", assignee_id: "acc_andy" },
        { title: "竞品对比表", role: "策划", depends_on: ["竞品调研"], insert_before: [], acceptance: "", assignee_id: null },
      ],
      assignments: [{ task_id: "task_copy", member_id: "acc_copy", reason: "文案 Agent 空闲" }],
      origin: "anna_coordination",
      source: { type: "workbench_run", run_id: "r9", tool_call_id: "call_1" },
      text: "先做竞品调研再写文案",
      suggested_assignee: null,
    },
  };
  const existing = [{ id: "task_copy", project_id: "p1", key: "copy", title: "文案撰写", status: "todo", role_required: "文案" }];
  const { page, calls, errors } = await openHarness("channel", async (call) => {
    if (call.method === "POST" && call.path === "/api/crew/projects/p1/channel/command/confirm") {
      confirms.push(call.body);
      return { body: { id: "p1", workspace_id: "ws1", owner_user_id: "owner-1", goal_text: "登录页重设计", sop_template_id: "tpl_1", status: "active", tasks: [
        { ...existing[0], depends_on: ["task_new"], assignee_member_id: "acc_copy", status: "blocked" },
        { id: "task_new", project_id: "p1", key: "c1", title: "竞品调研", status: "assigned", role_required: "设计", origin: "channel", created_from_message_id: "cmd_prop", assignee_member_id: "acc_andy" },
      ] } };
    }
    return host.handle(call);
  }, { __CREW_CHANNEL__: [proposal], __CREW_TASKS__: existing });
  try {
    const card = page.locator(".ir-chan-proposal");
    await card.getByText("来自 Anna 对话").waitFor();
    await card.getByText("放在“文案撰写”之前", { exact: false }).waitFor();
    await card.getByText("文案撰写 → Agent·Copy").waitFor();
    await card.getByRole("checkbox", { name: "采纳新任务“竞品对比表”" }).uncheck();
    await card.getByRole("button", { name: "采纳 · 2 项" }).click();
    await card.getByText("已确认 · 已下推").waitFor();
    assert.deepEqual(confirms, [{ message_id: "cmd_prop", draft_indexes: [0], assignment_indexes: [0] }]);
    assert.equal(await card.getByRole("checkbox").count(), 0);
    assert.deepEqual(workbenchPosts(calls), []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("template dialog: accessible, Esc cancels with focus return, errors inline, then creates and opens the project", async () => {
  const projectPosts = [];
  let failNext = true;
  let releaseCreate;
  const { page, errors } = await openHarness("templates", async (call) => {
    if (call.method === "GET" && call.path === "/api/crew/templates") {
      return { body: { templates: [{ id: "tpl_1", name: "功能迭代", description: "从需求到上线", tasks: [
        { key: "brief", title: "需求", role_required: "产品", depends_on: [], is_gate: false, reviews: null, acceptance_criteria: null },
        { key: "review", title: "评审", role_required: "负责人", depends_on: ["brief"], is_gate: true, reviews: "brief", acceptance_criteria: null },
      ] }] } };
    }
    if (call.method === "POST" && call.path === "/api/crew/projects") {
      projectPosts.push(call.body);
      if (failNext) {
        failNext = false;
        return { status: 500, body: { detail: "template_unavailable" } };
      }
      await new Promise((resolve) => { releaseCreate = resolve; });
      return { status: 201, body: { id: "proj_new", workspace_id: "ws1", owner_user_id: "owner-1", goal_text: call.body.goal_text, sop_template_id: call.body.sop_template_id, status: "active", tasks: [] } };
    }
    return undefined;
  });
  try {
    await page.locator("#go-templates").click();
    const trigger = page.getByRole("button", { name: "用此模板建项目" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "用“功能迭代”建项目" });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    const nameInput = dialog.getByLabel("项目名");
    await page.waitForFunction(() => document.activeElement?.id && document.activeElement === document.querySelector(".ir-crew-dialog__input"));

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[role='dialog'].ir-crew-dialog"));
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
    assert.deepEqual(projectPosts, []);

    await trigger.click();
    await dialog.waitFor();
    await page.keyboard.press("Enter");
    await dialog.getByRole("alert").getByText("请输入项目名。").waitFor();
    assert.deepEqual(projectPosts, []);

    await nameInput.fill("登录页重设计");
    await page.keyboard.press("Enter");
    await dialog.getByRole("alert").getByText(/template_unavailable/).waitFor();
    assert.equal(await nameInput.inputValue(), "登录页重设计");

    await dialog.getByRole("button", { name: "建项目" }).click();
    await dialog.getByRole("button", { name: "建项目中……" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "建项目中……" }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "取消" }).isDisabled(), true);
    releaseCreate();
    await page.locator("#opened-project").getByText("proj_new").waitFor();
    assert.equal(await page.locator(".ir-crew-dialog").count(), 0);
    assert.deepEqual(projectPosts, [
      { goal_text: "登录页重设计", sop_template_id: "tpl_1" },
      { goal_text: "登录页重设计", sop_template_id: "tpl_1" },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a 5-column GFM table in a 234 px Crew card keeps readable columns and scrolls horizontally", async () => {
  const { page, errors } = await openHarness("markdown", async () => undefined);
  try {
    await page.locator("#box table").waitFor();
    const metrics = await page.evaluate(() => {
      const box = document.querySelector("#box");
      const wrap = box.querySelector(".crew-md__tablewrap");
      return {
        box: box.getBoundingClientRect().width,
        wrap: wrap.getBoundingClientRect().width,
        scrollWidth: wrap.scrollWidth,
        clientWidth: wrap.clientWidth,
        columns: [...wrap.querySelectorAll("thead th")].map((th) => th.getBoundingClientRect().width),
        cellFont: getComputedStyle(wrap.querySelector("td")).fontSize,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    assert.equal(metrics.box, 234);
    assert.ok(metrics.wrap <= 234, `wrapper ${metrics.wrap}px stays inside the card`);
    assert.equal(metrics.columns.length, 5);
    for (const width of metrics.columns) assert.ok(width >= 60, `column ${width}px ≥ 60px (${metrics.columns.join(", ")})`);
    assert.ok(metrics.scrollWidth > metrics.clientWidth, `wrapper scrolls (${metrics.scrollWidth} > ${metrics.clientWidth})`);
    assert.equal(metrics.cellFont, "13px");
    assert.equal(metrics.pageOverflow, false);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
