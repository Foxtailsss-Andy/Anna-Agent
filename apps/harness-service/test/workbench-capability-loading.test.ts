import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

test("Workbench discovers and loads a Crew project capability before reading the project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-loading-"));
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
  let modelRequests = 0;
  let projectId = "";
  const modelContexts: Array<{ tools: string[]; messages: unknown[] }> = [];

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        goal_text: "WB-02 capability loading project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;

    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        modelRequests += 1;
        modelContexts.push({
          tools: (context.tools ?? []).map((tool) => tool.name),
          messages: context.messages as unknown[],
        });
        if (modelRequests === 1) {
          yield {
            deltas: [{
              type: "toolCall",
              contentIndex: 0,
              id: "capability-search-1",
              name: "capabilities.search",
              argumentsDelta: JSON.stringify({ query: "project" }),
            }],
            message: {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "capability-search-1",
                name: "capabilities.search",
                arguments: { query: "project" },
              }],
              stopReason: "toolUse",
            },
          };
          return;
        }
        if (modelRequests === 2) {
          yield {
            deltas: [{
              type: "toolCall",
              contentIndex: 0,
              id: "capability-load-1",
              name: "capabilities.load",
              argumentsDelta: JSON.stringify({ ids: ["crew.project.read"] }),
            }],
            message: {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "capability-load-1",
                name: "capabilities.load",
                arguments: { ids: ["crew.project.read"] },
              }],
              stopReason: "toolUse",
            },
          };
          return;
        }
        if (modelRequests === 3) {
          yield {
            deltas: [{
              type: "toolCall",
              contentIndex: 0,
              id: "project-read-1",
              name: "crew.project.read",
              argumentsDelta: JSON.stringify({ project_id: projectId }),
            }],
            message: {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "project-read-1",
                name: "crew.project.read",
                arguments: { project_id: projectId },
              }],
              stopReason: "toolUse",
            },
          };
          return;
        }
        yield {
          deltas: [{ type: "text", contentIndex: 0, text: "已读取项目事实" }],
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已读取项目事实" }],
            stopReason: "stop",
          },
        };
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-host-token",
      sessionStore: productSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const sessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ project_id: projectId, surface: "chat" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "读取当前项目事实",
        source_event_id: "wb02-capability-loading-1",
        surface: "chat",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const detail = await waitForRun(host.url, run.run_id, business.authorization);
    expect(detail.status).toBe("completed");
    expect(modelContexts).toHaveLength(4);
    expect(modelContexts[0]?.tools).toEqual(["capabilities.search", "capabilities.load"]);
    expect(modelContexts[1]?.tools).toEqual(["capabilities.search", "capabilities.load"]);
    expect(modelContexts[2]?.tools).toContain("crew.project.read");
    expect(modelContexts[3]?.tools).toContain("crew.project.read");
    expect(JSON.stringify(modelContexts[3]?.messages)).toContain("WB-02 capability loading project");
    expect(detail.events.filter((event) => event.type === "omp.tool.dispatch")).toHaveLength(3);
    expect(detail.events.filter((event) => event.type === "omp.tool.response")).toHaveLength(3);
    const loadEvent = detail.events.find((event) => event.type === "capability.loaded");
    expect(loadEvent?.capability_ids).toEqual(["crew.project.read"]);
    expect(typeof loadEvent?.catalog_hash).toBe("string");
    expect(typeof loadEvent?.load_tool_call_id).toBe("string");
    expect(typeof loadEvent?.load_dispatch_event_id).toBe("string");
    await writeWorkbenchReceipt({
      session_id: session.session_id,
      run_id: run.run_id,
      source_event_id: "wb02-capability-loading-1",
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
      tool_observations: detail.events
        .filter((event) => event.type === "omp.tool.dispatch" || event.type === "omp.tool.response")
        .map((event) => ({
          event_id: event.event_id,
          seq: event.seq,
          type: event.type,
          tool_name: event.tool_name,
          tool_status: event.tool_status,
          input_digest: event.input_digest,
        })),
      observed_project_fact: JSON.stringify(modelContexts[3]?.messages).includes("WB-02 capability loading project"),
      usage: "unavailable",
    }, "workbench-capability-loading.json");
  } finally {
    await host?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench chooses whether to load Crew channel facts from the project tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-channel-loading-"));
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
  const business = await startBusinessFixture(join(directory, "business.sqlite3"), `http://127.0.0.1:${hostPort}`);
  const productSessions = new ProductSessionStore(sessionStorePath);
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  const projectIds: string[] = [];
  const channelMarker = "WB02_CHANNEL_MARKER_observation_scope";
  const modelContexts: Array<{ tools: string[]; messages: unknown[] }> = [];
  const observedProjectDecisions: Array<{ projectId: string; next: "finish" | "load_channel" }> = [];
  try {
    for (const goalText of ["WB-02 observation is sufficient", "WB-02 observation needs-channel-fact"]) {
      const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({ goal_text: goalText, sop_template_id: "feature_iteration" }),
      });
      expect(projectResponse.status).toBe(200);
      projectIds.push((await projectResponse.json() as { id: string }).id);
    }
    const channelResponse = await fetch(`${business.origin}/api/crew/projects/${projectIds[1]}/channel`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ body: channelMarker, mentions: [] }),
    });
    expect(channelResponse.status).toBe(200);
    expect((await channelResponse.json() as { body: string }).body).toBe(channelMarker);
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await productSessions.get(runId))?.task,
      productTaskPeek: (runId) => productSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        modelContexts.push({ tools: (context.tools ?? []).map((tool) => tool.name), messages: context.messages as unknown[] });
        const messages = context.messages as unknown as readonly FixtureMessage[];
        const lastToolResult = [...messages].reverse().find((message) => message.role === "toolResult");
        if (lastToolResult === undefined) {
          yield capabilityToolResponse(`search-${modelContexts.length}`, "capabilities.search", { query: "project" });
          return;
        }
        const result = parseFixtureToolResult(lastToolResult);
        if (lastToolResult.toolName === "capabilities.search") {
          expect(result.results).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "crew.project.read", status: "available" }),
          ]));
          yield capabilityToolResponse(`load-project-${modelContexts.length}`, "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        if (lastToolResult.toolName === "capabilities.load") {
          const projectId = projectIds.find((id) => JSON.stringify(messages).includes(id));
          if (projectId === undefined) throw new Error("project id was not present in the model context");
          const loadedIds = Array.isArray(result.loaded)
            ? result.loaded
              .filter((item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null)
              .map((item: Record<string, unknown>) => item.id)
              .filter((id: unknown): id is string => typeof id === "string")
            : [];
          if (loadedIds.includes("crew.project.read")) {
            yield capabilityToolResponse(`project-read-${modelContexts.length}`, "crew.project.read", { project_id: projectId });
            return;
          }
          if (loadedIds.includes("crew.channel.read")) {
            yield capabilityToolResponse(`channel-read-${modelContexts.length}`, "crew.channel.read", { project_id: projectId });
            return;
          }
          throw new Error(`unexpected loaded capabilities: ${JSON.stringify(loadedIds)}`);
        }
        if (lastToolResult.toolName === "crew.project.read") {
          const projectId = projectIds.find((id) => JSON.stringify(messages).includes(id));
          if (projectId === undefined) throw new Error("project id was not present in the model context");
          const goalText = readProjectGoal(result);
          const next = goalText.includes("needs-channel-fact") ? "load_channel" : "finish";
          observedProjectDecisions.push({ projectId, next });
          if (next === "finish") {
            yield fixtureTextResponse("项目事实已足够");
          } else {
            yield capabilityToolResponse(`load-channel-${modelContexts.length}`, "capabilities.load", { ids: ["crew.channel.read"] });
          }
          return;
        }
        if (lastToolResult.toolName === "crew.channel.read") {
          expect(result.channel_messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: channelMarker }),
          ]));
          yield fixtureTextResponse(`项目事实与频道事实已读取：${channelMarker}`);
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
      serviceToken: "wb02-channel-host-token",
      sessionStore: productSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const sessions: Array<{ sessionId: string; runId: string; projectId: string }> = [];
    const details: Array<{ status: string; events: Array<Record<string, any> & { type: string }> }> = [];
    for (const [index, projectId] of projectIds.entries()) {
      const sessionResponse = await fetch(`${host.url}/api/workbench/sessions`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, surface: index === 0 ? "chat" : "create" }),
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { session_id: string };
      const runResponse = await fetch(`${host.url}/api/workbench/sessions/${session.session_id}/runs`, {
        method: "POST",
        headers: { authorization: business.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          prompt: `读取项目 ${projectId} 的事实`,
          source_event_id: `wb02-observation-${index + 1}`,
          surface: index === 0 ? "chat" : "create",
        }),
      });
      expect(runResponse.status).toBe(202);
      const run = await runResponse.json() as { run_id: string };
      sessions.push({ sessionId: session.session_id, runId: run.run_id, projectId });
      details.push(await waitForRun(host.url, run.run_id, business.authorization));
    }
    expect(details.every((detail) => detail.status === "completed")).toBe(true);
    expect(observedProjectDecisions).toEqual([
      { projectId: projectIds[0], next: "finish" },
      { projectId: projectIds[1], next: "load_channel" },
    ]);
    const dispatches = details.map((detail) => detail.events
      .filter((event) => event.type === "omp.tool.dispatch")
      .map((event) => event.tool_name));
    expect(dispatches[0]).toEqual(["capabilities.search", "capabilities.load", "crew.project.read"]);
    expect(dispatches[1]).toEqual([
      "capabilities.search",
      "capabilities.load",
      "crew.project.read",
      "capabilities.load",
      "crew.channel.read",
    ]);
    expect(details[0]?.events.some((event) => event.type === "capability.loaded"
      && event.capability_ids?.includes("crew.channel.read"))).toBe(false);
    expect(details[1]?.events.some((event) => event.type === "capability.loaded"
      && event.capability_ids?.includes("crew.channel.read"))).toBe(true);
    expect(JSON.stringify(modelContexts.at(-1)?.messages)).toContain(channelMarker);
    expect(JSON.stringify(details[1]?.events)).toContain(channelMarker);
    for (const [index, detail] of details.entries()) {
      await writeWorkbenchReceipt({
        session_id: sessions[index]?.sessionId,
        run_id: sessions[index]?.runId,
        project_id: sessions[index]?.projectId,
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
        tool_observations: detail.events
          .filter((event) => event.type === "omp.tool.dispatch" || event.type === "omp.tool.response")
          .map((event) => ({
            event_id: event.event_id,
            seq: event.seq,
            type: event.type,
            tool_name: event.tool_name,
            tool_status: event.tool_status,
            input_digest: event.input_digest,
          })),
        observation_branch: observedProjectDecisions[index]?.next,
        observed_channel_marker: index === 1 ? channelMarker : undefined,
        usage: "unavailable",
      }, `workbench-observation-${index + 1}.json`);
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

function parseFixtureToolResult(message: FixtureMessage): Record<string, any> {
  expect(message.role).toBe("toolResult");
  expect(message.status).toBe("succeeded");
  expect(typeof message.content).toBe("string");
  return JSON.parse(message.content as string) as Record<string, any>;
}

function readProjectGoal(result: Record<string, any>): string {
  expect(result.project).toEqual(expect.objectContaining({ goal_text: expect.any(String) }));
  return result.project.goal_text as string;
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

async function waitForRun(
  origin: string,
  runId: string,
  authorization: string,
): Promise<{ status: string; events: Array<Record<string, any> & { type: string }> }> {
  const startedAt = Date.now();
  let afterSeq = -1;
  const allEvents: Array<Record<string, any> & { type: string }> = [];
  let lastTypes: string[] = [];
  while (Date.now() - startedAt < fixtureRunObservationWindowMs) {
    const url = afterSeq < 0
      ? `${origin}/api/workbench/runs/${runId}/events`
      : `${origin}/api/workbench/runs/${runId}/events?after_seq=${afterSeq}`;
    const response = await fetch(url, {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      events: Array<Record<string, any> & { type: string }>;
      watermark: { seq?: number };
    };
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

async function writeWorkbenchReceipt(payload: Record<string, unknown>, filename: string): Promise<void> {
  const root = process.env.ANNA_WB02_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
