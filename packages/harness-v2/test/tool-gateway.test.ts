import { expect, test } from "vitest";

import * as toolGatewayPublicApi from "../src/index";
import {
  createToolGateway,
  parseCanonicalEvent,
  type CanonicalEvent,
  type ChannelScope,
  type SandboxAdapter,
  type ScopedChannelStore,
  type ToolDefinition,
  type ToolGateway,
  type ToolPolicy,
  type ToolRequest,
} from "../src/index";

interface ToolApprovalAnswer {
  workspaceId: ToolRequest["workspaceId"];
  channelId: ToolRequest["channelId"];
  runId: ToolRequest["runId"];
  effectKey: string;
  approvalId: string;
  actorId: string;
  decision: "approved" | "denied";
}

interface DurableToolGateway extends ToolGateway {
  answerApproval(answer: ToolApprovalAnswer): Promise<void>;
}

interface DeterministicFakeSandbox extends SandboxAdapter {
  readonly executions: readonly {
    request: ToolRequest;
    signal: AbortSignal;
  }[];
  readonly abortCount: number;
  readonly executionStarted: Promise<void>;
}

interface BoundToolGatewayOptions {
  readonly catalog: readonly ToolDefinition[];
  readonly policy: ToolPolicy;
  readonly sandbox: SandboxAdapter;
  readonly events: Pick<ScopedChannelStore, "append" | "read">;
  readonly scope: Readonly<ChannelScope>;
  readonly workerProfileId: ToolRequest["workerProfileId"];
  readonly createEventId?: () => string;
  readonly now?: () => string;
}

interface ExpectedToolGatewayPublicApi {
  createToolGateway(options: BoundToolGatewayOptions): DurableToolGateway;
  createDeterministicFakeSandbox(options: {
    steps: readonly { kind: "wait_for_abort" }[];
  }): DeterministicFakeSandbox;
}

const expectedToolGatewayPublicApi =
  toolGatewayPublicApi as unknown as ExpectedToolGatewayPublicApi;

const defaultScope = Object.freeze({
  workspaceId: "workspace-1" as ToolRequest["workspaceId"],
  channelId: "channel-1" as ToolRequest["channelId"],
});
const defaultWorkerProfileId = "worker-profile-1" as ToolRequest["workerProfileId"];

function createInMemoryEvents(): Pick<ScopedChannelStore, "append" | "read"> {
  const eventsByStream = new Map<string, CanonicalEvent[]>();

  return {
    async append(event) {
      const canonicalEvent = parseCanonicalEvent(event);
      const events = eventsByStream.get(canonicalEvent.streamId) ?? [];
      events.push(canonicalEvent);
      eventsByStream.set(canonicalEvent.streamId, events);
    },
    async *read(streamId, afterSeq) {
      for (const event of eventsByStream.get(streamId) ?? []) {
        if (afterSeq === undefined || event.seq > afterSeq) {
          yield event;
        }
      }
    },
  };
}

test("does not execute an unregistered Pi built-in Tool", async () => {
  const rawCommand = "touch should-never-run";
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const events = createInMemoryEvents();
  const gateway = createToolGateway({
    catalog: [],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy: { async decide() { return "deny"; } },
    sandbox,
    events,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  const request: ToolRequest & { toolCallId: string } = {
    name: "bash",
    input: { command: rawCommand },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    toolCallId: "tool-call-unregistered-1",
  };

  await expect(gateway.execute(request, new AbortController().signal))
    .resolves.toEqual({ status: "failed" });

  expect(sandboxExecutions).toBe(0);

  const streamId = `tool:${request.runId}:${request.toolCallId}`;
  const lifecycleEvents: CanonicalEvent[] = [];
  for await (const event of events.read(streamId as never)) {
    lifecycleEvents.push(event);
  }

  expect(lifecycleEvents.map((event) => event.seq)).toEqual([0, 1]);
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool.requested",
    "tool.result",
  ]);
  expect(lifecycleEvents[1]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        status: "failed",
        reason: "unregistered_tool",
      }),
    }),
  );

  const serializedEvents = JSON.stringify(lifecycleEvents);
  expect(serializedEvents).not.toContain(rawCommand);
  expect(serializedEvents).not.toContain("command");
  expect(serializedEvents).not.toContain("input");
});

test("preserves child Run attribution on every Tool lifecycle event", async () => {
  const events = createInMemoryEvents();
  const gateway = createToolGateway({
    catalog: [{
      name: "read_workspace",
      replayPolicy: "safe",
      inputSchema: { parse(input: unknown) { return input; } },
    }],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy: { async decide() { return "allow"; } },
    sandbox: { async execute() { return { status: "succeeded", output: { ok: true } }; } },
    events,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  const request: ToolRequest = {
    name: "read_workspace",
    input: { path: "README.md" },
    workspaceId: defaultScope.workspaceId,
    channelId: defaultScope.channelId,
    runId: "child-run" as never,
    workerProfileId: defaultWorkerProfileId,
    toolCallId: "tool-call-child-1",
    parentRunId: "parent-run" as never,
    parentEventId: "parent-event-1" as never,
    laneId: "lane-1",
  };

  await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "succeeded",
    output: { ok: true },
  });

  const lifecycleEvents: CanonicalEvent[] = [];
  for await (const event of events.read(`tool:${request.runId}:${request.toolCallId}` as never)) {
    lifecycleEvents.push(event);
  }
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool.requested",
    "tool.policy.decided",
    "tool.result",
  ]);
  for (const event of lifecycleEvents) {
    expect(event.payload).toEqual(expect.objectContaining({
      parentRunId: "parent-run",
      parentEventId: "parent-event-1",
      laneId: "lane-1",
    }));
  }
});

test("denies a registered Tool before Sandbox execution", async () => {
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const readWorkspace: ToolDefinition = {
    name: "read_workspace",
    inputSchema: {
      parse(input: unknown) {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          typeof (input as Record<string, unknown>).path !== "string"
        ) {
          throw new Error("read_workspace input requires a path");
        }

        return { path: (input as Record<string, unknown>).path as string };
      },
    },
  };
  const policyRequests: ToolRequest[] = [];
  const policy: ToolPolicy = {
    async decide(request) {
      policyRequests.push(request);
      return "deny";
    },
  };
  const events = createInMemoryEvents();
  const gateway = createToolGateway({
    catalog: [readWorkspace],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
  });
  const request: ToolRequest = {
    name: "read_workspace",
    input: { path: "README.md" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    toolCallId: "tool-call-denied-read-1",
  };

  await expect(gateway.execute(request, new AbortController().signal))
    .resolves.toEqual({ status: "failed" });

  expect(policyRequests).toEqual([
    expect.objectContaining({
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      workerProfileId: request.workerProfileId,
    }),
  ]);
  expect(sandboxExecutions).toBe(0);
});

test("emits a canonical lifecycle without effect or raw data for a denied registered Tool", async () => {
  const secretMarker = "secret-marker-tool-call-denied";
  const absolutePath = "/private/denied-tool-input.txt";
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const readWorkspace: ToolDefinition = {
    name: "read_workspace",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "deny";
    },
  };
  let eventNumber = 0;
  const gateway = createToolGateway({
    catalog: [readWorkspace],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-denied-lifecycle-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  const request: ToolRequest & { toolCallId: string } = {
    name: "read_workspace",
    input: {
      path: absolutePath,
      authorization: secretMarker,
    },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    toolCallId: "tool-call-denied-1",
  };

  await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
  });
  expect(sandboxExecutions).toBe(0);

  const streamId = `tool:${request.runId}:${request.toolCallId}`;
  const lifecycleEvents: CanonicalEvent[] = [];
  for await (const event of events.read(streamId as never)) {
    lifecycleEvents.push(event);
  }

  expect(lifecycleEvents.map((event) => event.seq)).toEqual([0, 1, 2]);
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool.requested",
    "tool.policy.decided",
    "tool.result",
  ]);
  for (const event of lifecycleEvents) {
    expect(event).toEqual(
      expect.objectContaining({
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        streamId,
      }),
    );
    expect(event.payload).toEqual(
      expect.objectContaining({
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        toolCallId: request.toolCallId,
      }),
    );
  }
  expect(lifecycleEvents[1]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ decision: "deny" }),
    }),
  );
  expect(lifecycleEvents[2]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        status: "failed",
        reason: "policy_denied",
      }),
    }),
  );

  const eventIds = lifecycleEvents.map((event) => event.id);
  expect(new Set(eventIds).size).toBe(lifecycleEvents.length);
  const rereadEventIds: string[] = [];
  for await (const event of events.read(streamId as never)) {
    rereadEventIds.push(event.id);
  }
  expect(rereadEventIds).toEqual(eventIds);

  const serializedEvents = JSON.stringify(lifecycleEvents);
  expect(serializedEvents).not.toContain(secretMarker);
  expect(serializedEvents).not.toContain(absolutePath);
  expect(serializedEvents).not.toContain("authorization");
});

test("records a durable approval request before a bounded patch can execute", async () => {
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    inputSchema: {
      parse(input: unknown) {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          typeof (input as Record<string, unknown>).path !== "string" ||
          typeof (input as Record<string, unknown>).patch !== "string"
        ) {
          throw new Error("bounded_patch input requires path and patch");
        }

        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval" as never;
    },
  };
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => "event-approval-1",
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const gateway = createToolGateway(gatewayOptions);
  const request = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-1",
    toolCallId: "tool-call-approval-request-1",
  };

  await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: "approval:effect-1",
    },
  });
  expect(sandboxExecutions).toBe(0);

  const durableEvents: CanonicalEvent[] = [];
  for await (const event of events.read(request.runId as never)) {
    durableEvents.push(event);
  }

  expect(durableEvents).toEqual([
    {
      id: "event-approval-1",
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      streamId: request.runId,
      seq: 0,
      type: "tool.approval.requested",
      timestamp: "2026-08-19T00:00:00.000Z",
      schemaVersion: 1,
      payload: {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: request.effectKey,
        approvalId: "approval:effect-1",
      },
    },
  ]);
});

test("executes a durably approved bounded patch after Gateway recreation", async () => {
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  const eventIds = [
    "event-approval-requested",
    "event-approval-answered",
    "event-effect-started",
    "event-effect-succeeded",
  ];
  const createEventId = () => {
    const eventId = eventIds.shift();
    if (eventId === undefined) {
      throw new Error("unexpected durable event");
    }

    return eventId;
  };
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-1",
    toolCallId: "tool-call-approved-patch-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: "effect-1",
    approvalId: "approval:effect-1",
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayA = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;

  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  expect(sandboxExecutions).toBe(0);

  await gatewayA.answerApproval(approval);

  const durableEvents: CanonicalEvent[] = [];
  for await (const event of events.read(request.runId as never)) {
    durableEvents.push(event);
  }

  expect(durableEvents).toEqual([
    {
      id: "event-approval-requested",
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      streamId: request.runId,
      seq: 0,
      type: "tool.approval.requested",
      timestamp: "2026-08-19T00:00:00.000Z",
      schemaVersion: 1,
      payload: {
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: approval.effectKey,
        approvalId: approval.approvalId,
      },
    },
    {
      id: "event-approval-answered",
      workspaceId: approval.workspaceId,
      channelId: approval.channelId,
      streamId: approval.runId,
      seq: 1,
      type: "tool.approval.answered",
      timestamp: "2026-08-19T00:00:00.000Z",
      schemaVersion: 1,
      payload: approval,
    },
  ]);

  const gatewayB = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "succeeded",
  });
  expect(sandboxExecutions).toBe(1);

  const lifecycleEvents: CanonicalEvent[] = [];
  const lifecycleStreamId = `tool:${request.runId}:${request.toolCallId}`;
  for await (const event of events.read(lifecycleStreamId as never)) {
    lifecycleEvents.push(event);
  }

  expect(lifecycleEvents.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool.requested",
    "tool.policy.decided",
    "tool.result",
    "tool.requested",
    "tool.policy.decided",
    "tool.result",
  ]);
  expect(lifecycleEvents[1]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ decision: "require_approval" }),
    }),
  );
  expect(lifecycleEvents[2]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        status: "failed",
        reason: "approval_required",
      }),
    }),
  );
  expect(lifecycleEvents[4]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ decision: "require_approval" }),
    }),
  );
  expect(lifecycleEvents[5]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ status: "succeeded" }),
    }),
  );

  const serializedLifecycleEvents = JSON.stringify(lifecycleEvents);
  expect(serializedLifecycleEvents).not.toContain("@@ -1 +1 @@\\n-before\\n+after");
  expect(serializedLifecycleEvents).not.toContain("README.md");
  expect(serializedLifecycleEvents).not.toContain("output");

  const eventsAfterRecreation: CanonicalEvent[] = [];
  for await (const event of events.read(request.runId as never)) {
    eventsAfterRecreation.push(event);
  }
  const approvalEventsAfterRecreation = eventsAfterRecreation.filter(
    (event) =>
      event.type === "tool.approval.requested" ||
      event.type === "tool.approval.answered",
  );
  expect(approvalEventsAfterRecreation).toEqual(durableEvents);
});

test("keeps a durable denied approval denied after Gateway recreation", async () => {
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-denied-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-denied-1",
    toolCallId: "tool-call-denied-patch-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-denied-1",
    actorId: "human-1",
    decision: "denied",
  };
  const approvalRequired = {
    status: "failed" as const,
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  };
  const approvalDenied = {
    status: "failed" as const,
    output: {
      reason: "approval_denied",
      approvalId: approval.approvalId,
    },
  };
  const gatewayA = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;

  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual(
    approvalRequired,
  );
  expect(sandboxExecutions).toBe(0);

  await gatewayA.answerApproval(approval);

  const gatewayB = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual(
    approvalDenied,
  );
  expect(sandboxExecutions).toBe(0);

  const gatewayC = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayC.execute(request, new AbortController().signal)).resolves.toEqual(
    approvalDenied,
  );
  expect(sandboxExecutions).toBe(0);

  const approvalEvents: CanonicalEvent[] = [];
  for await (const event of events.read(request.runId as never)) {
    approvalEvents.push(event);
  }
  expect(approvalEvents.map((event) => event.type)).toEqual([
    "tool.approval.requested",
    "tool.approval.answered",
  ]);

  const lifecycleEvents: CanonicalEvent[] = [];
  const lifecycleStreamId = `tool:${request.runId}:${request.toolCallId}`;
  for await (const event of events.read(lifecycleStreamId as never)) {
    lifecycleEvents.push(event);
  }
  expect(lifecycleEvents.filter((event) => event.type === "tool.requested")).toHaveLength(3);
  expect(
    lifecycleEvents
      .filter((event) => event.type === "tool.result")
      .map((event) => event.payload),
  ).toEqual([
    expect.objectContaining({ status: "failed", reason: "approval_required" }),
    expect.objectContaining({ status: "failed", reason: "approval_denied" }),
    expect.objectContaining({ status: "failed", reason: "approval_denied" }),
  ]);
});

test("executes a duplicate never-replay effect key at most once across Gateway recreation", async () => {
  let sandboxExecutions = 0;
  const succeededResult = {
    status: "succeeded" as const,
    output: { changedFiles: ["README.md"] },
  };
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return succeededResult;
    },
  };
  const boundedPatch: ToolDefinition & { replayPolicy: "never" } = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-1",
    toolCallId: "tool-call-duplicate-never-1",
    parentRunId: "parent-run" as never,
    parentEventId: "parent-event-1" as never,
    laneId: "lane-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-1",
    actorId: "human-1",
    decision: "approved",
  };

  const gatewayA = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  await gatewayA.answerApproval(approval);

  const gatewayB = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual(
    succeededResult,
  );
  expect(sandboxExecutions).toBe(1);

  const gatewayC = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayC.execute(request, new AbortController().signal)).resolves.toEqual(
    succeededResult,
  );
  expect(sandboxExecutions).toBe(1);

  const effectEvents: CanonicalEvent[] = [];
  const effectStreamId = `effect:${request.effectKey}`;
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }

  expect(effectEvents.map((event) => event.seq)).toEqual([0, 1]);
  expect(effectEvents).toEqual([
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 0,
      type: "tool.effect.started",
      payload: expect.objectContaining({
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: request.effectKey,
        replayPolicy: "never",
        parentRunId: "parent-run",
        parentEventId: "parent-event-1",
        laneId: "lane-1",
      }),
    }),
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 1,
      type: "tool.effect.succeeded",
      payload: expect.objectContaining({
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: request.effectKey,
        replayPolicy: "never",
        parentRunId: "parent-run",
        parentEventId: "parent-event-1",
        laneId: "lane-1",
        result: succeededResult,
      }),
    }),
  ]);
});

test("does not let safe replay policy bypass effect-key deduplication", async () => {
  let sandboxExecutions = 0;
  const succeededResult = {
    status: "succeeded" as const,
    output: { content: "# Anna" },
  };
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return succeededResult;
    },
  };
  const readWorkspace: ToolDefinition & { replayPolicy: "safe" } = {
    name: "read_workspace",
    replayPolicy: "safe",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const gatewayOptions = {
    catalog: [readWorkspace],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "read_workspace",
    input: { path: "README.md" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-1",
    toolCallId: "tool-call-duplicate-safe-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-1",
    actorId: "human-1",
    decision: "approved",
  };

  const gatewayA = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  await gatewayA.answerApproval(approval);

  const gatewayB = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual(
    succeededResult,
  );

  const gatewayC = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayC.execute(request, new AbortController().signal)).resolves.toEqual(
    succeededResult,
  );
  expect(sandboxExecutions).toBe(1);

  const effectEvents: CanonicalEvent[] = [];
  const effectStreamId = `effect:${request.effectKey}`;
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }

  expect(effectEvents.map((event) => event.seq)).toEqual([0, 1]);
  expect(effectEvents).toEqual([
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 0,
      type: "tool.effect.started",
      payload: expect.objectContaining({
        effectKey: request.effectKey,
        replayPolicy: "safe",
      }),
    }),
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 1,
      type: "tool.effect.succeeded",
      payload: expect.objectContaining({
        effectKey: request.effectKey,
        replayPolicy: "safe",
        result: succeededResult,
      }),
    }),
  ]);
});

test("makes a dispatched never-replay effect outcome durable-unknown without replaying it", async () => {
  let sandboxExecutions = 0;
  const dispatchThenLoseConnection: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      throw new Error("Sandbox connection lost after dispatch");
    },
  };
  const wouldSucceedIfCalled: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const createEventId = () => {
    return `event-${eventNumber++}`;
  };
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    events,
    createEventId,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-1",
    toolCallId: "tool-call-unknown-effect-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-1",
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayA = createToolGateway({
    ...gatewayOptions,
    sandbox: dispatchThenLoseConnection,
  }) as unknown as DurableToolGateway;

  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  await gatewayA.answerApproval(approval);

  const gatewayB = createToolGateway({
    ...gatewayOptions,
    sandbox: dispatchThenLoseConnection,
  }) as unknown as DurableToolGateway;
  const unknownResult = {
    status: "unknown" as const,
    output: {
      reason: "effect_outcome_unknown",
      effectKey: request.effectKey,
    },
  };
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual(
    unknownResult,
  );
  expect(sandboxExecutions).toBe(1);

  const effectStreamId = `effect:${request.effectKey}`;
  const effectEventsAfterB: CanonicalEvent[] = [];
  for await (const event of events.read(effectStreamId as never)) {
    effectEventsAfterB.push(event);
  }
  expect(effectEventsAfterB).toEqual([
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 0,
      type: "tool.effect.started",
    }),
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 1,
      type: "tool.effect.unknown",
      timestamp: "2026-08-19T00:00:00.000Z",
      schemaVersion: 1,
      payload: expect.objectContaining({
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: request.effectKey,
        replayPolicy: "never",
        reason: "effect_outcome_unknown",
      }),
    }),
  ]);
  expect(effectEventsAfterB.some((event) => event.type === "tool.effect.succeeded")).toBe(false);

  const gatewayC = createToolGateway({
    ...gatewayOptions,
    sandbox: wouldSucceedIfCalled,
  }) as unknown as DurableToolGateway;
  await expect(gatewayC.execute(request, new AbortController().signal)).resolves.toEqual(
    unknownResult,
  );
  expect(sandboxExecutions).toBe(1);

  const gatewayD = createToolGateway({
    ...gatewayOptions,
    sandbox: wouldSucceedIfCalled,
  }) as unknown as DurableToolGateway;
  await expect(gatewayD.execute(request, new AbortController().signal)).resolves.toEqual(
    unknownResult,
  );
  expect(sandboxExecutions).toBe(1);

  const effectEvents: CanonicalEvent[] = [];
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }
  expect(effectEvents).toEqual(effectEventsAfterB);
});

test("keeps a known failed never-replay Sandbox outcome durable without re-executing it", async () => {
  let sandboxExecutions = 0;
  const failedSandboxResult = {
    status: "failed" as const,
    output: {
      reason: "patch_precondition_failed",
      detail: "secret-not-durable",
    },
  };
  const recordedFailedResult = {
    status: "failed" as const,
    output: { reason: "patch_precondition_failed" },
  };
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return failedSandboxResult;
    },
  };
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-failed-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-failed-1",
    toolCallId: "tool-call-failed-patch-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-failed-1",
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayA = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;

  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  await gatewayA.answerApproval(approval);

  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual(
    failedSandboxResult,
  );
  expect(sandboxExecutions).toBe(1);

  const effectStreamId = `effect:${request.effectKey}`;
  const effectEvents: CanonicalEvent[] = [];
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }
  expect(effectEvents.map((event) => event.seq)).toEqual([0, 1]);
  expect(effectEvents.map((event) => event.type)).toEqual([
    "tool.effect.started",
    "tool.effect.failed",
  ]);
  expect(effectEvents[1]).toEqual(
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 1,
      payload: expect.objectContaining({
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: request.effectKey,
        replayPolicy: "never",
        result: recordedFailedResult,
      }),
    }),
  );
  expect(JSON.stringify(effectEvents)).not.toContain("secret-not-durable");
  expect(JSON.stringify(effectEvents)).not.toContain("detail");

  const lifecycleStreamId = `tool:${request.runId}:${request.toolCallId}`;
  const lifecycleEvents: CanonicalEvent[] = [];
  for await (const event of events.read(lifecycleStreamId as never)) {
    lifecycleEvents.push(event);
  }
  expect(lifecycleEvents.at(-1)).toEqual(
    expect.objectContaining({
      type: "tool.result",
      payload: expect.objectContaining({
        status: "failed",
        reason: "patch_precondition_failed",
      }),
    }),
  );
  expect(JSON.stringify(lifecycleEvents)).not.toContain("secret-not-durable");
  expect(JSON.stringify(lifecycleEvents)).not.toContain("detail");

  const gatewayB = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual(
    recordedFailedResult,
  );
  expect(sandboxExecutions).toBe(1);

  const replayedEffectEvents: CanonicalEvent[] = [];
  for await (const event of events.read(effectStreamId as never)) {
    replayedEffectEvents.push(event);
  }
  expect(replayedEffectEvents).toEqual(effectEvents);
});

test("executes an allowed safe read-only Tool with schema-normalized input", async () => {
  const succeededResult = {
    status: "succeeded" as const,
    output: { content: "# Anna" },
  };
  const policyRequests: ToolRequest[] = [];
  const sandboxRequests: ToolRequest[] = [];
  let sandboxExecutions = 0;
  const sandbox: SandboxAdapter = {
    async execute(request) {
      sandboxExecutions += 1;
      sandboxRequests.push(request);
      return succeededResult;
    },
  };
  const readWorkspace: ToolDefinition = {
    name: "read_workspace",
    replayPolicy: "safe",
    inputSchema: {
      parse(input: unknown) {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          typeof (input as Record<string, unknown>).path !== "string"
        ) {
          throw new Error("read_workspace input requires a path");
        }

        return {
          path: ((input as Record<string, unknown>).path as string).replace(
            /^\.\//,
            "",
          ),
        };
      },
    },
  };
  const policy: ToolPolicy = {
    async decide(request) {
      policyRequests.push(request);
      return "allow";
    },
  };
  const events = createInMemoryEvents();
  const request: ToolRequest & { toolCallId: string } = {
    name: "read_workspace",
    input: { path: "./README.md" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    toolCallId: "tool-call-safe-read-1",
  };
  const gateway = createToolGateway({
    catalog: [readWorkspace],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    now: () => "2026-08-19T00:00:00.000Z",
  });

  await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual(
    succeededResult,
  );

  expect(policyRequests).toEqual([
    expect.objectContaining({
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      runId: request.runId,
      workerProfileId: request.workerProfileId,
    }),
  ]);
  expect(policyRequests[0]).not.toHaveProperty("effectKey");
  expect(sandboxRequests).toEqual([
    expect.objectContaining({
      workspaceId: request.workspaceId,
      channelId: request.channelId,
      runId: request.runId,
      workerProfileId: request.workerProfileId,
      input: { path: "README.md" },
    }),
  ]);
  expect(sandboxRequests[0]).not.toHaveProperty("effectKey");
  expect(sandboxExecutions).toBe(1);

  const streamId = `tool:${request.runId}:${request.toolCallId}`;
  const lifecycleEvents: CanonicalEvent[] = [];
  for await (const event of events.read(streamId as never)) {
    lifecycleEvents.push(event);
  }

  expect(lifecycleEvents.map((event) => event.seq)).toEqual([0, 1, 2]);
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool.requested",
    "tool.policy.decided",
    "tool.result",
  ]);
  expect(lifecycleEvents[1]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ decision: "allow" }),
    }),
  );
  expect(lifecycleEvents[2]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ status: "succeeded" }),
    }),
  );

  const serializedEvents = JSON.stringify(lifecycleEvents);
  expect(serializedEvents).not.toContain("# Anna");
  expect(serializedEvents).not.toContain("./README.md");
  expect(serializedEvents).not.toContain("input");
});

test("cancellation reaches the deterministic Sandbox and records one terminal Tool result", async () => {
  const sandbox = expectedToolGatewayPublicApi.createDeterministicFakeSandbox({
    steps: [{ kind: "wait_for_abort" }],
  });
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-cancel-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-cancel-1",
    toolCallId: "tool-call-cancel-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-cancel-1",
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayA = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;

  await expect(gatewayA.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  await gatewayA.answerApproval(approval);

  const controller = new AbortController();
  const cancellationResult = gatewayA.execute(request, controller.signal);
  await sandbox.executionStarted;
  controller.abort("user_cancelled");

  const cancelledResult = {
    status: "failed" as const,
    output: { reason: "cancelled" },
  };
  await expect(cancellationResult).resolves.toEqual(cancelledResult);
  expect(sandbox.executions).toHaveLength(1);
  expect(sandbox.executions.at(0)?.signal).toBe(controller.signal);
  expect(sandbox.abortCount).toBe(1);

  const effectStreamId = `effect:${request.effectKey}`;
  const effectEvents: CanonicalEvent[] = [];
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }

  expect(effectEvents.map((event) => event.seq)).toEqual([0, 1]);
  expect(effectEvents.map((event) => event.type)).toEqual([
    "tool.effect.started",
    "tool.effect.cancelled",
  ]);
  const terminalEffectEvents = effectEvents.filter((event) =>
    [
      "tool.effect.succeeded",
      "tool.effect.failed",
      "tool.effect.unknown",
      "tool.effect.cancelled",
    ].includes(event.type),
  );
  expect(terminalEffectEvents).toHaveLength(1);
  expect(terminalEffectEvents).toEqual([
    expect.objectContaining({
      streamId: effectStreamId,
      seq: 1,
      type: "tool.effect.cancelled",
      payload: expect.objectContaining({
        workspaceId: request.workspaceId,
        channelId: request.channelId,
        runId: request.runId,
        workerProfileId: request.workerProfileId,
        tool: request.name,
        effectKey: request.effectKey,
        replayPolicy: "never",
        result: cancelledResult,
      }),
    }),
  ]);

  const gatewayB = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;
  await expect(gatewayB.execute(request, new AbortController().signal)).resolves.toEqual(
    cancelledResult,
  );
  expect(sandbox.executions).toHaveLength(1);

  const replayedEffectEvents: CanonicalEvent[] = [];
  for await (const event of events.read(effectStreamId as never)) {
    replayedEffectEvents.push(event);
  }
  expect(replayedEffectEvents).toEqual(effectEvents);
});

test("coordinates concurrent Gateway instances around one approved never-replay effect in local preview", async () => {
  let sandboxExecutions = 0;
  let resolveFirstExecutionStarted!: () => void;
  const firstExecutionStarted = new Promise<void>((resolve) => {
    resolveFirstExecutionStarted = resolve;
  });
  let releaseExecution!: () => void;
  const executionReleased = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const succeededResult = {
    status: "succeeded" as const,
    output: { changedFiles: ["README.md"] },
  };
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      resolveFirstExecutionStarted();
      await executionReleased;
      return succeededResult;
    },
  };
  const boundedPatch: ToolDefinition & { replayPolicy: "never" } = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const policy: ToolPolicy = {
    async decide() {
      return "require_approval";
    },
  };
  let eventNumber = 0;
  const gatewayOptions = {
    catalog: [boundedPatch],
    scope: defaultScope,
    workerProfileId: defaultWorkerProfileId,
    policy,
    sandbox,
    events,
    createEventId: () => `event-concurrent-${eventNumber++}`,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const request: ToolRequest = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "@@ -1 +1 @@\n-before\n+after" },
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
    runId: "run-1" as never,
    workerProfileId: "worker-profile-1" as never,
    effectKey: "effect-concurrent-1",
    toolCallId: "tool-call-concurrent-1",
  };
  const approval: ToolApprovalAnswer = {
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    runId: request.runId,
    effectKey: request.effectKey as string,
    approvalId: "approval:effect-concurrent-1",
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayBeforeApproval = createToolGateway(
    gatewayOptions,
  ) as unknown as DurableToolGateway;

  await expect(
    gatewayBeforeApproval.execute(request, new AbortController().signal),
  ).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approval.approvalId,
    },
  });
  await gatewayBeforeApproval.answerApproval(approval);

  const concurrentExecutions = Array.from({ length: 8 }, () =>
    createToolGateway(gatewayOptions).execute(request, new AbortController().signal),
  );
  await firstExecutionStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseExecution();

  await expect(Promise.all(concurrentExecutions)).resolves.toEqual(
    Array.from({ length: 8 }, () => succeededResult),
  );
  expect(sandboxExecutions).toBe(1);

  const effectEvents: CanonicalEvent[] = [];
  const effectStreamId = `effect:${request.effectKey}`;
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }

  expect(effectEvents.map((event) => event.seq)).toEqual([0, 1]);
  expect(effectEvents.map((event) => event.type)).toEqual([
    "tool.effect.started",
    "tool.effect.succeeded",
  ]);
});

test("fails closed before policy or Sandbox when a request escapes the bound scope or worker", async () => {
  const scope = Object.freeze({
    workspaceId: "workspace-bound" as never,
    channelId: "channel-bound" as never,
  });
  const workerProfileId = "worker-profile-bound" as never;
  let policyCalls = 0;
  let sandboxExecutions = 0;
  const policy: ToolPolicy = {
    async decide() {
      policyCalls += 1;
      return "allow";
    },
  };
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return { status: "succeeded" };
    },
  };
  const readWorkspace: ToolDefinition = {
    name: "read_workspace",
    replayPolicy: "safe",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const gateway = expectedToolGatewayPublicApi.createToolGateway({
    catalog: [readWorkspace],
    policy,
    sandbox,
    events,
    scope,
    workerProfileId,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  const rejectedRequests: readonly {
    request: ToolRequest & { toolCallId: string };
    spoofedValue: string;
  }[] = [
    {
      request: {
        name: "read_workspace",
        input: { path: "README.md" },
        workspaceId: "workspace-spoofed" as never,
        channelId: scope.channelId,
        runId: "run-scope-workspace" as never,
        workerProfileId,
        toolCallId: "tool-call-scope-workspace",
      },
      spoofedValue: "workspace-spoofed",
    },
    {
      request: {
        name: "read_workspace",
        input: { path: "README.md" },
        workspaceId: scope.workspaceId,
        channelId: "channel-spoofed" as never,
        runId: "run-scope-channel" as never,
        workerProfileId,
        toolCallId: "tool-call-scope-channel",
      },
      spoofedValue: "channel-spoofed",
    },
    {
      request: {
        name: "read_workspace",
        input: { path: "README.md" },
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        runId: "run-scope-worker" as never,
        workerProfileId: "worker-profile-spoofed" as never,
        toolCallId: "tool-call-scope-worker",
      },
      spoofedValue: "worker-profile-spoofed",
    },
  ];

  for (const { request } of rejectedRequests) {
    await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual({
      status: "failed",
      output: { reason: "scope_denied" },
    });
  }

  expect(policyCalls).toBe(0);
  expect(sandboxExecutions).toBe(0);

  for (const { request, spoofedValue } of rejectedRequests) {
    const lifecycleEvents: CanonicalEvent[] = [];
    const streamId = `tool:${request.runId}:${request.toolCallId}`;
    for await (const event of events.read(streamId as never)) {
      lifecycleEvents.push(event);
    }

    expect(lifecycleEvents.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.result",
    ]);
    expect(lifecycleEvents[1]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: "failed",
          reason: "scope_denied",
        }),
      }),
    );
    for (const event of lifecycleEvents) {
      expect(event).toEqual(
        expect.objectContaining({
          workspaceId: scope.workspaceId,
          channelId: scope.channelId,
          streamId,
          payload: expect.objectContaining({ workerProfileId }),
        }),
      );
    }

    const serializedEvents = JSON.stringify(lifecycleEvents);
    expect(serializedEvents).not.toContain(spoofedValue);
  }
});

test("fails closed when a recreated Gateway reuses a never-replay effect key for another Run", async () => {
  let sandboxExecutions = 0;
  const succeededResult = { status: "succeeded" as const };
  const sandbox: SandboxAdapter = {
    async execute() {
      sandboxExecutions += 1;
      return succeededResult;
    },
  };
  const boundedPatch: ToolDefinition = {
    name: "bounded_patch",
    replayPolicy: "never",
    inputSchema: {
      parse(input: unknown) {
        return input;
      },
    },
  };
  const events = createInMemoryEvents();
  const scope = Object.freeze({
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
  });
  const workerProfileId = "worker-profile-1" as never;
  const gatewayOptions: BoundToolGatewayOptions = {
    catalog: [boundedPatch],
    policy: {
      async decide() {
        return "require_approval";
      },
    },
    sandbox,
    events,
    scope,
    workerProfileId,
    now: () => "2026-08-19T00:00:00.000Z",
  };
  const requestA: ToolRequest & { toolCallId: string; effectKey: string } = {
    name: "bounded_patch",
    input: { path: "README.md", patch: "first patch" },
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    runId: "run-1" as never,
    workerProfileId,
    effectKey: "effect-intent-conflict-1",
    toolCallId: "tool-call-effect-intent-a",
  };
  const approvalA: ToolApprovalAnswer = {
    workspaceId: requestA.workspaceId,
    channelId: requestA.channelId,
    runId: requestA.runId,
    effectKey: requestA.effectKey,
    approvalId: `approval:${requestA.effectKey}`,
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayA = expectedToolGatewayPublicApi.createToolGateway(gatewayOptions);

  await expect(gatewayA.execute(requestA, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approvalA.approvalId,
    },
  });
  await gatewayA.answerApproval(approvalA);
  await expect(gatewayA.execute(requestA, new AbortController().signal)).resolves.toEqual(
    succeededResult,
  );
  expect(sandboxExecutions).toBe(1);

  const requestB: ToolRequest & { toolCallId: string; effectKey: string } = {
    ...requestA,
    runId: "run-2" as never,
    toolCallId: "tool-call-effect-intent-b",
  };
  const approvalB: ToolApprovalAnswer = {
    workspaceId: requestB.workspaceId,
    channelId: requestB.channelId,
    runId: requestB.runId,
    effectKey: requestB.effectKey,
    approvalId: `approval:${requestB.effectKey}`,
    actorId: "human-1",
    decision: "approved",
  };
  const gatewayB = expectedToolGatewayPublicApi.createToolGateway(gatewayOptions);

  await expect(gatewayB.execute(requestB, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: {
      reason: "approval_required",
      approvalId: approvalB.approvalId,
    },
  });
  await gatewayB.answerApproval(approvalB);
  await expect(gatewayB.execute(requestB, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "effect_key_conflict" },
  });
  expect(sandboxExecutions).toBe(1);

  const effectEvents: CanonicalEvent[] = [];
  const effectStreamId = `effect:${requestA.effectKey}`;
  for await (const event of events.read(effectStreamId as never)) {
    effectEvents.push(event);
  }
  expect(effectEvents.filter((event) => event.type === "tool.effect.started")).toHaveLength(
    1,
  );

  const lifecycleEvents: CanonicalEvent[] = [];
  const lifecycleStreamId = `tool:${requestB.runId}:${requestB.toolCallId}`;
  for await (const event of events.read(lifecycleStreamId as never)) {
    lifecycleEvents.push(event);
  }
  expect(lifecycleEvents.at(-1)).toEqual(
    expect.objectContaining({
      type: "tool.result",
      payload: expect.objectContaining({
        status: "failed",
        reason: "effect_key_conflict",
      }),
    }),
  );
});

test("records invalid registered tool input as a failed lifecycle result", async () => {
  const scope = Object.freeze({
    workspaceId: "workspace-1" as never,
    channelId: "channel-1" as never,
  });
  const workerProfileId = "worker-profile-1" as never;
  let policyCalls = 0;
  let sandboxExecutions = 0;
  const malformedInputTool: ToolDefinition = {
    name: "bounded_patch",
    inputSchema: {
      parse() {
        throw new Error("bounded_patch input is invalid");
      },
    },
  };
  const events = createInMemoryEvents();
  const gateway = expectedToolGatewayPublicApi.createToolGateway({
    catalog: [malformedInputTool],
    policy: {
      async decide() {
        policyCalls += 1;
        return "allow";
      },
    },
    sandbox: {
      async execute() {
        sandboxExecutions += 1;
        return { status: "succeeded" };
      },
    },
    events,
    scope,
    workerProfileId,
    now: () => "2026-08-19T00:00:00.000Z",
  });
  const request: ToolRequest & { toolCallId: string } = {
    name: "bounded_patch",
    input: { path: "README.md" },
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    runId: "run-invalid-tool-input" as never,
    workerProfileId,
    toolCallId: "tool-call-invalid-tool-input",
  };

  await expect(gateway.execute(request, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "invalid_tool_input" },
  });
  expect(policyCalls).toBe(0);
  expect(sandboxExecutions).toBe(0);

  const lifecycleEvents: CanonicalEvent[] = [];
  const streamId = `tool:${request.runId}:${request.toolCallId}`;
  for await (const event of events.read(streamId as never)) {
    lifecycleEvents.push(event);
  }
  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool.requested",
    "tool.result",
  ]);
  expect(lifecycleEvents[1]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        status: "failed",
        reason: "invalid_tool_input",
      }),
    }),
  );
});
