import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import {
  createPiKernelDescriptor,
  createPiKernelSourceIdentitySync,
  assertPiKernelSourceIdentity,
  loadPiKernelDescriptor,
  type PiKernelDescriptorV1,
} from "../src";

const sourceRoot = resolve(import.meta.dirname, "../src");

test("creates the Pi descriptor from the ordered implementation sources", async () => {
  const descriptor = await createPiKernelDescriptor();
  const entries = await Promise.all([
    ["packages/pi-loop-kernel/src/index.ts", "index.ts"],
    ["packages/pi-loop-kernel/src/pi-loop-kernel.ts", "pi-loop-kernel.ts"],
  ].map(async ([path, file]) => ({
    path,
    sha256: createHash("sha256")
      .update(await readFile(join(sourceRoot, file)))
      .digest("hex"),
  })));
  const expectedSourceHash = createHash("sha256")
    .update(JSON.stringify(entries), "utf8")
    .digest("hex");

  expect(descriptor.adapterSource.sha256).toBe(expectedSourceHash);
  expect(descriptor.adapterSource.packageName).toBe("@anna/pi-loop-kernel");
  expect(descriptor.upstream).toEqual({
    agentCore: {
      version: "0.84.2",
      integrity: "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
    },
    ai: {
      version: "0.84.2",
      integrity: "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
    },
  });
});

test("a source mutation changes the descriptor identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-pi-descriptor-"));
  try {
    await copyFile(join(sourceRoot, "index.ts"), join(directory, "index.ts"));
    await copyFile(join(sourceRoot, "pi-loop-kernel.ts"), join(directory, "pi-loop-kernel.ts"));
    const original = await createPiKernelDescriptor({ sourceRoot: directory });
    await writeFile(join(directory, "index.ts"), "\n// source identity probe\n", { flag: "a" });
    const mutated = await createPiKernelDescriptor({ sourceRoot: directory });

    expect(mutated.adapterSource.sha256).not.toBe(original.adapterSource.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the frozen path order and raw bytes for source identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-pi-descriptor-bytes-"));
  try {
    await writeFile(join(directory, "index.ts"), "alpha", "utf8");
    await writeFile(join(directory, "pi-loop-kernel.ts"), "beta", "utf8");
    const descriptor = await createPiKernelDescriptor({ sourceRoot: directory });

    expect(descriptor.adapterSource.sha256).toBe(
      "aafa2cf5938dc439001aabc8b9cf3ad61e8f9582b1d0c14769aa0e906c34a8cd",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a source identity that changes before build output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-pi-descriptor-toctou-"));
  try {
    await writeFile(join(directory, "index.ts"), "alpha", "utf8");
    await writeFile(join(directory, "pi-loop-kernel.ts"), "beta", "utf8");
    const captured = createPiKernelSourceIdentitySync(directory);
    await writeFile(join(directory, "pi-loop-kernel.ts"), "gamma", "utf8");
    const output = createPiKernelSourceIdentitySync(directory);

    expect(() => assertPiKernelSourceIdentity(captured, output))
      .toThrow("Pi kernel source identity changed before build output");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged loading validates a sidecar without consulting source files", async () => {
  const descriptor = await createPiKernelDescriptor();
  const directory = await mkdtemp(join(tmpdir(), "anna-pi-sidecar-"));
  try {
    const sidecarPath = join(directory, "pi-kernel-descriptor.json");
    await writeFile(sidecarPath, JSON.stringify(descriptor), "utf8");
    await expect(loadPiKernelDescriptor({
      mode: "packaged",
      metadataPath: sidecarPath,
    })).resolves.toEqual(descriptor);
    await writeFile(sidecarPath, JSON.stringify({ ...descriptor, adapterId: "omp" }), "utf8");
    await expect(loadPiKernelDescriptor({
      mode: "packaged",
      metadataPath: sidecarPath,
    })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("descriptor loader keeps the immutable public shape", async () => {
  const descriptor: PiKernelDescriptorV1 = await loadPiKernelDescriptor({ mode: "development" });
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(Object.isFrozen(descriptor.adapterSource)).toBe(true);
});
