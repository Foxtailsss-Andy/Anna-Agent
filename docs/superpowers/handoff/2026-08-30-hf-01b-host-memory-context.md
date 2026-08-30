# HF-01B Host Memory Context Handoff

Date: 2026-08-30
Status: accepted for the HF-01B deterministic scope after independent Sol Ultra
Standards and Spec review and Main-Agent integrated verification.
Base: `b2c50aa` (HF-01B accepted ticket)
Scope: production v2 Host Memory hydration, Pi preparation/receipt handoff,
private input projection and current Run recovery.

## Delivered

- `apps/harness-service/src/host-memory-context.ts`
  - Validates the stored admitted command, Channel scope, Worker, Profile hash,
    original `run.started` fingerprint and read policy before loading.
  - Uses the existing no-`runId` Memory Repository read, so the Host does not
    allocate Run-stream sequence numbers or append Run events.
  - Loads accepted current Channel Memory only, builds a typed immutable
    `RunContext`, and commits one private
    `harness-run-context-input` projection through the existing CAS API.
  - Stores the prepared raw Memory input in that private projection. The
    HF-01B-generated `memory.hit` and readiness records remain provenance-only;
    the pre-existing Memory stream and normal assistant transcript semantics
    are unchanged and may contain content bodies. The projection is anchored
    to the original start event and protected by a digest.
  - Reuses the persisted projection for the same Run; a new Run queries current
    accepted/edit/delete state.
- `apps/harness-service/src/production.ts`
  - Production general/Create profiles explicitly use `memoryPolicy.read:
    "channel"` with writes still disabled.
  - The same Host loader is passed to both the default and injected Pi kernel
    factory paths.
- `packages/pi-loop-kernel/src/pi-loop-kernel.ts`
  - Persists one start fingerprint before required preparation.
  - Adds Host preparation with pending `kernel.abort(runId)` handoff, external
    abort, remaining wall-budget timer, and post-ACK/read checks.
  - Pi alone appends provenance-only `memory.hit` receipts and one
    `run.context.ready` record, including snapshot and actual input fingerprints,
    before the first model call.
  - Restores consumed transcripts without duplicate user input, hydration or
    tool dispatch; `read:none` keeps the existing path.
- `packages/harness-v2/src/memory-projection.ts` and
  `src/memory-repository.ts`
  - Freeze deterministic case-insensitive AND tokenization, punctuation and
    explicit stop-word handling. Empty/whitespace/punctuation/stop-word-only
    queries return zero hits; limits must be integer `1..32`.
- Focused Pi/service/event-store tests and affected production factory tests.

## Evidence

Initial RED tracer:

```text
npm run test --workspace=@anna/harness-service -- --run test/memory-hydration.test.ts -t "accepted Memory"
1 failed: expected memory.hit after run.started, but no receipt existed
```

The fixture was then corrected to use real Repository `propose`/`accept` with a
source Profile allowing `write: propose` and a scope/actor Owner predicate.
The positive query was kept as a deterministic AND match (`release notes`),
not widened to OR.

Final focused GREEN commands:

```text
npm run test --workspace=@anna/harness-service -- --run test/memory-hydration.test.ts test/memory-hydration-negative.test.ts test/production-tools.test.ts test/runtime.test.ts
4 files, 31 tests passed

npm run test --workspace=@anna/pi-loop-kernel -- --run test/pi-loop-kernel.test.ts
1 file, 29 tests passed

npm run test --workspace=@anna/event-store -- --run test/memory-repository.test.ts test/memory-retrieval.test.ts test/memory-workspace-grant.test.ts test/sqlite-reopen.test.ts
4 files, 19 tests passed

npm run typecheck --workspace=@anna/harness-v2
npm run typecheck --workspace=@anna/pi-loop-kernel
npm run typecheck --workspace=@anna/harness-service
all passed

npx tsc --noEmit --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node apps/harness-service/test/memory-hydration.test.ts
passed

git diff --check
passed
```

## Acceptance Matrix

- **Accepted Memory:** real SQLite, real Repository Owner proposal/acceptance,
  actual Pi and production Host composition. Observed order is `run.started`,
  `memory.hit`, `run.context.ready`, first model progress, Contract Eval and
  one terminal. HF-01B hit/readiness receipts contain provenance only; the
  accepted body is available in the private projection and untrusted model
  input, while existing Memory-stream/transcript body behavior is unchanged.
- **Start-only loss:** first preparation fails after durable `run.started`; a
  second actual Pi attempt prepares the same SQLite Run with one start and one
  readiness record.
- **Partial hit/ready loss:** Pi durable-sink tests persist one or all receipts,
  interrupt before the next phase, then retry only missing records with no
  duplicates.
- **Real SQLite checkpoint reopen:** four parameterized actual-Pi/Host/
  Production-Gateway cases interrupt after `run.started`, after private
  projection commit, after one of two `memory.hit` receipts, and after
  `run.context.ready`. Each closes SQLite, creates a new Store and Pi, then
  restores two accepted Memory items with one started/hit-set/ready, contiguous
  seq, two model turns (one read-only Tool call plus answer) and one real
  `tool.requested`.
- **Readiness ACK and final history read:** real SQLite/actual Pi tests pause
  after `run.context.ready` persistence or during the final history read; both
  `kernel.abort(runId)` and wall timeout produce no model call after the pause.
- **Budget:** a delayed first SQLite history read beyond the budget returns
  `timed_out` before Host loader invocation, with zero loader calls and no
  private projection write. Positive preparation time is not given a fresh full
  budget.
- **Consumed input reopen:** real SQLite, Host loader, actual Pi and production
  ToolGateway persist a read-only tool result and transcript, close/reopen the
  database, then continue once. The resumed context has one user message, one
  `tool.requested`, one `memory.hit`, one `run.context.ready`, and contiguous
  sequence numbers.
- **Current versus historical Memory:** editing accepted Memory after the first
  Run leaves that Run's snapshot digest/content unchanged through reopen; a new
  Run observes the edited content.
- **Valid zero-hit/read:none:** a legal channel zero-hit writes readiness and
  reaches the model; historical `read:none` performs no Host preparation or
  Memory injection.
- **Query/limit guards:** empty/ambiguous queries return zero hits rather than
  all Memory; invalid limits are rejected by the Repository.
- **Fail-closed:** missing loader, missing/tampered/mismatched snapshot,
  inconsistent receipt and cancelled preparation stop before model input.
- **CAS competition:** two real SQLite connections prepare different candidate
  hit sets. Both callers return the same committed winner, including the
  delayed loser; no uncommitted candidate becomes model input.

## Independent Review

**Standards:** Sol Ultra accepted the fixed source/test candidate with zero
unresolved P0/P1/P2. The earlier preparation/Agent cancellation handoff and
remaining-budget defects were independently reproduced, fixed and rerun. The
100 ms budget plus 80 ms initial-read probe now times out near 102 ms with zero
model calls, rather than receiving a second full budget.

**Spec:** a separate Sol Ultra accepted Public RED requirements 1 through 6.
It additionally exercised production exclusion of candidates, rejected/deleted
Memory and other Channels, plus deletion followed by a zero-hit new Run. This
is a focused review probe, not an extra persistent test count.

Both axes independently reran service 31, Pi 29 and Memory/Store 19 focused
tests. Their before/after source and test fingerprints matched. The additional
negative regression cases were green on their first recorded execution; no
earlier RED is fabricated for already implemented guards.

## Integrated Verification

Main-Agent verification of the fixed candidate:

| Check | Result and boundary |
| --- | --- |
| `npm run typecheck` | Desktop and all seven workspaces passed |
| `npm test` | 1,002 passed; seven gated tests skipped |
| `./.venv/bin/python -m pytest -q` | 1,048 passed, 53 existing deprecation warnings |
| `npm run frontend:smoke` | Five passed |
| `npm run desktop:package` | Frontend/Host builds and unsigned macOS arm64 package passed |
| `npm run desktop:smoke-asar` | Index served and health OK; model/MCP deliberately not configured |
| `npm audit --json` | Root dependency graph: zero reported vulnerabilities |
| `uv run --locked pip-audit --progress-spinner off` | No known vulnerabilities reported |
| `npm run evidence:verify:all` | Seven existing archives verified, not new live executions |

JavaScript passes comprise Desktop 651, core 107, Event Store 103, Scheduler
20, Pi 31, service 67, Trace 13 and Eval 10. The historical Python race noted
in the HF-01A update remains a retained risk; no Python source/assertion was
changed here. No test count closes a live, platform or whole-Goal gate.

## Explicit Boundaries

- Deterministic fake provider transport is used; no paid or authenticated
  provider call is claimed.
- Partial-loss tests are simulated sink/ACK interruptions, not a full process
  crash or supervisor recovery proof. The HF-08 crash matrix remains open.
- Shared EventSink, SQLite sequencing, `DurableRunRuntime`, Contract Eval and
  effect-ledger implementation were not changed.
- CAS loser/winner and additional negative projection/receipt cases are covered
  by the separately assigned `memory-hydration-negative.test.ts` slice.
- No Desktop cutover, Router, Memory UI, OMP, Legacy Python or README changes
  are part of this handoff.

## Frozen Review Fingerprints

Use SHA-256 of each file's raw bytes, then SHA-256 of the compact
`JSON.stringify([{path,sha256}, ...])` array in the following order. The first
seven files form the source-only aggregate; all thirteen include tests.

```text
apps/harness-service/src/production.ts
apps/harness-service/src/host-memory-context.ts
packages/harness-v2/src/index.ts
packages/harness-v2/src/memory-projection.ts
packages/harness-v2/src/memory-repository.ts
packages/pi-loop-kernel/src/index.ts
packages/pi-loop-kernel/src/pi-loop-kernel.ts
apps/harness-service/test/memory-hydration.test.ts
apps/harness-service/test/memory-hydration-negative.test.ts
apps/harness-service/test/production-tools.test.ts
packages/event-store/test/memory-repository.test.ts
packages/pi-loop-kernel/test/pi-loop-kernel.test.ts
packages/pi-loop-kernel/test/run-profile-fixture.ts
```

Source aggregate:
`a12a49a6ee1e39381777c829fec34c5f142fce846a2772b4bc68fff74ae5bd09`.
Source and tests:
`8b452275fef959bef39998356703d55ee6e5779ba8037dad62e8fcd1492a56ed`.

Coding agents did not commit, push or merge. Main-Agent publication uses the
reviewed branch/PR and preserves the original dirty worktrees. The full Goal
remains active after this ticket's acceptance.
