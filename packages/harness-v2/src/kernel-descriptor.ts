import { SchemaValidationError, expectRecord } from "./schema";

export interface PiKernelDescriptorV1 {
  readonly schemaVersion: 1;
  readonly adapterId: "pi";
  readonly protocolVersion: "anna-loop-kernel/1";
  readonly adapterSource: {
    readonly packageName: "@anna/pi-loop-kernel";
    readonly sha256: string;
  };
  readonly upstream: {
    readonly agentCore: {
      readonly version: "0.84.2";
      readonly integrity: string;
    };
    readonly ai: {
      readonly version: "0.84.2";
      readonly integrity: string;
    };
  };
}

export interface OmpKernelDescriptorV1 {
  readonly schemaVersion: 1;
  readonly adapterId: "omp";
  readonly protocolVersion: "anna-omp/1";
  readonly adapterSource: {
    readonly packageName: "@anna/omp-loop-kernel";
    readonly sha256: string;
  };
  readonly upstream: {
    readonly packageName: "@oh-my-pi/pi-coding-agent";
    readonly version: "18.0.11";
    readonly sourceCommit: "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2";
    readonly integrity: string;
  };
  readonly runtime: {
    readonly platform: "darwin";
    readonly arch: "arm64";
    readonly bunVersion: "1.3.14";
    readonly bunSha256: string;
    readonly nativeSha256: string;
    readonly dependencyLockSha256: string;
    readonly runtimeManifestSha256: string;
  };
}

export type KernelDescriptorV1 = PiKernelDescriptorV1 | OmpKernelDescriptorV1;

function exactRecord(
  input: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  const value = expectRecord(input, name);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new SchemaValidationError(`${name}.${key} is not allowed`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new SchemaValidationError(`${name}.${key} is required`);
    }
  }
  return value;
}

function literal<Value>(value: unknown, expected: Value, name: string): Value {
  if (value !== expected) {
    throw new SchemaValidationError(`${name} is not allowed`);
  }
  return expected;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SchemaValidationError(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function sha512Integrity(value: unknown, name: string): string {
  if (
    typeof value !== "string"
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)
  ) {
    throw new SchemaValidationError(`${name} must be a SHA-512 SRI value`);
  }
  return value;
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<Value>;
}

export function parsePiKernelDescriptor(input: unknown): PiKernelDescriptorV1 {
  const value = exactRecord(input, "PiKernelDescriptorV1", [
    "schemaVersion",
    "adapterId",
    "protocolVersion",
    "adapterSource",
    "upstream",
  ]);
  const adapterSource = exactRecord(value.adapterSource, "PiKernelDescriptorV1.adapterSource", [
    "packageName",
    "sha256",
  ]);
  const upstream = exactRecord(value.upstream, "PiKernelDescriptorV1.upstream", [
    "agentCore",
    "ai",
  ]);
  const agentCore = exactRecord(
    upstream.agentCore,
    "PiKernelDescriptorV1.upstream.agentCore",
    ["version", "integrity"],
  );
  const ai = exactRecord(
    upstream.ai,
    "PiKernelDescriptorV1.upstream.ai",
    ["version", "integrity"],
  );

  return deepFreeze({
    schemaVersion: literal(value.schemaVersion, 1, "PiKernelDescriptorV1.schemaVersion"),
    adapterId: literal(value.adapterId, "pi", "PiKernelDescriptorV1.adapterId"),
    protocolVersion: literal(
      value.protocolVersion,
      "anna-loop-kernel/1",
      "PiKernelDescriptorV1.protocolVersion",
    ),
    adapterSource: {
      packageName: literal(
        adapterSource.packageName,
        "@anna/pi-loop-kernel",
        "PiKernelDescriptorV1.adapterSource.packageName",
      ),
      sha256: sha256(adapterSource.sha256, "PiKernelDescriptorV1.adapterSource.sha256"),
    },
    upstream: {
      agentCore: {
        version: literal(
          agentCore.version,
          "0.84.2",
          "PiKernelDescriptorV1.upstream.agentCore.version",
        ),
        integrity: sha512Integrity(
          agentCore.integrity,
          "PiKernelDescriptorV1.upstream.agentCore.integrity",
        ),
      },
      ai: {
        version: literal(
          ai.version,
          "0.84.2",
          "PiKernelDescriptorV1.upstream.ai.version",
        ),
        integrity: sha512Integrity(
          ai.integrity,
          "PiKernelDescriptorV1.upstream.ai.integrity",
        ),
      },
    },
  }) as PiKernelDescriptorV1;
}

export function parseOmpKernelDescriptor(input: unknown): OmpKernelDescriptorV1 {
  const value = exactRecord(input, "OmpKernelDescriptorV1", [
    "schemaVersion",
    "adapterId",
    "protocolVersion",
    "adapterSource",
    "upstream",
    "runtime",
  ]);
  const adapterSource = exactRecord(value.adapterSource, "OmpKernelDescriptorV1.adapterSource", ["packageName", "sha256"]);
  const upstream = exactRecord(value.upstream, "OmpKernelDescriptorV1.upstream", ["packageName", "version", "sourceCommit", "integrity"]);
  const runtime = exactRecord(value.runtime, "OmpKernelDescriptorV1.runtime", [
    "platform",
    "arch",
    "bunVersion",
    "bunSha256",
    "nativeSha256",
    "dependencyLockSha256",
    "runtimeManifestSha256",
  ]);
  return deepFreeze({
    schemaVersion: literal(value.schemaVersion, 1, "OmpKernelDescriptorV1.schemaVersion"),
    adapterId: literal(value.adapterId, "omp", "OmpKernelDescriptorV1.adapterId"),
    protocolVersion: literal(value.protocolVersion, "anna-omp/1", "OmpKernelDescriptorV1.protocolVersion"),
    adapterSource: {
      packageName: literal(adapterSource.packageName, "@anna/omp-loop-kernel", "OmpKernelDescriptorV1.adapterSource.packageName"),
      sha256: sha256(adapterSource.sha256, "OmpKernelDescriptorV1.adapterSource.sha256"),
    },
    upstream: {
      packageName: literal(upstream.packageName, "@oh-my-pi/pi-coding-agent", "OmpKernelDescriptorV1.upstream.packageName"),
      version: literal(upstream.version, "18.0.11", "OmpKernelDescriptorV1.upstream.version"),
      sourceCommit: literal(upstream.sourceCommit, "b8ce33a58911c26bed1d84f0db9a5e2e727c49a2", "OmpKernelDescriptorV1.upstream.sourceCommit"),
      integrity: sha512Integrity(upstream.integrity, "OmpKernelDescriptorV1.upstream.integrity"),
    },
    runtime: {
      platform: literal(runtime.platform, "darwin", "OmpKernelDescriptorV1.runtime.platform"),
      arch: literal(runtime.arch, "arm64", "OmpKernelDescriptorV1.runtime.arch"),
      bunVersion: literal(runtime.bunVersion, "1.3.14", "OmpKernelDescriptorV1.runtime.bunVersion"),
      bunSha256: sha256(runtime.bunSha256, "OmpKernelDescriptorV1.runtime.bunSha256"),
      nativeSha256: sha256(runtime.nativeSha256, "OmpKernelDescriptorV1.runtime.nativeSha256"),
      dependencyLockSha256: sha256(runtime.dependencyLockSha256, "OmpKernelDescriptorV1.runtime.dependencyLockSha256"),
      runtimeManifestSha256: sha256(runtime.runtimeManifestSha256, "OmpKernelDescriptorV1.runtime.runtimeManifestSha256"),
    },
  }) as OmpKernelDescriptorV1;
}

export function parseKernelDescriptor(input: unknown): KernelDescriptorV1 {
  const value = expectRecord(input, "KernelDescriptorV1");
  return value.adapterId === "omp" ? parseOmpKernelDescriptor(value) : parsePiKernelDescriptor(value);
}
