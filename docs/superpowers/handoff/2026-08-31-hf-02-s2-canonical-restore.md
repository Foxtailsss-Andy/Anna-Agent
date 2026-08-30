# HF-02 S2 Canonical Restore Evidence

Date: 2026-08-31
Status: local gates and independent source review passed; exact-SHA publication is tracked in PR 1.
Contract: [frozen S2](../plans/2026-08-30-harness-first/HF-02-S2-canonical-restore.md).
Product base: `c030246d90fca322717e6d20d2af07a2ee5866bc`.
Initial S2 document commit: `cb96a8d`.

## Published Starting Point

S1 push CI `33324464372` and PR CI `33324466412` both succeeded at the exact
product base above. Those results are historical S1 evidence and cannot verify
S2. This document freezes local S2 evidence before its publication; PR 1 records
the published SHA and its own push/PR CI outcomes. No merge, release or
deployment is part of this milestone.

## Final Local Gate

Final reviewed input: 29 non-document files, aggregate
`6a43cc645d18e78399ad69f655a0b679614845cce27159a112b3656e426a27fc`.
Both Sol Ultra axes accepted this exact candidate with no outstanding S2
P0/P1/P2. Luna Max performed principal coding; Root integrated, reproduced
counterexamples, corrected owned fixtures and ran the final gates.

| Check | Result |
| --- | --- |
| Default `npm test` | 1,136 passed, 7 skipped; final service portion 144 / 1 skip in 382.40 seconds |
| Full Python | 1,048 passed, 53 existing warnings; final repeat 31.49 seconds after the reviewed test-only projection barrier |
| Configured workspace and independent Worker typechecks | Passed |
| Direct strict check of eight newly added service/in-place tests | Passed; not a whole-service-test strict-clean claim |
| Web and service builds | Passed; 523 web and 1,120 service modules; existing bundle-size warning retained |
| Frontend smoke | 5 passed |
| Application non-dev, managed-runtime non-dev/non-optional, Python audits | No known vulnerabilities reported for those selections |
| Public-preview and candidate-file scan | Zero violations; tracked and new files checked |
| Existing evidence-manifest integrity | 7 verified; not new live executions |
| Local Markdown links and diff whitespace | Passed |

Runtime manifest:
`fbabb724c6da48ea44867b6e1743d85f2753c10866ec26b2c4be1f45b716745e`,
21,465 verified files. Source and runtime identities are detailed below.
The input aggregate hashes compact JSON of path-sorted `{path, sha256}` records
for non-document paths changed from the product base, including newly added
files; each file digest hashes raw bytes.

Actual pinned SDK, scoped SQLite, Host preparation, Gateway and Contract Eval
are exercised with deterministic Host transport. Persistence-loss injection
and real SQLite close/reopen remain distinct. The process test proves local
ownership release, not complete Host-kill/supervisor recovery. The two original
worktrees retained their recorded HEADs and tracked-diff hashes; no source or
uncommitted work was imported from them.

S2 completes its text/read-only canonical-restore implementation scope.
Final publication acceptance additionally requires this source's exact-SHA CI.
The separately reviewed S3 SPEC is frozen planning, with no S3 implementation
in this update. Full isolation/distribution, Desktop cutover, live Provider/
Hiker, official SWE-bench and the complete Harness-first Goal remain open.

## Host Ownership and Shutdown

Root reproduced and corrected three public-boundary failures:

- Two production Hosts could open the same SQLite file through path aliases.
  Production ownership now uses a canonical-path, dedicated SQLite exclusive
  connection, before opening the canonical data Store. All current selectors
  obey the same guard. The guard is released without deleting its file.
- Production close settled while an actual Pi Run's real Contract Eval append
  ACK was paused. Core Runtime close now stops admission, aborts and drains
  in-flight admission plus full Run completion. Production close orders core
  Runtime, OMP, Store and ownership, with one shared completion Promise.
- A resume command lookup preceding core admission could outlive close. The
  service factory now tracks pending start/resume/read operations as well as
  core work. Sol independently reproduced the initial window, then verified
  the fix: close remains pending, the resumed command rejects as closing and
  no kernel call occurs.

The initial ownership helper was placed in the service and failed its existing
architecture test because it imported SQLite directly. It was moved to
`packages/event-store/src/host-ownership.ts` and exported from that package;
the architecture gate was not weakened.

Focused evidence at this checkpoint:

- `apps/harness-service/test/host-ownership.test.ts`: 3 passed, including the
  real Pi/SQLite/Eval ACK pause, repeated close, lock retention and failed
  initialization followed by successful retry.
- `apps/harness-service/test/host-ownership-process.test.ts`: 3 passed. Actual
  Node processes cover alias contention, normal exit, SIGKILL owner exit and
  re-acquisition without replacing the lock inode. Hard links and dangling
  file aliases are rejected.
- Service Runtime, ownership, process and architecture focused group: 4 files,
  12 passed. Core Runtime: 7 passed; EventStore package: 105 passed.
- Sol Standards accepted the narrow drain correction and module move. This is
  not a final S2 review and does not prove network-filesystem coordination.

The Eval test injects an ACK delay into a real public Store port; it is not a
Host crash test. The ownership process test proves lock release on process
death, not complete worker/effect recovery. Older S1 Hosts do not obey this
owner protocol and must stop before upgrade.

## Active Restore Work

Luna Max owns Node adapter history, delivery checkpoints, cumulative budgets
and production resume. A second Luna Max owns the optional neutral transcript
field and actual Bun/OMP message restoration. The required tracer is a
consumed tool-result checkpoint followed by actual SDK continuation after real
SQLite reopen. A completed-answer terminal repair is a separate zero-new-model
case, not a replacement for that tracer.

## First Restore Review

The first frozen restore review covered 21 non-document files, aggregate
`a80b57e33f2b9b247c29f8444ec6399ee05dd93eb469f4752cb49c245ae35a08`.
Seven focused restore cases and the wall-budget regression had passed, but
the readiness-digest tamper test was still RED. Both Sol Ultra axes rejected
S2 acceptance at this checkpoint. They found:

- Original provider/model was not compared with current production transport
  configuration on resume.
- Tool counts were restored from an event name the OMP path does not produce.
- Restored token/cost limits and required unknown usage were not checked before
  completed-tail success or further work.
- Already observed tool messages bypassed durable checkpoint verification;
  changed duplicate replies and unknown-to-succeeded conflicts were accepted.
- Model replies could appropriate an earlier transcript position for a new
  request, and orphan indexed usage could disappear from accounting.
- An authorized tool call with no dispatch yet could not resume through the
  complete Host/client path, despite SDK-level support.

Reviewers used source inspection and explicitly labelled in-memory projection
probes, not live SDK/business runs, for these findings. Coding continues with
public regressions; none is declared closed by this checkpoint document.

The worker artifact was prepared independently with the unchanged dependency
lock. Its manifest is
`fcc9e550814a297d8bb9bc6140d832bf41a330902b31a367f8ea017d8891f666`
(21,465 files). Worker/protocol bytes match current sources; the preceding
local artifact was preserved. A package-wide worker test run found a
15-second test watchdog timeout (28 passed, one failed), so final integrated
worker gates remain pending even though focused worker tests had passed.
The subsequent package run with `--maxWorkers=2` passed all 30 tests; the
package test configuration now applies that fixture-concurrency bound. This
does not change Run concurrency, worker deadlines or product budgets. The
default-command rerun also passed all 30 tests. These results belong to the
second-review checkpoint below; further worker changes require a fresh artifact
and new fixed-source gates.

## Second Restore Review

Both Sol Ultra axes independently verified 24 non-document inputs at aggregate
`1ebb9d33f9399c9282ca3eefd7aa7f20e6ce60df6fdb7b668ad413776b85346f`.
The model-configuration comparison, restored tool count, already-observed
checkpoint consistency and single pending-tool continuation findings were
closed. S2 acceptance was still rejected for five concrete defects:

- Required usage validation checked only for an object, not the budget's
  required fields. Unanswered durable model requests could also lose unknown
  token/cost usage and continue as if it were zero.
- Cancellation while waiting for a tool-dispatch fence ACK could still enter
  the actual Gateway after that ACK. The boundary needs a fresh cancellation
  and wall-budget check before dispatch.
- Multiple tool calls in one assistant message confused the authorizing
  assistant position with each later tool-result position.
- An SDK projection omitted real zero usage, while model-request and restore
  digests used different message representations, rejecting valid history.
- A valid private preparation snapshot or partial Memory/readiness history
  without consumed user input was incorrectly treated as a missing transcript.

The review evidence was source inspection and explicitly labelled in-memory
probes of the frozen functions. Each correction requires its own public
regression; these probes are not actual SDK or production recovery evidence.
The production consumed-input tracer also needs explicit single Eval/terminal,
continuous sequence and Memory/readiness deduplication assertions. Additional
negative budget, identity, receipt-race and Channel-isolation evidence remains
part of the S2 ticket.

Root gates completed at this rejected checkpoint:

- `npm test`: 1,104 passed, 7 skipped across nine workspaces. The workspace
  pass counts were 651, 117, 105, 20, 37, 30, 121, 13 and 10.
- `npm run typecheck` and the explicit worker TypeScript check: exit 0.
- `uv run pytest -q`: 1,048 passed, 53 warnings.
- Frontend smoke: 5 passed. Public-preview verification: 0 violations.

Green regression suites did not cover the five counterexamples, so they do
not override the failed review. New correction work invalidates this source
checkpoint for final acceptance. Full web/service builds, dependency checks,
fresh artifact identity and dual review remain required at the next freeze.

For clarity, the published S1 JavaScript total was 1,075 passed / 7 skipped,
not the previously mis-added 1,085. The S1 handoff, update and PR body have been
corrected without changing the original per-workspace evidence.

## Partial Multi-Tool Recovery Checkpoint

The new actual SDK/SQLite/production-HTTP tracer first reported a RED when the
first tool result was consumed but the second dispatch had not been persisted.
The other checkpoint, second delivery durable with its observation missing,
was already GREEN. Pinned SDK inspection found that its normal continuation
recognizes unpaired calls only at an assistant tail; its retry helper excludes
partially successful batches.

Root then attempted an independent RED capture. The test instead passed at
26 non-document inputs with identical before/after aggregate
`ae20971811a16b0b533b17230d79c4f47e51a86a8cbabb60f12531742d1abdc3`:

```text
npm run test --workspace=@anna/harness-service -- --run test/omp-resume-multitool.test.ts -t first-result-consumed-second-dispatch-lost --reporter=verbose
1 passed / 1 filtered skip; exit 0; 21.59 seconds
```

This is a GREEN capture, not a reproduced RED. The worker already contained a
pending-only SDK projection plus a separate full-message overlay. Inspection
found that it substituted the overlay for actual SDK context without first
validating the SDK projection. The coder acknowledged that limitation; Root
froze the candidate and requested another bounded Sol review. Positive output
and one-time Gateway counts alone do not verify the required SDK/Host context
relationship. No S2 acceptance, artifact publication or push followed.

The multitool file's reported service `tsc -p tsconfig.json` check did not cover
tests. Root's direct strict check found a cleanup typing error involving
`void | Promise<void>`; direct test-file typechecks remain part of the next gate.
Root's new identity/scope test files passed their direct strict check, but their
runtime assertions still await the final matching materialized worker.

The application and runtime dependency manifests/locks remain unchanged from
`c030246`. Root reran `npm audit --omit=dev --audit-level=high`: exit 0, zero
vulnerabilities reported for that application dependency selection. This does
not expand the previously documented optional-worker dependency audit scope.

## Final-Candidate Corrections

The next dual review froze 26 inputs at
`cd8e6eb49903a56813078f634e48258a359771460a141ce7e66f08c7f43888dc`.
Both axes verified the guarded fixed projection and removal of the blind
overlay. They still rejected acceptance for two P2 findings:

- A queued-only Run with no started event ignored its queued timestamp and
  received a fresh wall origin on reopen.
- Corrupt or checkpoint-free tool history could cross a later assistant and
  pass restoration without proof of the alleged tool result.

Luna reproduced both through public boundaries and fixed them. The queued-only
HTTP case now retains its original queued time and times out with no model or
tool call. The corrupt-history regression uses a fresh budget and valid ready
receipt: the old parser reached Gateway creation, while the corrected parser
returns `tool_checkpoint_mismatch` before Gateway, model or tool admission.
It does not rely on an already expired budget to suppress execution.

A separate model-request ACK probe confirmed that a Host clock advancing beyond
the wall cap could still enter the provider before the timer callback ran.
The adapter now explicitly rechecks wall time and cancellation after that ACK.
Its public regression retains the request but writes no response and invokes
neither provider nor tool. Closed neutral assistant parsing also occurs before
model-response checkpoint persistence.

## Actual Runtime Location

Root rebuilt the runtime independently with the unchanged preparation script,
isolated locked installation and exact archive/native checks. Its first fresh
manifest, `d5d297b3a5f30d622db59aec335b552d1f2eec929d6c74f2be558f67c74e6c6c`,
passed identity verification and the managed SDK construct/dispose canary.
However, `worker.ts` launched directly from the repository's build directory
failed before any frame with a missing `@oh-my-pi/omptype/typebox` import, even
though that package and source file were present. Earlier tests that copied
the runtime to an OS temporary directory did not cover this location.

A small managed import comparison reproduced failure for the bare package
specifier and success for the exact artifact-relative source path. Adding only
a local package or TypeScript configuration did not resolve the failure.
The fix uses verified artifact-relative pinned SDK imports at the worker entry,
matching the existing canary convention. Dependencies, APIs, settings and OS
sandbox permissions were not changed.

Root rebuilt again from the corrected source. The new runtime manifest is
`6bb68f8c067c17790a8ccf1fcad605acd0be396a59f04ed031ccccae18c8d29b`
with 21,465 files. The prior artifacts were preserved. Worker, protocol and
dependency-lock bytes were compared with the repository before installation
into the local verification build path. The actual managed worker then emitted
ready, model request and completed terminal proposal with exit 0 and no stderr.
The new `in-place-runtime.test.ts` also passed without copying the runtime out
of that directory. This proves this local layout, not packaged Desktop or
another operating system.

## Intermediate Acceptance Candidate

The source-review candidate had 27 non-document inputs at
`f1cc05e784a11e5b3c67c5d1b76266c35fefb17672c6bf742dec6918f751d688`.
Independent Sol Ultra Standards and Spec re-review both passed with no
unresolved P0/P1/P2. Each reviewer verified an unchanged before/after input
fingerprint and matching runtime source. These source reviews do not replace
Root integrated gates or exact-SHA CI; S2 is not yet accepted or published.

Root has independently verified the five HTTP model/provider/descriptor/scope/
surface rejection cases and the actual in-place, two-Channel recovery case
sharing one Run ID. Duplicate active resume reused the existing execution, and
finished resume added no events. Each Channel retained its own Memory and real
tool output, one original user input, one tool execution, continuous sequence,
and one Contract Eval immediately before one terminal.

The first scope-test fixture omitted a required query word. Root corrected only
that fixture and added a public retrieval precondition; production retrieval
behavior was unchanged. Direct strict checking also found and corrected test
cleanup union-return errors and an undeclared test counter. These were test
defects, not product fixes. The six new service/in-place test files now pass
their direct strict TypeScript check.

Application and Python dependency audits both reported no known vulnerabilities
for their stated selections. Full JavaScript/Python regressions, final builds,
publication checks and exact-SHA GitHub CI still require the final gate record.

Steer and request-correlated answer remain S3 obligations. Full isolation,
distribution, business migration, live Provider/Hiker, Desktop cutover,
Legacy removal and official SWE-bench evidence remain open in the full Goal.

The actual worker test preserves a fully paired unknown result with zero tool
replay. A production Host unknown-checkpoint negative was not executed; that
narrower worker result must not be described as live unknown-effect recovery.

## Final Review And Test Concurrency

The first default Root `npm test` at the reviewed source exited 1: 1,133 passed,
3 failed and 7 skipped. The three service failures were SDK readiness/model
startup timeouts in the consumed-resume, partial-multitool and Channel-scope
tests. All other workspaces passed. Test fixtures copy the pinned runtime with
21,465 files, making many simultaneous service workers filesystem-intensive.

A controlled rerun of the complete service suite changed only Vitest worker
count, not source, assertions, deadlines or product budgets:

```text
npm run test --workspace=@anna/harness-service -- --maxWorkers=2
31 files; 144 passed, 1 skipped; exit 0; 420.60 seconds
```

The service Vitest configuration now uses `maxWorkers: 2`, matching the existing
OMP package fixture setting. Both independent Sol axes accepted this sole
post-review configuration delta. Excluding that file still reproduces the
27-input fingerprint above; the current 28-input aggregate is
`99837edadfd33c9cc68b1bcb4d1e59af1325d65d9d2eaa3285a11f997422f928`.
This limits test-file concurrency, not production Run concurrency. The default
Root `npm test` then passed: 1,136 passed, 7 skipped. The nine workspace pass
counts are 651, 117, 105, 20, 37, 39, 144, 13 and 10; the service portion took
423.45 seconds. Workspace typechecks and the direct strict test-file check
also passed at this checkpoint.

The independent Worker check subsequently blocked release:

```text
node packages/omp-loop-kernel/runtime/node_modules/typescript/bin/tsc --noEmit -p packages/omp-loop-kernel/runtime/tsconfig.json
exit 2
```

The artifact-relative SDK source imports now expose upstream implementation
files to this compiler, producing asset-declaration errors and duplicate
source/declaration nominal identities such as `AuthStorage`. Actual execution
and the local Node typecheck did not cover this separate Worker compiler
boundary. Luna is investigating a narrow import/type boundary fix; no Worker
check, assertion, compiler strictness or dependency identity may be weakened.
S2 remained unaccepted and unpublished pending that fix and refreshed gates.

## Final Typed Worker Candidate

The correction is restricted to nine fixed artifact-relative runtime imports,
published declaration type references and one neutral-context local variable
rename. Dynamic imports narrow from `unknown` only at those fixed pinned-module
boundaries. There is no generic loader, additional Runtime state, ambient
fallback, vendor patch, compiler relaxation or dependency change.

Both Sol Ultra axes independently accepted the delta. Their before/after
28-input fingerprint is
`9997e8c4fd13c0b7e41b92e527d990d5b3c0e20bbcebe1acc8a575f479000f9a`.
The Worker SHA-256 is
`2f20aa03c8ea6df8c3611e68b25f26f2fb4b4151227643b3660f63c5a66c7283`.
Only that file changed from the preceding 28-input candidate; all existing
recovery corrections remain present. Root independently reran the exact
Worker TypeScript command above: exit 0.

Root then used the unchanged preparation script and pinned lock in an isolated
installation, verified every generated file, compared Worker/protocol/canary/
lock bytes with repository inputs, and preserved the prior local artifact.
The new manifest is
`fbabb724c6da48ea44867b6e1743d85f2753c10866ec26b2c4be1f45b716745e`,
again with 21,465 files. Bun/native/SDK identities and the dependency lock are
unchanged. The actual no-copy in-place Worker test passed against this newly
installed artifact: 1 passed, 3.68 seconds.

A coder-reported temporary copied-artifact probe was clarified as a substituted
Worker in an existing artifact, not fresh preparation or full production-Gateway
evidence. It is not counted toward this Root gate. The preceding 1,136-test
result also belongs to its old source fingerprint. Root full gates are being
rerun for the typed Worker candidate before publication.

## Python Gate Race

At the typed Worker candidate, default JavaScript passed 1,136 / 7 skipped and
all typechecks passed. The first Python full run failed the existing active-
agent durable-steer test at `save_project`: its expected version 6 had become
stale (1,047 passed, 1 failed, 41.16 seconds). Five separate focused processes
passed. A second full run failed that case and the previously recorded exact
last-message race (1,046 passed, 2 failed, 50.42 seconds). These failures are
retained; no Python-green claim follows from the isolated repetitions.

All Python production/tests and dependency inputs were unchanged from `c030246`
at those failures. Independent source review located the missing test barrier:
`run_inflight` can be true before the asynchronous claimed projection commits
its project-version and Channel updates. The same-Run/task
`crew.task.execution_claimed` public project audit proves that transaction has
committed; the earlier started audit does not.

The S2 ticket now explicitly authorizes only a test-setup barrier correction in
those two functions. All original assertions and time limits must remain.
Production Legacy code is unchanged. Current full-gate acceptance awaits that
test-only correction, fresh full regressions and independent delta review.

Luna then changed only the two initial polling predicates to require the
claimed audit for the current task and Run. All assertions and timing limits
remained byte-for-byte unchanged. Both focused cases passed and the entire
Crew file passed 47 tests. Root's complete Python rerun passed 1,048 tests with
53 existing warnings in 31.42 seconds; no Python production code changed.

The 29-input final candidate is
`1a6cdc7471fb886b3588081165b0a2c4e8f244ef3f9eadad21622a9d514e3d57`.
Its additional Python test-file SHA-256 is
`13c1732821d43cea323c0c682865dbdd5ec34777f32b87e0c9dfd5e9fca2fbbb`.
Removing that entry exactly reproduces the accepted 28-input typed Worker
fingerprint; runtime bytes and all Node inputs are unchanged. Root is rerunning
default JavaScript at this complete candidate before the final gate record.

Root's full default JavaScript run at that checkpoint passed 1,136 tests with
7 skips. An expanded direct strict check of all eight newly added service/
in-place test files then found one missing constructor option in the Host
ownership test. Its custom factory now forwards the `workerProfileId` already
provided by production into the real Pi constructor. Assertions and product
code are unchanged. The eight-file strict check and all three ownership tests
passed after this two-line fixture correction.

That final fixture candidate has 29 inputs at
`6a43cc645d18e78399ad69f655a0b679614845cce27159a112b3656e426a27fc`;
the ownership test SHA-256 is
`0ba5ee6880c3d0b9d380955c44d95bcb25d80f79aa7b783e3a1b0f177d900e89`.
Runtime and production inputs remain unchanged. Final default JavaScript is
now green for this exact candidate: 1,136 passed, 7 skipped. Root repeated full
Python (1,048 passed), configured typechecks and the independent Worker check
before the publication freeze.

An additional strict sweep of every service test file is not clean: other
existing tests have JSON-union narrowing, branded-ID and optional-method typing
debt. Those untouched assertions are not refactored by S2. The verified static
scope is the configured workspace/Worker checks plus the eight new test files;
do not claim that the entire service test tree is strict-typecheck clean.

## External Validation Availability

A read-only check on 2026-08-31 found no Docker or Podman command on this
shell's PATH, and no Docker CLI at the standard application/user locations.
The currently exposed tool metadata contains no Hiker or remote-execution
connector. This integration checkout has no `.anna/runtime.json`. These are
local availability observations, not proof that no remote environment or
credentials exist elsewhere. No other worktree's credentials were inspected,
no software was globally installed, and no live provider, Hiker or official
benchmark run was attempted. Continue independent implementation work while
keeping those full-Goal validation gates open.
