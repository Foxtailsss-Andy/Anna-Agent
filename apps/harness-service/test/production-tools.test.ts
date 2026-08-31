import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { SqliteEventStore } from "@anna/event-store";
import {
  parseStartRun,
  type CanonicalEvent,
  type EventSink,
  type EventStore,
  type LoopKernel,
  type RunOutcome,
  type StartRun,
  type StreamId,
  type ToolResult,
} from "@anna/harness-v2";
import { PiLoopKernel } from "@anna/pi-loop-kernel";

import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
  createWebSearchProvider,
} from "../src/production";
import { validatedProductTask } from "../src/product-session";

async function productionCommand(
  webSearchEnabled = false,
  surface: "general" | "create" = "general",
  runId = surface === "create"
    ? "run:production-tools-create"
    : "run:production-tools-read",
): Promise<StartRun> {
  const profile = await createLiveProfile("fixture-model", undefined, webSearchEnabled, surface);
  return parseStartRun({
    commandId: "command:production-tools-read",
    runId,
    surfaceId: "chat",
    goal: "Read the approved note.",
    workspaceId: "workspace:production-tools",
    channelId: "channel:production-tools",
    source: { eventId: "event:production-tools-source" },
    runProfile: { id: profile.id, version: profile.version },
    runProfileSnapshot: profile,
    budget: profile.budget,
    permissionScope: "permission:production-tools",
    stopCondition: profile.terminalRules.stopCondition,
  });
}

test("production read_only uses the scoped durable ToolGateway lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-read-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();
  await writeFile(join(directory, "notes.txt"), "bounded read\n", "utf8");

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "read_only",
      input: { path: "notes.txt" },
      toolCallId: "tool-call-production-read",
    }, new AbortController().signal);

    expect(result).toEqual({
      status: "succeeded",
      output: { path: "notes.txt", content: "bounded read\n" },
    });

    const events: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      `tool:${command.runId}:tool-call-production-read` as never,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(events[1]?.payload).toEqual(expect.objectContaining({ decision: "allow" }));
    expect(events[2]?.payload).toEqual(expect.objectContaining({ status: "succeeded" }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Gateway keeps Hiker reads direct and keys local artifact writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-local-write-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const readProfile = await createLiveProfile("fixture-model", undefined, false, "hiker", "channel", undefined, true);
  const readCommand = parseStartRun({
    commandId: "command:production-tools-hiker-read",
    runId: "run:production-tools-hiker-read",
    surfaceId: "hiker",
    goal: "Read the approved Hiker capability.",
    workspaceId: "workspace:production-tools",
    channelId: "channel:production-tools-hiker",
    source: { eventId: "event:production-tools-hiker-source" },
    runProfile: { id: readProfile.id, version: readProfile.version },
    runProfileSnapshot: readProfile,
    budget: readProfile.budget,
    permissionScope: "permission:production-tools-hiker",
    stopCondition: readProfile.terminalRules.stopCondition,
  });
  const writeProfile = await createLiveProfile("fixture-model", undefined, false, "chat", "channel", undefined, true);
  const writeCommand = parseStartRun({
    commandId: "command:production-tools-chat-write",
    runId: "run:production-tools-chat-write",
    surfaceId: "chat",
    goal: "Write the approved document artifact.",
    workspaceId: "workspace:production-tools",
    channelId: "channel:production-tools-chat",
    source: { eventId: "event:production-tools-chat-source" },
    runProfile: { id: writeProfile.id, version: writeProfile.version },
    runProfileSnapshot: writeProfile,
    budget: writeProfile.budget,
    permissionScope: "permission:production-tools-chat",
    stopCondition: writeProfile.terminalRules.stopCondition,
  });
  const readRequests: unknown[] = [];
  const writeRequests: unknown[] = [];
  const readTool = {
    name: "hiker.system.list_capabilities",
    replayPolicy: "safe" as const,
    inputSchema: { parse(input: unknown) { return input; } },
  };
  const writeTool = {
    name: "chat.emit_document",
    replayPolicy: "never" as const,
    inputSchema: { parse(input: unknown) { return input; } },
  };

  try {
    const readGateway = createProductionToolGateway({
      eventStore: store,
      command: readCommand,
      workspaceRoot: directory,
      dynamicTools: [readTool],
      dynamicToolCall: async (request) => {
        readRequests.push(request);
        return { status: "succeeded", output: { write_tools_enabled: false } };
      },
    });
    await expect(readGateway.execute({
      workspaceId: readCommand.workspaceId,
      channelId: readCommand.channelId,
      runId: readCommand.runId,
      workerProfileId: readCommand.runProfileSnapshot.workerProfileId,
      name: readTool.name,
      input: {},
      toolCallId: "tool-call-hiker-capabilities",
    }, new AbortController().signal)).resolves.toEqual({
      status: "succeeded",
      output: { write_tools_enabled: false },
    });
    expect(readRequests).toHaveLength(1);
    expect(readRequests[0]).not.toHaveProperty("effectKey");

    const writeGateway = createProductionToolGateway({
      eventStore: store,
      command: writeCommand,
      workspaceRoot: directory,
      dynamicTools: [writeTool],
      dynamicToolCall: async (request) => {
        writeRequests.push(request);
        return { status: "succeeded", output: { artifact: { kind: "doc", title: "Brief", content: "# Brief" } } };
      },
    });
    const writeRequest = {
      workspaceId: writeCommand.workspaceId,
      channelId: writeCommand.channelId,
      runId: writeCommand.runId,
      workerProfileId: writeCommand.runProfileSnapshot.workerProfileId,
      name: writeTool.name,
      input: { title: "Brief", markdown: "# Brief" },
      toolCallId: "tool-call-chat-document",
    } as const;
    const first = await writeGateway.execute(writeRequest, new AbortController().signal);
    const second = await writeGateway.execute(writeRequest, new AbortController().signal);
    expect(first).toEqual({
      status: "succeeded",
      output: { artifact: { kind: "doc", title: "Brief", content: "# Brief" } },
    });
    expect(second).toEqual(first);
    expect(writeRequests).toHaveLength(1);
    expect(writeRequests[0]).toMatchObject({
      effectKey: "product-local-write:run:production-tools-chat-write:chat.emit_document:tool-call-chat-document",
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Gateway honors reimbursement reads, Crew proposals, and keyed intents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-business-effects-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const readProfile = await createLiveProfile("fixture-model", undefined, false, "reimbursement", "channel", undefined, true);
  const proposalProfile = await createLiveProfile("fixture-model", undefined, false, "crew", "channel", undefined, true);
  const intentProfile = await createLiveProfile("fixture-model", undefined, false, "reimbursement", "channel", undefined, true);
  const commandFor = (profile: Awaited<ReturnType<typeof createLiveProfile>>, surface: "reimbursement" | "crew", runId: string) =>
    parseStartRun({
      commandId: `command:${runId}`,
      runId,
      surfaceId: surface,
      goal: "Exercise the admitted business tool.",
      workspaceId: "workspace:production-business-effects",
      channelId: `channel:${surface}`,
      source: { eventId: `event:${runId}:source` },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: `permission:${runId}`,
      stopCondition: profile.terminalRules.stopCondition,
    });
  const readCommand = commandFor(readProfile, "reimbursement", "run:business-read");
  const proposalCommand = commandFor(proposalProfile, "crew", "run:business-proposal");
  const intentCommand = commandFor(intentProfile, "reimbursement", "run:business-intent");
  const requests: unknown[] = [];
  const readTool = {
    name: "reimbursement.get_policy",
    replayPolicy: "safe" as const,
    inputSchema: { parse(input: unknown) { return input; } },
  };
  const proposalTool = {
    name: "crew.emit_task_drafts",
    replayPolicy: "safe" as const,
    inputSchema: { parse(input: unknown) { return input; } },
  };
  const intentTool = {
    name: "reimbursement.submit_intent",
    replayPolicy: "never" as const,
    inputSchema: { parse(input: unknown) { return input; } },
  };
  const call = async (request: unknown) => {
    requests.push(request);
    return { status: "succeeded" as const, output: { accepted: true } };
  };

  try {
    const readGateway = createProductionToolGateway({
      eventStore: store,
      command: readCommand,
      workspaceRoot: directory,
      dynamicTools: [readTool],
      dynamicToolCall: call,
    });
    await expect(readGateway.execute({
      workspaceId: readCommand.workspaceId,
      channelId: readCommand.channelId,
      runId: readCommand.runId,
      workerProfileId: readCommand.runProfileSnapshot.workerProfileId,
      name: readTool.name,
      input: {},
      toolCallId: "call-business-read",
    }, new AbortController().signal)).resolves.toEqual({ status: "succeeded", output: { accepted: true } });
    expect(requests[0]).not.toHaveProperty("effectKey");

    const proposalGateway = createProductionToolGateway({
      eventStore: store,
      command: proposalCommand,
      workspaceRoot: directory,
      dynamicTools: [proposalTool],
      dynamicToolCall: call,
    });
    await expect(proposalGateway.execute({
      workspaceId: proposalCommand.workspaceId,
      channelId: proposalCommand.channelId,
      runId: proposalCommand.runId,
      workerProfileId: proposalCommand.runProfileSnapshot.workerProfileId,
      name: proposalTool.name,
      input: { drafts: [] },
      toolCallId: "call-business-proposal",
    }, new AbortController().signal)).resolves.toEqual({ status: "succeeded", output: { accepted: true } });
    expect(requests[1]).not.toHaveProperty("effectKey");

    const intentGateway = createProductionToolGateway({
      eventStore: store,
      command: intentCommand,
      workspaceRoot: directory,
      dynamicTools: [intentTool],
      dynamicToolCall: call,
    });
    const intentRequest = {
      workspaceId: intentCommand.workspaceId,
      channelId: intentCommand.channelId,
      runId: intentCommand.runId,
      workerProfileId: intentCommand.runProfileSnapshot.workerProfileId,
      name: intentTool.name,
      input: { external_reimbursement_id: "draft-1" },
      toolCallId: "call-business-intent",
    } as const;
    const first = await intentGateway.execute(intentRequest, new AbortController().signal);
    const second = await intentGateway.execute(intentRequest, new AbortController().signal);
    expect(first).toEqual({ status: "succeeded", output: { accepted: true } });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({
      effectKey: "product-business-effect:run:business-intent:reimbursement.submit_intent:call-business-intent",
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Runtime converts and dispatches a Crew proposal catalog entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-crew-proposal-runtime-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
  const task = validatedProductTask({
    run_id: "run:production-crew-proposal-runtime",
    workspace_id: "workspace:production-crew-proposal-runtime",
    actor_user_id: "actor:fixture",
    surface: "crew",
    prompt: "Draft the admitted project tasks.",
    context: {
      tool_catalog: [{
        name: "crew.emit_task_drafts",
        description: "Emit pure task draft proposals.",
        input_schema: {
          type: "object",
          properties: { drafts: { type: "array" } },
          required: ["drafts"],
          additionalProperties: false,
        },
        effect: "proposal",
        replay_policy: "safe",
      }],
    },
  });
  const businessRequests: Record<string, unknown>[] = [];
  let dispatched: ToolResult | undefined;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["crew"],
    businessOrigin: "https://business.fixture",
    businessServiceToken: "fixture-business-token",
    businessFetchImpl: async (_input, init) => {
      if (typeof init?.body === "string") businessRequests.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({
        result: { status: "succeeded", output: { drafts: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    productTaskPeek: (runId) => runId === task.run_id ? task : undefined,
    createKernel: ({ toolGatewayFor }) => ({
      async start(command, sink, signal): Promise<RunOutcome> {
        await sink.append({
          id: `event:${command.runId}:started` as never,
          workspaceId: command.workspaceId,
          channelId: command.channelId,
          streamId: command.runId as never,
          seq: 1,
          type: "run.started",
          timestamp: "2026-08-31T00:00:00.000Z",
          schemaVersion: 1,
          payload: { phase: "started" },
        });
        dispatched = await toolGatewayFor(command).execute({
          workspaceId: command.workspaceId,
          channelId: command.channelId,
          runId: command.runId,
          workerProfileId: command.runProfileSnapshot.workerProfileId,
          name: "crew.emit_task_drafts",
          input: { drafts: [] },
          toolCallId: "call-production-crew-proposal",
        }, signal);
        await sink.append({
          id: `event:${command.runId}:completed` as never,
          workspaceId: command.workspaceId,
          channelId: command.channelId,
          streamId: command.runId as never,
          seq: 2,
          type: "run.completed",
          timestamp: "2026-08-31T00:00:01.000Z",
          schemaVersion: 1,
          payload: { outcome: "completed" },
        });
        return { status: "completed" };
      },
      async steer() {},
      async answer() {},
      async abort() {},
    }),
  });

  try {
    const started = await live.runtime.start("crew", {
      workspace_id: task.workspace_id,
      channel_id: task.channel_id ?? "channel:production-crew-proposal-runtime",
      command_id: "command:production-crew-proposal-runtime",
      run_id: task.run_id,
      source_event_id: "event:production-crew-proposal-source",
      goal: task.prompt,
    });
    let events: readonly CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      events = await live.runtime.readEvents(
        task.workspace_id,
        task.channel_id ?? "channel:production-crew-proposal-runtime",
        started.runId,
      );
      if (events.some((event) => ["run.completed", "run.failed"].includes(event.type))) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(dispatched).toEqual({
      status: "succeeded",
      output: { status: "succeeded", output: { drafts: [] } },
    });
    expect(businessRequests).toHaveLength(1);
    expect(businessRequests[0]).toMatchObject({
      workspace_id: task.workspace_id,
      actor_user_id: task.actor_user_id,
      run_id: task.run_id,
      name: "crew.emit_task_drafts",
      arguments: { drafts: [] },
    });
    expect(events.at(-1)?.type).toBe("run.completed");
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production read_only rejects invalid input before the filesystem adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-invalid-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: join(directory, "missing-workspace-root"),
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "read_only",
      input: { path: "notes.txt", extra: "must be rejected" },
      toolCallId: "tool-call-production-invalid",
    }, new AbortController().signal);

    expect(result).toEqual({ status: "failed", output: { reason: "invalid_tool_input" } });
    const events: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      `tool:${command.runId}:tool-call-production-invalid` as never,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.result",
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production profile rejects a Tool that is absent from its effective catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-disabled-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "web_search",
      input: { query: "must not reach a provider" },
      toolCallId: "tool-call-production-disabled",
    }, new AbortController().signal);

    expect(result).toEqual({ status: "failed" });
    const events: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      `tool:${command.runId}:tool-call-production-disabled` as never,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.result",
    ]);
    expect(events[1]?.payload).toEqual(expect.objectContaining({
      reason: "unregistered_tool",
    }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production policy rejects a same-Channel Tool request from another Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-run-scope-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();
  await writeFile(join(directory, "notes.txt"), "must stay unread\n", "utf8");

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    const otherRunId = "run:production-tools-other";
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: otherRunId as never,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "read_only",
      input: { path: "notes.txt" },
      toolCallId: "tool-call-production-run-scope",
    }, new AbortController().signal);

    expect(result).toEqual({ status: "failed" });
    const events: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      `tool:${otherRunId}:tool-call-production-run-scope` as never,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(events[1]?.payload).toEqual(expect.objectContaining({ decision: "deny" }));
    expect(events[2]?.payload).toEqual(expect.objectContaining({
      status: "failed",
      reason: "policy_denied",
    }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Create uses its admitted worker and replays one Artifact effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-create-"));
  const eventStorePath = join(directory, "events.sqlite");
  let store: SqliteEventStore | undefined = new SqliteEventStore(eventStorePath);
  const command = await productionCommand(false, "create");
  const input = {
    kind: "skill" as const,
    skill_id: "release-notes",
    preview: [
      "---",
      "name: Release notes",
      "version: 1.0.0",
      "allowed_tools:",
      "  - read_only",
      "forbidden_tools:",
      "  - shell",
      "---",
      "Create release notes from approved source material.",
    ].join("\n"),
  };

  try {
    const initialStore = store;
    const gateway = createProductionToolGateway({
      eventStore: initialStore,
      command,
      workspaceRoot: directory,
    });
    const request = {
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "create_artifact",
      input,
      effectKey: "artifact:production-create-1",
      toolCallId: "tool-call-production-create",
    } as const;

    const first = await gateway.execute(request, new AbortController().signal);
    initialStore.close();
    store = undefined;
    const reopenedStore = new SqliteEventStore(eventStorePath);
    store = reopenedStore;
    const reopenedGateway = createProductionToolGateway({
      eventStore: reopenedStore,
      command,
      workspaceRoot: directory,
    });
    const second = await reopenedGateway.execute(request, new AbortController().signal);
    expect(first).toEqual(expect.objectContaining({
      status: "succeeded",
      output: expect.objectContaining({ artifact: expect.anything(), validation: expect.anything() }),
    }));
    expect(second).toEqual(first);

    const artifactPath = join(
      directory,
      "create-runs",
      "run_production-tools-create",
      "skill",
      "release-notes",
      "SKILL.md",
    );
    await expect(readFile(artifactPath, "utf8")).resolves.toBe(input.preview);

    const effectEvents: CanonicalEvent[] = [];
    for await (const event of reopenedStore.scope(command).read("effect:artifact:production-create-1" as never)) {
      effectEvents.push(event);
    }
    expect(effectEvents.map((event) => event.type)).toEqual([
      "tool.effect.started",
      "tool.effect.succeeded",
    ]);
    expect(effectEvents[0]?.payload).toEqual(expect.objectContaining({
      runId: command.runId,
      workerProfileId: "worker:harness-v2-create",
      tool: "create_artifact",
      replayPolicy: "never",
    }));
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Create performs no Artifact write for a pre-cancelled effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-create-cancelled-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand(false, "create");
  const input = {
    kind: "skill" as const,
    skill_id: "release-notes",
    preview: [
      "---",
      "name: Release notes",
      "version: 1.0.0",
      "allowed_tools:",
      "  - read_only",
      "forbidden_tools:",
      "  - shell",
      "---",
      "Create release notes from approved source material.",
    ].join("\n"),
  };
  const controller = new AbortController();
  controller.abort();

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "create_artifact",
      input,
      effectKey: "artifact:production-create-cancelled",
      toolCallId: "tool-call-production-create-cancelled",
    }, controller.signal);

    expect(result).toEqual({
      status: "failed",
      output: { reason: "cancelled" },
    });
    await expect(readFile(join(
      directory,
      "create-runs",
      "run_production-tools-create",
      "skill",
      "release-notes",
      "SKILL.md",
    ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Create rechecks cancellation after durable effect start before Artifact I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-create-race-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand(false, "create", "run:production-tools-create-race");
  const input = {
    kind: "skill" as const,
    skill_id: "release-notes",
    preview: [
      "---",
      "name: Release notes",
      "version: 1.0.0",
      "allowed_tools:",
      "  - read_only",
      "forbidden_tools:",
      "  - shell",
      "---",
      "Create release notes from approved source material.",
    ].join("\n"),
  };
  const controller = new AbortController();
  const scoped = store.scope(command);
  const eventStore: EventStore = {
    scope: () => new Proxy(scoped, {
      get(target, property, receiver) {
        if (property !== "append") {
          return Reflect.get(target, property, receiver);
        }
        return async (event: CanonicalEvent) => {
          await target.append(event);
          if (event.type === "tool.effect.started") {
            controller.abort();
          }
        };
      },
    }),
  };

  try {
    const gateway = createProductionToolGateway({
      eventStore,
      command,
      workspaceRoot: directory,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "create_artifact",
      input,
      effectKey: "artifact:production-create-race",
      toolCallId: "tool-call-production-create-race",
    }, controller.signal);

    expect(result).toEqual({
      status: "failed",
      output: { reason: "cancelled" },
    });
    await expect(readFile(join(
      directory,
      "create-runs",
      "run_production-tools-create-race",
      "skill",
      "release-notes",
      "SKILL.md",
    ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const effectEvents: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      "effect:artifact:production-create-race" as never,
    )) {
      effectEvents.push(event);
    }
    expect(effectEvents.map((event) => event.type)).toEqual([
      "tool.effect.started",
      "tool.effect.cancelled",
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Gateway rejects cross-scope and worker requests before the adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-scope-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();
  await writeFile(join(directory, "notes.txt"), "must stay unread\n", "utf8");

  const cases = [
    { label: "workspace", override: { workspaceId: "workspace:other" } },
    { label: "channel", override: { channelId: "channel:other" } },
    { label: "worker", override: { workerProfileId: "worker:other" } },
  ] as const;

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    for (const candidate of cases) {
      const toolCallId = `tool-call-production-scope-${candidate.label}`;
      const request = {
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId: command.runProfileSnapshot.workerProfileId,
        name: "read_only",
        input: { path: "notes.txt" },
        toolCallId,
        ...candidate.override,
      } as const;
      const result = await gateway.execute(request, new AbortController().signal);

      expect(result, candidate.label).toEqual({
        status: "failed",
        output: { reason: "scope_denied" },
      });
      const events: CanonicalEvent[] = [];
      for await (const event of store.scope(command).read(
        `tool:${command.runId}:${toolCallId}` as never,
      )) {
        events.push(event);
      }
      expect(events.map((event) => event.type), candidate.label).toEqual([
        "tool.requested",
        "tool.result",
      ]);
      expect(events[1]?.payload, candidate.label).toEqual(expect.objectContaining({
        status: "failed",
        reason: "scope_denied",
      }));
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production policy rejects parent and Lane attribution outside the admitted Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-attribution-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();
  await writeFile(join(directory, "notes.txt"), "must stay unread\n", "utf8");

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "read_only",
      input: { path: "notes.txt" },
      toolCallId: "tool-call-production-attribution",
      parentRunId: "run:other-parent" as never,
      parentEventId: "event:other-parent" as never,
      laneId: "lane:other" as never,
    }, new AbortController().signal);

    expect(result).toEqual({ status: "failed" });
    const events: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      `tool:${command.runId}:tool-call-production-attribution` as never,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(events[1]?.payload).toEqual(expect.objectContaining({ decision: "deny" }));
    expect(events[2]?.payload).toEqual(expect.objectContaining({
      status: "failed",
      reason: "policy_denied",
    }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Gateway keeps the admitted binding after the caller mutates its command object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-captured-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand();
  await writeFile(join(directory, "notes.txt"), "captured binding\n", "utf8");

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    command.runId = "run:caller-mutated" as never;

    await expect(gateway.execute({
      workspaceId: "workspace:production-tools" as never,
      channelId: "channel:production-tools" as never,
      runId: "run:production-tools-read" as never,
      workerProfileId: "worker:harness-v2-live" as never,
      name: "read_only",
      input: { path: "notes.txt" },
      toolCallId: "tool-call-production-captured",
    }, new AbortController().signal)).resolves.toEqual({
      status: "succeeded",
      output: { path: "notes.txt", content: "captured binding\n" },
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production WebSearch uses the configured provider through the durable Gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-search-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand(true);
  let providerCalls = 0;
  const webSearch = createWebSearchProvider({
    endpoint: "https://search.example/query",
    fetchImpl: async (_input, init) => {
      providerCalls += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ query: "durable runs", max_results: 5 });
      return new Response(JSON.stringify({
        results: [{
          title: "Durable Runs",
          url: "https://example.com/durable-runs",
          snippet: "A bounded result.",
        }],
      }), { status: 200 });
    },
  });

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
      webSearch,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "web_search",
      input: { query: " durable runs " },
      toolCallId: "tool-call-production-search",
    }, new AbortController().signal);

    expect(result).toEqual({
      status: "succeeded",
      output: {
        query: "durable runs",
        results: [{
          title: "Durable Runs",
          url: "https://example.com/durable-runs",
          snippet: "A bounded result.",
        }],
      },
    });
    expect(providerCalls).toBe(1);
    const events: CanonicalEvent[] = [];
    for await (const event of store.scope(command).read(
      `tool:${command.runId}:tool-call-production-search` as never,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(events[2]?.payload).toEqual(expect.objectContaining({ status: "succeeded" }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production WebSearch stays fail-closed when its provider is not configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-search-missing-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand(true);

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "web_search",
      input: { query: "provider must not be called" },
      toolCallId: "tool-call-production-search-missing",
    }, new AbortController().signal);

    expect(result).toEqual({
      status: "failed",
      output: { reason: "web_search_provider_not_configured" },
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production WebSearch preserves a safe upstream failure boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-search-failed-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const command = await productionCommand(true);
  const webSearch = createWebSearchProvider({
    endpoint: "https://search.example/query",
    fetchImpl: async () => new Response("provider response must not leak", { status: 503 }),
  });

  try {
    const gateway = createProductionToolGateway({
      eventStore: store,
      command,
      workspaceRoot: directory,
      webSearch,
    });
    const result = await gateway.execute({
      workspaceId: command.workspaceId,
      channelId: command.channelId,
      runId: command.runId,
      workerProfileId: command.runProfileSnapshot.workerProfileId,
      name: "web_search",
      input: { query: "anna" },
      toolCallId: "tool-call-production-search-failed",
    }, new AbortController().signal);

    expect(result).toEqual({
      status: "failed",
      output: { reason: "web_search_provider_failed" },
    });
    expect(JSON.stringify(result)).not.toContain("provider response must not leak");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Runtime constructs the durable Gateway from each admitted Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-runtime-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
  await writeFile(join(directory, "notes.txt"), "runtime-bound read\n", "utf8");

  let gatewayFactoryCalls = 0;
  let capturedCommand: StartRun | undefined;
  const createKernel = ({ toolGatewayFor }: {
    toolGatewayFor: (command: StartRun) => ReturnType<typeof createProductionToolGateway>;
  }): LoopKernel => ({
    async start(command, sink, signal): Promise<RunOutcome> {
      capturedCommand = command;
      const events = sink as EventSink & {
        read: (streamId: StreamId, afterSeq?: number) => AsyncIterable<CanonicalEvent>;
      };
      await sink.append({
        id: `event:${command.runId}:started` as never,
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        streamId: command.runId as never,
        seq: 1,
        type: "run.started",
        timestamp: "2026-08-30T00:00:00.000Z",
        schemaVersion: 1,
        payload: { phase: "started" },
      });
      const gateway = toolGatewayFor(command);
      gatewayFactoryCalls += 1;
      await gateway.execute({
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        runId: command.runId,
        workerProfileId: command.runProfileSnapshot.workerProfileId,
        name: "read_only",
        input: { path: "notes.txt" },
        toolCallId: "tool-call-production-runtime-read",
      }, signal);
      let nextSeq = 0;
      for await (const event of events.read(command.runId as never)) {
        nextSeq = Math.max(nextSeq, event.seq + 1);
      }
      await sink.append({
        id: `event:${command.runId}:completed` as never,
        workspaceId: command.workspaceId,
        channelId: command.channelId,
        streamId: command.runId as never,
        seq: nextSeq,
        type: "run.completed",
        timestamp: "2026-08-30T00:00:00.000Z",
        schemaVersion: 1,
        payload: { outcome: "completed" },
      });
      return { status: "completed" };
    },
    async steer() {},
    async answer() {},
    async abort() {},
  });

  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel,
  });

  try {
    const started = await live.runtime.start("cowork", {
      workspace_id: "workspace:production-runtime",
      channel_id: "channel:production-runtime",
      command_id: "command:production-runtime",
      source_event_id: "event:production-runtime-source",
      goal: "Read the approved note through the production Gateway.",
    });
    expect(started.status).toBe("queued");

    let runEvents: readonly CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      runEvents = await live.runtime.readEvents(
        "workspace:production-runtime",
        "channel:production-runtime",
        started.runId,
      );
      if (runEvents.some((event) => event.type === "run.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.queued",
      "run.started",
      "run.eval.contract",
      "run.completed",
    ]);
    expect(gatewayFactoryCalls).toBe(1);
    expect(capturedCommand?.runProfileSnapshot.workerProfileId).toBe("worker:harness-v2-live");

    const toolEvents: CanonicalEvent[] = [];
    for await (const event of live.eventStore.scope({
      workspaceId: "workspace:production-runtime",
      channelId: "channel:production-runtime",
    }).read(`tool:${started.runId}:tool-call-production-runtime-read` as never)) {
      toolEvents.push(event);
    }
    expect(toolEvents.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(toolEvents[1]?.payload).toEqual(expect.objectContaining({ decision: "allow" }));
    expect(toolEvents[2]?.payload).toEqual(expect.objectContaining({ status: "succeeded" }));
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Runtime drives the actual Pi adapter through SQLite and ToolGateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-pi-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");
  await writeFile(join(directory, "notes.txt"), "Pi production read\n", "utf8");

  const provider = fauxProvider();
  let streamCalls = 0;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["cowork"],
    createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
      prepareContext,
      workerProfileId,
      getApiKey: () => "fixture-key",
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        const message = streamCalls === 0
          ? fauxAssistantMessage(
              fauxToolCall("read_only", { path: "notes.txt" }),
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("Pi production answer");
        streamCalls += 1;
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        return stream;
      },
      now: () => 0,
    }),
  });

  try {
    const started = await live.runtime.start("cowork", {
      workspace_id: "workspace:production-pi",
      channel_id: "channel:production-pi",
      command_id: "command:production-pi",
      source_event_id: "event:production-pi-source",
      goal: "Read the approved note through the Pi production adapter.",
    });
    let runEvents: readonly CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      runEvents = await live.runtime.readEvents!(
        "workspace:production-pi",
        "channel:production-pi",
        started.runId,
      );
      if (runEvents.some((event) => [
        "run.completed",
        "run.failed",
        "run.timed_out",
        "run.cancelled",
      ].includes(event.type))) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(streamCalls).toBe(2);
    expect(runEvents.map((event) => event.seq)).toEqual(
      runEvents.map((_event, index) => index),
    );
    expect(runEvents[0]?.type).toBe("run.queued");
    expect(runEvents.some((event) => event.type === "run.started")).toBe(true);
    expect(runEvents.at(-2)?.type).toBe("run.eval.contract");
    expect(runEvents.at(-1)?.type).toBe("run.completed");
    expect(runEvents.filter((event) => [
      "run.completed",
      "run.failed",
      "run.timed_out",
      "run.cancelled",
    ].includes(event.type))).toHaveLength(1);

    const scope = live.eventStore.scope({
      workspaceId: "workspace:production-pi",
      channelId: "channel:production-pi",
    });
    const toolEvents: CanonicalEvent[] = [];
    for (const streamId of await scope.listRunStreamIds(started.runId as never)) {
      for await (const event of scope.read(streamId)) {
        if (event.type === "tool.requested"
          || event.type === "tool.policy.decided"
          || event.type === "tool.result") {
          toolEvents.push(event);
        }
      }
    }
    expect(toolEvents.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(toolEvents[0]?.payload).toEqual(expect.objectContaining({
      runId: started.runId,
      workerProfileId: "worker:harness-v2-live",
      tool: "read_only",
    }));
    expect(toolEvents[1]?.payload).toEqual(expect.objectContaining({ decision: "allow" }));
    expect(toolEvents[2]?.payload).toEqual(expect.objectContaining({ status: "succeeded" }));
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Create drives Pi through one durable Artifact effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-production-tools-pi-create-"));
  const configPath = join(directory, "runtime.json");
  const eventStorePath = join(directory, "events.sqlite");
  await writeFile(configPath, JSON.stringify({
    model_provider: "openai-compatible",
    model_name: "fixture-model",
    model_api_key: "fixture-key",
    model_endpoint: "https://provider.invalid/v1/chat/completions",
  }), "utf8");

  const input = {
    kind: "skill" as const,
    skill_id: "release-notes",
    preview: [
      "---",
      "name: Release notes",
      "version: 1.0.0",
      "allowed_tools:",
      "  - read_only",
      "forbidden_tools:",
      "  - shell",
      "---",
      "Create release notes from approved source material.",
    ].join("\n"),
  };
  const provider = fauxProvider();
  let streamCalls = 0;
  const live = await createLiveHarnessV2Runtime({
    runtimeConfigPath: configPath,
    eventStorePath,
    workspaceRoot: directory,
    surfaces: ["create"],
    createKernel: ({ toolGatewayFor, prepareContext, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
      prepareContext,
      workerProfileId,
      getApiKey: () => "fixture-key",
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        const message = streamCalls === 0
          ? fauxAssistantMessage(fauxToolCall("create_artifact", input), { stopReason: "toolUse" })
          : fauxAssistantMessage("Artifact draft created.");
        streamCalls += 1;
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        return stream;
      },
      now: () => 0,
    }),
  });

  try {
    const started = await live.runtime.start("create", {
      workspace_id: "workspace:production-pi-create",
      channel_id: "channel:production-pi-create",
      command_id: "command:production-pi-create",
      run_id: "run:production-pi-create",
      source_event_id: "event:production-pi-create-source",
      goal: "Create the approved Skill artifact.",
    });
    let runEvents: readonly CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      runEvents = await live.runtime.readEvents!(
        "workspace:production-pi-create",
        "channel:production-pi-create",
        started.runId,
      );
      if (runEvents.some((event) => event.type === "run.completed" || event.type === "run.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(streamCalls).toBe(2);
    expect(runEvents.map((event) => event.seq)).toEqual(
      runEvents.map((_event, index) => index),
    );
    expect(runEvents.at(-2)?.type).toBe("run.eval.contract");
    expect(runEvents.at(-1)?.type).toBe("run.completed");
    expect(runEvents.filter((event) => event.type === "run.completed")).toHaveLength(1);

    const scope = live.eventStore.scope({
      workspaceId: "workspace:production-pi-create",
      channelId: "channel:production-pi-create",
    });
    const toolEvents: CanonicalEvent[] = [];
    const effectEvents: CanonicalEvent[] = [];
    for (const streamId of await scope.listRunStreamIds(started.runId as never)) {
      for await (const event of scope.read(streamId)) {
        if (event.type === "tool.requested"
          || event.type === "tool.policy.decided"
          || event.type === "tool.result") {
          toolEvents.push(event);
        }
        if (event.type === "tool.effect.started" || event.type === "tool.effect.succeeded") {
          effectEvents.push(event);
        }
      }
    }
    expect(toolEvents.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.policy.decided",
      "tool.result",
    ]);
    expect(toolEvents[0]?.payload).toEqual(expect.objectContaining({
      runId: started.runId,
      workerProfileId: "worker:harness-v2-create",
      tool: "create_artifact",
    }));
    expect(toolEvents[1]?.payload).toEqual(expect.objectContaining({ decision: "allow" }));
    expect(toolEvents[2]?.payload).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(effectEvents.map((event) => event.type)).toEqual([
      "tool.effect.started",
      "tool.effect.succeeded",
    ]);
    expect(effectEvents[0]?.payload).toEqual(expect.objectContaining({
      workerProfileId: "worker:harness-v2-create",
      tool: "create_artifact",
      replayPolicy: "never",
    }));

    await expect(readFile(join(
      directory,
      "create-runs",
      "run_production-pi-create",
      "skill",
      "release-notes",
      "SKILL.md",
    ), "utf8")).resolves.toBe(input.preview);
  } finally {
    await live.close();
    await rm(directory, { recursive: true, force: true });
  }
});
