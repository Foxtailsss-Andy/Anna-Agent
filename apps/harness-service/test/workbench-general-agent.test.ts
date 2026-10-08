/**
 * General-Agent Workbench behaviour through the public Product Host routes,
 * the real Python business adapter and the real managed OMP worker. Only the
 * model provider is a deterministic fixture.
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import type { ModelContext, ModelDelta } from "../../../packages/omp-loop-kernel/src/protocol";
import type { OmpModelStreamObserver } from "../../../packages/omp-loop-kernel/src/omp-loop-kernel";
import { findFreePort, startBusinessFixture, type BusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

type Script = (context: ModelContext, observer: OmpModelStreamObserver | undefined) => AsyncIterable<FixtureResponse>;
interface FixtureResponse {
  deltas: ModelDelta[];
  message: { role: "assistant"; content: Array<Record<string, unknown>>; stopReason: "stop" | "toolUse" };
}

let directory: string;
let business: BusinessFixture;
let host: Awaited<ReturnType<typeof startProductHost>>;
let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>>;
let workdirRoot: string;
let workdirId: string;
/** Per-test model script, selected by the first user message of the Run. */
let script: Script = async function* () {
  yield text("unused");
};
const contexts: ModelContext[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "anna-general-agent-"));
  const workspaceRoot = join(directory, "workspace");
  workdirRoot = join(directory, "synthetic-workdir");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(workdirRoot, { recursive: true });
  await writeFile(join(workdirRoot, "README.md"), "# Synthetic project\nMARKER-GENERAL-AGENT\n", "utf8");
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: await createOmpKernelDescriptor(materializedRoot),
  }), "utf8");
  const hostPort = await findFreePort();
  business = await startBusinessFixture(join(directory, "business.sqlite3"), `http://127.0.0.1:${hostPort}`);
  const sessions = new ProductSessionStore(sessionStorePath);
  live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot,
    surfaces: ["chat", "create", "crew"],
    requireOmp: true,
    ompRuntimeRoot: materializedRoot,
    productTaskFor: async (runId) => (await sessions.get(runId))?.task,
    productTaskPeek: (runId) => sessions.peek(runId)?.task,
    businessOrigin: business.origin,
    businessServiceToken: "wb01-business-service-token",
    protectedPaths: [eventStorePath, sessionStorePath, configPath],
    ompModelTransport: (context, _signal, observer) => {
      contexts.push(context);
      return script(context, observer);
    },
  });
  host = await startProductHost({
    runtime: live.runtime,
    eventStore: live.eventStore,
    host: "127.0.0.1",
    port: hostPort,
    serviceToken: "general-agent-host-token",
    sessionStore: sessions,
    staticRoot: directory,
    businessOrigin: business.origin,
    businessServiceToken: "wb01-business-service-token",
    goalSupervisorIntervalMs: 100,
  });
  const registration = await api("/api/workdirs", { method: "POST", body: { path: workdirRoot, name: "Synthetic" }, origin: business.origin });
  expect(registration.status).toBe(200);
  workdirId = (registration.body as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await host?.close();
  await live?.close();
  await business?.close();
  await rm(directory, { recursive: true, force: true });
});

test("a contained-write Run plans, writes a file, runs it in the sandbox and exposes the evidence", async () => {
  const session = await createSession();

  const refused = await api(`/api/workbench/sessions/${session}/runs`, {
    method: "POST",
    body: { prompt: "改文件", source_event_id: "ga-refused", permission_mode: "contained-write" },
  });
  expect(refused).toEqual({ status: 422, body: { code: "permission_requires_workdir" } });

  let step = 0;
  script = async function* (context) {
    step += 1;
    const names = (context.tools ?? []).map((tool) => tool.name);
    if (step === 1) {
      expect(names).toEqual(expect.arrayContaining([
        "todo", "workdir.list", "workdir.search", "workdir.write_file", "workdir.edit_file", "sandbox.exec",
      ]));
      expect(names).not.toContain("crew.propose_changes");
      expect(context.systemPrompt).toContain("permission: contained-write");
      yield tool("plan-1", "todo", { op: "init", list: [{ phase: "实现", items: ["写脚本", "运行验证"] }] });
    } else if (step === 2) {
      yield tool("write-1", "workdir.write_file", { path: "calc.py", content: "print(6 * 7)\n" });
    } else if (step === 3) {
      expect(lastToolResult(context)).toMatchObject({ toolName: "workdir.write_file", status: "succeeded" });
      yield tool("exec-1", "sandbox.exec", { command: "/usr/bin/python3 calc.py" });
    } else if (step === 4) {
      const result = lastToolResult(context);
      expect(result).toMatchObject({ toolName: "sandbox.exec", status: "succeeded" });
      expect(JSON.parse(result.content)).toMatchObject({ exit_code: 0, stdout: "42\n", sandbox: { kind: "macos-seatbelt", network: "denied" } });
      yield tool("plan-2", "todo", { op: "done", phase: "实现" });
    } else {
      yield text("calc.py 已写入并运行，输出 42。");
    }
  };
  const run = await submit(session, {
    prompt: "写一个打印 6*7 的脚本并运行验证",
    source_event_id: "ga-write-1",
    resource_refs: [`workdir:${workdirId}`],
    permission_mode: "contained-write",
  });
  const detail = await waitForStatus(run, ["completed"]);

  expect(await readFile(join(workdirRoot, "calc.py"), "utf8")).toBe("print(6 * 7)\n");
  expect(detail.permission_mode).toBe("contained-write");
  expect(detail.plan.phases).toEqual([{ name: "实现", tasks: [
    { content: "写脚本", status: "completed" },
    { content: "运行验证", status: "completed" },
  ] }]);
  const tools = detail.tools as Array<{ name: string; status: string; summary?: string }>;
  expect(tools.map((item) => [item.name, item.status])).toEqual([
    ["todo", "succeeded"],
    ["workdir.write_file", "succeeded"],
    ["sandbox.exec", "succeeded"],
    ["todo", "succeeded"],
  ]);
  expect(tools[1]!.summary).toBe("写入 calc.py (13 B)");
  expect(tools[2]!.summary).toMatch(/^exit 0 · \d+ ms$/);
  expect(detail.sandbox).toMatchObject({ kind: "macos-seatbelt", network: "denied" });

  const trace = await api(`/api/workbench/runs/${run}/trace`);
  expect(trace.status).toBe(200);
  const spans = (trace.body as { spans: Array<{ kind: string; name: string; status: string }> }).spans;
  expect(spans.filter((span) => span.kind === "turn")).toHaveLength(5);
  expect(spans.filter((span) => span.kind === "tool").map((span) => span.name)).toEqual([
    "execute_tool workdir.write_file",
    "execute_tool sandbox.exec",
  ]);
}, 90_000);

test("a readonly Run with a workdir can browse but is not offered write or exec tools", async () => {
  const session = await createSession();
  script = async function* (context) {
    const names = (context.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["todo", "workdir.list", "workdir.search"]));
    for (const forbidden of ["workdir.write_file", "workdir.edit_file", "sandbox.exec"]) expect(names).not.toContain(forbidden);
    if (lastToolResult(context) === undefined) {
      yield tool("search-1", "workdir.search", { pattern: "MARKER-GENERAL-AGENT" });
      return;
    }
    expect(JSON.parse(lastToolResult(context)!.content)).toMatchObject({ matches: [expect.objectContaining({ path: "README.md", line: 2 })] });
    yield text("找到了标记。");
  };
  const run = await submit(session, { prompt: "找到标记", source_event_id: "ga-readonly-1", resource_refs: [`workdir:${workdirId}`] });
  const detail = await waitForStatus(run, ["completed"]);
  expect(detail.permission_mode).toBe("readonly");
  expect(detail.sandbox).toBeUndefined();
}, 60_000);

test("streaming text is visible on the run projection before the response completes", async () => {
  const session = await createSession();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  script = async function* (_context, observer) {
    observer?.onDelta({ type: "reasoning", text: "思考" });
    observer?.onDelta({ type: "text", contentIndex: 0, text: "第一段" });
    await gate;
    yield text("第一段，完整回答。");
  };
  const run = await submit(session, { prompt: "流式", source_event_id: "ga-stream-1" });
  const streaming = await waitFor(async () => {
    const detail = (await api(`/api/workbench/runs/${run}`)).body as Record<string, any>;
    return detail.live_output?.text === "第一段" ? detail : undefined;
  });
  expect(streaming.status).toBe("running");
  expect(streaming.live_output).toMatchObject({ text: "第一段", reasoning_chars: 2, request_index: 1 });
  release();
  const done = await waitForStatus(run, ["completed"]);
  expect(done.live_output).toBeUndefined();
}, 60_000);

test("steer reaches a running Run and is refused after it ends", async () => {
  const session = await createSession();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  let step = 0;
  script = async function* (context) {
    step += 1;
    if (step === 1) {
      await gate;
      yield tool("plan-steer", "todo", { op: "init", list: [{ phase: "步骤", items: ["一"] }] });
      return;
    }
    expect(JSON.stringify(context.messages)).toContain("请改用英文回答");
    yield text("OK, switching to English.");
  };
  const run = await submit(session, { prompt: "慢慢做", source_event_id: "ga-steer-1" });
  await waitForStatus(run, ["running"]);
  await waitFor(async () => contexts.length > 0 && step >= 1 ? true : undefined);
  const steer = api(`/api/workbench/runs/${run}/steer`, { method: "POST", body: { text: "请改用英文回答" } });
  // Let the steer frame reach the worker's queue while the model request is still open.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  release();
  const accepted = await steer;
  expect(accepted.status).toBe(202);
  expect(accepted.body).toMatchObject({ accepted: true });
  await waitForStatus(run, ["completed"]);
  const late = await api(`/api/workbench/runs/${run}/steer`, { method: "POST", body: { text: "太晚了" } });
  expect(late.body).toMatchObject({ accepted: false, status: "completed" });
}, 60_000);

test("a Goal continues while its plan is open and waits for the user to confirm completion", async () => {
  const session = await createSession();
  const steps = new Map<string, number>();
  script = async function* (context) {
    // Continuation Runs also carry the earlier Runs as conversation history, so
    // classify by the Host-authored continuation prompt.
    const continuationPrompt = context.messages.find((message) => message.role === "user" && String(message.content).includes("【目标续跑"));
    const firstUser = continuationPrompt === undefined ? "" : String(continuationPrompt.content);
    const key = continuationPrompt !== undefined ? "continuation" : "first";
    const step = (steps.get(key) ?? 0) + 1;
    steps.set(key, step);
    if (key === "first") {
      expect(context.systemPrompt).toContain("Goal mode (user-authorized)");
      if (step === 1) yield tool("g1-init", "todo", { op: "init", list: [{ phase: "调研", items: ["整理资料"] }, { phase: "成文", items: ["写总结"] }] });
      else if (step === 2) yield tool("g1-done", "todo", { op: "done", phase: "调研" });
      else yield text("资料已整理，总结留到下一轮。");
      return;
    }
    expect(firstUser).toContain("【目标续跑 2/3】");
    expect(firstUser).toContain("[x] 整理资料");
    // OMP starts the next open item automatically, so it is carried over as in progress.
    expect(firstUser).toContain("[>] 写总结");
    if (step === 1) yield tool("g2-init", "todo", { op: "init", list: [{ phase: "调研", items: ["整理资料"] }, { phase: "成文", items: ["写总结"] }] });
    else if (step === 2) yield tool("g2-done", "todo", { op: "done", phase: "调研" });
    else if (step === 3) yield tool("g2-done-2", "todo", { op: "done", phase: "成文" });
    else yield text("总结已写完。");
  };
  const created = await api(`/api/workbench/sessions/${session}/goal`, {
    method: "POST",
    body: { objective: "目标：调研并写一份总结", source_event_id: "ga-goal-1", max_runs: 3 },
  });
  expect(created.status).toBe(201);
  const goal = created.body as { goal: Record<string, any>; run_id: string };
  expect(goal.goal).toMatchObject({ status: "active", max_runs: 3, runs_used: 1, permission_mode: "readonly" });

  const review = await waitFor(async () => {
    const detail = (await api(`/api/workbench/sessions/${session}`)).body as Record<string, any>;
    return detail.goal?.status === "awaiting_review" ? detail : undefined;
  }, 60_000);
  expect(review.goal).toMatchObject({ runs_used: 2, last_reason: "plan_complete", plan_progress: { completed: 2, total: 2 } });
  const runs = review.runs as Array<Record<string, any>>;
  expect(runs.map((item) => [item.trigger, item.goal_id === goal.goal.goal_id, item.status])).toEqual([
    ["user", true, "completed"],
    ["goal_continuation", true, "completed"],
  ]);
  expect(String(runs[1]!.prompt)).toMatch(/^【目标续跑 2\/3】/);

  expect((await api(`/api/workbench/sessions/${session}/goal/pause`, { method: "POST", body: {} })).body).toEqual({ code: "goal_not_active" });
  const completed = await api(`/api/workbench/sessions/${session}/goal/complete`, { method: "POST", body: {} });
  expect(completed.body).toMatchObject({ goal: { status: "completed", last_reason: "user_confirmed" } });
  const again = await api(`/api/workbench/sessions/${session}/goal`, {
    method: "POST",
    body: { objective: "目标：调研并写一份总结", source_event_id: "ga-goal-1" },
  });
  expect(again.status).toBe(200);
}, 120_000);

test("stopping a Goal Run pauses the Goal, and resume starts a continuation", async () => {
  const session = await createSession();
  let release!: () => void;
  let gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  let continuation = false;
  script = async function* (context) {
    if (JSON.stringify(context.messages).includes("【目标续跑")) {
      continuation = true;
      yield text("恢复后继续完成。");
      return;
    }
    await gate;
    yield text("不会到这里");
  };
  const created = await api(`/api/workbench/sessions/${session}/goal`, {
    method: "POST",
    body: { objective: "目标：长任务", source_event_id: "ga-goal-stop", max_runs: 2 },
  });
  const firstRun = (created.body as { run_id: string }).run_id;
  await waitForStatus(firstRun, ["running"]);
  const stopped = await api(`/api/workbench/runs/${firstRun}/stop`, { method: "POST", body: { reason: "用户停止" } });
  expect(stopped.status).toBe(202);
  release();
  gate = Promise.resolve();
  const paused = await waitFor(async () => {
    const detail = (await api(`/api/workbench/sessions/${session}`)).body as Record<string, any>;
    return detail.goal?.status === "paused" ? detail.goal : undefined;
  });
  expect(paused).toMatchObject({ last_reason: "run_cancelled", runs_used: 1 });

  const resumed = await api(`/api/workbench/sessions/${session}/goal/resume`, { method: "POST", body: {} });
  expect(resumed.status).toBe(200);
  const resumedBody = resumed.body as { goal: Record<string, any>; run_id: string };
  expect(resumedBody.goal).toMatchObject({ status: "active", runs_used: 2 });
  await waitForStatus(resumedBody.run_id, ["completed"]);
  expect(continuation).toBe(true);
  // The continuation finished without a plan: a model answer alone never completes a Goal.
  const settled = await waitFor(async () => {
    const detail = (await api(`/api/workbench/sessions/${session}`)).body as Record<string, any>;
    return detail.goal?.status === "awaiting_review" ? detail.goal : undefined;
  });
  expect(settled.last_reason).toBe("final_answer_without_plan");
  expect((await api(`/api/workbench/sessions/${session}/goal/resume`, { method: "POST", body: {} })).body)
    .toEqual({ code: "goal_not_resumable" });
}, 90_000);

test("after a Host crash, the interrupted Goal Run is settled at start and the Goal can resume", async () => {
  // R-standards2 P1.2. A crash leaves the Goal active with its latest Run running;
  // a consistent copy of the durable state taken while the Run is running is exactly
  // what the next Host process finds on disk.
  const session = await createSession();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  script = async function* (context) {
    if (JSON.stringify(context.messages).includes("【目标续跑")) {
      yield text("重启后继续完成。");
      return;
    }
    await gate;
    yield text("原进程里的这一轮");
  };
  const created = await api(`/api/workbench/sessions/${session}/goal`, {
    method: "POST",
    body: { objective: "目标：跨重启的长任务", source_event_id: "ga-goal-crash", max_runs: 3 },
  });
  const firstRun = (created.body as { run_id: string }).run_id;
  await waitForStatus(firstRun, ["running"]);

  const crashed = await mkdtemp(join(directory, "crashed-"));
  const database = new DatabaseSync(join(directory, "events.sqlite"));
  database.exec(`VACUUM INTO '${join(crashed, "events.sqlite")}'`);
  database.close();
  for (const name of await readdir(directory)) {
    if (name.startsWith("sessions.json")) await copyFile(join(directory, name), join(crashed, name));
  }
  release();
  await waitForStatus(firstRun, ["completed"]);

  const restartedSessions = new ProductSessionStore(join(crashed, "sessions.json"));
  const restartedLive = await createLiveHarnessV2Runtime({
    runtimeConfigPath: join(directory, "runtime.json"),
    eventStorePath: join(crashed, "events.sqlite"),
    workspaceRoot: join(directory, "workspace"),
    surfaces: ["chat", "create", "crew"],
    requireOmp: true,
    ompRuntimeRoot: materializedRoot,
    productTaskFor: async (runId) => (await restartedSessions.get(runId))?.task,
    productTaskPeek: (runId) => restartedSessions.peek(runId)?.task,
    businessOrigin: business.origin,
    businessServiceToken: "wb01-business-service-token",
    protectedPaths: [join(crashed, "events.sqlite"), join(crashed, "sessions.json")],
    ompModelTransport: (context, _signal, observer) => script(context, observer),
  });
  const restarted = await startProductHost({
    runtime: restartedLive.runtime,
    eventStore: restartedLive.eventStore,
    host: "127.0.0.1",
    port: 0,
    serviceToken: "general-agent-restart-token",
    sessionStore: restartedSessions,
    staticRoot: directory,
    businessOrigin: business.origin,
    businessServiceToken: "wb01-business-service-token",
    goalSupervisorIntervalMs: 100,
  });
  try {
    const at = { origin: restarted.url };
    const interrupted = (await api(`/api/workbench/runs/${firstRun}`, at)).body as Record<string, any>;
    expect(interrupted.status).toBe("failed");
    const failedGoal = await waitFor(async () => {
      const detail = (await api(`/api/workbench/sessions/${session}`, at)).body as Record<string, any>;
      return detail.goal?.status === "failed" ? detail.goal : undefined;
    });
    expect(failedGoal).toMatchObject({ last_reason: "run_failed:process_restarted", runs_used: 1 });

    const resumed = await api(`/api/workbench/sessions/${session}/goal/resume`, { method: "POST", body: {}, ...at });
    expect(resumed.status).toBe(200);
    const resumedBody = resumed.body as { goal: Record<string, any>; run_id: string };
    expect(resumedBody.goal).toMatchObject({ status: "active", runs_used: 2 });
    const settled = await waitFor(async () => {
      const detail = (await api(`/api/workbench/sessions/${session}`, at)).body as Record<string, any>;
      return detail.goal?.status === "awaiting_review" ? detail : undefined;
    });
    expect((settled.runs as Array<Record<string, any>>).map((run) => [run.trigger, run.status])).toEqual([
      ["user", "failed"],
      ["goal_continuation", "completed"],
    ]);
  } finally {
    await restarted.close();
    await restartedLive.close();
  }
}, 120_000);

test("a Crew project Run proposes changes through the business adapter and cannot target another project", async () => {
  const project = await api("/api/crew/projects", {
    method: "POST",
    origin: business.origin,
    body: { goal_text: "通用 Agent 提案测试", sop_template_id: "marketing_collateral" },
  });
  expect(project.status).toBe(200);
  const projectId = (project.body as { id: string }).id;
  const created = await api("/api/workbench/sessions", { method: "POST", body: { surface: "crew", project_id: projectId } });
  expect(created.status).toBe(201);
  const session = (created.body as { session_id: string }).session_id;
  let step = 0;
  script = async function* (context) {
    step += 1;
    const names = (context.tools ?? []).map((tool) => tool.name);
    if (step === 1) {
      expect(names).toContain("crew.propose_changes");
      expect(context.systemPrompt).toContain("crew.propose_changes");
      yield tool("propose-foreign", "crew.propose_changes", {
        project_id: "proj_not_this_one",
        summary: "越权测试",
        new_tasks: [{ title: "越权任务", role: "设计" }],
      });
    } else if (step === 2) {
      expect(lastToolResult(context)).toMatchObject({ toolName: "crew.propose_changes", status: "failed" });
      expect(lastToolResult(context)!.content).toContain("capability_scope_not_authorized");
      yield tool("propose-1", "crew.propose_changes", {
        project_id: projectId,
        summary: "先做竞品调研再写文案",
        new_tasks: [{ title: "竞品调研", role: "设计", insert_before: ["文案撰写"], assignee_id: "acc_andy" }],
      });
    } else if (step === 3) {
      const result = lastToolResult(context)!;
      expect(result).toMatchObject({ toolName: "crew.propose_changes", status: "succeeded" });
      expect(JSON.parse(result.content)).toMatchObject({ status: "awaiting_confirmation", new_task_count: 1 });
      yield text("已提交协调提案，等待负责人确认。");
    }
  };
  const run = await submit(session, { surface: "crew", prompt: "加一个竞品调研，放在文案撰写之前，给 Andy", source_event_id: "ga-crew-1" });
  const detail = await waitForStatus(run, ["completed"]);
  const tools = detail.tools as Array<{ name: string; status: string; summary?: string }>;
  expect(tools.map((item) => [item.name, item.status])).toEqual([
    ["crew.propose_changes", "failed"],
    ["crew.propose_changes", "succeeded"],
  ]);
  expect(tools[1]!.summary).toBe("协调提案待确认 · 新任务 1 · 指派 0");

  const channel = await api(`/api/crew/projects/${projectId}/channel`, { origin: business.origin });
  const rows = (channel.body as { messages: unknown[] }).messages;
  const cards = (rows as Array<Record<string, any>>).filter((row) => row.payload?.source?.type === "workbench_run");
  expect(cards).toHaveLength(1);
  expect(cards[0]!.payload).toMatchObject({ origin: "anna_coordination", source: { run_id: run, tool_call_id: "propose-1" } });
  expect(cards[0]!.payload.drafts[0]).toMatchObject({ title: "竞品调研", insert_before: ["文案撰写"], assignee_id: "acc_andy" });
  // Nothing changed before confirmation.
  const facts = (await api(`/api/crew/projects/${projectId}`, { origin: business.origin })).body as { tasks: Array<{ title: string }> };
  expect(facts.tasks.map((task) => task.title)).not.toContain("竞品调研");
}, 90_000);

test("the Product Host answers review API paths with JSON instead of the SPA document", async () => {
  const response = await fetch(`${host.url}/v2/runs/any/trace`);
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
});

// ---------------------------------------------------------------- helpers

async function api(
  path: string,
  init: { method?: string; body?: unknown; origin?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${init.origin ?? host.url}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: business.authorization,
      "x-anna-workspace-id": business.workspaceId,
      "x-anna-user-id": business.actorUserId,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function createSession(): Promise<string> {
  const created = await api("/api/workbench/sessions", { method: "POST", body: { surface: "chat" } });
  expect(created.status).toBe(201);
  return (created.body as { session_id: string }).session_id;
}

async function submit(session: string, body: Record<string, unknown>): Promise<string> {
  const response = await api(`/api/workbench/sessions/${session}/runs`, { method: "POST", body: { surface: "chat", ...body } });
  expect(response.status).toBe(202);
  return (response.body as { run_id: string }).run_id;
}

async function waitForStatus(runId: string, statuses: string[]): Promise<Record<string, any>> {
  return waitFor(async () => {
    const detail = (await api(`/api/workbench/runs/${runId}`)).body as Record<string, any>;
    if (["failed", "timed_out", "cancelled"].includes(detail.status) && !statuses.includes(detail.status)) {
      throw new Error(`run ${runId} ended ${detail.status}`);
    }
    return statuses.includes(detail.status) ? detail : undefined;
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("condition not reached in time");
}

function tool(id: string, name: string, args: Record<string, unknown>): FixtureResponse {
  return {
    deltas: [{ type: "toolCall", contentIndex: 0, id, name, argumentsDelta: JSON.stringify(args) } as ModelDelta],
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" },
  };
}

function text(value: string): FixtureResponse {
  return {
    deltas: [{ type: "text", contentIndex: 0, text: value }],
    message: { role: "assistant", content: [{ type: "text", text: value }], stopReason: "stop" },
  };
}

function lastToolResult(context: ModelContext): { toolName: string; status: string; content: string } | undefined {
  const message = [...context.messages].reverse().find((item) => item.role === "toolResult");
  return message as { toolName: string; status: string; content: string } | undefined;
}
