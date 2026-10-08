import {
  parseCanonicalEvent,
  type CanonicalEvent,
  type ChannelScope,
  type StreamId,
} from "@anna/harness-v2";
import { expect, test } from "vitest";

import { projectTrace } from "../src/index";

const scope = { workspaceId: "workspace-omp-trace", channelId: "channel-omp-trace" } as ChannelScope;
const runId = "run-omp-trace";

function event(seq: number, type: string, payload: CanonicalEvent["payload"]): CanonicalEvent {
  return parseCanonicalEvent({
    id: `event-omp-${seq}`,
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    streamId: runId as StreamId,
    seq,
    type,
    timestamp: new Date(Date.UTC(2026, 9, 8, 3, 0, seq)).toISOString(),
    schemaVersion: 1,
    payload,
  });
}

/** The checkpoint sequence the OMP kernel persists for one tool turn and one final answer. */
const ompRun = [
  event(0, "run.queued", { phase: "queued" }),
  event(1, "run.started", { phase: "started" }),
  event(2, "run.model.requested", { requestIndex: 1, model: "deepseek-v4-pro", toolDefinitions: [{ name: "workdir.read_file" }] }),
  event(3, "omp.model.response", {
    requestIndex: 1,
    message: { role: "assistant", stopReason: "toolUse", usage: { input: 1200, output: 80 }, content: [] },
  }),
  event(4, "omp.tool.dispatch", { toolCallId: "call-1", tool: "workdir.read_file", inputDigest: "abc" }),
  event(5, "omp.tool.response", { toolCallId: "call-1", result: { status: "succeeded", output: { content: "secret-ish" } } }),
  event(6, "run.progress", { phase: "turn_end" }),
  event(7, "run.model.requested", { requestIndex: 2, model: "deepseek-v4-pro" }),
  event(8, "omp.model.response", {
    requestIndex: 2,
    // Usage deliberately absent: the trace must not invent token counts.
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  }),
  event(9, "omp.tool.dispatch", { toolCallId: "call-2", tool: "sandbox.exec" }),
  event(10, "omp.tool.response", { toolCallId: "call-2", result: { status: "failed" } }),
  event(11, "run.completed", { outcome: "completed" }),
];

test("projects OMP kernel checkpoints into turn, inference and tool spans", () => {
  const trace = projectTrace(ompRun, { runId, surface: "chat", scope });
  const byKind = (kind: string) => trace.spans.filter((span) => span.kind === kind);

  expect(trace.trace_id).toBe(runId);
  expect(byKind("agent")).toHaveLength(1);
  expect(byKind("agent")[0]!.status).toBe("ok");
  expect(byKind("agent")[0]!.attributes["anna.turns"]).toBe(2);
  expect(byKind("turn").map((span) => span.name)).toEqual(["turn 1", "turn 2"]);

  const [first, second] = byKind("inference");
  expect(first!.name).toBe("chat deepseek-v4-pro");
  expect(first!.attributes["gen_ai.usage.input_tokens"]).toBe(1200);
  expect(first!.attributes["gen_ai.usage.output_tokens"]).toBe(80);
  expect(first!.duration_ms).toBe(1000);
  expect(second!.attributes).not.toHaveProperty("gen_ai.usage.input_tokens");
  expect(second!.attributes).not.toHaveProperty("gen_ai.usage.output_tokens");

  const tools = byKind("tool");
  expect(tools.map((span) => [span.name, span.status, span.parent_span_id])).toEqual([
    ["execute_tool workdir.read_file", "ok", byKind("turn")[0]!.span_id],
    ["execute_tool sandbox.exec", "error", byKind("turn")[1]!.span_id],
  ]);
  // Tool outputs are never copied into span attributes or events.
  expect(JSON.stringify(trace)).not.toContain("secret-ish");
});

test("marks an inference still open at cancellation as orphaned", () => {
  const trace = projectTrace([
    event(0, "run.started", {}),
    event(1, "run.model.requested", { requestIndex: 1, model: "m" }),
    event(2, "run.cancelled", { outcome: "cancelled" }),
  ], { runId, surface: "chat", scope });
  const inference = trace.spans.find((span) => span.kind === "inference")!;
  expect(inference.status).toBe("error");
  expect(inference.attributes["anna.orphaned"]).toBe(true);
  const agent = trace.spans.find((span) => span.kind === "agent")!;
  expect(agent.status).toBe("error");
  expect(agent.attributes["anna.outcome"]).toBe("cancelled");
});
