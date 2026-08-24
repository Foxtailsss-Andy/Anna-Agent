import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { InMemoryEventStore } from "@anna/event-store";
import {
  createChannelMemoryRepository,
  createReviewToValidatedPatch,
  parseCanonicalEvent,
  parseStartRun,
  resolveRunProfile,
  type ChannelScope,
  type ReviewScenarioInput,
  type StreamId,
} from "@anna/harness-v2";

import { SchedulerService, schedulerStreamId } from "../src/index";

function memoryEnabledRunProfile() {
  const model = { provider: "fixture", name: "t07-memory", reasoning: "low" as const };
  const skill = {
    id: "t07-memory-skill",
    name: "T07 memory",
    version: "1.0.0",
    hash: "sha256:t07-memory-skill",
    provenance: { source: "test", uri: "fixture://t07-memory" },
    content: "Propose only provenance-bearing review decisions.",
    allowedTools: ["read_workspace"],
    forbiddenTools: ["shell"],
  };
  const artifactContract = {
    kind: "review",
    requiredFor: ["completed" as const],
    verification: "tests" as const,
  };
  return resolveRunProfile({
    catalog: [skill],
    workerProfile: {
      id: "worker:t07-memory" as never,
      version: "1.0.0",
      instructions: "Keep review Memory scoped to the Channel.",
      allowedSkillIds: [skill.id],
      allowedTools: ["read_workspace"],
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: { turns: 1 },
      artifactContract,
    },
    channelPolicy: {
      toolPolicy: { allowedTools: ["read_workspace"] },
      allowedSkillIds: [skill.id],
      allowedModels: [model],
      budgetLimits: { turns: 1 },
      memoryPolicy: { allowedReadModes: ["channel"], allowedWriteModes: ["propose"] },
    },
    runProfile: {
      id: "profile:t07-memory" as never,
      version: "1.0.0",
      model,
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal", "provenance"] }],
      toolPolicy: { allowedTools: ["read_workspace"] },
      budget: { turns: 1 },
      memoryPolicy: { read: "channel", write: "propose" },
      evalPolicy: { contract: "required", quality: "disabled" },
      artifactContract,
      terminalRules: { allowedOutcomes: ["completed", "failed"], stopCondition: "artifact_or_terminal" },
    },
  });
}

test("T07 follow-up passes the real Scheduler parser and policy before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-scheduler-"));
  const scope = {
    workspaceId: "workspace-t07-scheduler",
    channelId: "channel-t07-scheduler",
  } as ChannelScope;
  const input: ReviewScenarioInput = {
    ...scope,
    reviewNotes: "Re-check the validated patch.",
    prdPath: "docs/review.md",
    uiPath: "src/main.tsx",
    ownerId: "actor-t07-owner",
    sourceRunId: "run-t07-source",
    sourceEventIds: ["event-t07-source"],
  };
  const store = new InMemoryEventStore().scope(scope);
  const scheduler = new SchedulerService(store, {
    createRun: async () => undefined,
    policy: {
      permissionScopes: ["permission:t07-read-only" as never],
      allowedTools: ["read_workspace"],
    },
  });

  try {
    const scenario = createReviewToValidatedPatch({
      root,
      input,
      scheduler,
      services: {
        events: store,
        memory: {
          propose: async () => undefined,
          accept: async () => undefined,
        },
        traceProjector: {
          project: (_events, traceId) => ({ traceId, artifactIds: [], gateIds: [], eventIds: [] }),
        },
        evalGate: {
          evaluate: async () => ({ passed: true, checkedEventIds: [] }),
        },
      },
    });

    const followUp = await scenario.scheduleFollowUp({
      dueAt: "2026-08-21T09:00:00.000Z",
      label: "Re-check the validated patch",
      scheduler,
    });

    await expect(scheduler.list()).resolves.toEqual([followUp.schedule]);
    const lifecycle = [];
    for await (const event of store.read(schedulerStreamId)) {
      lifecycle.push(event);
    }
    expect(lifecycle).toMatchObject([{ type: "schedule.created" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T07 MemoryCandidate uses canonical events and preserves source provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "anna-t07-memory-"));
  const eventStore = new InMemoryEventStore();
  const scope = {
    workspaceId: "workspace-t07-memory",
    channelId: "channel-t07-memory",
  } as ChannelScope;
  const input: ReviewScenarioInput = {
    ...scope,
    reviewNotes: "Keep the approved review decision visible.",
    prdPath: "docs/review.md",
    uiPath: "src/main.tsx",
    ownerId: "actor-t07-owner",
    sourceRunId: "run-t07-source",
    sourceEventIds: ["event-t07-source"],
  };
  const runProfileSnapshot = memoryEnabledRunProfile();
  const store = eventStore.scope(scope);

  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, input.prdPath), "# Review\n");
    await writeFile(join(root, input.uiPath), "export const view = 'before';\n");
    await store.claimStart(parseStartRun({
      commandId: "command-t07-source",
      runId: input.sourceRunId,
      goal: "Provide review notes.",
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      source: { eventId: input.sourceEventIds[0] },
      runProfile: { id: runProfileSnapshot.id, version: runProfileSnapshot.version },
      runProfileSnapshot,
      budget: { turns: 1 },
      permissionScope: "permission:t07-memory",
      stopCondition: "artifact_or_terminal",
    }));
    await store.append(parseCanonicalEvent({
      id: input.sourceEventIds[0],
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      streamId: input.sourceRunId,
      seq: 0,
      type: "run.completed",
      timestamp: "2026-08-20T08:00:00.000Z",
      schemaVersion: 1,
      payload: {},
    }));
    const memory = createChannelMemoryRepository({
      eventStore,
      scope,
      runProfileSnapshot,
      authorization: {
        async assertOwner(_scope, actorId) {
          if (actorId !== input.ownerId) {
            throw new Error("Channel Owner authorization denied");
          }
        },
      },
      now: () => "2026-08-20T08:01:00.000Z",
      createEventId: (() => {
        let sequence = 0;
        return () => `event-t07-memory-${++sequence}`;
      })(),
    });
    const scenario = createReviewToValidatedPatch({
      root,
      input,
      services: {
        events: store,
        memory,
        traceProjector: {
          project: (_events, traceId) => ({ traceId, artifactIds: [], gateIds: [], eventIds: [] }),
        },
        evalGate: { evaluate: async () => ({ passed: true, checkedEventIds: [] }) },
      },
    });

    const prepared = await scenario.prepare();
    const candidate = await scenario.proposeMemoryCandidate(prepared);
    await scenario.confirmMemoryCandidate(candidate.id, input.ownerId);

    const memoryEvents = [];
    for await (const event of store.read("channel-memory" as StreamId)) {
      memoryEvents.push(event);
    }
    expect(memoryEvents.map((event) => event.type)).toEqual([
      "memory.candidate.proposed",
      "memory.accepted",
    ]);
    expect(memoryEvents[0]?.payload).toMatchObject({
      sourceRunId: input.sourceRunId,
      sourceEventIds: input.sourceEventIds,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
