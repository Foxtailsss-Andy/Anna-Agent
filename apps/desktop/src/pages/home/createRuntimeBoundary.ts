export type CreateRuntimeBoundary =
  | { kind: "legacy" }
  | { kind: "v2"; channelId: string }
  | { kind: "unavailable"; message: string };

const V2_ATTRIBUTION_ERROR =
  "Harness v2 Create Run attribution is unavailable; Legacy fallback is disabled.";

export function resolveCreateRuntimeBoundary(input: {
  v2Configured: boolean;
  runId: string;
  v2RunId: string | null;
  channelId: string | null;
}): CreateRuntimeBoundary {
  if (!input.v2Configured) return { kind: "legacy" };
  if (
    input.channelId === null
    || input.channelId.trim() === ""
    || input.v2RunId !== input.runId
  ) {
    return { kind: "unavailable", message: V2_ATTRIBUTION_ERROR };
  }
  return { kind: "v2", channelId: input.channelId };
}
