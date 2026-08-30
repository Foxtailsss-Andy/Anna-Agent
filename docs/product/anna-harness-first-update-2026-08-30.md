# Harness-first Update - 2026-08-30

Status: HF-00 and HF-01A accepted for a scoped Developer Preview source update.
The complete Harness-first migration remains open. This is not a new signed
release, a Desktop cutover, or a benchmark result.

Authority: [HF-SPEC-1.0](anna-harness-first-spec-2026-08-30.md).
Execution: [SDD plan](../superpowers/plans/2026-08-30-harness-first/00-plan.md).
Implementation: [HF-01A handoff](../superpowers/handoff/2026-08-30-hf-01a-durable-tool-gateway.md).

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

## Still Open

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
