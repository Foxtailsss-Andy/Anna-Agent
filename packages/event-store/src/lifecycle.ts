import type { RunOutcome, RunState } from "@anna/harness-v2";

const terminalOutcomes = {
  "run.completed": { status: "completed" },
  "run.awaiting_input": { status: "awaiting_input" },
  "run.awaiting_approval": { status: "awaiting_approval" },
  "run.failed": { status: "failed" },
  "run.timed_out": { status: "timed_out" },
  "run.cancelled": { status: "cancelled" },
} as const satisfies Record<string, RunOutcome>;

const finalEventTypes = new Set([
  "run.completed",
  "run.failed",
  "run.timed_out",
  "run.cancelled",
]);

export function terminalOutcome(type: string): RunOutcome | undefined {
  const outcome = terminalOutcomes[type as keyof typeof terminalOutcomes];
  return outcome === undefined ? undefined : { ...outcome };
}

export function isTerminalEvent(type: string): boolean {
  return finalEventTypes.has(type);
}

export function isTerminalRunState(status: RunState): boolean {
  return status !== "queued" && status !== "running";
}
