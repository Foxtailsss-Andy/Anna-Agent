import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  SchemaValidationError,
  budgetSchema,
  parseArtifact,
  parseBudget,
  parseCanonicalEvent,
  parseChannelScope,
  parseChannelSession,
  parseMemoryCandidate,
  parseResolvedRunProfileSnapshot,
  parseRun,
  parseStartRun,
} from "../src/index";
import { assertContractsDependencyBoundary } from "./dependency-boundary";
import { resolvedRunProfileFixture } from "./run-profile-fixture";
import type {
  ActorId,
  RunOutcome,
  ScheduleRun,
  Scheduler,
} from "../src/index";

const validRunProfileSnapshot = resolvedRunProfileFixture();

const validStartRun = {
  commandId: "command-1",
  runId: "run-1",
  goal: "Prepare the PRD delta.",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  source: { eventId: "event-1" },
  runProfile: { id: "profile-1", version: "1" },
  runProfileSnapshot: validRunProfileSnapshot,
  budget: { turns: 1 },
  permissionScope: "scope-1",
  stopCondition: "artifact_or_terminal",
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const scheduleRun: ScheduleRun = {
  ...parseStartRun(validStartRun),
  trigger: { kind: "explicit", label: "daily check" },
  notificationAudience: ["actor-1" as ActorId],
};
const schedulerParametersMatchScheduleRun: Equal<
  Parameters<Scheduler["schedule"]>,
  [record: import("../src/index").ScheduleRecord]
> = true;

// @ts-expect-error schedules must record their notification audience.
const missingNotificationAudience: ScheduleRun = {
  ...parseStartRun(validStartRun),
  trigger: { kind: "explicit", label: "daily check" },
};
void scheduleRun;
void schedulerParametersMatchScheduleRun;
void missingNotificationAudience;

describe("StartRun schema", () => {
  test("accepts a scoped command and deep-clones its resolved profile snapshot", () => {
    const input = structuredClone(validStartRun) as unknown as {
      runProfileSnapshot: { model: { name: string } };
    };
    const parsed = parseStartRun(input);

    input.runProfileSnapshot.model.name = "changed-model";
    expect(parsed).toMatchObject(validStartRun);
    expect(parsed.runProfileSnapshot).not.toBe(input.runProfileSnapshot);
    expect(parsed.runProfileSnapshot.model).toEqual({
      provider: "test",
      name: "fixture-model",
      reasoning: "low",
    });
    expect(Object.isFrozen(parsed.runProfileSnapshot)).toBe(true);
  });

  test("rejects a command without a channel", () => {
    expect(() => parseStartRun({ ...validStartRun, channelId: "" })).toThrow(
      SchemaValidationError,
    );
  });

  test("requires a matching non-empty resolved profile snapshot", () => {
    const { runProfileSnapshot: _snapshot, ...withoutSnapshot } = validStartRun;

    for (const invalidCommand of [
      withoutSnapshot,
      { ...validStartRun, runProfileSnapshot: "not-an-object" },
      {
        ...validStartRun,
        runProfileSnapshot: { ...validStartRun.runProfileSnapshot, version: "2" },
      },
      {
        ...validStartRun,
        runProfileSnapshot: { ...validStartRun.runProfileSnapshot, hash: "" },
      },
    ]) {
      expect(() => parseStartRun(invalidCommand)).toThrow(SchemaValidationError);
    }
  });

  test("rejects tampered or unknown resolved profile fields", () => {
    expect(() => parseResolvedRunProfileSnapshot({
      ...validRunProfileSnapshot,
      hash: "sha256:tampered",
    })).toThrow(SchemaValidationError);
    expect(() => parseResolvedRunProfileSnapshot({
      ...validRunProfileSnapshot,
      unknown: true,
    })).toThrow(SchemaValidationError);
  });

  test("rejects execution budget and stop condition drift from the resolved snapshot", () => {
    expect(() => parseStartRun({
      ...validStartRun,
      budget: { turns: 2 },
    })).toThrow(SchemaValidationError);
    expect(() => parseStartRun({
      ...validStartRun,
      stopCondition: "different-stop-condition",
    })).toThrow(SchemaValidationError);
  });

  test("rejects a command without an explicit goal", () => {
    const { goal: _goal, ...withoutGoal } = validStartRun;

    expect(() => parseStartRun(withoutGoal)).toThrow(SchemaValidationError);
  });

  test("rejects an empty goal", () => {
    expect(() => parseStartRun({ ...validStartRun, goal: "" })).toThrow(
      SchemaValidationError,
    );
  });
});

describe("Budget schema", () => {
  test("accepts a positive decimal cost and normalizes all invalid input errors", () => {
    expect(parseBudget({ cost: 0.125 })).toEqual({ cost: 0.125 });
    expect(budgetSchema.parse({ cost: 0.125 })).toEqual({ cost: 0.125 });

    for (const invalidBudget of [
      {},
      { cost: 0 },
      { cost: -0.125 },
      { cost: Number.NaN },
      { cost: Number.POSITIVE_INFINITY },
      { turns: 1.5 },
    ]) {
      expect(() => parseBudget(invalidBudget)).toThrow(SchemaValidationError);
    }
  });
});

describe("canonical event schema", () => {
  test("requires channel scope, a parseable timestamp, and JSON-safe payloads", () => {
    const event = {
      id: "event-2",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      streamId: "channel-1",
      seq: 1,
      type: "run.created",
      timestamp: "2026-08-17T00:00:00.000Z",
      schemaVersion: 1,
      payload: { runId: "run-1" },
    };
    const { channelId: _channelId, ...unscopedEvent } = event;

    expect(parseCanonicalEvent(event)).toMatchObject(event);
    expect(() => parseCanonicalEvent(unscopedEvent)).toThrow(
      SchemaValidationError,
    );
    expect(() =>
      parseCanonicalEvent({ ...event, timestamp: "not-a-timestamp" }),
    ).toThrow(SchemaValidationError);
    expect(() =>
      parseCanonicalEvent({ ...event, payload: { usage: Number.NaN } }),
    ).toThrow(SchemaValidationError);
    expect(() => parseCanonicalEvent({ ...event, payload: undefined })).toThrow(
      SchemaValidationError,
    );
  });
});

describe("ChannelSession schema", () => {
  test("requires the workspace and channel that bound the session", () => {
    const session = {
      id: "session-1",
      workspaceId: "workspace-1",
      channelId: "channel-1",
    };

    expect(parseChannelSession(session)).toMatchObject(session);
    expect(() => parseChannelSession({ ...session, workspaceId: "" })).toThrow(
      SchemaValidationError,
    );
  });
});

describe("ChannelScope schema", () => {
  test("parses an independently usable channel binding", () => {
    const scope = {
      workspaceId: "workspace-1",
      channelId: "channel-1",
    };

    expect(parseChannelScope(scope)).toEqual(scope);
    expect(() => parseChannelScope({ ...scope, channelId: "" })).toThrow(
      SchemaValidationError,
    );
  });
});

describe("Run schema", () => {
  test("requires a terminal outcome only after reaching a terminal state", () => {
    const run = {
      id: "run-1",
      goal: "Prepare the PRD delta.",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      source: { eventId: "event-1" },
      runProfile: { id: "profile-1", version: "1" },
      runProfileSnapshot: validRunProfileSnapshot,
      budget: { turns: 1 },
      permissionScope: "scope-1",
      stopCondition: "artifact_or_terminal",
      status: "completed",
      outcome: { status: "completed" },
    };

    expect(parseRun(run)).toMatchObject(run);
    expect(() => {
      const { outcome: _outcome, ...incompleteRun } = run;
      parseRun(incompleteRun);
    }).toThrow(SchemaValidationError);
    expect(() => {
      const { runProfileSnapshot: _snapshot, ...withoutSnapshot } = run;
      parseRun(withoutSnapshot);
    }).toThrow(SchemaValidationError);
    expect(() => parseRun({
      ...run,
      runProfileSnapshot: { ...run.runProfileSnapshot, id: "profile-2" },
    })).toThrow(SchemaValidationError);
  });
});

describe("Artifact schema", () => {
  test("requires its producer Run and immutable review evidence", () => {
    const artifact = {
      id: "artifact-1",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      runId: "run-1",
      kind: "prd",
      uri: "file:///worktree/PRD.md",
      hash: "sha256:abc",
      version: "1",
      validationStatus: "passed",
      reviewState: "approved",
    };
    const { runId: _runId, ...withoutProducer } = artifact;

    expect(parseArtifact(artifact)).toMatchObject(artifact);
    expect(() => parseArtifact(withoutProducer)).toThrow(SchemaValidationError);
  });
});

describe("MemoryCandidate schema", () => {
  test("requires channel scope and provenance before promotion", () => {
    const candidate = {
      id: "memory-candidate-1",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      content: "Product owner prefers a compact PRD.",
      sourceEventIds: ["event-1"],
    };

    expect(parseMemoryCandidate(candidate)).toMatchObject(candidate);
    expect(() =>
      parseMemoryCandidate({ ...candidate, sourceEventIds: [] }),
    ).toThrow(SchemaValidationError);
  });
});

describe("contract dependency boundary", () => {
  test("does not expose a filesystem scanner from the public package", async () => {
    const publicContracts = await import("../src/index");

    expect("assertContractsDependencyBoundary" in publicContracts).toBe(false);
  });

  test("accepts the package source", () => {
    expect(() =>
      assertContractsDependencyBoundary(fileURLToPath(new URL("../src/", import.meta.url))),
    ).not.toThrow();
  });

  test.each([".ts", ".mjs", ".cjs"])(
    "rejects Pi, Electron, legacy Python, Crew, and SQLite imports in %s source",
    (extension) => {
      const root = mkdtempSync(join(tmpdir(), "anna-harness-v2-boundary-"));
      writeFileSync(join(root, `forbidden${extension}`), 'import "pi-ai";');

      try {
        expect(() => assertContractsDependencyBoundary(root)).toThrow(
          "forbidden contract dependency",
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});

describe("terminal run outcomes", () => {
  test("accepts a terminal outcome and rejects running", async () => {
    const { parseRunOutcome } = await import("../src/index");
    const completed: RunOutcome = { status: "completed" };

    expect(parseRunOutcome(completed)).toEqual(completed);
    expect(() => parseRunOutcome({ status: "running" })).toThrow(
      SchemaValidationError,
    );

    // @ts-expect-error running is a lifecycle state, never a terminal outcome.
    const running: RunOutcome = { status: "running" };
    expect(running.status).toBe("running");
  });
});
