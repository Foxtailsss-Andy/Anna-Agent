import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveCreateRuntimeBoundary } from "./createRuntimeBoundary";

describe("Create Runtime boundary", () => {
  it("keeps the existing Legacy path when the v2 sidecar is absent", () => {
    expect(resolveCreateRuntimeBoundary({
      v2Configured: false,
      runId: "run-1",
      v2RunId: null,
      channelId: null,
    })).toEqual({ kind: "legacy" });
  });

  it("selects v2 only for a Run attributed to the current v2 channel", () => {
    expect(resolveCreateRuntimeBoundary({
      v2Configured: true,
      runId: "run-1",
      v2RunId: "run-1",
      channelId: "desktop-home:workspace-1",
    })).toEqual({ kind: "v2", channelId: "desktop-home:workspace-1" });
  });

  it("fails closed when v2 is configured but attribution is missing", () => {
    expect(resolveCreateRuntimeBoundary({
      v2Configured: true,
      runId: "run-1",
      v2RunId: null,
      channelId: "desktop-home:workspace-1",
    })).toEqual({
      kind: "unavailable",
      message: "Harness v2 Create Run attribution is unavailable; Legacy fallback is disabled.",
    });
  });

  it("fails closed when the current Run does not match the v2 attribution", () => {
    expect(resolveCreateRuntimeBoundary({
      v2Configured: true,
      runId: "legacy-run",
      v2RunId: "v2-run",
      channelId: "desktop-home:workspace-1",
    })).toEqual({
      kind: "unavailable",
      message: "Harness v2 Create Run attribution is unavailable; Legacy fallback is disabled.",
    });
  });

  it("keeps Home Create completion and activation behind the same resolver", () => {
    const source = readFileSync(new URL("./HomePage.tsx", import.meta.url), "utf8");
    expect(source.match(/resolveCreateRuntimeBoundary\(\{/g)).toHaveLength(2);
    expect(source).toContain('else if (boundary.kind === "legacy")');
    expect(source).not.toContain("if (v2CreateRunRef.current === id &&");
  });
});
