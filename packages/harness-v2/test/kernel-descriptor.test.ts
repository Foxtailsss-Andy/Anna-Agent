import { createHash } from "node:crypto";

import { expect, test } from "vitest";

import {
  parseResolvedRunProfileSnapshot,
  parsePiKernelDescriptor,
  type PiKernelDescriptorV1,
} from "../src/index";
import { resolvedRunProfileFixture } from "./run-profile-fixture";

const descriptor: PiKernelDescriptorV1 = {
  schemaVersion: 1,
  adapterId: "pi",
  protocolVersion: "anna-loop-kernel/1",
  adapterSource: {
    packageName: "@anna/pi-loop-kernel",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  upstream: {
    agentCore: {
      version: "0.84.2",
      integrity: "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
    },
    ai: {
      version: "0.84.2",
      integrity: "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
    },
  },
};

test("parses and deep-freezes the closed Pi kernel descriptor", () => {
  const parsed = parsePiKernelDescriptor(descriptor);

  expect(parsed).toEqual(descriptor);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.adapterSource)).toBe(true);
  expect(Object.isFrozen(parsed.upstream.agentCore)).toBe(true);
});

test.each([
  ["null", null],
  ["unknown field", { ...descriptor, extra: true }],
  ["missing field", { ...descriptor, upstream: undefined }],
  ["null nested record", { ...descriptor, adapterSource: null }],
  ["wrong adapter", { ...descriptor, adapterId: "omp" }],
  ["invalid source digest", {
    ...descriptor,
    adapterSource: { ...descriptor.adapterSource, sha256: "not-a-digest" },
  }],
  ["malformed SRI", {
    ...descriptor,
    upstream: {
      ...descriptor.upstream,
      ai: { ...descriptor.upstream.ai, integrity: "sha512-not-base64" },
    },
  }],
] as const)("rejects %s descriptor", (_name, value) => {
  expect(() => parsePiKernelDescriptor(value)).toThrow();
});

test("includes a descriptor in profile identity while preserving legacy snapshots", () => {
  const legacy = resolvedRunProfileFixture();
  const { hash: _legacyHash, ...legacyWithoutHash } = legacy;
  const withoutHash = { ...legacyWithoutHash, kernel: descriptor };
  const withKernel = {
    ...withoutHash,
    hash: canonicalHash(withoutHash),
  };

  expect(parseResolvedRunProfileSnapshot(legacy)).toEqual(legacy);
  expect(parseResolvedRunProfileSnapshot(withKernel)).toEqual(withKernel);
  expect(withKernel.hash).not.toBe(legacy.hash);
  expect(() => parseResolvedRunProfileSnapshot({
    ...withKernel,
    kernel: { ...descriptor, protocolVersion: "anna-loop-kernel/2" },
  })).toThrow();
});

test("round-trips a literal pre-S0 legacy snapshot without injecting a kernel", () => {
  const legacySnapshot = {
    id: "release-review-run",
    version: "7",
    hash: "sha256:d1a1e88b117d1569661ea7dc68e00a017a1c8bce54645b879e5da846eed85020",
    workerProfileId: "release-manager",
    workerProfile: {
      id: "release-manager",
      version: "1.0.0",
      instructions: "Review release evidence and provide a validated release artifact.",
    },
    model: { provider: "openai", name: "gpt-5.6-terra", reasoning: "high" },
    skills: [{
      id: "release-review",
      name: "Release review",
      version: "1.2.0",
      hash: "sha256:5c5e7f4a",
      provenance: { source: "workspace", uri: "skills/release-review/SKILL.md" },
      content: "Review the approved release evidence before creating an artifact.",
      allowedTools: ["read_workspace", "write_workspace"],
      forbiddenTools: ["shell"],
    }],
    allowedTools: ["read_workspace"],
    budget: { turns: 4, toolCalls: 2 },
    contextTransforms: [{ kind: "compact", preserve: ["goal"] }],
    memoryPolicy: { read: "channel", write: "propose" },
    evalPolicy: { contract: "required", quality: "human_on_risk" },
    artifactContract: {
      kind: "release_review",
      requiredFor: ["completed"],
      verification: "tests",
    },
    terminalRules: {
      allowedOutcomes: ["completed", "failed"],
      stopCondition: "artifact_or_terminal",
    },
  };

  const parsed = parseResolvedRunProfileSnapshot(legacySnapshot);
  expect(parsed).toEqual(legacySnapshot);
  expect(Object.hasOwn(parsed, "kernel")).toBe(false);
});

function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortJson(value)), "utf8")
    .digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
