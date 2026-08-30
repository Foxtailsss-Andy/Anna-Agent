# HF-02 S0: Kernel Identity and Admission

Date: 2026-08-30
Base: `b724c7d85fbea29c631321e0ba868f8761b22fe9`.
Status: accepted by Sol Ultra for Luna Max RED/GREEN implementation.
Parent: [HF-02](HF-02-governed-omp-kernel.md).
Requirements: HF-020/021 identity and compatibility subset; HF-022 source pin subset.
Coder: GPT-5.6-Luna Max. Independent reviewers: GPT-5.6-Sol Ultra.

## Scope and Full-Goal Boundary

New production Runs persist the identity of the actual reference Pi adapter.
An explicit unavailable OMP choice cannot execute through Pi. Original Runs
resume from their stored identity even after the new-admission selector changes.
This is the first vertical slice of HF-02, not an OMP integration substitute.
The parent ticket still requires actual upstream worker execution, all five
controls, governed tools, isolation, native artifacts and lifecycle conformance.

## Exact Snapshot Shape

Add optional `kernel` to `RunProfile` and `ResolvedRunProfile`. In S0 its only
resolved variant is the following closed record. Future OMP support must add a
reviewed variant; an unavailable selection does not mint an OMP snapshot.

```ts
type PiKernelDescriptorV1 = {
  schemaVersion: 1;
  adapterId: "pi";
  protocolVersion: "anna-loop-kernel/1";
  adapterSource: {
    packageName: "@anna/pi-loop-kernel";
    sha256: string;
  };
  upstream: {
    agentCore: { version: "0.84.2"; integrity: string };
    ai: { version: "0.84.2"; integrity: string };
  };
};
```

Reject unknown/missing fields, null, malformed lowercase 64-hex source digests,
unsupported literals and malformed SHA-512 SRI values. Deep-freeze the parsed
descriptor. Its fields participate in the existing recursively key-sorted
UTF-8 SHA-256 profile hash; array order is preserved.

Only absence of `kernel` uses the legacy parser/hash path. Never insert a
default descriptor when reading or serializing an old snapshot. A frozen
pre-S0 snapshot with a literal known hash must round-trip unchanged.
Production general/Create admission always supplies the real descriptor;
generic fixture construction may retain the existing legacy shape.

## Real Source Identity

The adapter owns descriptor creation, without Host imports of upstream packages.
Freeze the ordered implementation-input list as:

```text
packages/pi-loop-kernel/src/index.ts
packages/pi-loop-kernel/src/pi-loop-kernel.ts
```

For each file, compute lowercase SHA-256 over raw bytes. Hash the UTF-8 compact
`JSON.stringify([{path,sha256}, ...])` array in the listed order for
`adapterSource.sha256`. Pin the two upstream SRI values from the matching
root lockfile entries and verify their installed package versions. Do not use
`HEAD`, `0.0.0`, synthetic digests or empty strings as implementation identity.

Development/test loading computes from actual source files. The service build
generates a descriptor sidecar from the same inputs and ships it beside the
bundle; packaged loading reads that sidecar and never searches the user's cwd
for a source checkout or lockfile. The generated descriptor and metadata-loader
module are not inputs to their own digest. If additional adapter execution
modules are introduced, extend the frozen list and its verification tests.

Development versus packaged mode is determined by the module/build entry,
not by whether metadata happens to exist. Package absence/corruption tests must
also run with a valid source checkout as cwd, and still fail closed. Installed
version checks run during development/generation; the source-less bundle does
not require external installed package manifests.

Missing/invalid identity fails closed. Verify source mutations change the
descriptor and packaged source-less startup consumes the generated sidecar.
This source manifest plus npm identity does not attest the entire bundle,
Node binary or future Bun/native runtime. Those artifact checks remain open.

## Selection and Error Contract

Read `harness_v2_kernel` from trusted server configuration, not request bodies.
It selects only new production admission; it is not a mutable Run field.

| Configuration | New admission |
| --- | --- |
| absent or `"pi"` | Resolve the same actual Pi descriptor and admit normally |
| `"omp"` | Reject with `kernel_unavailable`, reason `managed_runtime_unavailable` |
| null, empty string, any other value/type | Reject with `kernel_selection_invalid` |

The Host may construct successfully for historical reads/resume. Before
`DurableRunRuntime.start` or `claimStart`, reject an unavailable/invalid new
selection. Observable rejection means zero Run command/event creation and zero
Pi start/model/tool dispatch; constructing an idle reference adapter is not
execution. Do not write a failed Run as a substitute for refusing admission.

Use a typed error at this boundary. Start/resume HTTP handlers map only that
error to 503 with these exact public payloads:

```json
{"code":"kernel_unavailable","requested_adapter":"omp","reason":"managed_runtime_unavailable"}
{"code":"kernel_selection_invalid"}
{"code":"kernel_unavailable","requested_adapter":"pi","reason":"kernel_identity_mismatch"}
```

Do not echo invalid raw configuration, paths, credentials or arbitrary exception
messages. Preserve existing JSON-body, scope/surface and generic-error handling.

Resume first loads and validates the scoped stored command and its surface.
An absent legacy descriptor retains Pi; a current Pi descriptor must exactly
match the available implementation. Mismatch rejects before execution or new
events. The current selector is never consulted to replace the stored kernel.
Retain HF-01B original input, fingerprint, budgets and terminal guards.

## Owned Files

- Core `run-profile.ts`, a focused descriptor schema module if needed, exports
  and profile parser/hash tests. No upstream imports in the core.
- Pi adapter metadata loader/manifest helper, exports and focused tests.
  No changes to Pi's loop/context/cancellation behavior without an observed RED.
- Service `production.ts`, `runtime.ts` admission/resume guards and `index.ts`
  start/resume typed-error mapping; a small local selection-error module.
- Service `kernel-selection.test.ts` and related runtime/HTTP tests, real SQLite.
- Service Vite build configuration and a focused manifest-generation helper;
  package smoke coverage for the source-less sidecar path.
- This ticket, parent status and an implementation handoff.

No shared EventSink, SQLite sequencing, DurableRunRuntime implementation,
Contract Eval, Legacy Python, UI, dependency upgrades or OMP process code.
Retain generic Runtime fixture compatibility without a production bypass flag;
any narrow policy injection must be mandatory in production composition.

## Vertical RED and Acceptance

1. Through production Host and HTTP, explicit OMP returns the exact 503 response
   with no claimed command, events, Pi start or external dispatch. Demonstrate
   behavioral RED before implementing the selection guard.
2. Absent/explicit Pi choices produce equal real descriptors; persisted new
   profiles consume the actual descriptor, not a caller-provided replacement.
3. Strict descriptor/schema/hash negatives and a literal legacy snapshot/hash
   fixture pass. Altering descriptor content without recomputing hash fails.
4. Real SQLite reopen plus actual Pi: selector now OMP still restores original
   legacy and descriptor-bearing Pi Runs without changing their stored hashes,
   input or budgets. A validly hashed but unavailable implementation rejects.
5. Invalid selector and typed mismatch errors use the exact HTTP contract;
   existing scope/surface/body errors are not converted to kernel errors.
6. Source mutation affects identity, source-less built-service loading works,
   and missing/corrupt packaged metadata does not silently use development data.

Use actual Store/Gateway/Runtime; deterministic provider transport is allowed.
Do not mock away admission or replay an array in place of database reopen.
Add one observable slice at a time, record real RED/GREEN commands and review
source/test fingerprints. Final gates include relevant tests/typechecks,
full regressions, built/package checks and privacy checks. S0 acceptance cannot
close HF-02 or the complete Harness-first Goal.
