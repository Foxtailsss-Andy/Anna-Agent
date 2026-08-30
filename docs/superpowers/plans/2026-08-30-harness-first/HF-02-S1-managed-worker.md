# HF-02 S1: Actual Governed Worker

Date: 2026-08-30
Status: locally accepted on 2026-08-31; fixed-source Standards/Spec review and
integrated gates passed. GitHub publication/CI pending. See
[implementation evidence](../../handoff/2026-08-30-hf-02-s1-runtime-materialization.md).
Implementation base: `991394b52c6c167d9dd56d50cd4f71f629526a58`.
Parent: [HF-02](HF-02-governed-omp-kernel.md).
Evidence inputs: [runtime preflight](../../handoff/2026-08-30-hf-02-runtime-preflight.md).
Coder: GPT-5.6-Luna Max. Independent review: GPT-5.6-Sol Ultra.

## Actual Outcome

Run the pinned Oh-my-Pi SDK in a managed Bun worker through the production
LoopKernel boundary. A successful first tracer is model/tool/model execution
through the real Host Gateway and SQLite, not an alias to the reference Pi.
S0 identity/selection alone cannot satisfy this outcome.

The first execution target is the verified macOS arm64 runtime. Other targets
remain explicitly unavailable until their artifacts and execution are verified.
This is not the full HF-02 exit: all five controls, restart/restore, package
validation and full isolation remain required by the parent ticket.

## Ownership and Isolation

- `packages/omp-loop-kernel` owns the Node adapter, bounded worker protocol and
  Bun SDK entry. Only that package imports OMP. The core/Host remain neutral.
- One worker owns one admitted Run attempt. Bind the complete Workspace,
  Channel, Run and attempt identity at spawn; Run ID alone is not a map key.
- The Bun worker has no provider/MCP credentials and no network. It receives
  only the Host's prepared prompt, fixed model metadata and governed proxy
  tool definitions. Node Host performs authorized model transport and Gateway
  calls. Provider-internal retries must not bypass request accounting.
- Use explicit isolated settings/auth/registry/session/context/Skills and
  disable ambient discovery, native Memory/autolearning, title generation,
  background model discovery, retry/fallback, unexpected-stop retries,
  compaction, advisor, Goal/async work and native tool execution.
- Temporary caches/logs are disposable per-attempt data. No upstream session
  file becomes canonical state. Reuse the HF-01B Host snapshot and original
  input/identity, rather than implementing a second Memory loader.

The existing sandbox experiments only prove a limited user-home read guard,
write scope and loopback denial. Select and test the full execution boundary
before claiming complete isolation; no sensitive directories may be exposed
merely to make an upstream startup probe pass.

The initial macOS launcher uses `/usr/bin/sandbox-exec` with fixed argv and
three private pipes, no shell or inherited extra descriptors. Resolve all
paths before constructing policy. Deny network, process-fork and process-exec
except the initial exact Bun executable. Deny all filesystem writes except a
new per-attempt `0700` directory. Deny file-data reads under user homes,
`/Volumes`, temporary-user storage, the caller workspace and Host state,
except the exact read-only runtime/entry roots and attempt directory. Redirect
HOME/USERPROFILE/XDG/TMPDIR/cwd to the attempt directory, using a minimal
environment without credentials. No allowed writable root may contain a
read-only runtime root. Do not fall back to bare Bun if policy application fails.

This limited policy must pass real canary tests for protected reads, symlink
escapes, runtime writes, allowed temporary writes, child-process creation and
network server-side zero connections before the SDK tracer is enabled. It
still permits system reads outside protected roots and has not proven all IPC
containment. Keep that limitation explicit and restrict execution to the
declared built-in proxy session; arbitrary Plugins/native execution remain
unavailable. Full HF-024 isolation remains a parent-ticket gate.

## Protocol

Use a versioned newline-delimited JSON protocol over private child-process
pipes. Each frame carries the captured scope, Run, attempt ID, request ID and
monotonic worker sequence. Host durable sequence is separate and Host-owned.
Frames are UTF-8 JSON lines, limited to 1 MiB including the newline. Each side
has a 4 MiB queued-output limit and 64 outstanding receipt limit. Exceeding a
limit fails the attempt; it does not drop evidence. Model requests and tool
requests each have at most one in flight. These are protocol safety limits,
not a two-turn Run limit: later sequential model/tool cycles remain possible
within the admitted Run budget.

Every envelope has exactly `protocol: "anna-omp/1"`, `kind`, `frameId`,
`requestId`, `binding` and `workerSeq`, plus its kind-specific payload below.
Binding is `{workspaceId, channelId, runId, attemptId, commandId, profileHash}`.
Identifiers are nonempty strings of at most 256 UTF-8 bytes. The worker emits
strictly increasing safe-integer sequence numbers starting at zero. Host
responses echo the triggering sequence and request ID; unsolicited abort uses
the most recently accepted sequence. Canonical EventStore sequence numbers
and event IDs are always assigned by the Node adapter, never by the worker.
Host `start` uses bootstrap sequence -1 and its own request ID. Before ready,
abort uses that same request ID and -1. Worker `ready` is sequence zero and
echoes the bootstrap request ID; prompt execution waits for its Host receipt.
Only ready/event frames enter the receipt queue. `throughWorkerSeq` means all
receipt-required frames received up to that sequence are acknowledged; model,
tool and terminal frame sequence gaps are explicitly skipped. `forFrameId`
is the primary ACK correlation key, not an assumption of dense event numbers.

| Direction/kind | Payload |
| --- | --- |
| Host `start` | `input`: rendered system prompt, original goal, admitted model ID, allowed proxy definitions, snapshot digest, original execution fingerprint |
| Worker `ready` | `runtime`: actual Bun and OMP version, active tool names; Host compares against its validated installation |
| Worker `event` | `event`: a typed SDK observation, restricted to message end, turn end or nonterminal progress; no worker-supplied canonical envelope |
| Host `receipt` | `forFrameId`, `accepted: true`, `throughWorkerSeq`: highest consecutively persisted worker event watermark |
| Worker `model.request` | `modelId`, `context`: the actual text/tool-call/tool-result context received by the custom SDK transport |
| Host `model.delta` | `index`: monotonically increasing per-request index, `delta`: text or tool-call argument fragment |
| Host `model.end` | `index`, `message`: validated final assistant response with stop reason and optional provider-reported usage |
| Host `model.error` | `index`, `code`: `transport_failed`, `budget_exhausted`, `cancelled` or `protocol_failed`; ends the request without fabricating a response |
| Worker `tool.request` | `toolCallId`, `name`, `input`: JSON value; scope and effect identity are constructed by Host |
| Host `tool.result` | original Gateway `status` and optional `output` |
| Host `abort` | bounded reason code, no credentials or arbitrary diagnostic text |
| Worker `terminal.proposed` | `outcome`: completed, failed, timed_out or cancelled; no canonical terminal event |

The neutral text-only message schema accepts user text, assistant text/tool
calls and tool-result text with stable toolCallId. It excludes images, opaque
provider payloads, executable values and model/auth/endpoint overrides. JSON
tool schemas are Host-owned; the worker cannot redefine their parameters.
Reject unknown envelope fields and unsupported message kinds. Public receipts
contain provenance/digests, not prompt or Memory bodies; private transcript
events retain the established HF-01B privacy boundary.

Freeze the text-only payload types as follows. All records are closed; arrays
are additionally bounded by the frame byte limit. Finite nonnegative numeric
usage fields are accepted only when reported by the Host transport.

```typescript
type Content = {type: "text"; text: string}
  | {type: "toolCall"; id: string; name: string; arguments: JsonValue};
type Usage = {input?: number; output?: number; cacheRead?: number;
  cacheWrite?: number; cost?: number};
type Assistant = {role: "assistant"; content: Content[];
  stopReason: "stop" | "length" | "toolUse"; usage?: Usage};
type Message = {role: "user"; content: string}
  | Assistant
  | {role: "toolResult"; toolCallId: string; toolName: string;
      content: string; status: "succeeded" | "failed" | "unknown"};
type Context = {systemPrompt: string; messages: Message[]};
type Delta = {type: "text"; contentIndex: number; text: string}
  | {type: "toolCall"; contentIndex: number; id: string;
      name: string; argumentsDelta: string};
type Observation = {type: "message_end"; message: Message}
  | {type: "turn_end"; modelRequestId: string}
  | {type: "progress"; phase: "started" | "tool_started" | "tool_finished"};
```

Indexes are safe nonnegative integers; message/tool IDs follow the envelope
identifier bound. Reject tool-call arguments that are not JSON objects. Delta
indexes begin at zero per request and increment by one, including the terminal
end/error frame; an end or error occurs exactly once. Worker SDK observations
must match the Host-returned model/tool result, and cannot add usage. SDK-only
timestamps/metadata are omitted by a typed adapter, not serialized wholesale.
`model.error` latches failure/abort and fails the actual SDK event stream; it
cannot become a normal assistant answer or authorize another request.

Duplicate worker requests are protocol faults, including identical duplicates:
the transport is a private reliable pipe and never retries dispatch. An exact
duplicate Host receipt for an already acknowledged frame is a no-op; changed
duplicates, unknown response IDs and old-attempt responses fail the attempt.
Once abort/failure is latched, late replies are ignored and cannot reopen gates.
Receipt wait and worker startup each have a 10-second ceiling, further bounded
by the remaining Run wall budget. Disposal gets 2 seconds before SIGTERM and
1 additional second before SIGKILL; wait for child close before deleting its
temporary directory or closing the owned Store.

Required frame families:

```text
event -> receipt
model.request -> model.delta / model.end
tool.request -> tool.result
abort
terminal.proposed
```

Model transport uses a non-reserved custom API inside OMP. Return an actual
upstream AssistantMessageEventStream and pump Host responses; do not register
over a reserved provider API. The Host validates the model request against its
admitted policy rather than trusting worker-supplied provider settings.

Reject wrong scope/attempt, uncorrelated responses, malformed/oversized frames,
unknown request types and terminal proposals with pending work. Explicitly
classify safe duplicate ACKs versus protocol faults; never accept old-attempt
responses after restart. Diagnostics must not be mixed into protocol stdout.

## Durable Execution Barriers

OMP subscribers do not await async callbacks. A callback synchronously enqueues
its event; a single Node appender persists canonical events and sends receipts.
Do not pretend that `await sink.append()` inside a subscriber blocks the loop.

1. Before actual model transport, persist an explicit dispatch-intent event and
   await its receipt plus prior required event persistence. The model hook runs
   before some turn events, so flushing the existing queue is insufficient by
   itself. Every transport attempt is accounted for by Host budget policy.
2. Custom tool execution waits for the real Gateway result, including durable
   policy/approval/effect handling. Preserve success/failed/unknown semantics.
   A callback throw alone is insufficient: OMP may turn it into a normal tool
   error and continue. Protocol/persistence failure latches the attempt failed,
   aborts the SDK, and permanently closes later model/tool gates.
3. Worker completion is only a terminal proposal. Worker first waits for all
   required receipts and zero pending model/tool requests. Host rejects an
   early proposal, applies Contract Eval to a valid proposal, and appends one actual
   terminal. RPC ACK, prompt boolean, exit zero or nonterminal agent-end cannot
   independently authorize success.

Cancellation first blocks new intake, then requests SDK abort/disposal and
awaits bounded settlement. Host escalates process-tree termination on timeout
and closes pipes/requests. Already persisted success/unknown effect outcomes
remain authoritative; cancellation is not a rollback or permission to replay.

## First Public Tracer and Negatives

Through the actual adapter and real SQLite/Gateway, the Host's deterministic
transport returns one tool call, observes the real tool result, then returns
text. Verify actual Bun/OMP identity, exact request/tool counts, canonical
scope/order, input receipts, pre-terminal Eval and clean worker exit.

Then add vertical negatives: delayed/rejected receipt blocks transport/tool
dispatch; pipe failure cannot complete; late response after abort is ignored;
same Run ID in different Channels remains isolated; old-attempt ACK is invalid;
pending requests prevent success; undeclared native tools perform zero I/O.
These are deterministic transport tests, not live provider evidence.

## Prepared Input and Transport

Move only the structural prepared-input contract into `@anna/harness-v2`:
`PreparedRunContext` contains `context`, `memoryHits`, `snapshotDigest` and
`originalExecutionFingerprint`, matching existing Host/Pi fields. Keep legacy
Pi type exports as aliases. The Host loader and private projection remain the
only Memory loader/snapshot implementation. Do not move Pi lifecycle code into
the neutral core or import the Pi kernel from the OMP adapter.

The Node OMP adapter renders system text deterministically from the fixed
worker instructions, approved Skill contents and clearly delimited untrusted
Memory. The original goal is the sole initial user message. Persist the exact
rendered-input digest in `run.context.ready` before worker model dispatch.
Separately digest every actual custom-transport request after SDK transforms;
validate model/tool names, message roles and correspondence with committed
transcript and Gateway results. A worker cannot authorize extra tools or change
the original Run policy by sending a different context.

HostModelTransport is a Node callback taking the admitted model, validated
neutral context and AbortSignal, returning an async iterable of neutral deltas
and one final assistant message. The production implementation owns the
configured HTTPS endpoint/key and performs one bounded provider request without
automatic retries. A request intent is persisted before invoking the callback;
persist provider-reported usage before acknowledging completion. Missing usage
stays unknown, never reported as zero. If a required token/cost ceiling cannot
be safely enforced with the available response, stop with an explicit failure.
The deterministic callback is allowed only in tests; no fake response is wired
into production. The worker's SDK-required numeric placeholders are not
canonical usage or pricing evidence.

Only `read_only` is enabled for the first general-profile tracer. Other tools
must be fully proxied before their profile is admitted; unsupported profiles
are unavailable, not silently reduced. The production selector routes an
admitted OMP profile to the actual worker when its verified runtime is ready.
Missing runtime remains the S0 unavailable result. Pi remains unchanged.

## Distribution and Identity

Worker dependencies live under `packages/omp-loop-kernel/runtime/`, with their
own private package manifest and lock, outside the root workspace dependency
graph. Pin OMP and the macOS arm64 native package to exactly `18.0.11`; no caret
or runtime installation. Materialize with locked npm installation, scripts
disabled and unrelated optional packages omitted. Verify the installed graph,
native import and preserved licenses; the earlier audit-only lock is evidence,
not the shipping lock. Do not reference `.tmp-tests` from product code.

A preparation script materializes immutable runtime resources under ignored
`build/omp-runtime/darwin-arm64/`: the verified Bun 1.3.14 binary, locked
dependencies and worker entry. It emits a sorted file manifest (path, byte
length, SHA-256), validates it before spawn and rejects links escaping the
runtime root. The reviewed release constants come from the runtime preflight;
downloads and installation happen only in explicit preparation, never during
a user Run. A clean build must reproduce the dependency lock and all selected
artifact identities. Native and Bun hashes must match the recorded release
bytes, not merely the filename or reported version.

The Bun archive digest remains
`d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620`.
The independently hashed extracted executable is
`e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233`;
record the latter as Bun binary identity. Runtime manifest entries exclude the
manifest itself, generated descriptor and disposable caches. Sort normalized
relative paths lexically, encode compact UTF-8 JSON with ordered fields
`path`, `bytes`, `sha256`, and hash those exact bytes. Reject duplicate paths,
absolute paths, traversal and links outside the root. The descriptor binds the
manifest digest and is excluded from its own hash to avoid self-reference.

Extend the S0 descriptor as an explicit discriminated union. The OMP member
retains schemaVersion 1 and adapter source identity, with adapterId `omp`,
packageName `@anna/omp-loop-kernel`, protocolVersion `anna-omp/1`, upstream
package/version/sourceCommit/integrity, and runtime platform/arch/Bun version,
Bun SHA-256, native SHA-256, dependency-lock SHA-256 and runtime-manifest SHA-256.
Use closed parsers, lowercase hex digests and the exact known source mapping.
Existing Pi and absent-kernel snapshots/hashes stay byte-compatible. All OMP
identities participate in the immutable RunProfile hash before admission.

## Controls and Recovery Boundary

Keep the full scope/Run/attempt key internally. The admitted AbortSignal always
targets its own worker. RunId-only `abort` must reject ambiguous matches rather
than select an arbitrary Channel. `steer` and `answer` remain explicitly
unavailable in this first slice until their scoped routing is implemented.
Consumed OMP resume is also unavailable until canonical-transcript restore is
implemented; never restart it as a new prompt, reinterpret it as Pi or refresh
Memory. These are open HF-02 requirements, not removed acceptance criteria.

## Owned Files and Public Tests

- `packages/omp-loop-kernel/`: Node adapter, protocol, provider transport,
  managed launcher, Bun entry, runtime manifest/lock and focused public tests.
- `packages/harness-v2/src/kernel-descriptor.ts`, `run-profile.ts`, exports and
  relevant tests: OMP descriptor union and neutral prepared-context types only.
- Existing Host/Pi prepared-context type declarations: alias-only migration.
- `apps/harness-service/src/production.ts`, selector and corresponding tests:
  explicit OMP admission, actual adapter/model/Gateway composition and awaited
  shutdown. Existing Runtime/Eval behavior remains the production authority.
- Root/service manifests and build/preparation scripts: package wiring,
  isolated worker resources and focused test/typecheck commands only.
- `.gitignore`, relevant handoff and this ticket: generated runtime exclusion
  and exact evidence. No Legacy/UI/business-connector edits.

The first failing public test goes through production composition, actual Bun
and SDK, real SQLite, Host loader and production Gateway with deterministic
Host model transport. It must reach two model requests and one real read, with
the expected tool content in the second request, required Eval before terminal,
one terminal and child exit. A missing module or fake worker is not its RED.
Then add the listed negative cases one at a time. Freeze the selected launcher
policy with independent review before executing actual user input. No broad
Store or control-contract amendment is authorized without a concrete RED.
