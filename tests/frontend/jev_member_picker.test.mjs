import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { chromium } from "playwright";

async function bundleHarness() {
  mkdirSync(join(process.cwd(), ".tmp-tests"), { recursive: true });
  const outDir = mkdtempSync(join(process.cwd(), ".tmp-tests", "anna-jev-picker-"));
  const outFile = join(outDir, "picker.mjs");
  await esbuild.build({
    stdin: {
      contents: `
        import React, { useMemo, useState } from "react";
        import { createRoot } from "react-dom/client";
        import { MemberPicker } from "./apps/desktop/src/pages/crew/inspect/MemberPicker";
        import { useTaskOps } from "./apps/desktop/src/pages/crew/inspect/useTaskOps";
        import { assignTask, suggestAssignment, cancelAssignmentSuggestion } from "./apps/desktop/src/lib/api/crew";
        import "./apps/desktop/src/pages/crew/inspect/inspect.css";
        const members = [
          { id: "member-1", workspace_id: "workspace-1", email: "hidden@example.test", display_name: "文案 Agent", role: "writer", kind: "agent" },
          { id: "member-2", workspace_id: "workspace-1", email: "second@example.test", display_name: "另一位", role: "writer", kind: "human" },
        ];
        function Harness() {
          const [task, setTask] = useState({ id: "task-1", project_id: "project-1", key: "brief", title: "Brief", status: "todo", role_required: "writer", assignee_member_id: null, is_gate: false });
          const [assignments, setAssignments] = useState([]);
          const actions = useMemo(() => ({
            sessionUserId: "owner-1", ownerUserId: "owner-1", isOwner: true, members, memory: [],
            assign: (taskId, memberId, decisionId) => assignTask(task.project_id, task.id, memberId, decisionId).then(() => { if (task.id !== taskId) return; setAssignments((x) => [...x, { memberId, decisionId }]); setTask((x) => ({ ...x, assignee_member_id: memberId, status: "assigned" })); }),
            suggestAssignment: (_taskId, requestId, signal) => suggestAssignment(task.project_id, task.id, requestId, signal),
            cancelAssignmentSuggestion: (_taskId, decisionId) => cancelAssignmentSuggestion(task.project_id, task.id, decisionId).then(() => undefined),
            start: async () => {}, submit: async () => {}, runAgent: async () => {}, say: async () => {}, ring: () => {}, openDrawer: () => {}, close: () => {}, refresh: () => {},
          }), [task.project_id, task.id]);
          const ops = useTaskOps(task, [task], new Map([[task.id, task]]), actions);
          return React.createElement("div", { id: "harness" },
            React.createElement("button", { id: "open", onClick: ops.openPicker }, "打开"),
            React.createElement("button", { id: "switch", onClick: () => setTask((x) => ({ ...x, id: "task-2", project_id: "project-2" })) }, "切换任务"),
            ops.pickerOpen && React.createElement(MemberPicker, { members, ownerUserId: "owner-1", currentId: task.assignee_member_id, onPick: ops.confirmReassign, suggestion: ops.suggestion, suggestionPending: ops.suggestionPending, onSuggest: ops.requestSuggestion, onAdoptSuggestion: ops.adoptSuggestion, suggestionAdopting: ops.suggestionAdopting, suggestable: true, taskStatus: task.status, onClose: ops.closePicker }),
            React.createElement("output", { id: "assignments" }, JSON.stringify(assignments)),
            React.createElement("output", { id: "task-status" }, task.status),
            React.createElement("output", { id: "busy" }, String(ops.busy)),
            ops.error && React.createElement("output", { id: "error" }, ops.error),
          );
        }
        createRoot(document.getElementById("root")).render(React.createElement(Harness));
      `,
      resolveDir: process.cwd(),
      sourcefile: "JevMemberPickerHarness.tsx",
      loader: "tsx",
    },
    outfile: outFile,
    bundle: true,
    platform: "browser",
    format: "iife",
    loader: { ".css": "empty" },
    define: { "import.meta.env.VITE_ANNA_API_BASE": '""' },
    logLevel: "silent",
  });
  return { outDir, script: readFileSync(outFile, "utf8") };
}

test("MemberPicker suggestion uses explicit click, shows Jev metadata, and adopts once", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let suggestionRequests = 0;
  let assignRequests = 0;
  let suggestionDecisionId = null;
  let releaseSuggestion;
  const suggestionReady = new Promise((resolve) => { releaseSuggestion = resolve; });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    suggestionRequests += 1;
    suggestionDecisionId = JSON.parse(route.request().postData()).request_id;
    await suggestionReady;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: suggestionDecisionId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 42 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    assignRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    assert.equal(suggestionRequests, 0);
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.waitForFunction(() => document.body.textContent.includes("正在生成建议"));
    releaseSuggestion();
    await page.getByText("判断耗时 42ms").waitFor();
    assert.equal(await page.getByText("来源：Jev").count(), 1);
    assert.equal(assignRequests, 0);
    await page.getByRole("button", { name: "采纳指派" }).dblclick();
    await page.waitForFunction(() => document.querySelector("#task-status")?.textContent === "assigned");
    assert.equal(assignRequests, 1);
    assert.match(await page.locator("#assignments").textContent(), new RegExp(suggestionDecisionId));
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("closing MemberPicker cancels pending request and late response cannot revive it", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let cancelRequests = 0;
  let suggestionDecisionId = null;
  let releaseSuggestion;
  const pending = new Promise((resolve) => { releaseSuggestion = resolve; });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    suggestionDecisionId = JSON.parse(route.request().postData()).request_id;
    await pending;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: suggestionDecisionId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 12 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancelRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.waitForFunction(() => document.body.textContent.includes("正在生成建议"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[aria-label='改派给']"));
    for (let attempt = 0; attempt < 20 && cancelRequests === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(cancelRequests, 1);
    releaseSuggestion();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await page.getByText("采纳指派").count(), 0);
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("expired suggestion is shown as unavailable and cannot be adopted", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2000-01-01T00:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 8 } }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByText("建议已过期").waitFor();
    assert.equal(await page.getByRole("button", { name: "采纳指派" }).count(), 0);
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("switching task cancels the old scope and ignores its late response", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let cancelPath = null;
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    await pending;
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 9 } }) });
  });
  await page.route("**/api/crew/projects/*/tasks/*/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancelPath = new URL(route.request().url()).pathname;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.waitForFunction(() => document.body.textContent.includes("正在生成建议"));
    await page.locator("#switch").click();
    for (let attempt = 0; attempt < 20 && cancelPath === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(cancelPath ?? "", /^\/api\/crew\/projects\/project-1\/tasks\/task-1\/assignment-suggestions\//);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await page.getByText("采纳指派").count(), 0);
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("closing a ready suggestion clears it and reopening starts a fresh request", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let requests = 0;
  let cancels = 0;
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    requests += 1;
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "role_rule", member_id: "member-1", reason_code: "exact_role_match", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: null }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancels += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[aria-label='改派给']"));
    for (let attempt = 0; attempt < 20 && cancels === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cancels, 1);
    await page.locator("#open").click();
    assert.equal(await page.getByRole("button", { name: "采纳指派" }).count(), 0);
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).waitFor();
    assert.equal(requests, 2);
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("adoption checks current time after the suggestion TTL passes", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let assignRequests = 0;
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: new Date(Date.now() + 300000).toISOString(), evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 11 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    assignRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).waitFor();
    await page.evaluate(() => {
      const original = Date.now;
      Date.now = () => original() + 301000;
    });
    await page.getByRole("button", { name: "采纳指派" }).click();
    assert.equal(assignRequests, 0);
    await page.getByText("建议已过期").waitFor();
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("adoption button reflects pending assign while manual options remain visible", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let suggestionRequests = 0;
  let releaseAssign;
  const pendingAssign = new Promise((resolve) => { releaseAssign = resolve; });
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    suggestionRequests += 1;
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "role_rule", member_id: "member-1", reason_code: "exact_role_match", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: null }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    await pendingAssign;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).waitFor();
    await page.getByRole("button", { name: "采纳指派" }).click();
    await page.getByRole("button", { name: "正在采纳…" }).waitFor();
    assert.equal(await page.getByRole("option", { name: /另一位/ }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "正在采纳…" }).isDisabled(), true);
    assert.equal(await page.locator(".ir-insp-picker__suggest:disabled").count(), 1);
    await page.locator(".ir-insp-picker__suggest").click({ force: true });
    assert.equal(suggestionRequests, 1);
    releaseAssign();
    await page.waitForFunction(() => document.querySelector("#task-status")?.textContent === "assigned");
    assert.equal(await page.locator("#busy").textContent(), "false");
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("Esc during delayed adoption still cancels the original request", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let cancelRequests = 0;
  let releaseAssign;
  const pendingAssign = new Promise((resolve) => { releaseAssign = resolve; });
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 5 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    await pendingAssign;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancelRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).click();
    await page.getByRole("button", { name: "正在采纳…" }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[aria-label='改派给']"));
    for (let attempt = 0; attempt < 20 && cancelRequests === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cancelRequests, 1);
    releaseAssign();
  } finally {
    releaseAssign();
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("stale adoption failure keeps the original suggestion cancellable", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let cancelRequests = 0;
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    const requestId = JSON.parse(route.request().postData()).request_id;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 5 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: { code: "suggestion_stale" } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancelRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).click();
    await page.getByText("任务或成员资料已变化").waitFor();
    await page.keyboard.press("Escape");
    for (let attempt = 0; attempt < 20 && cancelRequests === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cancelRequests, 1);
  } finally {
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("late success from old adoption cannot close a new scope picker", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let releaseOldAssign;
  let releaseNewSuggestion;
  const oldAssign = new Promise((resolve) => { releaseOldAssign = resolve; });
  const newSuggestion = new Promise((resolve) => { releaseNewSuggestion = resolve; });
  let cancelRequests = 0;
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/*/tasks/*/assignment-suggestions", async (route) => {
    const url = new URL(route.request().url());
    const taskId = url.pathname.match(/tasks\/([^/]+)\/assignment-suggestions/)?.[1];
    const requestId = JSON.parse(route.request().postData()).request_id;
    if (taskId === "task-2") await newSuggestion;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: url.pathname.includes("project-2") ? "project-2" : "project-1", task_id: taskId, status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 6 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    await oldAssign;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
  });
  await page.route("**/api/crew/projects/*/tasks/*/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancelRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).click();
    await page.getByRole("button", { name: "正在采纳…" }).waitFor();
    await page.locator("#switch").click();
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.waitForFunction(() => document.body.textContent.includes("正在生成建议"));
    releaseOldAssign();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await page.locator("[aria-label='改派给']").count(), 1);
    assert.equal(cancelRequests, 1);
    assert.equal(await page.locator("#busy").textContent(), "false");
    assert.equal(await page.locator("#error").count(), 0);
    releaseNewSuggestion();
  } finally {
    releaseOldAssign();
    releaseNewSuggestion();
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("same-scope close and reopen invalidates old adoption before the new request", async () => {
  const { outDir, script } = await bundleHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let requestCount = 0;
  let releaseOldAssign;
  let releaseNewSuggestion;
  const oldAssign = new Promise((resolve) => { releaseOldAssign = resolve; });
  const newSuggestion = new Promise((resolve) => { releaseNewSuggestion = resolve; });
  const cancelPaths = [];
  await page.route("http://preview.test/", async (route) => {
    await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
  });
  await page.route("**/api/session/current", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ workspace_id: "workspace-1", user_id: "owner-1", role: "boss", user_display_name: "Owner", source: "token" }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions", async (route) => {
    requestCount += 1;
    const requestId = JSON.parse(route.request().postData()).request_id;
    if (requestCount === 2) await newSuggestion;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision_id: requestId, project_id: "project-1", task_id: "task-1", status: "suggested", source: "jev", member_id: "member-1", reason_code: "model_choice", expires_at: "2099-09-21T01:00:00Z", evidence: { task_role: "writer", member_role: "writer", member_kind: "agent" }, meta: { elapsed_ms: 6 } }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assign", async (route) => {
    await oldAssign;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
  });
  await page.route("**/api/crew/projects/project-1/tasks/task-1/assignment-suggestions/*", async (route) => {
    if (route.request().method() === "DELETE") cancelPaths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "canceled" }) });
  });
  try {
    await page.goto("http://preview.test/", { waitUntil: "commit" });
    await page.addScriptTag({ content: script });
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.getByRole("button", { name: "采纳指派" }).click();
    await page.getByRole("button", { name: "正在采纳…" }).waitFor();
    await page.keyboard.press("Escape");
    for (let attempt = 0; attempt < 20 && cancelPaths.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    await page.locator("#open").click();
    await page.getByRole("button", { name: "建议人选" }).click();
    await page.waitForFunction(() => document.body.textContent.includes("正在生成建议"));
    releaseOldAssign();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await page.locator("[aria-label='改派给']").count(), 1);
    assert.equal(await page.locator("#busy").textContent(), "false");
    assert.equal(await page.locator("#error").count(), 0);
    await page.keyboard.press("Escape");
    for (let attempt = 0; attempt < 20 && cancelPaths.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cancelPaths.length, 2);
    assert.notEqual(cancelPaths[0], cancelPaths[1]);
    releaseNewSuggestion();
  } finally {
    releaseOldAssign();
    releaseNewSuggestion();
    await browser.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
