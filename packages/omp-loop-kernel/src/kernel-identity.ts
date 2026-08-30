import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OmpKernelDescriptorV1 } from "@anna/harness-v2";
import { measureOmpImplementation } from "./kernel-source";
import { verifyRuntimeManifest } from "./runtime-manifest";

declare const __ANNA_OMP_IMPLEMENTATION__: ReturnType<typeof measureOmpImplementation>;

export function currentOmpImplementation() {
  if (process.env.NODE_ENV === "production") {
    if (typeof __ANNA_OMP_IMPLEMENTATION__ === "undefined") throw new Error("OMP build identity unavailable");
    return __ANNA_OMP_IMPLEMENTATION__;
  }
  return measureOmpImplementation();
}

export async function verifyOmpKernelIdentity(runtimeRoot: string, descriptor: OmpKernelDescriptorV1): Promise<void> {
  const actual = currentOmpImplementation();
  if (descriptor.adapterSource.sha256 !== actual.sourceSha256
    || descriptor.runtime.dependencyLockSha256 !== actual.dependencyLockSha256
    || descriptor.runtime.bunSha256 !== "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233"
    || descriptor.runtime.nativeSha256 !== "e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b"
    || descriptor.upstream.integrity !== "sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==") {
    throw new Error("OMP implementation identity mismatch");
  }
  await verifyRuntimeManifest(runtimeRoot, `sha256:${descriptor.runtime.runtimeManifestSha256}`);
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  for (const [file, expected] of [["worker.ts", actual.workerSha256], ["protocol.ts", actual.protocolSha256], ["package-lock.json", actual.dependencyLockSha256]]) {
    if (hash(await readFile(join(runtimeRoot, file))) !== expected) throw new Error("OMP runtime source identity mismatch");
  }
}
