# HF-02 S1 Runtime Materialization Checkpoint

Date: 2026-08-30
Contract: [frozen S1](../plans/2026-08-30-harness-first/HF-02-S1-managed-worker.md),
commit `d36087d`. Status: S1 locally accepted after frozen dual review and
integrated verification; publication pending. Earlier sections are chronological
evidence, not results for the current source snapshot.

The independent runtime manifest/lock pins OMP and its darwin-arm64 native
package to `18.0.11`. Preparation completed successfully and materialized the
runtime under ignored `build/omp-runtime/darwin-arm64/`. Root independently
recomputed all 20,823 manifest entries: zero byte-length or SHA-256 mismatches.

- Manifest SHA-256: `5516d2ae05c71e24952eededc96e5f4d35b98a5f7c80cf0a804ac9944bc9cce8`.
- Bun executable SHA-256: `e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233`.
- Root application lockfile was not changed by the isolated installation.

## Execution Deviation

Luna reported successful native/SDK construction and disposal with Bun 1.3.14,
OMP 18.0.11, 100 native exports, zero reported model/fetch calls, no active tools
and no session file. This command used verified Bun directly with `env -i` and
temporary HOME/XDG/TMP paths; it did **not** use `sandbox-exec`. No credentials
were supplied. This departed from the instruction to establish the OS policy
before SDK execution and cannot establish network or filesystem containment.
The counters are constructor instrumentation, not proof of zero external I/O.
Retain this deviation; do not relabel the run as a sandbox canary.

Root observed no remaining preparation, npm-ci or canary process at this
checkpoint. No S1 implementation commit or push was made.

## Restricted Launcher Follow-up

The subsequent launcher invokes the fixed `sandbox-exec` executable with
three private pipes, protected read roots, network/process restrictions and
an independent `0700` attempt directory. Root ran actual Bun tests proving:
protected workspace reads and symlink escapes denied; runtime writes denied;
attempt writes allowed; shell and same-Bun subprocess creation denied; zero
connections observed by an external Host listener, with one connection from
the unrestricted non-SDK control. An active-close test also confirms child
close precedes attempt cleanup and preserves the parent sentinel.

Root independently ran the patched actual OMP SDK/native constructor through
this launcher: success, zero reported model/fetch calls, no active tools or
session file, and disposal/exit. This later evidence does not erase the earlier
bare-Bun deviation. It proves the declared limited macOS boundary, not all IPC,
other operating systems or a completed worker model/tool loop.

Current focused results: OMP package 2 files / 5 tests passed; package typecheck
passed; preparation CLI boundary tests 3/3 passed. The preparation tests first
reproduced invalid-lock and existing-output admission failures, then verified
pre-install rejection, existing-runtime preservation and lock-drift rejection.
Sol closed both preparation P2 code defects. Canary no longer recursively
deletes the caller-specified directory; launcher owns attempt cleanup. Sol also
closed launcher entry-root expansion and exit-versus-close code defects.
Final frozen-source review and full integration gates remain outstanding.

## Actual Worker Follow-up

The new Bun worker and Node client now execute the actual OMP custom API over
private JSONL pipes through the restricted launcher. Root's service integration
test uses a real SQLite Store, admitted profile and Production ToolGateway:
two deterministic Host model responses surround one real `read_only` call.
The second request contains the actual file content; the tool stream contains
`tool.requested`, `tool.policy.decided` and `tool.result`. This is actual SDK and
Gateway execution with deterministic provider transport, not live-provider or
full production-composition evidence.

Strict input matching exposed the SDK's automatic first-user date/cwd reminder.
The worker now removes the exact attempt/date-bound reminder representation;
the original goal and subsequent Host model/tool history are checked before
dispatch. Earlier import/signature and history-mismatch failures were retained
while bringing the tracer to green. A missing-worker-file failure was setup
failure, not a behavioral RED. Its exact temporary directory was cleaned.

Current focused evidence: OMP package 3 files / 9 tests passed, package
typecheck passed, actual Gateway integration 1/1 passed. Manifest verification
has a real 20,823-file positive case and digest/path/extra-file/link/missing-file
negatives. Production must still provide a trusted expected manifest digest;
reading it from the untrusted manifest is not a trust anchor.

These results do not sign off all protocol failure paths. Remaining work
includes mandatory production manifest/profile binding, complete Host loader
and Eval integration, authoritative usage/budget handling, protocol failure and
abort settlement, direct SDK worker typechecking, and frozen-source dual review.
The Node client waits for its Host handling chain before returning after stop;
a dependency ignoring cancellation can still delay settlement and must be
handled explicitly by the production lifecycle owner. No S1 implementation
commit or push has been made.

## Production Composition Checkpoint

The current WIP production composition now selects the actual OMP LoopKernel
from an explicit server-side configuration and verifies the configured runtime
manifest before admission. Root's `omp-production-composition.test.ts` uses the
actual runtime, SQLite, Host Memory repository/loader and Production Gateway.
An Owner-accepted Memory appears in the actual model prompt, while hit/ready
receipts omit its body. Two deterministic model calls surround one actual file
read; `run.eval.contract` precedes the single success terminal and Run sequence
numbers remain contiguous. This focused test passed after a real final-only
model-response handling failure was corrected in the worker.

Host model transport has single-request/no-retry and reported-usage tests.
Production controls now use the active Run's actual kernel owner, not the
current configuration selector. Pre-aborted startup performs zero preparation
or event writes. OMP/service typechecks and the relocated pre-abort plus model
transport tests passed (3 tests). Existing selector/resume tests passed (13),
and the source-less Pi sidecar build/startup test still passed.

This checkpoint is not accepted S1. In particular, the configured descriptor's
source, dependency-lock and other identity fields are not yet all compared to
the actual adapter/runtime, despite manifest verification. Sol's identity P2
remains open. Budget/cancellation changes require broader negative coverage;
the complete protocol, worker typecheck, packaging and frozen dual-axis gates
remain open. No implementation commit or push was made at this checkpoint.

## Identity and Budget Follow-up

Verification date: 2026-08-31, Asia/Shanghai. Development identity now measures
eight adapter/worker inputs and the dedicated dependency lock; packaged Host
uses a build-embedded snapshot with source-drift rejection before output.
Admission compares configured source/lock identities and fixed upstream
SRI/Bun/native hashes, then verifies manifest membership and actual runtime
worker/protocol/lock bytes. Five valid-shaped wrong-identity cases reject before
claim. The updated production Memory/Gateway/Eval positive case and source-less
sidecar build/startup both passed. Sol closed the identity P2 in narrow review.

Known provider usage is now persisted before enforcing an exceeded cap.
Missing required usage produces an explicit failed outcome rather than timeout.
Root independently reran five actual-SDK kernel budget tests: startup exhaustion,
preparation cancellation, turn limit, missing usage and retained over-cap usage.
These use RecordingSink and are not SQLite crash/negative-matrix evidence.
Sol closed the usage P2. Setup/import failures and an insufficient test timeout
were corrected before the five behavioral tests passed.

Host client sends an abort frame and allows a two-second cooperative grace
before escalating process termination. A real Bun protocol probe confirms
receipt and cooperative exit; it does not replace an actual OMP SDK abort gate.
Latest OMP package tests: four files, ten passed. OMP and service typechecks
passed. No full S1 frozen-source acceptance, implementation commit or push yet.

## Input ACK and Lifecycle Follow-up

Verification date: 2026-08-31. A stricter actual-SDK/SQLite negative reproduced
one model dispatch after the initial user message persistence failed. This was
a real execution defect, not a setup failure. Worker now explicitly emits the
initial user observation and awaits its receipt before prompt execution,
filters the SDK's single duplicate initial user event, and waits for the
observation queue to stop changing before model/tool/terminal dispatch. Host
also requires all expected message observations before model dispatch.

Root independently verified three actual-SDK/SQLite lifecycle cases: cancellation
during Host model wait; initial-user persistence failure with zero model/tool
calls; and cancellation during paused initial-user ACK with zero model/tool
calls. Each checks attempt cleanup and SQLite usability after settlement.
These tests do not prove that SIGTERM escalation was never needed.

Seven adversarial pipe-peer cases reject wrong scope, old attempt, sequence
gaps, undeclared tools, early completion, oversized frames and malformed JSON
before model/tool dispatch. These are protocol-client tests, not SDK execution.
After the final observation-tail fix, production composition plus lifecycle
passed four tests; OMP/service typechecks passed. The earlier package run passed
17 tests, and budget/pre-abort/model-transport checks passed eight tests.
Final whole-workspace, worker typechecking, clean-runtime packaging and fixed
source dual review remain outstanding. No implementation commit or push yet.

## Workspace and Typecheck Follow-up

Verification date: 2026-08-31. Root scripts now include OMP in workspace test
and typecheck commands, with an explicit runtime preparation command. Root
lock changes only add the local workspace relationship. Integrated JavaScript
verification passed 1,062 tests with seven gated skips. Python initially failed
the zero-egress gate because preparation embedded a download destination;
preparation now requires an explicit HTTPS `ANNA_OMP_BUN_ARCHIVE_URL`, retaining
the fixed archive/binary digests. The unchanged egress gate passed, then all
1,048 Python tests passed with 53 existing warnings.

An independent empty preparation directory produced 21,465 runtime files;
root recomputed every length/hash with zero mismatches. Its manifest digest is
`b71ff31ad031e418880a1526b1721aca319d641fc97d32fe990851119a7efc46`.
This captured an intermediate source snapshot and does not replace final
packaging after the later worker corrections.

An initially reported worker typecheck pass was not reproducible: an explicit
runtime working-directory/config invocation exposed upstream source resolution
and nine owned worker errors. That earlier pass is withdrawn. Imports now use
the package's typed exports, and owned type errors were corrected without
excluding the worker or introducing permissive declaration shims. Root ran
`node node_modules/typescript/bin/tsc --noEmit -p packages/omp-loop-kernel/runtime/tsconfig.json`
successfully, then reran actual SDK lifecycle plus production composition:
four tests passed. Runtime dev dependencies pin Bun types and TypeScript
separately. Final CI preparation wiring, clean final artifacts and full frozen
dual review still remain; no S1 acceptance or implementation push yet.

## Final Runtime and Review Corrections

Verification date: 2026-08-31. The current 47 non-document source, test and
configuration inputs, relative to `d36087d` including untracked files, hash to
`0a1d9b9b38b49d8ca5138a2421bd5f263cc460c3f7c946dd38377e0b60f50927`.
Compute this from path-sorted `{path,sha256}` records over raw file bytes,
using compact JSON. Do not reuse earlier review fingerprints.

Independent empty-directory preparation now produces 21,465 files and digest
`266e397bbcba257b296efa15552b6336076c7de52b4c04e718b9ba1e3dcc151a`.
The lock digest is
`f5a96c28a0187d549959fbe33c78596198491df29be9ea18424bf814fea88ceb`.
Worker, protocol and lock bytes were compared with the current repository
before this artifact became the local test runtime. Preparation publishes one
staging directory by rename. The former separate persistent receipt was
removed because its later write could leave a partly published result.
Stdout remains diagnostic; production admission still requires its trusted
descriptor and complete manifest verification. Tests independently measure
the artifact or use its manifest as lifecycle-fixture input; none requires
the former external receipt. Runtime dev dependencies include pinned worker
types and TypeScript; this is not a minimal distribution claim.

Review corrections cover concurrent close completion, unsupported-platform
rejection before claim, cancellation after durable context readiness, exact
receipt correlation/duplicate handling/deadline, and durable assistant
observations before tool execution or completion. Six actual SDK receipt
tests passed, including a successful duplicate-ACK Run with natural exit 0
and empty stderr. Lifecycle evidence includes an actual late model yield
after abort and two simultaneous Runs sharing runId across distinct Channels.

Current completed gates: root and worker typechecks; Python 1,048 passed with
53 warnings; five frontend smoke tests; web and service builds; Python audit
with no known vulnerabilities; public-preview boundary and diff checks.
The first whole-workspace run on this artifact failed three integration tests
at their default five-second test timeout during concurrent full-manifest
verification. Only their test watchdogs changed to 30 seconds; product budgets
were preserved. The final `npm test` rerun exited zero: 1,085 passed and seven
skipped (651 Desktop, 117 core, 103 EventStore, 20 scheduler, 37 Pi, 25 OMP,
99 service, 13 trace and 10 Eval). No external receipt was present during this
rerun. Both Sol Ultra Standards and Spec reviews accepted the exact 47-file
fingerprint above with no outstanding P0/P1/P2 finding. Reviews were read-only;
Root ran the integration gates. No S1 implementation push has occurred yet.

## Outstanding Global Work

S1 has passed local fixed-source review and integrated verification.
Actual model/Gateway/model execution and focused failure cases have evidence;
this does not complete the parent controls, canonical OMP restore, packaged
Desktop delivery or complete platform isolation. HF-03 through HF-10 and live
provider/Hiker, platform and official SWE-bench gates remain open. S1 alone
does not close HF-02 or the active Harness-first Goal.
