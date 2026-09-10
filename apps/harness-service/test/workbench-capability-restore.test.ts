import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import type { CanonicalEvent } from "@anna/harness-v2";
import { expect, test } from "vitest";

import { startHarnessService } from "../src/index";
import { startProductHost } from "../src/product-facade";
import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { HOST_CONTEXT_PROJECTION } from "../src/host-memory-context";
import {
  capabilityToolDescription,
  capabilityToolParameters,
  createWorkbenchCapabilityPolicy,
} from "../src/workbench-capabilities";
import { ProductSessionStore, validatedProductTask } from "../src/product-session";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("Workbench restores a successfully loaded capability and reads the project through the public resume route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-restore-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
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
  const initialSessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let projectId = "";
  const resumedModelContexts: Array<{ tools: string[]; messages: unknown[] }> = [];

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        goal_text: "WB-02 restore capability project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;

    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await initialSessions.get(runId))?.task,
      productTaskPeek: (runId) => initialSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        initialModelRequests += 1;
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("restore-search-1", "capabilities.search", { query: "project" });
          return;
        }
        if (initialModelRequests === 2) {
          yield capabilityToolResponse("restore-load-1", "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成加载检查点");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: initialSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ project_id: projectId, surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "恢复后读取当前项目事实",
        source_event_id: "wb02-capability-restore-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const taskRecord = await initialSessions.get(run.run_id);
    expect(taskRecord?.task.workspace_id).toBe(business.workspaceId);
    expect(taskRecord?.task.channel_id).toEqual(expect.any(String));
    const channelId = taskRecord!.task.channel_id!;

    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForLoadCheckpoint(
      initialLive.eventStore,
      business.workspaceId,
      channelId,
      run.run_id,
    );
    const contextProjection = await originalScope.loadProjection(
      HOST_CONTEXT_PROJECTION,
      run.run_id as never,
    );
    expect(contextProjection).toBeDefined();
    expect(initialModelRequests).toBeGreaterThanOrEqual(3);
    expect(checkpoint.some((event) => event.type === "capability.loaded")).toBe(true);
    expect(checkpoint.some((event) => isSuccessfulLoadObservation(event))).toBe(true);

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of checkpoint.filter((candidate) => !isTerminalEvent(candidate.type))) {
        await checkpointScope.append(event);
      }
      const started = checkpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        resumedModelContexts.push({
          tools: (context.tools ?? []).map((tool) => tool.name),
          messages: context.messages as unknown[],
        });
        if (resumedModelContexts.length === 1) {
          yield capabilityToolResponse("restore-project-read-1", "crew.project.read", { project_id: projectId });
          return;
        }
        expect(JSON.stringify(context.messages)).toContain("WB-02 restore capability project");
        yield fixtureTextResponse("恢复后已读取项目事实");
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({
      runtime: resumedLive.runtime,
      port: await findFreePort(),
    });

    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    expect(
      resumedEvents.some((event) => event.type === "run.completed"),
      JSON.stringify(resumedEvents.map((event) => ({
        type: event.type,
        reason: isRecord(event.payload) && typeof event.payload.reason === "string" ? event.payload.reason : undefined,
        error_code: isRecord(event.payload) && typeof event.payload.error_code === "string" ? event.payload.error_code : undefined,
        tool: toolName(event),
      }))) + ` contexts=${JSON.stringify(resumedModelContexts.map((context) => context.tools))}`,
    ).toBe(true);
    expect(resumedModelContexts).toHaveLength(2);
    expect(new Set(resumedModelContexts[0]?.tools)).toEqual(new Set([
      "capabilities.search",
      "capabilities.load",
      "crew.project.read",
    ]));
    const checkpointLastSeq = checkpoint.at(-1)?.seq ?? -1;
    expect(resumedEvents
      .filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")
      .map(toolName)).toEqual(["crew.project.read"]);
    expect(JSON.stringify(resumedModelContexts.at(-1)?.messages)).toContain("WB-02 restore capability project");
    await writeReceipt({
      run_id: run.run_id,
      checkpoint_event_types: checkpoint.map((event) => event.type),
      resumed_event_types: resumedEvents.map((event) => event.type),
      resumed_tool_names: resumedEvents.filter((event) => event.type === "omp.tool.dispatch").map(toolName),
      loaded_capability: "crew.project.read",
      observed_project: true,
    }, "workbench-capability-restore.json");
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench rejects a loaded receipt whose dispatch points to a different tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-restore-tamper-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
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
  const initialSessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let resumedModelRequests = 0;
  let projectId = "";

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 tampered dispatch project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;

    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await initialSessions.get(runId))?.task,
      productTaskPeek: (runId) => initialSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        initialModelRequests += 1;
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("tamper-search-1", "capabilities.search", { query: "project" });
          return;
        }
        if (initialModelRequests === 2) {
          yield capabilityToolResponse("tamper-load-1", "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        if (initialModelRequests === 3) {
          yield capabilityToolResponse("tamper-load-2", "capabilities.load", { ids: ["crew.channel.read"] });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成加载检查点");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: initialSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "恢复后读取项目并校验加载凭据",
        source_event_id: "wb02-capability-restore-tamper-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const taskRecord = await initialSessions.get(run.run_id);
    expect(taskRecord?.task.channel_id).toEqual(expect.any(String));
    const channelId = taskRecord!.task.channel_id!;
    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForToolCheckpointCount(
      initialLive.eventStore,
      business.workspaceId,
      channelId,
      run.run_id,
      "capabilities.load",
      2,
    );
    const contextProjection = await originalScope.loadProjection(HOST_CONTEXT_PROJECTION, run.run_id as never);
    expect(contextProjection).toBeDefined();
    const loadedEvents = checkpoint.filter((event) => event.type === "capability.loaded");
    expect(loadedEvents).toHaveLength(2);
    const secondLoadPayload = isRecord(loadedEvents[1]?.payload)
      ? loadedEvents[1]!.payload as Record<string, unknown>
      : undefined;
    const wrongDispatch = checkpoint.find((event) => event.type === "omp.tool.dispatch"
      && event.id === secondLoadPayload?.dispatchEventId);
    expect(wrongDispatch).toBeDefined();
    const loadedEvent = loadedEvents[0];
    const tamperedCheckpoint = checkpoint.map((event) => {
      if (event.id !== loadedEvent!.id || !isRecord(event.payload)) return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          dispatchEventId: wrongDispatch!.id,
        },
      };
    });

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of tamperedCheckpoint) await checkpointScope.append(event);
      const started = tamperedCheckpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        resumedModelRequests += 1;
        if (resumedModelRequests === 1) {
          yield capabilityToolResponse("tamper-project-read-1", "crew.project.read", { project_id: projectId });
          return;
        }
        yield fixtureTextResponse("不应到达的恢复结果");
        void context;
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({ runtime: resumedLive.runtime, port: await findFreePort() });
    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    const checkpointLastSeq = checkpoint.at(-1)?.seq ?? -1;
    expect(
      resumedEvents.some((event) => event.type === "run.failed"),
      JSON.stringify({
        terminal: resumedEvents.filter((event) => isTerminalEvent(event.type)).map((event) => event.type),
        resumedModelRequests,
        resumedDispatches: resumedEvents
          .filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")
          .map(toolName),
      }),
    ).toBe(true);
    expect(resumedModelRequests).toBe(0);
    expect(resumedEvents.filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")).toHaveLength(0);
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench rejects a load receipt whose definition disagrees with the load input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-receipt-tamper-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
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
  const initialSessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let resumedModelRequests = 0;
  let projectId = "";

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 receipt definition tamper project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;
    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await initialSessions.get(runId))?.task,
      productTaskPeek: (runId) => initialSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        initialModelRequests += 1;
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("receipt-search-1", "capabilities.search", { query: "project" });
          return;
        }
        if (initialModelRequests === 2) {
          yield capabilityToolResponse("receipt-load-1", "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成加载检查点");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: initialSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "恢复后读取项目并校验加载定义",
        source_event_id: "wb02-capability-receipt-tamper-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const taskRecord = await initialSessions.get(run.run_id);
    expect(taskRecord?.task.channel_id).toEqual(expect.any(String));
    const channelId = taskRecord!.task.channel_id!;
    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForLoadCheckpoint(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    const contextProjection = await originalScope.loadProjection(HOST_CONTEXT_PROJECTION, run.run_id as never);
    expect(contextProjection).toBeDefined();
    const loadedEvent = checkpoint.find((event) => event.type === "capability.loaded");
    const catalog = createWorkbenchCapabilityPolicy().catalog;
    const capabilityB = catalog.capabilities.find((capability) => capability.id === "crew.channel.read");
    expect(loadedEvent).toBeDefined();
    expect(capabilityB).toBeDefined();
    const tamperedCheckpoint = checkpoint.map((event) => {
      if (event.id !== loadedEvent!.id || !isRecord(event.payload)) return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          capabilities: [{
            id: capabilityB!.id,
            version: capabilityB!.version,
            hash: capabilityB!.hash,
            source: capabilityB!.source,
            effect: capabilityB!.effect,
            input_schema: capabilityB!.inputSchema,
          }],
        },
      };
    });
    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of tamperedCheckpoint) await checkpointScope.append(event);
      const started = tamperedCheckpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }
    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        resumedModelRequests += 1;
        if (resumedModelRequests === 1) {
          const names = new Set((context.tools ?? []).map((tool) => tool.name));
          const name = names.has("crew.channel.read") ? "crew.channel.read" : "crew.project.read";
          yield capabilityToolResponse("receipt-tamper-read-1", name, { project_id: projectId });
          return;
        }
        yield fixtureTextResponse("不应到达的恢复结果");
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({ runtime: resumedLive.runtime, port: await findFreePort() });
    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    const checkpointLastSeq = checkpoint.at(-1)?.seq ?? -1;
    expect(resumedEvents.some((event) => event.type === "run.failed")).toBe(true);
    expect(resumedModelRequests).toBe(0);
    expect(resumedEvents.filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")).toHaveLength(0);
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("v1 fixed read_only remains active when a real project task is present", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-v1-project-task-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "v1-project-source.txt"), "WB02_V1_PROJECT_MARKER", "utf8");
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
  const sessions = new ProductSessionStore(sessionStorePath);
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let service: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let modelRequests = 0;
  let firstModelTools: readonly string[] = [];

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 v1 project task",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    const projectId = (await projectResponse.json() as { id: string }).id;
    const scopeResponse = await fetch(`${business.origin}/_business/workbench/scope`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-anna-service-token": "wb01-business-service-token",
      },
      body: JSON.stringify({
        workspace_id: business.workspaceId,
        actor_user_id: business.actorUserId,
        project_id: projectId,
      }),
    });
    expect(scopeResponse.status).toBe(200);
    const channelId = (await scopeResponse.json() as { channel_id: string }).channel_id;
    const runId = "run-wb02-v1-project-task";
    const task = validatedProductTask({
      run_id: runId,
      workspace_id: business.workspaceId,
      actor_user_id: business.actorUserId,
      surface: "crew",
      prompt: "Read the v1 project source file.",
      channel_id: channelId,
      project_id: projectId,
      source_event_id: "source-wb02-v1-project-task",
    });
    await sessions.save(task);
    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (id) => (await sessions.get(id))?.task,
      productTaskPeek: (id) => sessions.peek(id)?.task,
      ompModelTransport: async function* (context) {
        modelRequests += 1;
        if (modelRequests === 1) firstModelTools = (context.tools ?? []).map((tool) => tool.name);
        if (modelRequests === 1) {
          yield capabilityToolResponse("v1-project-read-1", "read_only", { path: "v1-project-source.txt" });
          return;
        }
        yield fixtureTextResponse("v1 project read complete");
      },
    });
    service = await startHarnessService({ runtime: live.runtime, port: await findFreePort() });
    const startResponse = await fetch(`${service.url}/v2/surfaces/cowork/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: business.workspaceId,
        channel_id: channelId,
        command_id: "command-wb02-v1-project-task",
        run_id: runId,
        source_event_id: "source-wb02-v1-project-task",
        goal: task.prompt,
      }),
    });
    expect(startResponse.status).toBe(202);
    const events = await waitForTerminal(
      live.eventStore,
      business.workspaceId,
      channelId,
      runId,
    );
    await writeReceipt({
      first_model_tools: firstModelTools,
      terminal_events: events.filter((event) => ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(event.type)),
      tool_responses: events.filter((event) => event.type === "omp.tool.response"),
    }, "v1-project-task-actual.json");
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    expect(events.find((event) => event.type === "omp.tool.response" && isRecord(event.payload)
      && event.payload.toolCallId === "v1-project-read-1")?.payload).toMatchObject({
        result: { status: "succeeded", output: { content: "WB02_V1_PROJECT_MARKER" } },
      });
  } finally {
    await service?.close();
    await live?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("v1 fixed read_only checkpoint restores without business configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-v1-restore-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "v1-source.txt"), "WB02_V1_OLD_MARKER", "utf8");
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
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

  const workspaceId = "workspace-wb02-v1";
  const channelId = "channel-wb02-v1";
  const runId = "run-wb02-v1";
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let resumedModelRequests = 0;

  try {
    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      ompModelTransport: async function* () {
        initialModelRequests += 1;
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("v1-read-1", "read_only", { path: "v1-source.txt" });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成固定工具读取");
      },
    });
    initialService = await startHarnessService({
      runtime: initialLive.runtime,
      port: await findFreePort(),
    });
    const startResponse = await fetch(`${initialService.url}/v2/surfaces/cowork/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspaceId,
        channel_id: channelId,
        command_id: "command-wb02-v1",
        run_id: runId,
        source_event_id: "source-wb02-v1",
        goal: "Read the v1 source file and preserve fixed tool semantics.",
      }),
    });
    expect(startResponse.status).toBe(202);
    const originalScope = initialLive.eventStore.scope({
      workspaceId: workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(runId as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForToolResultCheckpoint(
      initialLive.eventStore,
      workspaceId,
      channelId,
      runId,
      "read_only",
      "v1-read-1",
    );
    const initialResponse = checkpoint.find((event) =>
      event.type === "omp.tool.response"
      && isRecord(event.payload)
      && event.payload.toolCallId === "v1-read-1",
    );
    expect(initialResponse).toBeDefined();
    expect(initialResponse?.payload).toMatchObject({
      result: { status: "succeeded", output: { content: "WB02_V1_OLD_MARKER" } },
    });
    const contextProjection = await originalScope.loadProjection(HOST_CONTEXT_PROJECTION, runId as never);
    expect(contextProjection).toBeDefined();
    expect(command!.runProfileSnapshot.capabilityPolicy).toBeUndefined();
    expect(initialModelRequests).toBeGreaterThanOrEqual(1);

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, workspaceId, channelId, runId);
    await initialService.close();
    initialService = undefined;
    await initialLive.close();
    initialLive = undefined;
    await writeFile(join(workspaceRoot, "v1-source.txt"), "WB02_V1_NEW_MARKER", "utf8");

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of checkpoint) await checkpointScope.append(event);
      const started = checkpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: runId as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["cowork"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      ompModelTransport: async function* (context) {
        resumedModelRequests += 1;
        if (resumedModelRequests === 1) {
          yield capabilityToolResponse("v1-read-restore-1", "read_only", { path: "v1-source.txt" });
          return;
        }
        expect(JSON.stringify(context.messages)).toContain("WB02_V1_NEW_MARKER");
        yield fixtureTextResponse("恢复后已读取固定工具结果");
      },
    });
    resumedService = await startHarnessService({
      runtime: resumedLive.runtime,
      port: await findFreePort(),
    });
    const resumeResponse = await fetch(`${resumedService.url}/v2/surfaces/cowork/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, workspaceId, channelId, runId);
    expect(resumedEvents.some((event) => event.type === "run.completed")).toBe(true);
    expect(resumedModelRequests).toBe(2);
    expect(resumedEvents.filter((event) => event.type === "omp.tool.dispatch").map(toolName).at(-1)).toBe("read_only");
    const resumedResponse = resumedEvents.find((event) =>
      event.type === "omp.tool.response"
      && isRecord(event.payload)
      && event.payload.toolCallId === "v1-read-restore-1",
    );
    expect(resumedResponse).toBeDefined();
    expect(resumedResponse?.payload).toMatchObject({
      result: { status: "succeeded", output: { content: "WB02_V1_NEW_MARKER" } },
    });
    const resumedToolResult = resumedEvents.find((event) =>
      event.type === "omp.transcript.message"
      && isRecord(event.payload)
      && isRecord(event.payload.message)
      && event.payload.message.role === "toolResult"
      && event.payload.message.toolCallId === "v1-read-restore-1",
    );
    expect(resumedToolResult?.payload).toMatchObject({
      message: { status: "succeeded", content: expect.stringContaining("WB02_V1_NEW_MARKER") },
    });
    await writeReceipt({
      run_id: runId,
      resumed_model_requests: resumedModelRequests,
      resumed_events: resumedEvents.map((event) => ({ type: event.type, tool: toolName(event) })),
    }, "workbench-v1-restore.json");
  } finally {
    releaseInitialModel.resolve();
    await resumedService?.close();
    await resumedLive?.close();
    await initialService?.close();
    await initialLive?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench rejects a model checkpoint that exposes capability A before its load receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-model-prefix-tamper-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
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
  const initialSessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let resumedModelRequests = 0;
  let projectId = "";
  const initialContexts: Array<{
    readonly systemPrompt: string;
    readonly messages: unknown[];
    readonly tools: Array<Record<string, unknown>>;
  }> = [];

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 model prefix tamper project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;

    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await initialSessions.get(runId))?.task,
      productTaskPeek: (runId) => initialSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        initialModelRequests += 1;
        initialContexts.push({
          systemPrompt: context.systemPrompt,
          messages: context.messages as unknown[],
          tools: (context.tools ?? []).map((tool) => tool as unknown as Record<string, unknown>),
        });
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("prefix-search-1", "capabilities.search", { query: "project" });
          return;
        }
        if (initialModelRequests === 2) {
          yield capabilityToolResponse("prefix-load-1", "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成加载检查点");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: initialSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "恢复后读取项目并校验模型工具前缀",
        source_event_id: "wb02-model-prefix-tamper-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const taskRecord = await initialSessions.get(run.run_id);
    expect(taskRecord?.task.channel_id).toEqual(expect.any(String));
    const channelId = taskRecord!.task.channel_id!;
    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForLoadCheckpoint(
      initialLive.eventStore,
      business.workspaceId,
      channelId,
      run.run_id,
    );
    await waitForContextCount(initialContexts, 3);
    const contextProjection = await originalScope.loadProjection(HOST_CONTEXT_PROJECTION, run.run_id as never);
    expect(contextProjection).toBeDefined();
    const secondRequestContext = initialContexts[1];
    const loadedDefinition = initialContexts[2]?.tools.find((tool) => tool.name === "crew.project.read");
    expect(secondRequestContext).toBeDefined();
    expect(loadedDefinition).toBeDefined();
    const tamperedCheckpoint = tamperModelToolPrefix(checkpoint, secondRequestContext!, loadedDefinition!);

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of tamperedCheckpoint) await checkpointScope.append(event);
      const started = tamperedCheckpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        resumedModelRequests += 1;
        yield capabilityToolResponse("prefix-tamper-project-read-1", "crew.project.read", { project_id: projectId });
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({ runtime: resumedLive.runtime, port: await findFreePort() });
    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    const checkpointLastSeq = checkpoint.at(-1)?.seq ?? -1;
    expect(resumedEvents.some((event) => event.type === "run.failed")).toBe(true);
    expect(resumedModelRequests).toBe(0);
    expect(resumedEvents.filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")).toHaveLength(0);
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench rejects a v2 model checkpoint that omits tool definitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-model-definitions-missing-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
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
  const initialSessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let resumedModelRequests = 0;
  let projectId = "";
  const initialContexts: Array<{
    readonly systemPrompt: string;
    readonly messages: unknown[];
    readonly tools: Array<Record<string, unknown>>;
  }> = [];

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 missing model definitions project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    projectId = (await projectResponse.json() as { id: string }).id;

    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await initialSessions.get(runId))?.task,
      productTaskPeek: (runId) => initialSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        initialModelRequests += 1;
        initialContexts.push({
          systemPrompt: context.systemPrompt,
          messages: context.messages as unknown[],
          tools: (context.tools ?? []).map((tool) => tool as unknown as Record<string, unknown>),
        });
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("missing-search-1", "capabilities.search", { query: "project" });
          return;
        }
        if (initialModelRequests === 2) {
          yield capabilityToolResponse("missing-load-1", "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成定义检查点");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: initialSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "恢复后读取项目并校验模型定义",
        source_event_id: "wb02-model-definitions-missing-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const taskRecord = await initialSessions.get(run.run_id);
    const channelId = taskRecord!.task.channel_id!;
    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForLoadCheckpoint(
      initialLive.eventStore,
      business.workspaceId,
      channelId,
      run.run_id,
    );
    await waitForContextCount(initialContexts, 2);
    const context = initialContexts[1];
    expect(context).toBeDefined();
    const tamperedCheckpoint = tamperMissingModelToolDefinitions(checkpoint, context!, [
      capabilityDefinitionForModel("crew.project.read"),
      capabilityDefinitionForModel("crew.channel.read"),
    ]);
    const contextProjection = await originalScope.loadProjection(HOST_CONTEXT_PROJECTION, run.run_id as never);
    expect(contextProjection).toBeDefined();

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of tamperedCheckpoint) await checkpointScope.append(event);
      const started = tamperedCheckpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        resumedModelRequests += 1;
        yield fixtureTextResponse("恢复模型不应被调用");
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({ runtime: resumedLive.runtime, port: await findFreePort() });
    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    expect(resumedEvents.some((event) => event.type === "run.failed")).toBe(true);
    expect(resumedModelRequests).toBe(0);
    const checkpointLastSeq = checkpoint.at(-1)?.seq ?? -1;
    expect(resumedEvents.filter((event) => event.seq > checkpointLastSeq && event.type === "omp.tool.dispatch")).toHaveLength(0);
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Workbench rejects a v2 model checkpoint with a tampered tool definition hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-model-definition-hash-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const configPath = join(directory, "runtime.json");
  const originalEventStorePath = join(directory, "events-original.sqlite");
  const checkpointEventStorePath = join(directory, "events-checkpoint.sqlite");
  const missingHashEventStorePath = join(directory, "events-checkpoint-missing-hash.sqlite");
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
  const sessions = new ProductSessionStore(sessionStorePath);
  const releaseInitialModel = deferred();
  let initialLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let initialHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumedLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let resumedHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let resumeService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let missingHashLive: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let missingHashHost: Awaited<ReturnType<typeof startProductHost>> | undefined;
  let missingHashService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
  let initialModelRequests = 0;
  let resumedModelRequests = 0;
  let missingHashModelRequests = 0;

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 model definition hash project",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    const projectId = (await projectResponse.json() as { id: string }).id;
    initialLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: originalEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessions.get(runId))?.task,
      productTaskPeek: (runId) => sessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        initialModelRequests += 1;
        if (initialModelRequests === 1) {
          yield capabilityToolResponse("hash-search-1", "capabilities.search", { query: "project" });
          return;
        }
        if (initialModelRequests === 2) {
          yield capabilityToolResponse("hash-load-1", "capabilities.load", { ids: ["crew.project.read"] });
          return;
        }
        await releaseInitialModel.promise;
        yield fixtureTextResponse("初轮已完成 hash 检查点");
      },
    });
    initialHost = await startProductHost({
      runtime: initialLive.runtime,
      eventStore: initialLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: sessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    const sessionResponse = await fetch(`${initialHost.url}/api/workbench/sessions`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId, surface: "create" }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { session_id: string };
    const runResponse = await fetch(`${initialHost.url}/api/workbench/sessions/${session.session_id}/runs`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "恢复后校验模型工具定义 hash",
        source_event_id: "wb02-model-definition-hash-1",
        surface: "create",
      }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { run_id: string };
    const task = await sessions.get(run.run_id);
    const channelId = task!.task.channel_id!;
    const originalScope = initialLive.eventStore.scope({
      workspaceId: business.workspaceId as never,
      channelId: channelId as never,
    });
    const command = await originalScope.getRunCommand(run.run_id as never);
    expect(command).toBeDefined();
    const checkpoint = await waitForLoadCheckpoint(
      initialLive.eventStore,
      business.workspaceId,
      channelId,
      run.run_id,
    );
    const tamperedCheckpoint = tamperModelToolDefinitionHash(checkpoint);
    const contextProjection = await originalScope.loadProjection(HOST_CONTEXT_PROJECTION, run.run_id as never);
    expect(contextProjection).toBeDefined();

    releaseInitialModel.resolve();
    await waitForTerminal(initialLive.eventStore, business.workspaceId, channelId, run.run_id);
    await initialHost.close();
    initialHost = undefined;
    await initialLive.close();
    initialLive = undefined;

    const checkpointStore = new SqliteEventStore(checkpointEventStorePath);
    try {
      const checkpointScope = checkpointStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await checkpointScope.claimStart(command!);
      for (const event of tamperedCheckpoint) await checkpointScope.append(event);
      const started = tamperedCheckpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await checkpointScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      checkpointStore.close();
    }

    const resumedSessions = new ProductSessionStore(sessionStorePath);
    resumedLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: checkpointEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await resumedSessions.get(runId))?.task,
      productTaskPeek: (runId) => resumedSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        resumedModelRequests += 1;
        yield fixtureTextResponse("被篡改 hash 的恢复不应调用模型");
      },
    });
    resumedHost = await startProductHost({
      runtime: resumedLive.runtime,
      eventStore: resumedLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: resumedSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    resumeService = await startHarnessService({ runtime: resumedLive.runtime, port: await findFreePort() });
    const resumeResponse = await fetch(`${resumeService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(resumeResponse.status).toBe(202);
    const resumedEvents = await waitForTerminal(resumedLive.eventStore, business.workspaceId, channelId, run.run_id);
    expect(resumedEvents.some((event) => event.type === "run.failed")).toBe(true);
    expect(resumedModelRequests).toBe(0);

    await resumeService.close();
    resumeService = undefined;
    await resumedHost.close();
    resumedHost = undefined;
    await resumedLive.close();
    resumedLive = undefined;

    const missingHashCheckpoint = tamperMissingModelToolDefinitionHashes(checkpoint);
    const missingHashStore = new SqliteEventStore(missingHashEventStorePath);
    try {
      const missingHashScope = missingHashStore.scope({
        workspaceId: business.workspaceId as never,
        channelId: channelId as never,
      });
      await missingHashScope.claimStart(command!);
      for (const event of missingHashCheckpoint) await missingHashScope.append(event);
      const started = missingHashCheckpoint.find((event) => event.type === "run.started");
      expect(started).toBeDefined();
      await missingHashScope.commitProjection({
        projector: HOST_CONTEXT_PROJECTION,
        streamId: run.run_id as never,
        eventId: started!.id,
        eventSeq: started!.seq,
        expectedVersion: 0,
        state: contextProjection!.state,
      });
    } finally {
      missingHashStore.close();
    }

    const missingHashSessions = new ProductSessionStore(sessionStorePath);
    missingHashLive = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath: missingHashEventStorePath,
      workspaceRoot,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await missingHashSessions.get(runId))?.task,
      productTaskPeek: (runId) => missingHashSessions.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* () {
        missingHashModelRequests += 1;
        yield fixtureTextResponse("缺失 hash 的恢复不应调用模型");
      },
    });
    missingHashHost = await startProductHost({
      runtime: missingHashLive.runtime,
      eventStore: missingHashLive.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore: missingHashSessions,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });
    missingHashService = await startHarnessService({ runtime: missingHashLive.runtime, port: await findFreePort() });
    const missingHashResume = await fetch(`${missingHashService.url}/v2/surfaces/create/runs/${run.run_id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: business.workspaceId, channel_id: channelId }),
    });
    expect(missingHashResume.status).toBe(202);
    const missingHashEvents = await waitForTerminal(missingHashLive.eventStore, business.workspaceId, channelId, run.run_id);
    expect(missingHashEvents.some((event) => event.type === "run.failed")).toBe(true);
    expect(missingHashModelRequests).toBe(0);
  } finally {
    releaseInitialModel.resolve();
    await resumeService?.close();
    await resumedHost?.close();
    await resumedLive?.close();
    await missingHashService?.close();
    await missingHashHost?.close();
    await missingHashLive?.close();
    await initialHost?.close();
    await initialLive?.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitForContextCount(
  contexts: readonly unknown[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (contexts.length >= count) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`expected ${count} model contexts, observed ${contexts.length}`);
}

function tamperModelToolPrefix(
  checkpoint: readonly CanonicalEvent[],
  context: {
    readonly systemPrompt: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly Record<string, unknown>[];
  },
  extraTool: Record<string, unknown>,
): CanonicalEvent[] {
  const request = checkpoint.find((event) => {
    if (event.type !== "run.model.requested" || !isRecord(event.payload)) return false;
    return event.payload.requestIndex === 2;
  });
  if (request === undefined || !isRecord(request.payload) || !Array.isArray(request.payload.toolDefinitions)) {
    throw new Error("second model checkpoint was not captured");
  }
  const toolDefinitions = [
    ...request.payload.toolDefinitions,
    extraTool,
  ];
  const inputDigest = sha256ForKernelEvidence(stableJsonForEvidence({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: toolDefinitions,
  }));
  const toolDefinitionHashes = toolDefinitions.map((tool) => sha256ForKernelEvidence(stableJsonForEvidence(tool)));
  return checkpoint.map((event) => {
    if (event.id !== request.id || !isRecord(event.payload)) return event;
    return {
      ...event,
      payload: {
        ...event.payload,
        toolDefinitions,
        toolDefinitionHashes,
        inputDigest,
      },
    };
  });
}

function capabilityDefinitionForModel(name: string): Record<string, unknown> {
  const description = capabilityToolDescription(name);
  const parameters = capabilityToolParameters(name);
  if (description === undefined || parameters === undefined) {
    throw new Error(`capability definition unavailable: ${name}`);
  }
  return { name, description, parameters };
}

function tamperMissingModelToolDefinitions(
  checkpoint: readonly CanonicalEvent[],
  context: {
    readonly systemPrompt: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly Record<string, unknown>[];
  },
  admittedExtras: readonly Record<string, unknown>[],
): CanonicalEvent[] {
  const request = checkpoint.find((event) => {
    if (event.type !== "run.model.requested" || !isRecord(event.payload)) return false;
    return event.payload.requestIndex === 2;
  });
  if (request === undefined || !isRecord(request.payload)) {
    throw new Error("second model checkpoint was not captured");
  }
  const inputDigest = sha256ForKernelEvidence(stableJsonForEvidence({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: [...context.tools, ...admittedExtras],
  }));
  return checkpoint.map((event) => {
    if (event.id !== request.id || !isRecord(event.payload)) return event;
    const { toolDefinitions: _toolDefinitions, toolDefinitionHashes: _toolDefinitionHashes, ...withoutDefinitions } = event.payload;
    return {
      ...event,
      payload: {
        ...withoutDefinitions,
        inputDigest,
      },
    };
  });
}

function tamperModelToolDefinitionHash(
  checkpoint: readonly CanonicalEvent[],
): CanonicalEvent[] {
  const request = checkpoint.find((event) => {
    if (event.type !== "run.model.requested" || !isRecord(event.payload)) return false;
    return event.payload.requestIndex === 2;
  });
  if (request === undefined || !isRecord(request.payload) || !Array.isArray(request.payload.toolDefinitionHashes)) {
    throw new Error("second model checkpoint hashes were not captured");
  }
  const hashes = request.payload.toolDefinitionHashes.map((hash, index) =>
    index === 0 && typeof hash === "string"
      ? `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`
      : hash,
  );
  return checkpoint.map((event) => {
    if (event.id !== request.id || !isRecord(event.payload)) return event;
    return {
      ...event,
      payload: { ...event.payload, toolDefinitionHashes: hashes },
    };
  });
}

function tamperMissingModelToolDefinitionHashes(
  checkpoint: readonly CanonicalEvent[],
): CanonicalEvent[] {
  const request = checkpoint.find((event) => {
    if (event.type !== "run.model.requested" || !isRecord(event.payload)) return false;
    return event.payload.requestIndex === 2;
  });
  if (request === undefined || !isRecord(request.payload)) {
    throw new Error("second model checkpoint was not captured");
  }
  return checkpoint.map((event) => {
    if (event.id !== request.id || !isRecord(event.payload)) return event;
    const { toolDefinitionHashes: _toolDefinitionHashes, ...withoutHashes } = event.payload;
    return { ...event, payload: withoutHashes };
  });
}

function sha256ForKernelEvidence(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJsonForEvidence(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

async function readRunEvents(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of store.scope({
    workspaceId: workspaceId as never,
    channelId: channelId as never,
  }).read(runId as never)) {
    events.push(event);
  }
  return events;
}

async function waitForLoadCheckpoint(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<CanonicalEvent[]> {
  return waitForToolCheckpoint(store, workspaceId, channelId, runId, "capabilities.load");
}

async function waitForToolCheckpoint(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
  expectedToolName: string,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events = await readRunEvents(store, workspaceId, channelId, runId);
    const observationIndex = events.findIndex((event) => isSuccessfulToolObservation(event, expectedToolName));
    if (observationIndex >= 0) return events.slice(0, observationIndex + 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${expectedToolName} checkpoint was not observed for ${runId}`);
}

async function waitForToolResultCheckpoint(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
  expectedToolName: string,
  expectedToolCallId: string,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events = await readRunEvents(store, workspaceId, channelId, runId);
    const observationIndex = events.findIndex((event) =>
      isToolResultObservation(event, expectedToolName, expectedToolCallId),
    );
    if (observationIndex >= 0) return events.slice(0, observationIndex + 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${expectedToolName}/${expectedToolCallId} result was not observed for ${runId}`);
}

async function waitForToolCheckpointCount(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
  expectedToolName: string,
  count: number,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events = await readRunEvents(store, workspaceId, channelId, runId);
    const observations = events.filter((event) => isSuccessfulToolObservation(event, expectedToolName));
    if (observations.length >= count) {
      const lastObservation = observations[count - 1]!;
      return events.slice(0, lastObservation.seq + 1);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${count} ${expectedToolName} checkpoints were not observed for ${runId}`);
}

async function waitForTerminal(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events = await readRunEvents(store, workspaceId, channelId, runId);
    if (events.some((event) => isTerminalEvent(event.type))) return events;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Run did not terminate: ${runId}`);
}

function isSuccessfulLoadObservation(event: CanonicalEvent): boolean {
  return isSuccessfulToolObservation(event, "capabilities.load");
}

function isSuccessfulToolObservation(event: CanonicalEvent, expectedToolName: string): boolean {
  return isToolResultObservation(event, expectedToolName) && isRecord(event.payload)
    && isRecord(event.payload.message)
    && event.payload.message.status === "succeeded";
}

function isToolResultObservation(
  event: CanonicalEvent,
  expectedToolName: string,
  expectedToolCallId?: string,
): boolean {
  if (event.type !== "omp.transcript.message" || !isRecord(event.payload)) return false;
  const message = isRecord(event.payload.message) ? event.payload.message : undefined;
  return message?.role === "toolResult"
    && message.toolName === expectedToolName
    && (expectedToolCallId === undefined || message.toolCallId === expectedToolCallId);
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(type);
}

function toolName(event: CanonicalEvent): string | undefined {
  if (event.type !== "omp.tool.dispatch" || !isRecord(event.payload)) return undefined;
  return typeof event.payload.tool === "string" ? event.payload.tool : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function writeReceipt(payload: Record<string, unknown>, filename: string): Promise<void> {
  const root = process.env.ANNA_WB02_RECEIPT_DIR;
  if (typeof root !== "string" || root.trim() === "") return;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
