import { expect, test } from "vitest";

import { parseStartRun } from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

function startRun(overrides: Record<string, unknown> = {}) {
  return parseStartRun({
    commandId: "command-child",
    runId: "child-run",
    goal: "Run the child lane.",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    source: { eventId: "source-event" },
    runProfile: { id: "profile-1", version: "1" },
    runProfileSnapshot: resolvedRunProfileFixture({ budget: { turns: 1 } }),
    budget: { turns: 1 },
    permissionScope: "permission-1",
    stopCondition: "artifact_or_terminal",
    ...overrides,
  });
}

test("parses parent Run and lane attribution as part of the durable command", () => {
  expect(startRun({
    parentRunId: "parent-run",
    parentEventId: "parent-event",
    laneId: "lane-1",
  })).toMatchObject({
    parentRunId: "parent-run",
    parentEventId: "parent-event",
    laneId: "lane-1",
  });
});

test.each([
  [{ parentRunId: "parent-run" }],
  [{ parentEventId: "parent-event" }],
])("requires both parent Run and source event for child attribution", (overrides) => {
  expect(() => startRun(overrides)).toThrow(
    "StartRun.parentRunId and StartRun.parentEventId must be provided together",
  );
});
