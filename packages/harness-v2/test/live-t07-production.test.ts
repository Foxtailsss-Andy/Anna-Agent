import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { SqliteEventStore } from "@anna/event-store";
import { evaluateContract } from "@anna/eval";
import { projectTrace } from "@anna/trace";
import { expect, test } from "vitest";

import {
  createChannelMemoryRepository,
  createHttpReviewApprovalProvider,
  createReviewToValidatedPatch,
  loadSkillCatalogEntry,
  parseStartRun,
  resolveRunProfile,
  type CanonicalEvent,
  type ReviewArtifact,
  type ReviewScenarioInput,
  type ReviewScenarioServices,
  type ReviewScenarioResult,
  type ResolvedRunProfile,
  type ScheduleRecord,
} from "../src/index";

const live = process.env.ANNA_T07_LIVE_SOURCE !== undefined
  && process.env.ANNA_T07_LIVE_HEAD !== undefined
  && process.env.ANNA_T07_LIVE_BACKEND_ORIGIN !== undefined
  && process.env.ANNA_T07_LIVE_OWNER_ID !== undefined
  && process.env.ANNA_T07_LIVE_PROVIDER !== undefined
  && process.env.ANNA_T07_LIVE_APPROVAL_ORIGIN !== undefined
  && process.env.ANNA_T07_LIVE_EVIDENCE_DIR !== undefined;

const runLive = live ? test : test.skip;

runLive("executes T07 with real provider, durable Store, Memory, Trace, Eval and Owner approval", async () => {
  const sourceRoot = resolve(process.env.ANNA_T07_LIVE_SOURCE!);
  const ownerId = process.env.ANNA_T07_LIVE_OWNER_ID!;
  const provider = process.env.ANNA_T07_LIVE_PROVIDER!;
  const backendOrigin = process.env.ANNA_T07_LIVE_BACKEND_ORIGIN!.replace(/\/+$/, "");
  const evidenceDirectory = resolve(process.env.ANNA_T07_LIVE_EVIDENCE_DIR!);
  const workspaceId = "workspace-t07-live-production";
  const channelId = "channel-t07-live-production";
  const input: ReviewScenarioInput = {
    workspaceId,
    channelId,
    reviewNotes: "Record the Owner-approved T07 review decision without changing legacy surfaces.",
    prdPath: "docs/product/anna-harness-v2-spec-2026-08-17.md",
    uiPath: "apps/desktop/src/main.tsx",
    testPath: "apps/desktop/src/lib/theme.test.ts",
    ownerId,
    sourceRunId: "",
    sourceEventIds: ["event:t07:provider-source"],
  };
  const databaseDirectory = await mkdtemp(join(tmpdir(), "anna-t07-live-production-store-"));
  const databasePath = join(databaseDirectory, "events.sqlite");
  let store: SqliteEventStore | undefined;
  let result: ReviewScenarioResult | undefined;

  try {
    const providerRun = await runRealProviderRun(backendOrigin, workspaceId, channelId);
    const liveInput: ReviewScenarioInput = { ...input, sourceRunId: providerRun.runId };
    const profile = liveReviewProfile(provider);
    store = new SqliteEventStore(databasePath);
    const scoped = store.scope({ workspaceId, channelId } as never);
    const sourceRun = parseStartRun({
      commandId: `command:t07:provider-source:${providerRun.runId}`,
      runId: providerRun.runId,
      goal: "Source provider Run for the live T07 review canary.",
      workspaceId,
      channelId,
      source: { eventId: input.sourceEventIds[0]! },
      runProfile: { id: profile.id, version: profile.version },
      runProfileSnapshot: profile,
      budget: profile.budget,
      permissionScope: "permission:t07-live-source",
      stopCondition: profile.terminalRules.stopCondition,
    });
    await scoped.claimStart(sourceRun);
    await scoped.append({
      id: input.sourceEventIds[0] as CanonicalEvent["id"],
      workspaceId: workspaceId as CanonicalEvent["workspaceId"],
      channelId: channelId as CanonicalEvent["channelId"],
      streamId: providerRun.runId as CanonicalEvent["streamId"],
      seq: 0,
      type: "run.started",
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      payload: { providerRunId: providerRun.runId },
    });

    const memory = createChannelMemoryRepository({
      eventStore: store,
      scope: { workspaceId, channelId } as never,
      runProfileSnapshot: profile,
      authorization: {
        async assertOwner(_scope, actorId) {
          if (actorId !== ownerId) throw new Error("live Owner identity mismatch");
        },
      },
    });
    const services = liveReviewServices(scoped, liveInput, memory);
    const scenario = createReviewToValidatedPatch({
      root: sourceRoot,
      input: liveInput,
      mode: "live",
      liveWorktree: {
        expectedHead: process.env.ANNA_T07_LIVE_HEAD!,
        backendOrigin,
      },
      runProfileSnapshot: profile,
      services,
      scheduler: {
        async schedule(record: ScheduleRecord) {
          await scoped.createSchedule(record);
          return record;
        },
      },
      approvalProvider: createHttpReviewApprovalProvider({
        origin: process.env.ANNA_T07_LIVE_APPROVAL_ORIGIN!,
        ownerId,
      }),
    });
    result = await scenario.run();

    const events = await readAllRunEvents(scoped, result.traceId);
    const summary = {
      schemaVersion: 1,
      caseId: "t07-live",
      evidenceMode: "live",
      provider,
      owner: ownerId,
      providerRun,
      t07: {
        traceId: result.traceId,
        eventCount: events.length,
        terminal: events.filter((event) => ["run.completed", "run.failed"].includes(event.type)).map((event) => event.type),
        contiguous: events.map((event) => event.seq).every((seq, index) => seq === index),
        eventIndex: events.map(redactedEventIndex),
        mergeReady: result.mergeReady,
        evalPassed: result.eval.passed,
        memoryConfirmed: result.memoryCandidate?.confirmed === true,
        ownerActors: result.gates.map((gate) => gate.actorId).filter((actor): actor is string => actor !== undefined),
        artifacts: result.artifacts.map((artifact) => ({
          kind: artifact.kind,
          hash: artifact.hash,
          producerRunId: artifact.producerRunId,
          validationStatus: artifact.validationStatus,
        })),
        testExitCode: result.testEvidence.exitCode,
      },
    };
    await writeFile(join(evidenceDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
    expect(result.mergeReady).toBe(true);
    expect(result.eval.passed).toBe(true);
    expect(result.memoryCandidate?.confirmed).toBe(true);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(summary.t07.contiguous).toBe(true);
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      caseId: "t07-live",
      evidenceMode: "live",
      provider,
      owner: ownerId,
      failure: error instanceof Error ? error.message : String(error),
      evidenceSufficient: false,
    };
    await writeFile(join(evidenceDirectory, "summary.json"), JSON.stringify(failure, null, 2) + "\n", "utf8");
    throw error;
  } finally {
    store?.close();
    await rm(databaseDirectory, { recursive: true, force: true });
    if (result?.paths?.root !== undefined && result.paths.root !== sourceRoot) {
      const worktreeParent = resolve(result.paths.root, "..");
      if (worktreeParent.includes("anna-t07-live-worktree-")) {
        await rm(worktreeParent, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}, 180_000);

async function runRealProviderRun(
  backendOrigin: string,
  workspaceId: string,
  channelId: string,
): Promise<{
  readonly runId: string;
  readonly terminal: string;
  readonly eventCount: number;
  readonly usagePresent: boolean;
  readonly toolCalls: number;
  readonly evalPassed: boolean;
}> {
  const response = await fetch(`${backendOrigin}/api/harness/v2/surfaces/create/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: workspaceId,
      channel_id: channelId,
      command_id: `command:t07:provider:${Date.now()}`,
      source_event_id: "event:t07:provider-source",
      goal: "Use the approved read_only tool to inspect notes.txt and reply with a short completion confirmation.",
    }),
  });
  if (!response.ok) throw new Error(`live provider Run start returned HTTP ${response.status}`);
  const body = await response.json() as { run_id?: unknown };
  if (typeof body.run_id !== "string" || body.run_id.trim() === "") throw new Error("live provider Run response omitted run_id");
  const eventsUrl = `${backendOrigin}/api/harness/v2/runs/${encodeURIComponent(body.run_id)}/events?workspace_id=${encodeURIComponent(workspaceId)}&channel_id=${encodeURIComponent(channelId)}`;
  let events: Array<{ seq: number; type: string; payload?: Record<string, unknown> }> = [];
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const eventsResponse = await fetch(eventsUrl);
    if (!eventsResponse.ok) throw new Error(`live provider Run events returned HTTP ${eventsResponse.status}`);
    events = (await eventsResponse.json() as { events?: typeof events }).events ?? [];
    if (events.some((event) => ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(event.type))) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  const terminal = events.filter((event) => ["run.completed", "run.failed", "run.timed_out", "run.cancelled"].includes(event.type));
  if (terminal.length !== 1 || terminal[0]?.type !== "run.completed") throw new Error("live provider Run did not complete exactly once");
  const sequence = events.map((event) => event.seq);
  if (!sequence.every((seq, index) => seq === index)) throw new Error("live provider Run sequence is not contiguous");
  const evidence = {
    runId: body.run_id,
    terminal: terminal[0]!.type,
    eventCount: events.length,
    usagePresent: events.some((event) => event.payload?.usage !== undefined),
    toolCalls: events.filter((event) => event.type === "run.tool.completed").length,
    evalPassed: events.some((event) => event.type === "run.eval.contract" && event.payload?.passed === true),
  };
  if (!evidence.usagePresent || evidence.toolCalls === 0 || !evidence.evalPassed) {
    throw new Error("live provider Run lacks usage, Tool, or contract Eval evidence");
  }
  return evidence;
}

function liveReviewProfile(provider: string): ResolvedRunProfile {
  const allowedTools = [
    "read_workspace",
    "bounded_patch",
    "build_changed_ui",
    "capture_screenshot",
    "run_command",
    "write_artifact",
    "create_isolated_worktree",
  ];
  const skill = loadSkillCatalogEntry({
    id: "skill:t07-live-review",
    document: "---\nname: T07 live review\nversion: 1.0.0\n---\nExecute only approved review worktree operations.\n",
    provenance: { source: "anna-live", uri: "anna://live/t07/review" },
  });
  const model = { provider, name: "t07-review", reasoning: "low" as const };
  const budget = { turns: 32, toolCalls: 64 };
  const artifactContract = {
    kind: "validated_patch",
    requiredFor: ["completed" as const],
    verification: "tests" as const,
  };
  return resolveRunProfile({
    catalog: [skill],
    channelPolicy: {
      toolPolicy: { allowedTools },
      allowedSkillIds: [skill.id],
      allowedModels: [model],
      budgetLimits: budget,
      memoryPolicy: { allowedReadModes: ["none"], allowedWriteModes: ["propose"] },
    },
    workerProfile: {
      id: "worker:t07-development" as never,
      version: "1.0.0",
      instructions: "Execute the approved T07 review-to-validated-patch flow inside its isolated worktree.",
      allowedSkillIds: [skill.id],
      allowedTools,
      modelPolicy: { allowedModels: [model] },
      budgetDefaults: budget,
      artifactContract,
    },
    runProfile: {
      id: "profile:t07-review-live" as never,
      version: "1.0.0",
      model,
      skillIds: [skill.id],
      contextTransforms: [{ kind: "compact", preserve: ["goal", "provenance"] }],
      toolPolicy: { allowedTools },
      budget,
      memoryPolicy: { read: "none", write: "propose" },
      evalPolicy: { contract: "required", quality: "disabled" },
      artifactContract,
      terminalRules: {
        allowedOutcomes: ["completed", "failed", "awaiting_approval"],
        stopCondition: "artifact_or_terminal",
      },
    },
  });
}

function liveReviewServices(
  scoped: ReturnType<SqliteEventStore["scope"]>,
  input: ReviewScenarioInput,
  memory: ReviewScenarioServices["memory"],
): ReviewScenarioServices {
  return {
    events: scoped,
    memory,
    traceProjector: {
      project(events, traceId) {
        const trace = projectTrace(events, {
          runId: traceId,
          surface: "t07-review",
          scope: { workspaceId: input.workspaceId as never, channelId: input.channelId as never },
        });
        return {
          traceId,
          artifactIds: events
            .filter((event) => event.type === "t07.artifact.recorded")
            .flatMap((event) => artifactId(event)),
          gateIds: events
            .filter((event) => event.type === "t07.gate.recorded")
            .flatMap((event) => gateId(event)),
          eventIds: events.map((event) => event.id),
        };
      },
    },
    evalGate: {
      async evaluate(evidence) {
        const contract = evaluateContract({
          traceId: evidence.traceId,
          events: evidence.events,
          artifacts: evidence.artifacts.map((artifact: ReviewArtifact) => ({
            id: artifact.id as never,
            workspaceId: input.workspaceId as never,
            channelId: input.channelId as never,
            runId: artifact.producerRunId as never,
            kind: artifact.kind,
            uri: artifact.path,
            hash: artifact.hash,
            version: artifact.version,
            validationStatus: artifact.validationStatus,
            reviewState: artifact.reviewState,
          })),
        }, {
          requiredEventTypes: ["run.started", "t07.test.executed"],
          requiredArtifactKinds: ["test"],
          requireTerminal: false,
        });
        return {
          passed: evidence.testsPassed && contract.passed,
          reason: contract.reason,
          checkedEventIds: contract.checkedEventIds,
        };
      },
    },
  };
}

async function readAllRunEvents(
  scoped: ReturnType<SqliteEventStore["scope"]>,
  runId: string,
): Promise<CanonicalEvent[]> {
  const streams = new Set([runId, `t07-result:${runId}`]);
  for (const stream of await scoped.listRunStreamIds(runId as never)) streams.add(stream);
  const events: CanonicalEvent[] = [];
  for (const stream of streams) {
    for await (const event of scoped.read(stream as never)) events.push(event);
  }
  return events;
}

function artifactId(event: CanonicalEvent): string[] {
  const payload = event.payload as { artifact?: { id?: unknown } };
  return typeof payload.artifact?.id === "string" ? [payload.artifact.id] : [];
}

function gateId(event: CanonicalEvent): string[] {
  const payload = event.payload as { gate?: { id?: unknown } };
  return typeof payload.gate?.id === "string" ? [payload.gate.id] : [];
}

function redactedEventIndex(event: CanonicalEvent): {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly payloadKeys: readonly string[];
} {
  const payload = event.payload;
  return {
    seq: event.seq,
    id: event.id,
    type: event.type,
    payloadKeys: typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [],
  };
}
