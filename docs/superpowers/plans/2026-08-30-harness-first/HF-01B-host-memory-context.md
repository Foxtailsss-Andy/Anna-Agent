# HF-01B: Host Memory Context and Recovery

Date: 2026-08-30
Base: `825824a` (product code baseline `25e70a9`)
Spec: [HF-SPEC-1.0](../../../product/anna-harness-first-spec-2026-08-30.md)
Goal: [HF-GOAL-1.0](../../../product/anna-harness-first-goal-2026-08-30.md)
Status: implemented and accepted in the [HF-01B handoff](../../handoff/2026-08-30-hf-01b-host-memory-context.md); full Goal remains active.
Coder: GPT-5.6-Luna Max. Review: GPT-5.6-Sol Ultra.

## Outcome and Scope

The production v2 Host supplies accepted, Channel-scoped Memory before the
first actual Pi model call. A restored Run uses its validated immutable input,
not newly queried Memory silently substituted into the old fingerprint.

This ticket implements HF-040/044 and the Context/loading and restoration
subsets already assigned to HF-01B. Owner UI, automatic candidate generation,
Router, OMP, full Supervisor recovery and default Desktop cutover remain their
own tickets. Do not add Python execution behavior or claim the full Goal done.

## Architecture Decision

Use the existing serial ownership handoff: Runtime writes queued, Pi's active
appender writes active Run events, then Contract Eval writes the terminal tail.
The Host loader returns typed prepared context and Memory-hit provenance; it
does not allocate Run-stream seq or append canonical Run events independently.
No hidden sequence offsets, Store guard removal or generic resequencing proxy.

The existing Repository's no-`runId` lookup is a pure read and may be reused.
The Host must first validate the admitted, stored command, original start,
scope/worker/profile and read policy. Preserve the Repository's existing
`retrieve({runId})` guards/recording behavior for its existing callers.

The new loader is a small provider-independent Host boundary consumed by the
adapter. Reuse the immutable `RunContext` contract. Keep original goal,
worker/Skill instructions, Tool allowlist and RunProfile unchanged. Memory is
an explicitly untrusted addition to model context, not new instructions/grants.

## Durable Input and Readiness

1. Persist one `run.started` and its original execution fingerprint before
   required loading. A prior start alone does not mean a transcript exists.
2. The Host validates/loads a private scoped input projection, or queries the
   accepted-Memory Repository and commits that projection. Reuse the Store's
   projection CAS API, anchored to the original start event. The persisted
   winner is authoritative; do not return an uncommitted losing candidate.
3. The private snapshot contains the normalized RunContext, required provenance,
   schema/version and binding/digests sufficient to restore the same input.
   Do not put raw Memory bodies into `memory.hit` or the readiness event.
4. After snapshot persistence, Pi appends the missing `memory.hit` receipts and
   one `run.context.ready` record, then invokes the model. A legitimate zero-hit
   lookup still has a readiness record; absence of hits is not proof of loading.
5. Readiness binds the private snapshot digest and actual effective prompt/input
   fingerprint as well as the original execution fingerprint. A changed prompt
   format or tampered/mismatched snapshot must not bypass restore checks.

Before any model-input consumption, a start-only crash may retry preparation.
If the snapshot was committed, resume that snapshot and finish only missing
receipts. Existing receipts/readiness or consumed input without the matching
snapshot are fail-closed, not an invitation to refresh Memory. Valid restored
transcripts continue without duplicate user input, hits or tool execution.

For the same Run, the snapshot is historical execution input, not a new Memory
retrieval. New Runs/retrievals must observe current deletion/revocation/edit
state. This slice does not promise retroactive erasure of already consumed Run
history or add implicit cross-Channel grants.

## Failure, Cancellation and Budget

- `read: channel` without a Host loader, or a Store/scope/policy/projection/
  receipt failure, invokes zero model calls and cannot become a successful
  empty context. Do not add a second optional `required` flag.
- `read: none` invokes no Memory Repository lookup and preserves existing
  reference-adapter behavior. Production general/Create profiles enable
  Channel reads; Memory writes remain disabled in this ticket.
  Historical `read:none` Runs retain their original transcript/fingerprint
  restore path; do not demand a new prepared-input snapshot or inject new
  Memory into that old path. Snapshot/readiness requirements apply to Runs
  admitted to the new prepared-input protocol.
- Abort and wall timeout during a blocked loader settle without a later model
  call or late loading writes. The loader must observe the execution signal;
  waiting for context is inside the current attempt's wall-time budget.
- Preserve the original profile/limits, cumulative token/cost/turn restoration
  and durable reader. Do not claim the full Supervisor/wall-time crash matrix
  is closed; HF-08 retains that responsibility.
- Empty/whitespace, punctuation-only and explicitly frozen stop-word-only
  queries cannot recall all Memory. Keep meaningful queries deterministic;
  freeze tokenization/limits in tests and do not invent semantic-search claims.

## Owned Files

- `apps/harness-service/src/production.ts` and a focused new Host context module.
- `apps/harness-service/test/memory-hydration.test.ts` and affected production
  tests, including actual-Pi factory injection regressions.
- `apps/harness-service/test/memory-hydration-negative.test.ts`, a separately
  owned test-only slice for snapshot corruption and projection-CAS winner cases.
- `packages/pi-loop-kernel/src/pi-loop-kernel.ts` and its focused tests.
- `packages/harness-v2/src/run-context.ts` and `src/index.ts`, only for the typed
  prepared-input boundary/validation shared with the Host and adapter.
- `packages/harness-v2/src/memory-repository.ts` and `memory-projection.ts`, only
  for frozen query/limit semantics or a necessary shared provenance helper.
- Existing Memory/RunContext tests in harness-v2 and event-store.
- The HF-01B implementation handoff.

No new central writer or changes to `DurableRunRuntime`, shared EventSink,
SQLite sequencing or Contract Eval are authorized by default. If an observed
RED proves an ownership expansion necessary, record a main-Agent amendment
before implementing it. No dependency, UI, OMP or Legacy changes in this ticket.

## Public RED and Acceptance

Use real scoped SQLite and actual Pi with deterministic provider transport;
do not mock authorization, Memory state, Gateway, projection or Eval away.

1. Accepted Memory reaches the actual model context through production Host
   composition. A blocked loader is visible after started with zero model calls;
   order is started, hit receipts, ready, first model, required Eval, one terminal.
2. Candidates, rejected/deleted records and unauthorized other Channels do not
   load. A new Run after restart sees current accepted state. Repository grant
   revocation regressions remain intact; no caller-supplied grant expansion.
3. Legal zero-hit continues. Disabled reads perform no lookup. Empty/ambiguous
   query and invalid-limit cases cannot become an unbounded recall.
4. Missing loader, invalid binding, retrieval, projection and receipt failures
   stop before the model. Abort/timeout during loading cannot leak late work.
5. Simulate loss after start, projection commit, partial hits, ready and input
   transcript commit; close/reopen SQLite. Observe no missed/double hydration,
   profile/prompt drift, duplicate Tool dispatch or reset cumulative usage.
6. Tampered/missing/mismatched snapshots fail closed; changing current Memory
   does not silently change the restored original input. Hit/readiness metadata
   remains provenance-only. Explicitly label simulated crash versus real
   supervisor/process-crash evidence; the latter remains a HF-08 requirement.

Record actual RED/GREEN commands per changed behavior. Complete focused tests,
related typechecks and a handoff before requesting independent Standards/Spec
review. Main Agent verifies the integrated tree, fixes remaining correctness
findings through Luna and publishes only the evidenced scope.

## Test Ownership Amendment

On 2026-08-30, independent Spec review identified missing real reopen/continue,
snapshot-corruption and CAS-loser evidence. A second GPT-5.6-Luna Max may edit
only `memory-hydration-negative.test.ts` for the latter two behaviors, using
the same already-approved public boundaries and real SQLite. The primary Luna
retains all product code and the actual-Pi reopen/continue tests. This does not
expand product scope, weaken a gate or authorize changes to Store sequencing.
Any observed implementation defect returns to the primary coder for a public
RED/minimal GREEN cycle and final Sol Ultra review.
