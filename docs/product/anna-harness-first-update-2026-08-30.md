# Harness-first Update - 2026-08-30

Status: HF-00, HF-01A, HF-01B and HF-02 S0/S1 accepted for scoped Developer Preview source updates.
The complete Harness-first migration remains open. This is not a new signed
release, a Desktop cutover, or a benchmark result.

Authority: [HF-SPEC-1.0](anna-harness-first-spec-2026-08-30.md).
Execution: [SDD plan](../superpowers/plans/2026-08-30-harness-first/00-plan.md).
Implementation: [HF-01A handoff](../superpowers/handoff/2026-08-30-hf-01a-durable-tool-gateway.md).

## HF-02 S2 Local Acceptance

S2 now restores actual OMP execution from canonical Host history through the
production HTTP route and real SQLite close/reopen. It retains original input,
Memory/profile/kernel identity and cumulative budgets, repairs provable lost
observations, and avoids re-running consumed tools. Unprovable dispatch gaps
fail closed. Local Host ownership and complete Runtime/Eval shutdown draining
prevent a second owner or an early Store close.

Principal coding used Luna Max; independent Sol Ultra Standards and Spec reviews
accepted the final 29-input fingerprint. Local JavaScript passed **1,136 tests /
7 skipped**, Python **1,048 tests**, and the configured typechecks, eight new
test-file strict checks, builds, frontend smoke and publication/audit checks
passed. The source and runtime digests, earlier failures and exact evidence
boundaries are in the [S2 handoff](../superpowers/handoff/2026-08-31-hf-02-s2-canonical-restore.md).
Two existing Python test races required a reviewed startup-projection wait;
their original assertions and time limits were preserved. A whole-service-test
strict sweep still exposes older typing debt, which is not claimed resolved.

This is local source acceptance, with final published SHA and its push/PR CI
recorded in PR 1. S1 CI below remains historical. The separately reviewed
[S3 SPEC](../superpowers/plans/2026-08-30-harness-first/HF-02-S3-scoped-controls.md)
defines scoped steer, human question/answer and abort; no S3 implementation is
claimed. Desktop still defaults to Python Legacy, and full Harness-first,
live Provider/Hiker, Windows delivery and official SWE-bench remain open.

## HF-02 S1 Follow-on - 2026-08-31

Commit `c030246d90fca322717e6d20d2af07a2ee5866bc` adds actual managed
Bun/Oh-my-Pi model/Gateway/model execution through the v2 production Host.
Host Memory preparation, scoped SQLite, identity validation, bounded protocol
receipts, cancellation and required pre-terminal Eval are covered. This first
profile is text/read-only on verified macOS arm64, with deterministic Host
model transport in the public integration tests.

Both Sol Ultra review axes accepted the fixed source. Root gates passed:
JavaScript **1,075 passed / 7 skipped**, Python **1,048 passed**, typechecks,
web/service builds, frontend smoke, public boundary and Python audit. GitHub
push `33324464372` and PR `33324466412` both completed successfully at that
exact commit. Detailed evidence and prior failed runs are retained in the
[S1 handoff](../superpowers/handoff/2026-08-30-hf-02-s1-runtime-materialization.md).
The earlier S1 aggregate of 1,085 was an arithmetic error; the nine recorded
workspace counts sum to 1,075. No individual test result changed.

HF-02 remains open for canonical OMP restore, steer/answer, distribution and
complete isolation. Full surface migration, default Desktop cutover, Legacy
removal, live Provider/Hiker and official SWE-bench gates also remain open.

## HF-01B Follow-on

The subsequent [HF-01B handoff](../superpowers/handoff/2026-08-30-hf-01b-host-memory-context.md)
records that milestone's accepted source/test candidate. Production v2 now loads
accepted Channel Memory through its Host before actual Pi input, persists a
private immutable input checkpoint, and writes coordinated provenance-only
hit/readiness receipts. Memory writes remain disabled in these profiles.

Real SQLite close/reopen cases cover start, projection, partial-hit, readiness
and consumed-transcript interruption. Cancellation handoff and remaining-budget
defects found during review are fixed. Corrupt/missing input fails closed, and
two competing SQLite callers use the persisted CAS winner. Normal Memory-stream
and assistant-transcript content is not claimed to be body-free.

Both independent Sol Ultra axes accepted the frozen candidate with zero open
P0/P1/P2. Main-Agent gates: JavaScript **1,002 passed / 7 gated skipped**;
Python **1,048 passed**; typechecks, frontend smoke, builds, unsigned macOS
package/ASAR smoke and root dependency audits passed. Exact scope, commands and
the source/test SHA-256 aggregates are in the handoff. ASAR smoke deliberately
had no configured model or MCP, and does not prove default Host cutover.

The [full Goal](anna-harness-first-goal-2026-08-30.md) remains active with nine
main tickets. Default Desktop execution is still Python Legacy. The HF-02 S1
record above supersedes the earlier package-only preflight status, without
claiming live Hiker, a Desktop cutover or an official benchmark result.

## Original HF-01A Record

The sections below retain the earlier HF-01A evidence at `25e70a9`, including
its then-open work and failures. They are not the latest HF-01B test counts.

## Delivered

- Froze a Harness-first SPEC with explicit runtime ownership, scope, Memory,
  kernel, recovery, migration and benchmark acceptance gates before coding.
- Replaced the handwritten Tool execution object in the existing v2 production
  factory with the existing durable ToolGateway. `read_only`, `web_search` and
  `create_artifact` now use its validation, policy and lifecycle records.
- Bound each Gateway to the admitted Workspace, Channel, Run, worker,
  parent/Lane and Tool allowlist. Later mutation of caller objects cannot widen
  that binding. Pi Tool requests use their actual RunProfile worker.
- Gave local Artifact generation a stable scoped effect identity. Its `never`
  replay policy preserves the original result after SQLite close/reopen and
  prevents repeated writes. Activation and external-write approvals remain
  separate; no approval is fabricated to generate a draft.
- Preserved durable success/unknown outcomes when a later request is cancelled.
  New cancelled effect dispatches perform zero adapter I/O. The Create adapter also
  checks cancellation before entry; this is not post-dispatch rollback.

This closes the HF-01A ticket for the current v2 Tool path. It advances the
SPEC's Tool requirements without closing the cross-surface or overall gates.
The default Desktop Agent Runtime is still Python Legacy with opt-in v2.

## Independent Review

Coding used GPT-5.6-Luna Max. Two GPT-5.6-Sol Ultra reviewers independently
checked Standards and Spec, including correction rounds.

| Axis | Final decision | Corrections verified |
| --- | --- | --- |
| Standards | Accepted; no remaining HF-01A hard violation | Malformed effect identity; cancellation before dispatch and after effect-start persistence; immutable Run binding |
| Spec | Accepted; no remaining HF-01A material deviation | Durable success/unknown takes precedence over a later cancelled replay; actual Pi/SQLite integration; reopen/replay |

Both reviewers reran 66 focused tests (production 16, Gateway 23, Pi 27).
The Spec reviewer also ran nine deterministic scoped SQLite probes. These are
local verification results, not live Provider or MCP evidence.

The reviewed seven-file fingerprint is
`65517a1208466c28ad3dd9922a466d4dc06b05a4ca7fd07e806be1e5a69ad32e`.
It is SHA256 of UTF-8 `JSON.stringify(hashes)`, where `hashes` is the ordered
array of `{path, sha256}` objects and each file digest hashes its raw bytes:

```text
apps/harness-service/src/production.ts
apps/harness-service/src/production-tools.ts
apps/harness-service/test/production-tools.test.ts
packages/harness-v2/src/tool-gateway.ts
packages/harness-v2/test/tool-gateway.test.ts
packages/pi-loop-kernel/src/pi-loop-kernel.ts
packages/pi-loop-kernel/test/pi-loop-kernel.test.ts
```

## Verification

Local environment: macOS arm64, Node 24.12.0, CPython 3.12.13. No real
Provider/MCP credentials or business data were used. The Pi integration runs
the actual adapter against deterministic model streams and real SQLite.

| Check | Result and evidence boundary |
| --- | --- |
| `npm run typecheck` | Passed: Desktop and seven workspaces |
| `npm test -- --reporter=dot` | 988 passed, seven gated tests skipped |
| `uv run pytest -q` | Final serial run: 1,048 passed; earlier failure retained below |
| `npm run frontend:smoke` | Five passed |
| `npm run build`, `npm run harness:v2:build` | Passed through the final package command |
| `npm run desktop:package` | Passed: macOS arm64, unsigned local preview |
| `npm run desktop:smoke-asar` | Passed: index served, health OK; model and MCP explicitly not configured |
| `uv run pip-audit --progress-spinner off` | No known vulnerabilities reported |
| `npm audit --omit=dev --audit-level=high` | Zero vulnerabilities reported |
| `npm run evidence:verify:all` | Seven existing manifests verified; archive integrity, not new live executions |

The JavaScript result comprises Desktop 651, core 107, Event Store 102,
Scheduler 20, Pi 29, service 56, Trace 13 and Eval 10 passing tests.
Public-source/privacy, Markdown-link and `git diff --check` gates are rerun
before publication. Generated packages, local environments and databases are
excluded from the Git update.

## Retained Failure

One broad Python run failed
`test_channel_say_terminal_signal_race_keeps_message_and_does_not_500`:
the test expected the user message to remain the last Channel message, while
an asynchronous execution projection was appended afterwards. The affected
Python source, tests and lockfile are unchanged from the publication baseline.

Five isolated repetitions passed, followed by a serial 1,048-test pass. Sol's
source audit found no projection barrier behind `run_inflight`; a last-message
assertion is therefore timing-sensitive. The exact trigger of that occurrence
was not established. This risk is retained, not claimed fixed or silently
removed from the evidence. No Python assertion was weakened for this update.

An earlier first-run Desktop-hosting test failed before `dist/` existed and
passed after the required frontend build. Existing deprecation, bundle-size
and unsigned-package warnings remain visible.

## HF-01A Open Items

- HF-01B: Host Memory hydration, pre-model Memory evidence, sequence ownership
  and restore behavior. Production Memory loading has not been enabled here.
- HF-02: actual pinned Oh-my-Pi worker integration, isolation and conformance.
  No Oh-my-Pi dependency was installed by this ticket.
- HF-03..08: complete Chat, Router, Hiker/business MCP, approvals/readback,
  coding sandbox, Create lifecycle, Crew/Hub and Scheduler integration.
- HF-09..10: one default Desktop Host, state migration, Legacy deletion and
  full release acceptance. Windows and signed/notarized distribution are not
  validated by the local macOS package smoke.
- SWE-bench solver/evaluator/performance gates and real Provider/MCP canaries
  remain unexecuted in this milestone. No benchmark score is claimed.

## Publication Boundary

The integration branch is `codex/harness-first-20260830`, based on verified
Anna-Agent main `df1bf0ccb954af7a174e7aa1671dae9379d07da0`. Its SPEC was committed
before implementation. Both original dirty worktrees retained identical HEAD,
status, tracked-diff and untracked-content fingerprints after verification.

Publish this milestone through a branch and PR in `Foxtailsss-Andy/Anna-Agent`.
The PR's remote SHA and CI checks are the publication record. No force push,
automatic merge, version tag or GitHub Release is part of this update.
