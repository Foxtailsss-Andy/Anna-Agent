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
} from "@anna/harness-v2";
import { PiLoopKernel } from "@anna/pi-loop-kernel";

import {
  createLiveHarnessV2Runtime,
  createLiveProfile,
  createProductionToolGateway,
  createWebSearchProvider,
} from "../src/production";

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
    live.close();
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
    createKernel: ({ toolGatewayFor, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
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
    live.close();
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
    createKernel: ({ toolGatewayFor, workerProfileId }) => new PiLoopKernel({
      model: {
        ...provider.getModel(),
        id: "fixture-model",
        name: "fixture-model",
        provider: "anna-openai-compatible",
      },
      createToolGateway: toolGatewayFor,
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
    live.close();
    await rm(directory, { recursive: true, force: true });
  }
});
