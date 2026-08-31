import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const OMP_IMPLEMENTATION_INPUTS = [
  "src/index.ts", "src/omp-loop-kernel.ts", "src/worker-client.ts",
  "src/managed-launcher.ts", "src/runtime-manifest.ts", "src/protocol.ts",
  "runtime/worker.ts", "runtime/protocol.ts",
] as const;

export function measureOmpImplementation(packageRoot = resolve(import.meta.dirname, "..")) {
  const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  const entries = OMP_IMPLEMENTATION_INPUTS.map(path => ({ path, sha256: sha256(readFileSync(resolve(packageRoot, path))) }));
  return {
    sourceSha256: sha256(JSON.stringify(entries)),
    dependencyLockSha256: sha256(readFileSync(resolve(packageRoot, "runtime/package-lock.json"))),
    workerSha256: entries.find(entry => entry.path === "runtime/worker.ts")!.sha256,
    protocolSha256: entries.find(entry => entry.path === "runtime/protocol.ts")!.sha256,
  };
}
