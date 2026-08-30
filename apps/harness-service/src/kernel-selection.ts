export type HarnessKernelAdapter = "pi" | "omp";

export type KernelSelectionErrorBody =
  | {
      readonly code: "kernel_unavailable";
      readonly requested_adapter: HarnessKernelAdapter;
      readonly reason: "managed_runtime_unavailable" | "kernel_identity_mismatch";
    }
  | {
      readonly code: "kernel_selection_invalid";
    };

export class KernelSelectionError extends Error {
  readonly body: KernelSelectionErrorBody;

  constructor(body: KernelSelectionErrorBody) {
    super(body.code);
    this.name = "KernelSelectionError";
    this.body = body;
  }
}

export function assertKernelSelectionAdmitted(value: unknown): void {
  if (value === undefined || value === "pi") {
    return;
  }
  if (value === "omp") {
    throw new KernelSelectionError({
      code: "kernel_unavailable",
      requested_adapter: "omp",
      reason: "managed_runtime_unavailable",
    });
  }
  throw new KernelSelectionError({ code: "kernel_selection_invalid" });
}

export function isKernelSelectionError(
  error: unknown,
): error is KernelSelectionError {
  return error instanceof KernelSelectionError;
}
