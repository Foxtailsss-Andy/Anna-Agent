import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  parsePiKernelDescriptor,
  type PiKernelDescriptorV1,
} from "@anna/harness-v2";
import {
  createPiKernelSourceIdentity,
  PI_KERNEL_UPSTREAM,
} from "./kernel-source";

export type { PiKernelDescriptorV1 } from "@anna/harness-v2";

export { PI_KERNEL_IMPLEMENTATION_INPUTS, PI_KERNEL_UPSTREAM } from "./kernel-source";

export interface CreatePiKernelDescriptorOptions {
  readonly sourceRoot?: string;
}

export interface LoadPiKernelDescriptorOptions {
  readonly mode?: "development" | "packaged";
  readonly metadataPath?: string;
  readonly sourceRoot?: string;
  readonly expectedSourceSha256?: string;
}

export async function createPiKernelDescriptor(
  options: CreatePiKernelDescriptorOptions = {},
): Promise<PiKernelDescriptorV1> {
  await verifyInstalledUpstream();
  const sourceIdentity = await createPiKernelSourceIdentity(
    options.sourceRoot ?? import.meta.dirname,
  );
  return parsePiKernelDescriptor({
    schemaVersion: 1,
    adapterId: "pi",
    protocolVersion: "anna-loop-kernel/1",
    adapterSource: {
      packageName: "@anna/pi-loop-kernel",
      sha256: sourceIdentity.sha256,
    },
    upstream: PI_KERNEL_UPSTREAM,
  });
}

export async function loadPiKernelDescriptor(
  options: LoadPiKernelDescriptorOptions = {},
): Promise<PiKernelDescriptorV1> {
  if (options.mode === "packaged") {
    if (options.metadataPath === undefined) {
      throw new Error("packaged Pi kernel metadata path is required");
    }
    const descriptor = parsePiKernelDescriptor(
      JSON.parse(await readFile(options.metadataPath, "utf8")),
    );
    if (
      descriptor.upstream.agentCore.version !== PI_KERNEL_UPSTREAM.agentCore.version
      || descriptor.upstream.agentCore.integrity !== PI_KERNEL_UPSTREAM.agentCore.integrity
      || descriptor.upstream.ai.version !== PI_KERNEL_UPSTREAM.ai.version
      || descriptor.upstream.ai.integrity !== PI_KERNEL_UPSTREAM.ai.integrity
      || (
        options.expectedSourceSha256 !== undefined
        && descriptor.adapterSource.sha256 !== options.expectedSourceSha256
      )
    ) {
      throw new Error("packaged Pi kernel metadata does not match this implementation");
    }
    return descriptor;
  }
  return createPiKernelDescriptor({ sourceRoot: options.sourceRoot });
}

async function verifyInstalledUpstream(): Promise<void> {
  const expected = [
    ["@earendil-works/pi-agent-core", PI_KERNEL_UPSTREAM.agentCore],
    ["@earendil-works/pi-ai", PI_KERNEL_UPSTREAM.ai],
  ] as const;
  for (const [packageName, identity] of expected) {
    const packageJson = await readInstalledPackageJson(packageName);
    if (packageJson.version !== identity.version) {
      throw new Error(`${packageName} installed version does not match Pi descriptor`);
    }
  }
  const lockPath = resolve(import.meta.dirname, "../../../package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    packages?: Record<string, { version?: unknown; integrity?: unknown }>;
  };
  for (const [packageName, identity] of expected) {
    const entry = lock.packages?.[`node_modules/${packageName}`];
    if (entry?.version !== identity.version || entry.integrity !== identity.integrity) {
      throw new Error(`${packageName} lock identity does not match Pi descriptor`);
    }
  }
}

async function readInstalledPackageJson(
  packageName: string,
): Promise<{ version?: unknown }> {
  let entryPath: string;
  try {
    entryPath = fileURLToPath(await import.meta.resolve(packageName));
  } catch {
    throw new Error(`${packageName} is not installed`);
  }
  let directory = dirname(entryPath);
  while (true) {
    try {
      const packageJson = JSON.parse(
        await readFile(resolve(directory, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (packageJson.name === packageName) return packageJson;
    } catch {
      // Continue to the package root without exposing filesystem details.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`${packageName} package metadata is unavailable`);
}
