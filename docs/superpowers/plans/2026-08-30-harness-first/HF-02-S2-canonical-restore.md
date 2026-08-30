# HF-02 S2: Canonical OMP Restore

Date: 2026-08-31
Status: frozen for canonical-restore tracer coding after independent design
review. Single-Host ownership amendment accepted; any broader lifecycle change
requires the concrete RED described below.
Implementation base: `c030246d90fca322717e6d20d2af07a2ee5866bc`.
Parent: [HF-02](HF-02-governed-omp-kernel.md).
Contract: [HF-SPEC-1.0](../../../product/anna-harness-first-spec-2026-08-30.md),
HF-021, HF-025 and HF-033.
Coder: GPT-5.6-Luna Max. Independent review: GPT-5.6-Sol Ultra.

## Outcome

Resume an interrupted OMP Run through the existing production resume route,
real SQLite, actual pinned Bun/OMP, Host Memory loader and production Gateway.
The resumed worker continues the original admitted input and transcript. It
does not repeat the initial user goal, refresh same-Run Memory, reset budgets,
repeat a consumed tool action, or switch to Pi because new admission changed.

S2 closes canonical restore for the enabled text/read-only profile. S3 must
still implement steer and request-correlated answer, including their durable
scope and pending-request contract. Full HF-02 also retains distribution and
complete isolation requirements. These are remaining obligations, not removed
acceptance criteria. No new tools, Legacy changes, UI work or native discovery.

## Public Boundaries

Tests cross `LoopKernel.start(command, durableSink, signal)` for adapter
conformance and the existing
`POST /v2/surfaces/:surface/runs/:runId/resume` for production admission and
Eval. Use real scoped SQLite, actual managed worker and real Host/Gateway.
Deterministic Host model transport is permitted. Test-only injected persistence
loss must be labelled simulated loss, even when close/reopen is real. OS Host
kill/supervisor recovery remains separate evidence in the parent migration.

The first RED is an actual consumed OMP transcript from a model/read cycle,
followed by SQLite close/reopen and the public production resume route. Current
S1 rejects it as unavailable. The resumed request must see the original user,
assistant tool call and actual tool output, with one initial user message and
one total tool dispatch. Missing modules or a fake SDK are not this RED.
Generate the first stage through actual `LoopKernel.start` and the scoped
durable sink, with an injected simulated persistence loss before terminal;
assert that no terminal exists before closing. The production Eval wrapper
normally makes thrown errors terminal, so do not use that wrapper to fake a
crash and never delete a terminal event. Restore uses actual production HTTP.

## Single Host Ownership

S2 permits one production Host owner per local canonical EventStore. Same-Host
duplicate resume reuses the existing Runtime handle; it must not launch a
second worker. Different Channels can still execute concurrently in that Host.

Acquire a dedicated SQLite ownership connection at the canonical EventStore
path plus `.omp-owner.sqlite`, using `BEGIN EXCLUSIVE` and zero busy wait.
Hold it for the lifetime of every production Host, regardless of new-Run
selector. Canonicalize the actual data-file path so symlink aliases cannot
bypass ownership; hard-linked data files are unsupported and must be rejected.
A busy lock rejects
startup before admitting commands; initialization failures close the connection.
This is an OS-held ownership guard, not product state or a second event store.
It holds no long-running transaction on the canonical data database, has no
expiry-based lease stealing, and does not add a dependency. Keep the lock file
in place on close; release by rollback/connection close only, after active OMP
workers and Host callbacks settle and the canonical Store closes.

Only verified local filesystems are supported for this owner mechanism. Test
two actual Node processes, ordinary close and owner process exit; do not infer
network filesystem safety or full supervisor recovery from those tests. The
This guarantees mutual exclusion only among local Hosts that obey this
protocol. Stop older S1 Hosts before upgrading; they do not acquire this lock.
The owner guard is a narrow production composition amendment needed for explicit
OMP resume; canonical Store schemas remain unchanged.

The production close test must include completion of Host Eval and the full
durable drive, not only SDK idle or kernel completion. If the current close
path demonstrably closes SQLite before those operations finish, record that
RED and review a narrow drain/close lifecycle addition; do not mask it by
ignoring late Store errors or by releasing ownership early.

This RED was observed on 2026-08-31 using actual Pi, SQLite and production
Contract Eval: `live.close()` settled while the real Eval append ACK was
paused. Sol accepted the narrow amendment: add `DurableRunRuntime.close()` to
stop admission, abort controllers and drain every in-flight start and complete
drive (including Eval/terminal ACK), without early return when one Run fails.
Expose it on the production Runtime object; preserve existing LoopKernel and
HTTP payload contracts. The single production close Promise orders
`runtime.close -> omp.close -> store.close -> ownership.close`.

## Admission and Identity

- Load/validate an explicitly configured OMP installation independently of the
  selector used for new Runs. Selecting Pi for new admission does not reinterpret
  or prevent an otherwise available original OMP Run from resuming.
- An OMP resume requires exact original/current kernel descriptor equality,
  validated installation and matching provider/model configuration. Validate
  scope, surface and the stored command first. Reject mismatch before new
  events, worker creation or model/tool I/O; no fallback.
- New admission continues to obey its selector. Loading an OMP installation
  for recovery must not change new Pi profiles. Historical Pi behavior stays
  compatible; this ticket does not retrofit its kernel implementation.
- Validate original `run.started.executionFingerprint` against the complete
  admitted RunProfile, model and rendered approved Skill/Worker instructions.
  Validate the restored Host snapshot and existing `run.context.ready` fields,
  including snapshot/input digests and Memory provenance. Missing or corrupt
  consumed input fails closed; never rebuild it from current Memory.
- A finished Run stays terminal and must not launch a worker. Resume remains
  `start` with the stored command/readable sink; no new public resume method.

## Canonical History and Worker Projection

All recovery state lives in the existing canonical EventStore. OMP in-memory
messages are a disposable projection. Keep the text-only protocol schema and
1 MiB frame bound; an oversized restore fails explicitly without truncation.
Extend the start input with `transcript?: readonly Message[]` using the existing
closed neutral Message schema. A present empty array is invalid; an absent field
means a fresh start. An existing transcript means replacement of SDK messages
and actual SDK continuation, never another prompt of the original goal.

The Host validates the complete transcript: scope/stream and contiguous event
sequence; one initial user goal; ordered assistant/tool-call/tool-result
pairing; admitted tool names and arguments; unique tool-call identities; and
legal final stop reason. Unknown event payloads do not become model messages.
Do not expose upstream model/credential/native session state in this schema.
Already durable restored messages must not be emitted again as new events.
Initialize client authorization/pending-call/used-call bookkeeping from the
validated Host transcript, preserving the S1 dispatch and receipt barriers.

If the durable tail already contains a completed assistant answer, first
restore/validate all reported usage and the wall origin and apply budget gates.
Only then finalize through Host Contract Eval with zero new model/tool calls.
Exhausted budgets still yield timed_out, including loss after reply persistence
but before the original cap check. A user or tool-result
tail continues the SDK. An assistant with an unexecuted admitted tool call can
continue that same call only when durable records prove it was not dispatched.

## Lost Replies and Dispatch Fences

The existing Gateway lifecycle stream records status, not full output. It is
not sufficient to reconstruct a missing tool-result body. Never invent one.

Persist Host-authorized model responses and full tool replies in private Run
events before returning them to the worker. Record their request/tool identity
and transcript position. They are delivery checkpoints in the same EventStore,
not a second transcript authority or upstream session. Normal SDK observations
must match these bytes. A restore may repair an absent observation from an
Host checkpoint acknowledged by EventStore, exactly once, before worker
continuation. A lost worker ACK does not invalidate an already durable event.

Freeze these private Run-event payloads, with the existing optional Run/Lane
attribution fields only. All records are closed and versioned:

```typescript
// model request index is one-based; transcript index is zero-based.
type ModelDelivery = {
  schemaVersion: 1;
  requestIndex: number;
  requestEventId: string; // the durable run.model.requested event
  transcriptIndex: number;
  message: AssistantMessage;
}; // omp.model.response
type ToolDispatch = {
  schemaVersion: 1;
  toolCallId: string;
  tool: "read_only";
  inputDigest: string;
  transcriptIndex: number;
}; // omp.tool.dispatch
type ToolDelivery = {
  schemaVersion: 1;
  toolCallId: string;
  dispatchEventId: string;
  transcriptIndex: number;
  result: { status: "succeeded" | "failed" | "unknown"; output?: JsonValue };
}; // omp.tool.response
```

Logical uniqueness is `(scope, runId, requestIndex)` for model delivery and
`(scope, runId, toolCallId)` for tool dispatch/delivery; observation repair uses
the validated transcript index. A duplicate with changed identity or content
fails. Do not use new attempt/frame IDs to reinterpret an old checkpoint.
Each referenced request/dispatch event must exist, match its recorded type and
index, and belong to the same scope/Run. A new request cannot appropriate an
older reply. Validate a model reply with the neutral parser before persisting it. Persist
model delivery then the corresponding cumulative usage update (with the same
requestIndex), and await both before forwarding to the worker. A restore can
complete a missing usage update from the provider-reported usage in a durable
model delivery, without charging an already recorded response twice. Existing
usage/response records must agree; placeholder usage is never accepted.

Persist a tool-dispatch fence before entering Gateway. Restoring a fence with
no durable reply does not execute the tool again, even for read_only; stop with
an explicit indeterminate-recovery reason. Likewise, an existing unknown tool
reply is preserved as unknown and is not replayed. No success is synthesized.
Completed safe replies resume without Gateway execution. Older event shapes
without these new checkpoints can be read only when complete observations and
lifecycle records suffice AND the executing descriptor still matches exactly.
This is schema compatibility, not a cross-version migration: published S1 Run
descriptors will not match a rebuilt S2 implementation. Such Runs remain
unavailable unless their original implementation is available; never rewrite
an old profile/hash to make it match S2. Unprovable delivery gaps remain
explicit failures.

Every new model attempt is preceded by durable `run.model.requested`. A request
without a durable response consumes its attempt/turn allowance. It may be
retried with a new request identity only when remaining budget is provable.
If a required token/cost budget cannot be recovered because response/usage was
lost, fail explicitly instead of treating missing usage as zero.

Checkpoint events may contain prompt/tool bodies and keep the existing private
transcript privacy boundary. Public Memory hit/readiness receipts remain
provenance-only. Test failure hooks must not change successful Gateway output
or fabricate provider usage.

## Cumulative Budgets and Lifecycle

- Persist `run.started.payload.budgetStartedAt` as the ISO-8601 time captured
  at the first attempt entry, including its pre-verification I/O time.
  The immutable origin survives each attempt. For older history without this
  field, use the earliest valid queued/started timestamp conservatively; never
  grant a fresh full wall budget on reopen. Downtime counts toward wall time.
- Recover model attempts, tool dispatches, input/output tokens and cost from
  durable records. Validate nonnegative finite counters and monotonic cumulative
  usage. Missing optional usage remains absent; required unknown usage blocks
  continuation. Never add upstream placeholder zeros as provider evidence.
- Account for initial verification/read/preparation I/O and every new attempt.
  Exhaustion settles timed_out before any further worker/model/tool dispatch.
  Preserve original limits and already recorded usage at the stop boundary.
- New attempt IDs and worker sequence zero are independent of continuous Host
  sequence. Record `run.resumed` after validated input with the new attemptId,
  original startedEventId, snapshotDigest and restored transcript length. Every
  repaired transcript observation references its source delivery event ID and
  transcript index; a repeated reopen cannot apply the same repair twice.
  Do not duplicate
  started, context ready or Memory hit events. Repeated loss/reopen is safe.
- Cancel/timeout during validation, hydration, checkpoint repair or ACK waits
  cannot leak a model/tool call. Await worker and pending Host operations before
  closing SQLite. Keep one final terminal and Contract Eval before that terminal.
- Do not change the Store schema, generic Gateway contracts or Eval semantics
  without a concrete RED and an explicit reviewed ownership amendment.

## Owned Files

- `packages/omp-loop-kernel/src/omp-loop-kernel.ts`, `worker-client.ts`, a small
  private restore module if it removes real complexity, and implementation
  identity inputs when a module is added.
- `packages/omp-loop-kernel/runtime/{protocol,worker}.ts` and focused tests.
- `apps/harness-service/src/production.ts`: recovery installation and identity
  admission only. `host-memory-context.ts`: consumed-input marker recognition
  only if required to keep Host loading fail-closed for OMP events.
- One small production `omp-host-ownership.ts` helper and its process-level
  tests for the single-owner mechanism above; no canonical Store schema change.
- `packages/event-store/src/run-runtime.ts` and its focused tests, plus
  `apps/harness-service/src/runtime.ts`: the demonstrated close/drain amendment
  only. Root owns these and Host ownership tests; Luna owns kernel restore and
  production composition.
- Focused public tests under `apps/harness-service/test/omp-resume*.test.ts`,
  relevant existing regressions, this ticket and its handoff.

No root lock/runtime dependency update is expected. Re-materialize the final
worker artifact from the unchanged pinned dependency lock before acceptance.

## Vertical Verification Order

1. Real consumed transcript and Host Memory snapshot, real SQLite reopen,
   production HTTP resume under a changed new-Run selector: one user message,
   one real tool dispatch, original context, one final Eval/terminal.
2. Completed-answer checkpoint recovery performs zero additional model/tool
   calls. Validate close/reopen after model reply, tool fence, tool reply and
   observation ACK boundaries; distinguish indeterminate from complete replies.
3. Cumulative turn/tool/token/cost and wall budget exhaustion survives reopen.
   Missing required usage, corrupt/inconsistent checkpoints, changed input,
   invalid Memory projection and identity/model/Skill drift stop before I/O.
4. Restore/cancel/timeout receipt races, same runId in separate Channels,
   contiguous sequence, no duplicate Memory/readiness/initial-input events,
   unknown replies not replayed, and actual worker cleanup remain observable.

Implement one observed RED at a time; do not pre-write the whole matrix.
Final gates: focused real SDK suites, independent Standards and Spec review on
one source fingerprint, clean runtime identity, worker and workspace typechecks,
full JavaScript/Python regressions, web/service build, public-preview and
dependency checks, then commit/push and exact-SHA GitHub CI. Report real Provider,
Windows/Linux, packaged Desktop and official benchmark evidence as still open.
