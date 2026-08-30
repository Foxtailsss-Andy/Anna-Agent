import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { resolve } from "node:path";

export const PI_KERNEL_IMPLEMENTATION_INPUTS = [
  "packages/pi-loop-kernel/src/index.ts",
  "packages/pi-loop-kernel/src/pi-loop-kernel.ts",
] as const;

export const PI_KERNEL_UPSTREAM = {
  agentCore: {
    version: "0.84.2",
    integrity: "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
  },
  ai: {
    version: "0.84.2",
    integrity: "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
  },
} as const;

export interface PiKernelSourceIdentity {
  readonly entries: readonly { readonly path: string; readonly sha256: string }[];
  readonly sha256: string;
}

export async function createPiKernelSourceIdentity(
  sourceRoot: string = import.meta.dirname,
): Promise<PiKernelSourceIdentity> {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const path of PI_KERNEL_IMPLEMENTATION_INPUTS) {
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const bytes = await readFileAsync(resolve(sourceRoot, fileName));
    entries.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return sourceIdentity(entries);
}

export function createPiKernelSourceIdentitySync(
  sourceRoot: string = import.meta.dirname,
): PiKernelSourceIdentity {
  const entries = PI_KERNEL_IMPLEMENTATION_INPUTS.map((path) => {
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    return {
      path,
      sha256: createHash("sha256")
        .update(readFileSync(resolve(sourceRoot, fileName)))
        .digest("hex"),
    };
  });
  return sourceIdentity(entries);
}

export function assertPiKernelSourceIdentity(
  captured: PiKernelSourceIdentity,
  current: PiKernelSourceIdentity,
): void {
  if (
    captured.sha256 !== current.sha256
    || JSON.stringify(captured.entries) !== JSON.stringify(current.entries)
  ) {
    throw new Error("Pi kernel source identity changed before build output");
  }
}

function sourceIdentity(
  entries: Array<{ path: string; sha256: string }>,
): PiKernelSourceIdentity {
  return {
    entries,
    sha256: createHash("sha256")
      .update(JSON.stringify(entries), "utf8")
      .digest("hex"),
  };
}
