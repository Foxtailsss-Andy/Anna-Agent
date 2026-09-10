import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "vitest";

import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");
const fixtureRunObservationWindowMs = 30_000;
const terminalEventTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
  "run.awaiting_input",
  "run.awaiting_approval",
]);
const surfaces = ["chat", "create", "crew"] as const;
const projectMarker = "WB02_SURFACE_PROJECT_MARKER";

test("Workbench keeps the same admitted project capability reachable across chat, create, and crew", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-scope-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");
  const hostPort = await findFreePort();
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    `http://127.0.0.1:${hostPort}`,
  );
  const productSessions = new ProductSessionStore(sessionStorePath);
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let projectId = "";
  const modelContexts: Array<{ surface: string; tools: string[]; messages: unknown[] }> = [];

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ goal_text: projectMarker, sop_template_id: "feature_iteration" }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;

    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: [...surfaces],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        const messages = context.messages as unknown as readonly FixtureMessage[];
        const contextText = JSON.stringify(messages);
        const surface = surfaces.find((candidate) => contextText.includes(`surface=${candidate}`));
        if (surface === undefined) throw new Error("surface was not present in the model context");
        modelContexts.push({
          surface,
          tools: (context.tools ?? []).map((tool) => tool.name),
          messages: context.messages as unknown[],
        });

        if (!contextText.includes(projectId)) {
          expect(surface).toBe("create");
          yield fixtureTextResponse("普通文本已完成，无需产物");
          return;
        }

        const lastToolResult = [...messages].reverse().find((message) => message.role === "toolResult");
        if (lastToolResult === undefined) {
          yield capabilityToolResponse(`search-${surface}`, "capabilities.search", { query: "project" });
          return;
        }
        const result = lastToolResult.status === "failed"
          ? {}
          : parseFixtureToolResult(lastToolResult);
        if (lastToolResult.toolName === "capabilities.search") {
          expect(result.results).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "crew.project.read", status: "available" }),
          ]));
          yield capabilityToolResponse(`load-${surface}`, "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        if (lastToolResult.toolName === "capabilities.load") {
          expect(result.loaded).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "crew.project.read" }),
          ]));
          yield capabilityToolResponse(`project-read-${surface}`, "crew.project.read", { project_id: projectId });
          return;
        }
        if (lastToolResult.toolName === "crew.project.read") {
          expect(result.project).toEqual(expect.objectContaining({ goal_text: projectMarker }));
          yield fixtureTextResponse(`${surface} 已读取 ${projectMarker}`);
          return;
        }
        throw new Error(`unexpected tool result: ${lastToolResult.toolName}`);
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-scope-host-token",
      sessionStore: productSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const projectRuns = new Map<string, RunDetail>();
    const projectSessions = new Map<string, { sessionId: string; runId: string }>();
    for (const surface of surfaces) {
      const sessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, surface }),
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { session_id: string };
      const runResponse = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          prompt: `读取项目 ${projectId} 的事实（surface=${surface}）`,
          source_event_id: `wb02-scope-${surface}`,
          surface,
        }),
      });
      expect(runResponse.status).toBe(202);
      const run = await runResponse.json() as { run_id: string };
      projectSessions.set(surface, { sessionId: session.session_id, runId: run.run_id });
      projectRuns.set(surface, await waitForRun(host.url, run.run_id, business.authorization));
    }

    for (const surface of surfaces) {
      const detail = projectRuns.get(surface)!;
      expect(detail.status).toBe("completed");
      expect(JSON.stringify(detail.events)).toContain(projectMarker);
      const dispatchNames = detail.events
        .filter((event) => event.type === "omp.tool.dispatch")
        .map((event) => event.tool_name);
      expect(dispatchNames).toEqual(["capabilities.search", "capabilities.load", "crew.project.read"]);
      const loads = detail.events.filter((event) => event.type === "capability.loaded");
      expect(loads).toHaveLength(1);
      expect(loads[0]?.capability_ids).toEqual(["crew.project.read"]);
      expect(typeof loads[0]?.catalog_hash).toBe("string");
      expect(loads[0]?.capability_hashes).toEqual([expect.stringMatching(/^sha256:/)]);
    }

    const baselineModelRequest = modelContexts
      .filter((context) => context.surface === "chat")
      .map((context) => context.tools)
      .find((tools) => tools.includes("crew.project.read"));
    expect(baselineModelRequest).toEqual([
      "capabilities.search",
      "capabilities.load",
      "crew.project.read",
    ]);
    for (const surface of surfaces) {
      const loadedModelRequest = modelContexts
        .filter((context) => context.surface === surface)
        .map((context) => context.tools)
        .find((tools) => tools.includes("crew.project.read"));
      expect(loadedModelRequest).toEqual(baselineModelRequest);
    }

    const catalogHashes = surfaces.map((surface) => projectRuns.get(surface)!.events
      .find((event) => event.type === "capability.loaded")?.catalog_hash);
    expect(catalogHashes).toEqual([catalogHashes[0], catalogHashes[0], catalogHashes[0]]);
    const projectCapabilityHashes = surfaces.map((surface) => projectRuns.get(surface)!.events
      .find((event) => event.type === "capability.loaded")?.capability_hashes);
    expect(projectCapabilityHashes).toEqual([projectCapabilityHashes[0], projectCapabilityHashes[0], projectCapabilityHashes[0]]);

    const textSessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ surface: "create" }),
    });
    expect(textSessionResponse.status).toBe(201);
    const textSession = await textSessionResponse.json() as { session_id: string };
    const textRunResponse = await fetch(`${host.url}/api/workbench/sessions/${textSession.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "普通文本入口（surface=create）请直接回答，不需要产物",
        source_event_id: "wb02-scope-create-text",
        surface: "create",
      }),
    });
    expect(textRunResponse.status).toBe(202);
    const textRun = await textRunResponse.json() as { run_id: string };
    const textDetail = await waitForRun(host.url, textRun.run_id, business.authorization);
    expect(textDetail.status).toBe("completed");
    expect(textDetail.events.some((event) => event.type === "omp.tool.dispatch")).toBe(false);
    const textSessionProjection = await fetch(`${host.url}/api/workbench/sessions/${textSession.session_id}`, {
      headers: { authorization: business.authorization },
    });
    expect(textSessionProjection.status).toBe(200);
    const textRunProjection = (await textSessionProjection.json() as { runs: Array<Record<string, any>> }).runs
      .find((run) => run.run_id === textRun.run_id);
    expect(textRunProjection?.result?.assistant_message).toContain("普通文本已完成");
    expect(textRunProjection?.result?.artifact).toBeUndefined();
    expect(textRunProjection?.result?.tools_used).toBeUndefined();

    for (const surface of surfaces) {
      const detail = projectRuns.get(surface)!;
      const run = projectSessions.get(surface)!;
      await writeWorkbenchReceipt({
        session_id: run.sessionId,
        run_id: run.runId,
        surface,
        project_id: projectId,
        model_requests: detail.events
          .filter((event) => event.type === "run.model.requested")
          .map((event) => ({
            event_id: event.event_id,
            seq: event.seq,
            tool_definition_names: event.tool_definition_names,
            tool_definition_hashes: event.tool_definition_hashes,
          })),
        capability_loads: detail.events
          .filter((event) => event.type === "capability.loaded")
          .map((event) => ({
            event_id: event.event_id,
            seq: event.seq,
            catalog_hash: event.catalog_hash,
            capability_ids: event.capability_ids,
            capability_hashes: event.capability_hashes,
            load_tool_call_id: event.load_tool_call_id,
            load_dispatch_event_id: event.load_dispatch_event_id,
          })),
        observation_marker: projectMarker,
        usage: "unavailable",
      }, `workbench-scope-${surface}.json`);
    }
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench rechecks Crew project scope after load and keeps another Run working", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-revocation-"));
  const workspaceRoot = join(directory, "workspace");
  const businessDbPath = join(directory, "business.sqlite3");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  const sessionStorePath = join(directory, "sessions.json");
  const descriptor = await createOmpKernelDescriptor(materializedRoot);
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-only",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
    harness_v2_kernel: "omp",
    harness_v2_omp_runtime_root: materializedRoot,
    harness_v2_omp_descriptor: descriptor,
  }), "utf8");
  const hostPort = await findFreePort();
  const business = await startBusinessFixture(businessDbPath, `http://127.0.0.1:${hostPort}`);
  const productSessions = new ProductSessionStore(sessionStorePath);
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  const targetMarker = "WB02_REVOKED_PROJECT_MARKER";
  const normalMarker = "WB02_NORMAL_PROJECT_MARKER";
  const projectIds: string[] = [];
  const businessRequests: Array<{ path: string; status: number }> = [];
  const modelContexts: Array<{ messages: unknown[] }> = [];
  let targetMutated = false;

  try {
    for (const goalText of [targetMarker, normalMarker]) {
      const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({ goal_text: goalText, sop_template_id: "feature_iteration" }),
      });
      expect(projectResponse.status).toBe(200);
      projectIds.push((await projectResponse.json() as { id: string }).id);
    }
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      businessFetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        businessRequests.push({ path: String(input), status: response.status });
        return response;
      },
      ompModelTransport: async function* (context) {
        const messages = context.messages as unknown as readonly FixtureMessage[];
        modelContexts.push({ messages: context.messages as unknown[] });
        const contextText = JSON.stringify(messages);
        const projectId = projectIds.find((id) => contextText.includes(id));
        if (projectId === undefined) throw new Error("project id was not present in model context");
        const lastToolResult = [...messages].reverse().find((message) => message.role === "toolResult");
        if (lastToolResult === undefined) {
          yield capabilityToolResponse(`search-${projectId}`, "capabilities.search", { query: "project" });
          return;
        }
        const result = lastToolResult.status === "failed"
          ? {}
          : parseFixtureToolResult(lastToolResult);
        if (lastToolResult.toolName === "capabilities.search") {
          yield capabilityToolResponse(`load-${projectId}`, "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        if (lastToolResult.toolName === "capabilities.load") {
          expect(result.loaded).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "crew.project.read" }),
          ]));
          if (projectId === projectIds[0] && !targetMutated) {
            moveProjectToOtherWorkspace(businessDbPath, projectId);
            targetMutated = true;
          }
          yield capabilityToolResponse(`project-read-${projectId}`, "crew.project.read", { project_id: projectId });
          return;
        }
        if (lastToolResult.toolName === "crew.project.read") {
          if (lastToolResult.status === "failed") {
            expect(String(lastToolResult.content)).not.toContain(targetMarker);
            yield fixtureTextResponse("目标项目读取被拒绝");
          } else {
            expect(result.project).toEqual(expect.objectContaining({ goal_text: normalMarker }));
            yield fixtureTextResponse(`正常项目已读取 ${normalMarker}`);
          }
          return;
        }
        throw new Error(`unexpected tool result: ${lastToolResult.toolName}`);
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-revocation-host-token",
      sessionStore: productSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const details: RunDetail[] = [];
    const runReceipts: Array<{ sessionId: string; runId: string; sourceEventId: string; projectId: string }> = [];
    for (const [index, projectId] of projectIds.entries()) {
      const sessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, surface: "crew" }),
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { session_id: string };
      const runResponse = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          prompt: `读取项目 ${projectId} 的事实`,
          source_event_id: `wb02-revocation-${index + 1}`,
          surface: "crew",
        }),
      });
      expect(runResponse.status).toBe(202);
      const run = await runResponse.json() as { run_id: string };
      runReceipts.push({
        sessionId: session.session_id,
        runId: run.run_id,
        sourceEventId: `wb02-revocation-${index + 1}`,
        projectId,
      });
      details.push(await waitForRunAtKnownScope(
        live.eventStore,
        business.workspaceId,
        `crew_channel:${projectId}`,
        run.run_id,
      ));
    }

    expect(targetMutated).toBe(true);
    expect(details[0]?.status).toBe("completed");
    expect(details[1]?.status).toBe("completed");
    expect(details[0]?.events.some((event) => event.type === "omp.tool.dispatch"
      && event.tool_name === "crew.project.read")).toBe(true);
    expect(details[0]?.events.some((event) => event.type === "omp.tool.response"
      && event.tool_status === "failed")).toBe(true);
    expect(JSON.stringify(details[0]?.events)).not.toContain(targetMarker);
    expect(JSON.stringify(details[1]?.events)).toContain(normalMarker);
    expect(businessRequests.filter((request) => request.path.endsWith("/_business/crew/tools/call")).length).toBe(1);
    expect(modelContexts.some((context) => JSON.stringify(context.messages).includes(targetMarker))).toBe(false);

    for (const [index, detail] of details.entries()) {
      await writeWorkbenchReceipt({
        run_index: index,
        actual_run_id: runReceipts[index]?.runId,
        session_id: runReceipts[index]?.sessionId,
        source_event_id: runReceipts[index]?.sourceEventId,
        actual_status: detail.status,
        target_project_id: runReceipts[index]?.projectId,
        workspace_after_mutation: index === 0 ? "ws_other" : business.workspaceId,
        business_scope_recheck_statuses: businessRequests
          .filter((request) => request.path.endsWith("/_business/workbench/scope"))
          .map((request) => request.status),
        business_crew_tool_call_count: businessRequests
          .filter((request) => request.path.endsWith("/_business/crew/tools/call"))
          .length,
        target_business_io_reached: index === 0 ? false : true,
        capability_loads: detail.events
          .filter((event) => event.type === "capability.loaded")
          .map((event) => ({
            event_id: event.event_id,
            seq: event.seq,
            catalog_hash: event.catalog_hash,
            capability_ids: event.capability_ids,
            capability_hashes: event.capability_hashes,
            load_tool_call_id: event.load_tool_call_id,
            load_dispatch_event_id: event.load_dispatch_event_id,
          })),
        tool_observations: detail.events
          .filter((event) => event.type === "omp.tool.dispatch" || event.type === "omp.tool.response")
          .map((event) => ({
            event_id: event.event_id,
            seq: event.seq,
            type: event.type,
            tool_name: event.tool_name,
            tool_status: event.tool_status,
          })),
        observation_branch: index === 0 ? "revoked-before-business-read" : "normal-run-completed",
        usage: "unavailable",
      }, `workbench-revocation-${index + 1}.json`);
    }
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

type FixtureMessage = {
  readonly role?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly content?: unknown;
};

type RunDetail = {
  readonly status: string;
  readonly events: Array<Record<string, any> & { type: string }>;
};

function parseFixtureToolResult(message: FixtureMessage): Record<string, any> {
  expect(message.role).toBe("toolResult");
  expect(message.status).toBe("succeeded");
  expect(typeof message.content).toBe("string");
  return JSON.parse(message.content as string) as Record<string, any>;
}

function capabilityToolResponse(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
): {
  readonly deltas: readonly [{ readonly type: "toolCall"; readonly contentIndex: 0; readonly id: string; readonly name: string; readonly argumentsDelta: string }];
  readonly message: { readonly role: "assistant"; readonly content: readonly [{ readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }]; readonly stopReason: "toolUse" };
} {
  return {
    deltas: [{ type: "toolCall", contentIndex: 0, id, name, argumentsDelta: JSON.stringify(argumentsValue) }],
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: argumentsValue }], stopReason: "toolUse" },
  };
}

function fixtureTextResponse(text: string): {
  readonly deltas: readonly [{ readonly type: "text"; readonly contentIndex: 0; readonly text: string }];
  readonly message: { readonly role: "assistant"; readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly stopReason: "stop" };
} {
  return {
    deltas: [{ type: "text", contentIndex: 0, text }],
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  };
}

async function waitForRun(origin: string, runId: string, authorization: string): Promise<RunDetail> {
  const startedAt = Date.now();
  let afterSeq = -1;
  const allEvents: RunDetail["events"] = [];
  let lastTypes: string[] = [];
  while (Date.now() - startedAt < fixtureRunObservationWindowMs) {
    const url = afterSeq < 0
      ? `${origin}/api/workbench/runs/${runId}/events`
      : `${origin}/api/workbench/runs/${runId}/events?after_seq=${afterSeq}`;
    const response = await fetch(url, {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { events: RunDetail["events"] };
    allEvents.push(...body.events);
    if (body.events.length > 0) afterSeq = body.events.at(-1)?.seq ?? afterSeq;
    lastTypes = allEvents.map((event) => event.type);
    const terminal = [...allEvents].reverse().find((event) => terminalEventTypes.has(event.type));
    if (terminal !== undefined) {
      if (terminal.type !== "run.completed") {
        throw new Error(`Workbench Run ${runId} ended with ${terminal.type} at seq ${terminal.seq}`);
      }
      return { status: "completed", events: allEvents };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Workbench Run did not terminate within ${fixtureRunObservationWindowMs}ms: ${runId}; last events: ${lastTypes.slice(-5).join(",")}; after_seq=${afterSeq}`);
}

async function waitForRunAtKnownScope(
  eventStore: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>>["eventStore"],
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<RunDetail> {
  const startedAt = Date.now();
  let lastTypes: string[] = [];
  let afterSeq = -1;
  const allEvents: RunDetail["events"] = [];
  while (Date.now() - startedAt < fixtureRunObservationWindowMs) {
    const events: Array<Record<string, any> & { type: string }> = [];
    const scoped = eventStore.scope({
      workspaceId: workspaceId as never,
      channelId: channelId as never,
    });
    const source = afterSeq < 0
      ? scoped.read(runId as never)
      : scoped.read(runId as never, afterSeq);
    for await (const event of source) {
      const payload = typeof event.payload === "object" && event.payload !== null
        ? event.payload as Record<string, any>
        : {};
      const result = typeof payload.result === "object" && payload.result !== null
        ? payload.result as Record<string, any>
        : {};
      events.push({
        ...event,
        event_id: event.id,
        tool_name: typeof payload.tool === "string" ? payload.tool : undefined,
        tool_status: typeof result.status === "string" ? result.status : undefined,
      });
    }
    allEvents.push(...events);
    if (events.length > 0) afterSeq = events.at(-1)?.seq ?? afterSeq;
    lastTypes = allEvents.map((event) => event.type);
    const terminal = [...allEvents].reverse().find((event) => terminalEventTypes.has(event.type));
    if (terminal !== undefined) {
      if (terminal.type !== "run.completed") {
        throw new Error(`Workbench Run ${runId} ended with ${terminal.type} at seq ${terminal.seq}`);
      }
      return { status: "completed", events: allEvents };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Workbench Run did not terminate within ${fixtureRunObservationWindowMs}ms: ${runId}; last events: ${lastTypes.slice(-5).join(",")}; after_seq=${afterSeq}`);
}

async function writeWorkbenchReceipt(payload: Record<string, unknown>, filename: string): Promise<void> {
  const root = process.env.ANNA_WB02_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function moveProjectToOtherWorkspace(databasePath: string, projectId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(
      "SELECT payload, project_version FROM crew_projects WHERE project_id = ?",
    ).get(projectId) as { payload: string; project_version: number } | undefined;
    if (row === undefined) throw new Error(`project was not found in business store: ${projectId}`);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    payload.workspace_id = "ws_other";
    payload.owner_user_id = "acc_other";
    database.prepare(
      "UPDATE crew_projects SET workspace_id = ?, owner_user_id = ?, payload = ?, project_version = ?, updated_at = datetime('now') WHERE project_id = ? AND project_version = ?",
    ).run(
      "ws_other",
      "acc_other",
      JSON.stringify(payload),
      row.project_version + 1,
      projectId,
      row.project_version,
    );
  } finally {
    database.close();
  }
}
