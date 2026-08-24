import type { SandboxAdapter, ToolRequest, ToolResult } from "./interfaces";

export interface DeterministicFakeSandboxOptions {
  steps: readonly { kind: "wait_for_abort" }[];
}

export interface DeterministicFakeSandbox extends SandboxAdapter {
  readonly executions: readonly { request: ToolRequest; signal: AbortSignal }[];
  readonly abortCount: number;
  readonly executionStarted: Promise<void>;
}

export function createDeterministicFakeSandbox(
  options: DeterministicFakeSandboxOptions,
): DeterministicFakeSandbox {
  const executions: { request: ToolRequest; signal: AbortSignal }[] = [];
  let abortCount = 0;
  let resolveExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    resolveExecutionStarted = resolve;
  });
  let stepIndex = 0;

  return {
    get executions() {
      return executions;
    },
    get abortCount() {
      return abortCount;
    },
    executionStarted,
    execute(request, signal): Promise<ToolResult> {
      executions.push({ request, signal });
      resolveExecutionStarted();

      const step = options.steps[stepIndex++];
      if (step?.kind !== "wait_for_abort") {
        return Promise.resolve({
          status: "failed",
          output: { reason: "missing_fake_sandbox_step" },
        });
      }

      return new Promise((resolve) => {
        let settled = false;
        const cancel = () => {
          if (settled) {
            return;
          }

          settled = true;
          abortCount += 1;
          resolve({ status: "failed", output: { reason: "cancelled" } });
        };

        if (signal.aborted) {
          cancel();
          return;
        }

        signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
}
