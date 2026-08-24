import { expect, test } from "vitest";

import { buildRunContext, compactRunContext } from "../src/index";

test("compaction preserves the Run goal, constraints, pending Tool calls, and provenance", () => {
  const input = {
    workspaceId: "workspace-release-notes",
    channelId: "channel-release-notes",
    runId: "run-release-note-correction",
    workerProfileId: "worker-profile-release-manager",
    goal: {
      content: "Apply the approved release-note correction.",
      provenance: {
        source: "channel-message",
        sourceEventIds: ["event-goal-1"],
      },
    },
    constraints: [
      {
        content: "Change only the Chinese release-note text.",
        provenance: {
          source: "channel-message",
          sourceEventIds: ["event-constraint-language-1"],
        },
      },
      {
        content: "Do not publish before the owner reviews the artifact.",
        provenance: {
          source: "channel-message",
          sourceEventIds: ["event-constraint-review-1"],
        },
      },
    ],
    transientMessages: [
      {
        role: "user",
        content: "The Chinese description needs the approved correction.",
        provenance: {
          source: "channel-message",
          sourceEventIds: ["event-message-1", "event-message-shared"],
        },
      },
      {
        role: "assistant",
        content: "I will prepare a reviewable patch.",
        provenance: {
          source: "run-event",
          sourceEventIds: ["event-message-shared", "event-message-2"],
        },
      },
    ],
    pendingToolCalls: [
      {
        workspaceId: "workspace-release-notes",
        channelId: "channel-release-notes",
        runId: "run-release-note-correction",
        workerProfileId: "worker-profile-release-manager",
        name: "bounded_patch",
        input: {
          path: "docs/release-notes.md",
          expected: "旧版中文说明",
          replacement: "已批准的中文说明",
        },
        effectKey: "effect-release-note-correction-17",
        toolCallId: "tool-call-17",
        provenance: {
          source: "tool.requested",
          sourceEventIds: ["event-tool-requested-17"],
        },
      },
    ],
    memoryHits: [
      {
        memoryId: "memory-release-approval",
        content: "Release notes require owner review before publication.",
        provenance: {
          source: "channel-memory",
          sourceEventIds: ["event-memory-accepted-3"],
        },
      },
    ],
  };
  const mismatchedInput = {
    ...input,
    pendingToolCalls: [
      {
        ...input.pendingToolCalls[0],
        channelId: "channel-other",
      },
    ],
  };

  const compacted = compactRunContext(buildRunContext(input), {
    summary:
      "The owner approved a Chinese-only correction; prepare the pending reviewable patch.",
  });

  input.goal.content = "Mutated goal";
  input.constraints[0].content = "Mutated constraint";
  input.transientMessages[0].content = "Mutated transient message";
  input.memoryHits[0].content = "Mutated memory";
  input.workspaceId = "mutated-workspace";
  input.channelId = "mutated-channel";
  input.runId = "mutated-run";
  input.workerProfileId = "mutated-worker-profile";
  input.pendingToolCalls[0].workspaceId = "mutated-tool-workspace";
  input.pendingToolCalls[0].channelId = "mutated-tool-channel";
  input.pendingToolCalls[0].runId = "mutated-tool-run";
  input.pendingToolCalls[0].workerProfileId = "mutated-tool-worker-profile";
  input.pendingToolCalls[0].name = "mutated_tool";
  input.pendingToolCalls[0].effectKey = "mutated-effect-key";
  input.pendingToolCalls[0].toolCallId = "mutated-tool-call";
  input.pendingToolCalls[0].input.replacement = "Mutated replacement";

  expect(compacted).toEqual({
    workspaceId: "workspace-release-notes",
    channelId: "channel-release-notes",
    runId: "run-release-note-correction",
    workerProfileId: "worker-profile-release-manager",
    goal: {
      content: "Apply the approved release-note correction.",
      provenance: {
        source: "channel-message",
        sourceEventIds: ["event-goal-1"],
      },
    },
    constraints: [
      {
        content: "Change only the Chinese release-note text.",
        provenance: {
          source: "channel-message",
          sourceEventIds: ["event-constraint-language-1"],
        },
      },
      {
        content: "Do not publish before the owner reviews the artifact.",
        provenance: {
          source: "channel-message",
          sourceEventIds: ["event-constraint-review-1"],
        },
      },
    ],
    transientMessages: [
      {
        role: "summary",
        content:
          "The owner approved a Chinese-only correction; prepare the pending reviewable patch.",
        provenance: {
          source: "compaction",
          sourceEventIds: [
            "event-goal-1",
            "event-constraint-language-1",
            "event-constraint-review-1",
            "event-message-1",
            "event-message-shared",
            "event-message-2",
            "event-tool-requested-17",
            "event-memory-accepted-3",
          ],
        },
      },
    ],
    pendingToolCalls: [
      {
        workspaceId: "workspace-release-notes",
        channelId: "channel-release-notes",
        runId: "run-release-note-correction",
        workerProfileId: "worker-profile-release-manager",
        name: "bounded_patch",
        input: {
          path: "docs/release-notes.md",
          expected: "旧版中文说明",
          replacement: "已批准的中文说明",
        },
        effectKey: "effect-release-note-correction-17",
        toolCallId: "tool-call-17",
        provenance: {
          source: "tool.requested",
          sourceEventIds: ["event-tool-requested-17"],
        },
      },
    ],
    memoryHits: [
      {
        memoryId: "memory-release-approval",
        content: "Release notes require owner review before publication.",
        provenance: {
          source: "channel-memory",
          sourceEventIds: ["event-memory-accepted-3"],
        },
      },
    ],
  });

  expect(() => buildRunContext(mismatchedInput)).toThrow(
    "RunContext pending Tool call must match its bound scope, Run, and Worker",
  );
});

test("compaction accepts a context without transient messages and preserves all provenance", () => {
  const context = buildRunContext({
    workspaceId: "workspace-compact-empty",
    channelId: "channel-compact-empty",
    runId: "run-compact-empty",
    workerProfileId: "worker-compact-empty",
    goal: {
      content: "Preserve the goal while compacting.",
      provenance: { source: "goal", sourceEventIds: ["event-goal"] },
    },
    constraints: [],
    transientMessages: [],
    pendingToolCalls: [],
    memoryHits: [],
  });

  expect(compactRunContext(context, { summary: "Goal preserved." }).transientMessages[0]).toEqual({
    role: "summary",
    content: "Goal preserved.",
    provenance: { source: "compaction", sourceEventIds: ["event-goal"] },
  });
});
