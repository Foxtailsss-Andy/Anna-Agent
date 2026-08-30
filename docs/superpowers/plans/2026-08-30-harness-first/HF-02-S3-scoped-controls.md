# HF-02 S3: Scoped OMP Controls

Status: design frozen after independent review; coding waits for accepted S2.
Implementation base: the accepted S2 commit, still pending its final gates.
Parent: [HF-02](HF-02-governed-omp-kernel.md).
Contract: [HF-SPEC-1.0](../../../product/anna-harness-first-spec-2026-08-30.md),
HF-021, HF-025 and HF-033.
Coder: GPT-5.6-Luna Max. Independent review: GPT-5.6-Sol Ultra.

## Outcome

Through the production Host API, a Human can steer an active actual OMP Run,
answer a specific durable question after a restart, or cancel the scoped Run.
Controls preserve the original command, profile, Memory snapshot, tool/effect
identities and cumulative budgets. An accepted control is durable; it is not
claimed consumed until the actual SDK observation or matching Host settlement
proves that consumption. No control is silently ignored.

Human input follows durable suspension, canonical answer and continuation of
the same Run. It does not keep an unbounded worker/tool Promise alive while
waiting for a person. OMP session state remains disposable.

This slice does not implement product UI, authenticated Actor/Owner identity,
MCP approval, dynamic permission grants, new coding tools, native discovery,
Desktop cutover or Legacy removal. Existing local Host scope checks still apply.
`actor_id` is a local declared attribution, not verified authentication.

## Public Boundaries

Use the existing production start, events and resume interfaces and add:

```text
POST /v2/surfaces/:surface/runs/:runId/steer
POST /v2/surfaces/:surface/runs/:runId/answer
POST /v2/surfaces/:surface/runs/:runId/abort
```

All three bodies require `workspace_id`, `channel_id`, `control_id` and
`actor_id`. Steer also requires `content`; answer requires `request_id` and
`content`; abort requires `reason`. Bodies are closed, bounded JSON records.
Use the existing 1 MiB body/frame limit and reject required-field or encoding
violations before acceptance. No permission/profile fields are accepted.

The 202 receipt is a closed record:

```typescript
type ControlReceipt = {
  surface_id: string;
  run_id: string;
  control_id: string;
  operation: "steer" | "answer" | "abort";
  status: "accepted";
  event_id: string;
  request_id?: string; // answer only
};
```

Identical retries return the same receipt, including its event ID. This is
acceptance, not a promise that cancellation cannot prevent consumption. Events
expose actual consumption or the terminal not-consumed disposition. Use 400 for
malformed input, 404 for an unknown scoped Run/surface, 409 for
`control_conflict`, `run_settling`, `run_terminal`, `input_not_pending`,
`run_not_active` or `control_unavailable`, and the existing typed 503 kernel
identity/unavailability body for new execution. Storage failures never return
an accepted receipt. Preserve existing start/resume response contracts.

The Host loads the admitted command from that Channel scope and validates the
route surface and original kernel. A control cannot provide replacement
profile, model, Skill, Memory, budget or permission fields. An unavailable
operation fails explicitly and is advertised as unavailable.

Control identity is `(workspace, channel, run, controlId)`. An identical retry
returns the original durable receipt. Changing its kind, actor, request or
content conflicts. Accepted retries remain readable after completion; they
must not launch another worker or append another control. A new control after
final settlement is rejected. A request in another Channel cannot cancel,
steer or answer this Run, even when both Channels use the same Run ID.

LoopKernel controls take `RunControlContext = { command: StartRun; sink:
DurableEventSink }`, constructed by the Host, replacing unscoped Run-ID lookup.
Their second argument contains `controlId`, `actorId` and the operation fields.
Their existing `Promise<void>` means durable acceptance, not SDK consumption;
the Host derives the HTTP receipt from that accepted canonical event. A missing
event cannot yield 202. This is a deliberate narrow contract amendment.
Existing Pi callers must remain explicitly compatible or fail unavailable;
request-correlated answer cannot degrade into plain steer.

## Ordering And Receipts

One Host-owned per-Run mutation order covers control admission, sequence
allocation, SDK observations and kernel settlement. No HTTP handler performs
an independent read-next-sequence-append operation.

Do not put control admission behind a Promise waiting for a complete provider
stream or tool execution. Abort must remain actionable during those waits.
Keep the mutation boundary short, and preserve all S2 observation/checkpoint
ACK fences before subsequent execution.

Distinguish durable acceptance from actual consumption. Restore resends only
unconsumed steering controls and uses only a matching canonical answer for a
pending question. Changed duplicates, stale attempts and invalid correlation
fail closed. Real messages and their consumption records are validated
together; transport delivery alone is not consumption.

For a validated matching active Run, abort signals its controller promptly;
it does not wait behind the provider operation. Acceptance is still reported
only after its audit append is acknowledged. A rejected/failed append cannot
be reported as accepted merely because safety cancellation occurred.

Kernel settlement closes new control admission and drains admitted mutations
before `start` returns. Contract Eval then owns the terminal tail. A control
arriving in the transition cannot append outside that ownership boundary.
The worker waits for a correlated Host terminal decision before disposal.
In the same short mutation order, a completed proposal with accepted but
unconsumed steer receives `continue`: resend its original control ID and let
actual SDK continuation consume it, then propose again. With no such control,
close admission atomically and return `commit`. Cancel/timeout need not consume
pending steering, but record `not_consumed` with the stop reason. Recovery must
not take the S2 completed-assistant shortcut while an accepted steer remains.

During kernel return/Contract Eval, inactive answer fails `run_settling`.
After durable suspension and drive settlement, the same scoped mutation owner
accepts it; the Runtime does not create another sequence allocator or writer.

## Actual Steering

Use the pinned public `session.agent.steer` with an explicitly constructed
neutral user message. Do not call the higher-level prompt-template expansion
API. Configure interruption to wait for the current tool batch, preserving
the real Host replies for already admitted sibling calls.

An accepted steering message is correlated with the actual SDK observation
and appears once in canonical history and the next authorized model context.
The Host validates its original text and control identity. Upstream synthetic
skipped/aborted tool results do not become Host tool evidence.

Use these closed version-1 payloads in the canonical scoped Run envelope:

```typescript
type SteerAccepted = {
  schemaVersion: 1; controlId: string; actorId: string; content: string;
}; // run.steer.accepted
type InputRequested = {
  schemaVersion: 1; requestId: string; toolCallId: string;
  dispatchEventId: string; inputDigest: string; question: string;
}; // run.input.requested
type InputAnswered = {
  schemaVersion: 1; controlId: string; actorId: string; requestId: string;
  requestEventId: string; toolCallId: string; content: string;
}; // run.input.answered: the answer acceptance event
type AbortRequested = {
  schemaVersion: 1; controlId: string; actorId: string; reason: string;
}; // run.abort.requested
```

A steering `omp.transcript.message` user observation includes `controlId` and
`acceptedEventId`; one append records the message and its consumption. Do not
create a second writer or duplicate user event for consumption. Validate exact
acceptance reference/text/order before authorizing the next model. Answer
consumption is its matching response/observation checkpoint, backed by the
unique answer event. Abort consumption is matching Host cancellation
settlement, not an invented SDK message.

## Questions And Answers

Introduce only `ask_human({question})`, explicitly admitted in the original
RunProfile and executed through Host Gateway validation and policy. Allow at
most one pending question per Run. The Host generates the request ID and binds
it to scope, Run, tool-call ID, dispatch event and input digest.

A question is durable before a tagged suspension leaves the Gateway. It is
neither a failed nor a successful tool result. Stop and clean up the worker,
then return `awaiting_input`. Pending state is readable through the canonical
event interface; no private SDK session or infinite pending Promise is the
question authority.

Keep the existing three-status `ToolResult` and Sandbox/effect result contracts.
Only `ToolGateway.execute` gains the union with
`HumanInputSuspension = { status: "awaiting_input"; requestId: string;
requestEventId: EventId }`. After catalog/schema/scope/policy validation, a
narrow Host human-input port persists the request through the same Run writer.
It does not enter Sandbox/effect execution or the ordinary `terminalResult`.
Without that configured port, do not advertise or admit `ask_human`.

Answer must match the sole unresolved human-input request. Persist the answer
before forming the matching tool-result checkpoint or continuing the SDK.
Continuation uses the original tool-call identity and answer text, without
re-running the question tool or re-submitting the initial goal. Approved human
input is ordinary task data and does not grant additional tool permissions.
Approval/effect requests remain separate and cannot be answered through this
operation.

A narrow, read-only resolver in the Host/Gateway human-input module validates
the scoped request, unique canonical answer and exact expected dispatch/call/
input binding. The OMP restorer supplies that binding only after its existing
authorizer/checkpoint validation. The generic Harness/Gateway must not import
OMP or duplicate its private transcript parser. A valid answer resolves to
`{ status: "succeeded", output: { requestId, answerEventId, content } }`;
success means obtaining that actual Human answer, not completing the Run.
Persist this result once as the original call's `omp.tool.response`, then use
S2 observation repair/SDK continuation. Do not call `ask_human` again or charge
another dispatch. Missing or inconsistent evidence cannot synthesize a reply.

Only a matching durable human-input request permits recovery of its suspended
dispatch. A dispatch fence without a provable human request or reply retains
S2 indeterminate-recovery behavior. Corrupt/missing questions or answers stop
before new model/tool I/O. Answer submission must also work without an active
worker, including SQLite close/reopen, and drive existing Runtime resume.

An unanswered resume remains suspended without launching a worker or adding
another suspension/Eval. Each actual suspension and final settlement follows
the existing pre-settlement Eval order. There is one final terminal for the
whole Run; `awaiting_input` is recoverable suspension, not final completion.

Only the question is durable before Worker suspension. Preserve the order
`question ACK -> execution stop/synthetic-message suppression -> suspension
proposal -> Host commit -> Worker disposal/cleanup -> kernel awaiting_input
return -> Contract Eval -> durable run.awaiting_input`. Keep Worker input and
output available for the proposal/decision handshake. Do not bypass Eval by
writing an earlier awaiting event or save SDK abort-generated tool messages.

## Worker Amendment

Retain `anna-omp/1`, its closed neutral schemas, existing frame bounds and
attempt binding. Add only these Host frames:

- `control.steer { controlId, acceptedEventId, content }`: Host-initiated with
  a fresh frame/request ID; its worker sequence is the last durably observed
  causal position. Worker verifies the attempt, deduplicates identical control
  IDs and rejects changed duplicates. It calls actual `agent.steer`.
- `terminal.decision { forFrameId, decision: "commit" | "continue" }`:
  correlated with the proposed terminal frame. Commit closes admission and
  allows cleanup; continue preserves the same Run and original budget.
- `tool.suspend { humanRequestId, requestEventId }`: a correlated response to
  the current `tool.request`, separate from `tool.result`. The canonical human
  request ID is not the worker transport request ID. Worker stops intake,
  suppresses abort-generated observations and proposes suspension, retaining
  its transport until the matching Host commit. Only then does it dispose and
  finish cleanup; stopping SDK execution must not close the handshake pipes.

Steering observation metadata carries the same `controlId`/`acceptedEventId`.
Every Worker frame still gets its own strictly increasing sequence. Existing
model/tool/receipt responses keep their strict request/sequence correlation;
the new causal marker does not weaken those checks. Unknown, oversized,
cross-attempt or changed-duplicate frames remain protocol faults.

A suspension report is accepted only for the Host-authorized current question,
never from an arbitrary worker proposal. Extend the existing closed
`terminal.proposed` union with `outcome: "awaiting_input"`, `humanRequestId`
and `requestEventId`; those two fields are required only for suspension.
The Host must match its pending question before issuing commit. No pending model/tool work may be
hidden by terminal negotiation. Cancellation/timeouts settle outstanding
decisions, transports and child processes using the existing bounded cleanup.

## Budgets And Cancellation

All elapsed time, including downtime and human waiting, counts against the
original wall budget. Control acceptance cannot reset turn/tool/token/cost
accounting. Exhausted or unverifiable required budgets stop further I/O.

Abort, timeout, worker loss and Host close settle pending transports and drain
durable work before Store/ownership close. Preserve real unknown effects;
cancellation is not rollback or permission to replay. Late responses and old
attempts cannot consume a control for a different active attempt.

## Owned Area

- Harness contracts/interfaces and parsers for scoped controls, receipts and
  the narrow human-input suspension outcome.
- Existing Gateway human-input branch and its production binding only; no
  business-specific logic or broader effect-policy change.
- Service Runtime, production composition, HTTP routes and capabilities.
- OMP adapter, client, closed protocol, worker and canonical restore validation.
- Required Pi compatibility/unavailable behavior and focused regression tests.
- Per-Run lifecycle plumbing only when needed for the ordering contract above.

No canonical Store schema, dependency lock, SDK version or generic control
framework is authorized. Any required expansion needs a demonstrated public
RED and a reviewed amendment first.

## Vertical Verification

1. Public start -> actual OMP `ask_human` -> durable pending state -> SQLite
   close/reopen -> public answer -> actual SDK continuation. Assert original
   question/call/answer correlation and one consumption, not a mocked kernel.
2. Active steer through production HTTP reaches actual SDK and next model input
   once. Tool batches retain only real Gateway replies.
3. Delayed/rejected acceptance ACK, loss before/after SDK consumption, repeated
   reopen and lost question/answer/result ACKs retain accepted versus consumed
   truth without duplicate user input or tool dispatch.
4. Duplicate/conflicting controls, wrong question, cross-scope/surface, same Run
   ID in two Channels, stale attempts and terminal races reject before I/O.
5. Abort during provider/tool waits, human suspension, Eval transition and Host
   close retains continuous sequence, original budgets and one final terminal.

These are the agreed public production/LoopKernel boundaries. Use actual
pinned SDK, real scoped SQLite, Host Memory and production Gateway; deterministic
Host model transport is permitted. Label injected persistence loss separately
from real process death. No live Provider/MCP evidence is implied.

Follow one RED -> minimal GREEN at a time. Before acceptance, rebuild the
unchanged pinned runtime dependencies with the final Worker source; run the
independent Worker and local/test typechecks, all JavaScript/Python regressions,
web/service builds and publication checks. Obtain independent Standards and
Spec acceptance and verify exact-SHA CI. Parent HF-02 and the full Goal still
retain isolation, distribution and subsequent migration gates.

## Freeze Review

Independent Sol Ultra Standards and Spec reviews accepted the contract at
SHA-256 `11550d1194357282ec399e0a7bbba39349746b980fd980331d1d7c378e095442`.
Spec review first found a P2 disposal/handshake ordering conflict; the text now
requires Host commit before Worker transport disposal, and both axes verified
that correction. This status/review stamp changes documentation metadata only.

The read-only design and Luna implementation map are planning evidence, not
runtime validation. Implementation starts only after S2 acceptance and its
base commit is recorded. The first public RED is question suspension, followed
by actual answered reopen. No S3 source work has started at this freeze.
