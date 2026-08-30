import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import {
  loadSkillCatalogEntry,
  parseStartRun,
  resolveRunProfile,
  type CanonicalEvent,
  type EventSink,
  type LoopKernel,
  type RunOutcome,
  type StartRun,
} from "@anna/harness-v2";
import { SqliteEventStore } from "@anna/event-store";
import { PiLoopKernel } from "@anna/pi-loop-kernel";

import { startHarnessService } from "../src/index";
import { createDurableHarnessV2Runtime } from "../src/runtime";

function profile(turns = 1) {
  const budget = { turns };
  const skill = loadSkillCatalogEntry({
    id: "skill:runtime-test",
    document: [
      "---",
      "name: Runtime test",
      "version: 1.0.0",
      "allowed_tools:",
      "  - fixture_read",
      "forbidden_tools:",
      "  - shell",
      "---",
      "Use the bounded fixture read tool when the goal requires it.",
      "",
    ].join("\n"),
    provenance: { source: "test", uri: "test://runtime-profile" },
  });

  return resolveRunProfile({
    catalog: [skill],
    channelPolicy: {
      toolPolicy: { allowedTools: ["fixture_read"] },
      allowedSkillIds: [skill.id],
      allowedModels: [{ provider: "test", name: "test-model", reasoning: "low" }],
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["disabled"] },
    },
    workerProfile: {
      id: "worker:runtime-test",
      version: "1",
      instructions: "Run the test goal.",
      allowedSkillIds: [skill.id],
      allowedTools: ["fixture_read"],
      modelPolicy: {
        allowedModels: [{ provider: "test", name: "test-model", reasoning: "low" }],
      },
      budgetDefaults: budget,
      artifactContract: {
        kind: "test-result",
        requiredFor: ["completed"],
        verification: "tests",
      },
    },
    runProfile: {
      id: "profile:runtime-test",
      version: "1",
      model: { provider: "test", name: "test-model", reasoning: "low" },
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal", "provenance"] }],
      toolPolicy: { allowedTools: ["fixture_read"] },
      budget,
      memoryPolicy: { read: "none", write: "disabled" },
      evalPolicy: { contract: "required", quality: "disabled" },
      artifactContract: {
        kind: "test-result",
        requiredFor: ["completed"],
        verification: "tests",
      },
      terminalRules: {
        allowedOutcomes: ["completed", "failed"],
        stopCondition: "artifact_or_terminal",
      },
    },
  });
}

test("close drains a resume command lookup before the core Runtime is entered", async () => {
  const store = new SqliteEventStore(":memory:");
  const configuredProfile = profile();
  const command = parseStartRun({
    workspaceId: "workspace-close-lookup", channelId: "channel-close-lookup",
    commandId: "command-close-lookup", runId: "run-close-lookup", goal: "Resume after lookup.",
    source: { eventId: "source-close-lookup" },
    runProfile: { id: configuredProfile.id, version: configuredProfile.version },
    runProfileSnapshot: configuredProfile, budget: configuredProfile.budget,
    permissionScope: "permission-close-lookup", stopCondition: configuredProfile.terminalRules.stopCondition,
  });
  await store.scope(command).claimStart(command);
  const originalScope = store.scope.bind(store);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolveReading) => { entered = resolveReading; });
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  store.scope = (scope) => {
    const port = originalScope(scope);
    return new Proxy(port, {
      get(target, key) {
        if (key === "getRunCommand") return async (runId: StartRun["runId"]) => {
          entered(); await gate; return target.getRunCommand(runId);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  let starts = 0;
  const runtime = createDurableHarnessV2Runtime({
    eventStore: store, profile: configuredProfile, surfaces: ["create"],
    kernel: {
      async start() { starts += 1; return { status: "completed" }; },
      async steer() {}, async answer() {}, async abort() {},
    },
  });
  const resuming = runtime.resume!("create", command.runId, {
    workspace_id: command.workspaceId, channel_id: command.channelId,
  });
  void resuming.catch(() => undefined);
  try {
    await reading;
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    expect(closed).toBe(false);
    release();
    await expect(resuming).rejects.toThrow("closing");
    await closing;
    expect(starts).toBe(0);
  } finally {
    release(); await resuming.catch(() => undefined); await runtime.close(); store.close();
  }
});

class CompletingKernel implements LoopKernel {
  async start(command: StartRun, sink: EventSink): Promise<RunOutcome> {
    await sink.append(event(command, 1, "run.started", { phase: "started" }));
    await sink.append(event(command, 2, "run.completed", { outcome: "completed" }));
    return { status: "completed" };
  }

  async steer(): Promise<void> {}
  async answer(): Promise<void> {}
  async abort(): Promise<void> {}
}

class ResumeCompletingKernel implements LoopKernel {
  async start(command: StartRun, sink: EventSink): Promise<RunOutcome> {
    const readable = sink as EventSink & {
      read?: (streamId: never) => AsyncIterable<CanonicalEvent>;
    };
    const events: CanonicalEvent[] = [];
    if (readable.read !== undefined) {
      for await (const persisted of readable.read(command.runId as never)) {
        events.push(persisted);
      }
    }
    await sink.append(event(command, events.length, "run.resumed", { phase: "resumed" }));
    await sink.append(event(command, events.length + 1, "run.completed", { outcome: "completed" }));
    return { status: "completed" };
  }

  async steer(): Promise<void> {}
  async answer(): Promise<void> {}
  async abort(): Promise<void> {}
}

function event(
  command: StartRun,
  seq: number,
  type: string,
  payload: Record<string, string>,
): CanonicalEvent {
  return {
    id: `event:${command.runId}:${seq}`,
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    streamId: command.runId,
    seq,
    type,
    timestamp: "2026-08-23T00:00:00.000Z",
    schemaVersion: 1,
    payload,
  } as unknown as CanonicalEvent;
}

test("HTTP v2 create starts a durable scoped Run and exposes persisted events", async () => {
  expect(profile().evalPolicy.contract).toBe("required");
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-runtime-test-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const runtime = createDurableHarnessV2Runtime({
    eventStore: store,
    kernel: new CompletingKernel(),
    profile: profile(),
    surfaces: ["create", "cowork", "hub"],
  });
  const service = await startHarnessService({ runtime });

  try {
    const response = await fetch(`${service.url}/v2/surfaces/create/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "workspace-runtime-test",
        channel_id: "channel-runtime-test",
        command_id: "command-runtime-test",
        source_event_id: "event-source-runtime-test",
        goal: "Complete the runtime integration test.",
      }),
    });

    expect(response.status).toBe(202);
    const started = await response.json() as {
      surface_id: string;
      run_id: string;
      status: string;
    };
    expect(started).toMatchObject({ surface_id: "create", status: "queued" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await fetch(
      `${service.url}/v2/runs/${started.run_id}/events?workspace_id=workspace-runtime-test&channel_id=channel-runtime-test`,
    );
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      run_id: started.run_id,
      events: [
        { type: "run.queued", seq: 0 },
        { type: "run.started", seq: 1 },
        { type: "run.eval.contract", seq: 2, payload: { passed: true } },
        { type: "run.completed", seq: 3 },
      ],
    });

    for (const surfaceId of ["cowork", "hub"] as const) {
      const surfaceResponse = await fetch(`${service.url}/v2/surfaces/${surfaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: `workspace-${surfaceId}`,
          channel_id: `channel-${surfaceId}`,
          command_id: `command-${surfaceId}`,
          source_event_id: `event-source-${surfaceId}`,
          goal: `Complete the ${surfaceId} runtime test.`,
        }),
      });
      expect(surfaceResponse.status).toBe(202);
    }

    const capabilities = await fetch(`${service.url}/capabilities`);
    await expect(capabilities.json()).resolves.toMatchObject({
      surfaces: expect.arrayContaining([
        expect.objectContaining({ id: "create", status: "test_only" }),
        expect.objectContaining({ id: "cowork", status: "test_only" }),
        expect.objectContaining({ id: "hub", status: "test_only" }),
      ]),
    });
  } finally {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP v2 event reader survives a service restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-restart-test-"));
  const databasePath = join(directory, "events.sqlite");
  const firstStore = new SqliteEventStore(databasePath);
  let firstStoreClosed = false;
  const firstRuntime = createDurableHarnessV2Runtime({
    eventStore: firstStore,
    kernel: new CompletingKernel(),
    profile: profile(),
    surfaces: ["create"],
  });
  const firstService = await startHarnessService({ runtime: firstRuntime });

  try {
    const response = await fetch(`${firstService.url}/v2/surfaces/create/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "workspace-restart-test",
        channel_id: "channel-restart-test",
        command_id: "command-restart-test",
        source_event_id: "event-source-restart-test",
        goal: "Persist the restart test Run.",
      }),
    });
    expect(response.status).toBe(202);
    const started = await response.json() as { run_id: string };
    await new Promise((resolve) => setTimeout(resolve, 30));
    await firstService.close();
    firstStore.close();
    firstStoreClosed = true;

    const reopenedStore = new SqliteEventStore(databasePath);
    const restartedRuntime = createDurableHarnessV2Runtime({
      eventStore: reopenedStore,
      kernel: new CompletingKernel(),
      profile: profile(),
      surfaces: ["create"],
    });
    const restartedService = await startHarnessService({ runtime: restartedRuntime });
    try {
      const events = await fetch(
        `${restartedService.url}/v2/runs/${started.run_id}/events?workspace_id=workspace-restart-test&channel_id=channel-restart-test`,
      );
      expect(events.status).toBe(200);
      const body = await events.json() as { events: Array<{ type: string }> };
      expect(body.events.map((event) => event.type)).toEqual([
        "run.queued",
        "run.started",
        "run.eval.contract",
        "run.completed",
      ]);
    } finally {
      await restartedService.close();
      reopenedStore.close();
    }
  } finally {
    await firstService.close().catch(() => undefined);
    if (!firstStoreClosed) firstStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP v2 resume restores a persisted Pi Run after SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-resume-route-test-"));
  const databasePath = join(directory, "events.sqlite");
  const configuredProfile = profile();
  const command = parseStartRun({
    workspaceId: "workspace-resume-route",
    channelId: "channel-resume-route",
    commandId: "command-resume-route",
    runId: "run-resume-route",
    goal: "Resume the durable Run.",
    source: { eventId: "event-source-resume-route" },
    runProfile: { id: configuredProfile.id, version: configuredProfile.version },
    runProfileSnapshot: configuredProfile,
    budget: configuredProfile.budget,
    permissionScope: "permission-resume-route",
    stopCondition: configuredProfile.terminalRules.stopCondition,
  });

  const firstStore = new SqliteEventStore(databasePath);
  const firstScope = firstStore.scope(command);
  await firstScope.claimStart(command);
  await firstScope.append(event(command, 0, "run.queued", { phase: "queued" }));
  await firstScope.append(event(command, 1, "run.started", { phase: "started" }));
  firstStore.close();

  const reopenedStore = new SqliteEventStore(databasePath);
  const runtime = createDurableHarnessV2Runtime({
    eventStore: reopenedStore,
    kernel: new ResumeCompletingKernel(),
    profile: configuredProfile,
    surfaces: ["create"],
  });
  const service = await startHarnessService({ runtime });

  try {
    const response = await fetch(
      `${service.url}/v2/surfaces/create/runs/${command.runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: command.workspaceId,
          channel_id: command.channelId,
          command_id: command.commandId,
          source_event_id: command.source.eventId,
          goal: command.goal,
        }),
      },
    );
    expect(response.status).toBe(202);

    let events: CanonicalEvent[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const eventsResponse = await fetch(
        `${service.url}/v2/runs/${command.runId}/events?workspace_id=${command.workspaceId}&channel_id=${command.channelId}`,
      );
      const body = await eventsResponse.json() as { events: CanonicalEvent[] };
      events = body.events;
      if (events.some((persisted) => persisted.type === "run.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(events.map((persisted) => persisted.type)).toEqual([
      "run.queued",
      "run.started",
      "run.resumed",
      "run.eval.contract",
      "run.completed",
    ]);
    expect(events.find((persisted) => persisted.type === "run.eval.contract")?.payload)
      .toMatchObject({ passed: true });
    expect(events.map((persisted) => persisted.seq)).toEqual([0, 1, 2, 3, 4]);
  } finally {
    await service.close();
    reopenedStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi resumes a SQLite transcript after approval across process reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-harness-pi-reopen-test-"));
  const databasePath = join(directory, "events.sqlite");
  const configuredProfile = profile(2);
  const command = parseStartRun({
    workspaceId: "workspace-pi-reopen",
    channelId: "channel-pi-reopen",
    commandId: "command-pi-reopen",
    runId: "run-pi-reopen",
    goal: "Read the approved fixture and finish the Run.",
    source: { eventId: "event-source-pi-reopen" },
    runProfile: { id: configuredProfile.id, version: configuredProfile.version },
    runProfileSnapshot: configuredProfile,
    budget: configuredProfile.budget,
    permissionScope: "permission-pi-reopen",
    stopCondition: configuredProfile.terminalRules.stopCondition,
  });
  const provider = fauxProvider();
  const firstMessage = fauxAssistantMessage(
    fauxToolCall("fixture_read", { key: "release-note" }),
    { stopReason: "toolUse" },
  );
  const resumedMessage = fauxAssistantMessage("The Run resumed and completed.");
  const approvalRequiredGateway = {
    async execute() {
      return { status: "failed" as const, output: { reason: "approval_required" } };
    },
  };
  const approvedGateway = {
    async execute() {
      return { status: "succeeded" as const, output: "approved fixture" };
    },
  };

  try {
    const firstStore = new SqliteEventStore(databasePath);
    const scoped = firstStore.scope(command);
    await scoped.claimStart(command);
    await scoped.append(event(command, 0, "run.queued", { phase: "queued" }));
    const firstKernel = new PiLoopKernel({
      model: provider.getModel(),
      toolGateway: approvalRequiredGateway,
      workerProfileId: configuredProfile.workerProfileId,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: firstMessage });
        stream.push({ type: "done", reason: "toolUse", message: firstMessage });
        return stream;
      },
      now: () => 0,
    });

    await expect(firstKernel.start(command, scoped, new AbortController().signal))
      .resolves.toEqual({ status: "awaiting_approval" });
    firstStore.close();

    const reopenedStore = new SqliteEventStore(databasePath);
    try {
      const resumedKernel = new PiLoopKernel({
        model: provider.getModel(),
        toolGateway: approvedGateway,
        workerProfileId: configuredProfile.workerProfileId,
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: resumedMessage });
          stream.push({ type: "done", reason: "stop", message: resumedMessage });
          return stream;
        },
        now: () => 0,
      });

      await expect(resumedKernel.start(
        command,
        reopenedStore.scope(command),
        new AbortController().signal,
      )).resolves.toEqual({ status: "completed" });

      const events: CanonicalEvent[] = [];
      for await (const persisted of reopenedStore.scope(command).read(command.runId)) {
        events.push(persisted);
      }
      expect(events.map((persisted) => persisted.type)).toContain("run.resumed");
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(events.map((persisted) => persisted.seq)).toEqual(
        events.map((_persisted, index) => index),
      );
      expect(events.find((persisted) => persisted.type === "run.started")?.payload)
        .toHaveProperty("executionFingerprint");
    } finally {
      reopenedStore.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
