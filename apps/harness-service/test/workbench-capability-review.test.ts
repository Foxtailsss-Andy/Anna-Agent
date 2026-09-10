import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteEventStore } from "@anna/event-store";
import {
  type CanonicalEvent,
  buildCapabilityCatalog,
  buildCapabilityDefinition,
  parseStartRun,
  resolveRunProfile,
  WORKBENCH_CAPABILITY_POLICY_VERSION,
  type CapabilityPolicySnapshot,
  type StartRun,
} from "@anna/harness-v2";
import { expect, test } from "vitest";

import {
  createProductionToolGateway,
} from "../src/production";
import { createLiveHarnessV2Runtime, createOmpKernelDescriptor } from "../src/production";
import { startProductHost } from "../src/product-facade";
import { ProductSessionStore } from "../src/product-session";
import { createWorkbenchCapabilityController } from "../src/workbench-capabilities";
import { findFreePort, startBusinessFixture } from "./workbench-session-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const materializedRoot = join(repositoryRoot, "build/omp-runtime/darwin-arm64");

test("Workbench preserves a historical capability catalog through Gateway and business read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-capability-review-"));
  await mkdir(join(directory, "workspace"), { recursive: true });
  const business = await startBusinessFixture(
    join(directory, "business.sqlite3"),
    "http://127.0.0.1:1",
  );
  const eventStore = new SqliteEventStore(join(directory, "events.sqlite"));

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: {
        authorization: business.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        goal_text: "WB-02 historical capability catalog",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    const projectId = (await projectResponse.json() as { id: string }).id;
    const historicalCapability = buildCapabilityDefinition({
      id: "crew.project.read",
      version: "0.9.0",
      description: "Read a historical Crew project snapshot.",
      source: "anna.workbench.crew.fixture-history",
      effect: "read",
      replayPolicy: "safe",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
        additionalProperties: false,
      },
    });
    const historicalPolicy: CapabilityPolicySnapshot = {
      version: WORKBENCH_CAPABILITY_POLICY_VERSION,
      catalog: buildCapabilityCatalog([historicalCapability]),
    };
    const allowedTools = ["capabilities.search", "capabilities.load", "crew.project.read"];
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
    const controller = createWorkbenchCapabilityController({
      projectId,
      loadedIds: [],
      capabilityPolicy: historicalPolicy,
      allowedTools,
      dynamicToolCall: async (request, signal) => {
        const response = await fetch(`${business.origin}/_business/crew/tools/call`, {
          method: "POST",
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-anna-service-token": "wb01-business-service-token",
          },
          body: JSON.stringify({
            workspace_id: business.workspaceId,
            actor_user_id: business.actorUserId,
            run_id: String(request.runId),
            name: request.name,
            arguments: request.input,
          }),
        });
        const payload = await response.json() as { result?: unknown };
        return response.ok
          ? { status: "succeeded", output: payload.result as never }
          : { status: "failed", output: { reason: "business_tool_failed" } };
      },
    });
    const model = {
      provider: "anna-openai-compatible",
      name: "fixture-model",
      reasoning: "high" as const,
    };
    const budget = { wallTimeMs: 180_000, turns: 12, toolCalls: 64 };
    const artifactContract = {
      kind: "run-result",
      requiredFor: ["completed", "failed", "timed_out", "cancelled"] as const,
      verification: "tests" as const,
    };
    const profile = resolveRunProfile({
      catalog: [],
      channelPolicy: {
        toolPolicy: { allowedTools },
        allowedSkillIds: [],
        allowedModels: [model],
        budgetLimits: budget,
        memoryPolicy: { allowedReadModes: ["channel"], allowedWriteModes: ["disabled"] },
      },
      workerProfile: {
        id: "worker:harness-v2-crew",
        version: "1.0.0",
        instructions: "Complete a Workbench read.",
        allowedSkillIds: [],
        allowedTools,
        modelPolicy: { allowedModels: [model] },
        budgetDefaults: budget,
        artifactContract,
      },
      runProfile: {
        id: "profile:harness-v2-crew",
        version: "1.0.0",
        model,
        skillIds: [],
        contextTransforms: [{ kind: "compact", preserve: ["goal", "constraints", "provenance"] }],
        toolPolicy: { allowedTools },
        budget,
        memoryPolicy: { read: "channel", write: "disabled" },
        evalPolicy: { contract: "required", quality: "disabled" },
        artifactContract,
        terminalRules: {
          allowedOutcomes: ["completed", "failed", "timed_out", "cancelled"],
          stopCondition: "artifact_or_terminal",
        },
        capabilityPolicy: historicalPolicy,
      },
    });
    const command = parseStartRun({
      commandId: "command-wb02-capability-review",
      runId: "run-wb02-capability-review",
      surfaceId: "crew",
      goal: "Read the historical project capability.",
      workspaceId: business.workspaceId,
      channelId,
      source: { eventId: "source-wb02-capability-review" },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission:workbench",
      stopCondition: profile.terminalRules.stopCondition,
    });
    await eventStore.scope({ workspaceId: business.workspaceId, channelId }).claimStart(command);
    const gateway = createProductionToolGateway({
      eventStore,
      command,
      workspaceRoot: join(directory, "workspace"),
      dynamicTools: allowedTools.map((name) => ({
        name,
        replayPolicy: "safe" as const,
        inputSchema: { parse: (input: unknown) => input },
      })),
      dynamicToolCall: (request, signal) => controller.execute(request, signal),
      trustedAuthorize: async (request) => {
        const response = await fetch(`${business.origin}/_business/workbench/scope`, {
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
        return response.ok ? "allow" : "deny";
      },
    });

    const search = await gateway.execute({
      workspaceId: business.workspaceId,
      channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "capabilities.search",
      input: { query: "project" },
      toolCallId: "historical-search-1",
    }, new AbortController().signal);
    expect(search).toMatchObject({ status: "succeeded" });
    expect(search.output).toMatchObject({
      results: [{
        id: historicalCapability.id,
        version: historicalCapability.version,
        description: historicalCapability.description,
        schema_hash: historicalCapability.hash,
        input_schema: historicalCapability.inputSchema,
      }],
    });

    const load = await gateway.execute({
      workspaceId: business.workspaceId,
      channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "capabilities.load",
      input: { ids: [historicalCapability.id] },
      toolCallId: "historical-load-1",
    }, new AbortController().signal);
    expect(load).toMatchObject({
      status: "succeeded",
      output: { loaded: [{
        id: historicalCapability.id,
        version: historicalCapability.version,
        hash: historicalCapability.hash,
        input_schema: historicalCapability.inputSchema,
      }] },
    });

    const read = await gateway.execute({
      workspaceId: business.workspaceId,
      channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: historicalCapability.id,
      input: { project_id: projectId },
      toolCallId: "historical-read-1",
    }, new AbortController().signal);
    expect(read.status).toBe("succeeded");
    expect(read.output).toMatchObject({
      project: { id: projectId, goal_text: "WB-02 historical capability catalog" },
    });
  } finally {
    eventStore.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("explicit Skill restrictions survive public Workbench entry points", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-wb02-explicit-skill-"));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const skillPath = join(directory, "explicit-skill.md");
  await writeFile(skillPath, `---
name: explicit-capability-review
version: 9.0.0
allowed_tools:
  - crew.project.read
  - crew.channel.read
forbidden_tools:
  - crew.channel.read
---

Use only the admitted Crew read capabilities and preserve their scope.
`, "utf8");
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
  const sessionStore = new ProductSessionStore(sessionStorePath);
  let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
  let host: Awaited<ReturnType<typeof startProductHost>> | undefined;
  const requestsBySource = new Map<string, number>();
  const observations: Array<{
    readonly surface: "chat" | "create" | "crew";
    readonly mode: "a" | "b";
    readonly command: StartRun;
    readonly events: readonly CanonicalEvent[];
  }> = [];
  const eventStore = new SqliteEventStore(eventStorePath);

  try {
    const projectResponse = await fetch(`${business.origin}/api/crew/projects`, {
      method: "POST",
      headers: { authorization: business.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        goal_text: "WB-02 explicit Skill restrictions",
        sop_template_id: "feature_iteration",
      }),
    });
    expect(projectResponse.status).toBe(200);
    const projectId = (await projectResponse.json() as { id: string }).id;

    live = await createLiveHarnessV2Runtime({
      runtimeConfigPath: configPath,
      eventStorePath,
      workspaceRoot,
      skillPath,
      surfaces: ["chat", "create", "crew"],
      requireOmp: true,
      ompRuntimeRoot: materializedRoot,
      productTaskFor: async (runId) => (await sessionStore.get(runId))?.task,
      productTaskPeek: (runId) => sessionStore.peek(runId)?.task,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
      ompModelTransport: async function* (context) {
        const sourceEventId = sourceEventIdFromMessages(context.messages);
        if (sourceEventId === undefined) throw new Error("missing source_event_id in model context");
        const requestIndex = (requestsBySource.get(sourceEventId) ?? 0) + 1;
        requestsBySource.set(sourceEventId, requestIndex);
        const mode = sourceEventId.endsWith("-a") ? "a" : "b";
        if (requestIndex === 1) {
          yield capabilityToolResponse(
            `${sourceEventId}-search`,
            "capabilities.search",
            { query: mode === "a" ? "project" : "channel" },
          );
          return;
        }
        if (requestIndex === 2) {
          yield capabilityToolResponse(
            `${sourceEventId}-load`,
            "capabilities.load",
            { ids: [mode === "a" ? "crew.project.read" : "crew.channel.read"] },
          );
          return;
        }
        if (requestIndex === 3) {
          yield capabilityToolResponse(
            `${sourceEventId}-read`,
            mode === "a" ? "crew.project.read" : "crew.channel.read",
            { project_id: projectId },
          );
          return;
        }
        yield fixtureTextResponse(`explicit skill ${mode} complete`);
      },
    });
    host = await startProductHost({
      runtime: live.runtime,
      eventStore: live.eventStore,
      host: "127.0.0.1",
      port: hostPort,
      serviceToken: "wb02-capability-restore-host-token",
      sessionStore,
      staticRoot: directory,
      businessOrigin: business.origin,
      businessServiceToken: "wb01-business-service-token",
    });

    for (const surface of ["chat", "create", "crew"] as const) {
      for (const mode of ["a", "b"] as const) {
        const sourceEventId = `wb02-explicit-skill-${surface}-${mode}`;
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
            prompt: `Run explicit Skill ${mode} through ${surface}.`,
            source_event_id: sourceEventId,
            surface,
          }),
        });
        expect(runResponse.status).toBe(202);
        const run = await runResponse.json() as { run_id: string };
        const task = await sessionStore.get(run.run_id);
        const channelId = task!.task.channel_id!;
        const scope = eventStore.scope({
          workspaceId: business.workspaceId as never,
          channelId: channelId as never,
        });
        const command = await scope.getRunCommand(run.run_id as never);
        expect(command).toBeDefined();
        const events = await waitForTerminalEvents(eventStore, business.workspaceId, channelId, run.run_id);
        observations.push({ surface, mode, command: command!, events });
      }
    }

    for (const observation of observations) {
      const allowedTools = observation.command!.runProfileSnapshot.allowedTools;
      const skills = observation.command!.runProfileSnapshot.skills;
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ version: "9.0.0", forbiddenTools: ["crew.channel.read"] });
      expect(allowedTools).toContain("crew.project.read");
      expect(allowedTools).not.toContain("crew.channel.read");
      if (observation.mode === "a") {
        expect(toolResponse(observation.events, "capabilities.search")).toMatchObject({
          payload: { result: { status: "succeeded" } },
        });
        expect(JSON.stringify(toolResponse(observation.events, "capabilities.search"))).toContain("crew.project.read");
        expect(toolResponse(observation.events, "capabilities.load")).toMatchObject({
          payload: { result: { status: "succeeded" } },
        });
        expect(toolResponse(observation.events, "crew.project.read")).toMatchObject({
          payload: { result: { status: "succeeded" } },
        });
      } else {
        expect(JSON.stringify(toolResponse(observation.events, "capabilities.search"))).not.toContain("crew.channel.read");
        expect(toolResponse(observation.events, "capabilities.load")).toMatchObject({
          payload: { result: { status: "failed" } },
        });
        const forbiddenRead = toolResponse(observation.events, "crew.channel.read");
        expect(forbiddenRead === undefined || !JSON.stringify(forbiddenRead).includes('"status":"succeeded"')).toBe(true);
      }
    }
  } finally {
    await host?.close();
    await live?.close();
    eventStore.close();
    await business.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

function sourceEventIdFromMessages(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    if (!isRecord(message) || typeof message.content !== "string") continue;
    const match = /"source_event_id":"([^"]+)"/.exec(message.content);
    if (match !== null) return match[1];
  }
  return undefined;
}

async function waitForTerminalEvents(
  store: SqliteEventStore,
  workspaceId: string,
  channelId: string,
  runId: string,
): Promise<CanonicalEvent[]> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const events: CanonicalEvent[] = [];
    for await (const event of store.scope({
      workspaceId: workspaceId as never,
      channelId: channelId as never,
    }).read(runId as never)) events.push(event);
    if (events.some((event) => ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(event.type))) {
      return events;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Run did not terminate: ${runId}`);
}

function toolResponse(events: readonly CanonicalEvent[], name: string): CanonicalEvent | undefined {
  return events.find((event) => {
    if (event.type !== "omp.tool.response" || !isRecord(event.payload)) return false;
    const toolCallId = event.payload.toolCallId;
    return typeof toolCallId === "string" && events.some((candidate) =>
      candidate.type === "omp.tool.dispatch"
      && isRecord(candidate.payload)
      && candidate.payload.toolCallId === toolCallId
      && candidate.payload.tool === name);
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilityToolResponse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): {
  readonly deltas: readonly [{ readonly type: "toolCall"; readonly contentIndex: 0; readonly id: string; readonly name: string; readonly argumentsDelta: string }];
  readonly message: { readonly role: "assistant"; readonly content: readonly [{ readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }]; readonly stopReason: "toolUse" };
} {
  return {
    deltas: [{ type: "toolCall", contentIndex: 0, id, name, argumentsDelta: JSON.stringify(input) }],
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], stopReason: "toolUse" },
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
