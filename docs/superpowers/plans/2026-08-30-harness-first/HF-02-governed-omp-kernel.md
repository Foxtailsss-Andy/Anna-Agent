# HF-02: Governed Oh-my-Pi Kernel

Date: 2026-08-30
Status: design draft; independent review and prerequisite verification pending.
Implementation base: record the accepted HF-01B commit before coding.
Spec: [HF-SPEC-1.0](../../../product/anna-harness-first-spec-2026-08-30.md), HF-020..025.
Goal: [HF-GOAL-1.0](../../../product/anna-harness-first-goal-2026-08-30.md).
Coder: GPT-5.6-Luna Max. Review: GPT-5.6-Sol Ultra, independent axes.

## Outcome

An explicitly selected Oh-my-Pi adapter actually runs the pinned upstream
inside a managed worker. The Anna Host remains the authority for admitted
profiles, Context/Memory, tools, effects, events, budgets and terminal Eval.
An unavailable or mismatched worker fails explicitly, without a Pi/Python
fallback. Installing a package or passing a fake-worker test is insufficient.

This ticket does not switch the default Desktop Runtime, add broad coding
tools, enable native Plugins/MCP/Memory, or delete Python execution. Those
remain HF-04..HF-10 work. An incomplete capability stays unavailable.

## Dependency Decision

The proposed install target is the published
`@oh-my-pi/pi-coding-agent@18.0.11`, with the integrity recorded in the
[upstream preflight](../../handoff/2026-08-30-hf-02-upstream-preflight.md).
The registry provenance statement names source
`b8ce33a58911c26bed1d84f0db9a5e2e727c49a2`; the original inspected
`51f0380` is a later source revision, not the installed package identity.

The isolated preflight verified the archive, registry signatures and source
statement, plus six critical source-file hashes. It has not executed OMP or
verified optional native artifacts. Retain these distinct evidence scopes.
Review the changed provider paths between source revisions and lock the exact
transitive dependency graph used by the worker. No floating Git branch or
global install. Preserve upstream license notices.

The full audit-only lock graph has five high findings in unused optional
inference dependencies; the installed non-optional tree is clean. Freeze the
minimal shipped tree explicitly, including the required platform native package,
and verify actual imports without omitted Memory/audio backends. Do not use an
audit exclusion to claim that the full graph is clean or skip native validation.

Candidate managed Bun is `1.3.14`, with per-platform archive digests from the
official release. A supported target needs local binary/hash and native-loader
evidence, not just an upstream platform declaration. Keep worker dependencies
and native assets outside the Electron/Host Node bundle and user HOME.

## Contract To Freeze Before Implementation

1. Add a versioned kernel descriptor to new effective RunProfiles: adapter ID,
   package/version, exact source mapping, protocol version and runtime artifact
   identity. Include it in the validated snapshot/hash. Preserve old stored
   snapshots and their original hash; never reinterpret a historical Pi Run
   as OMP. The exact legacy/new-schema parser cases are public RED tests.
2. Use one Host-owned configuration selector for new admission. The proposed
   private configuration key is `harness_v2_kernel`, with explicit `pi` or
   `omp`. Until HF-09, absence preserves the existing preview default. Invalid
   values or an explicit unavailable OMP selection fail before model/tool I/O.
   Store the resolved choice in the RunProfile, not only in environment/logs.
3. Only `packages/omp-loop-kernel` imports upstream packages. Its Node adapter
   implements the existing LoopKernel; the Bun worker owns the SDK instance.
   The Host loader stays provider-independent and is reused from HF-01B,
   without a second Memory repository or snapshot protocol.
4. Freeze a bounded worker protocol before its first implementation: schema
   version, Run/command/profile identity, request correlation, ordered frames,
   size limits, ACK/error meanings and disposal. Protocol stdout is separate
   from bounded diagnostics. SDK prompt ACK and nonterminal agent-end events
   cannot become a successful Anna Run.
5. The worker receives explicit model/auth, cwd/agentDir, isolated settings,
   in-memory session, Host Context/Skills and allowed proxy tools. Disable
   ambient context, extension discovery, native commands, native MCP/LSP,
   native Memory/reflection and auto-learning. Pass an environment allowlist
   and dedicated HOME/USERPROFILE/XDG/cache/temp directories. Do not inherit
   arbitrary process environment or user credentials through discovery.
6. All tool requests return to the real scoped durable ToolGateway. Worker
   builtins cannot read/edit/search/execute as a bypass. Preserve tool-call and
   effect identity, failed/approval/unknown outcomes and cancellation. Tests
   must observe zero dispatch for undeclared tools and hostile ambient files.
   HOME redirection alone does not establish OS containment; claim only the
   actual tested isolation boundary and keep unsafe capabilities unavailable.
7. Keep `start`, `steer`, `answer` and `abort` meanings explicit. Resume is
   `start` with the stored command and readable durable sink, not a new
   public `resume` method. Upstream has no interchangeable generic answer RPC:
   freeze the pending-request mapping or necessary narrow Host contract
   amendment before coding it. No advertised-but-ignored control operation.
8. Restore from canonical Host history and the HF-01B input checkpoint, with
   original model/profile/Skill/kernel fingerprints and cumulative budgets.
   Upstream session state is a validated disposable representation, never an
   independent source of product truth. Do not refresh Memory for the same Run
   or replay an unknown effect while constructing a fresh worker.
9. Abort, timeout, worker exit and Host shutdown settle all pending operations.
   Apply remaining budgets across loading/worker startup/model/tools. Stop
   intake, await SDK disposal, and escalate bounded process-tree termination.
   Change production `close()` and callers to await worker/Run settlement before
   closing SQLite. Do not silently discard pending effects or Eval events.

## Owned Files

- New `packages/omp-loop-kernel/`: Node adapter, worker protocol/entry, locked
  runtime dependency manifest and focused public conformance tests.
- `packages/harness-v2/src/run-profile.ts`, its exports and profile/schema tests:
  only kernel identity/versioning and historical-snapshot compatibility.
- A shared prepared-input type only if needed to keep the Host/adapter boundary
  neutral. Do not duplicate HF-01B hydration or introduce a generic event writer.
- `apps/harness-service/src/production.ts`, `main.ts` and matching tests:
  selection, actual worker composition, capability diagnostics and shutdown.
- Root/service manifests, lockfiles, build configuration, a managed-runtime
  preparation script and package smoke: only worker dependency/artifact handling.
- Focused adapter/runtime packaging docs, dependency notices and this handoff.

No Legacy feature edits, broad UI refactor, business connector, native Plugin
enablement or global machine installation. EventStore/Eval/LoopKernel contract
expansions require a demonstrated RED and a recorded ownership amendment.

## Vertical RED Sequence

1. Production selection with a missing managed OMP runtime fails explicitly and
   performs zero Pi/model/tool I/O. Add
   `apps/harness-service/test/kernel-selection.test.ts`; current production has
   no selector. This is a behavioral unavailable-path RED, not an import error.
2. New kernel identity survives profile validation/hash/persistence; mismatch
   and historical snapshot reinterpretation fail before model dispatch.
3. The actual verified upstream worker completes a controlled model/tool/model
   cycle through the real Gateway and scoped SQLite Store. Deterministic local
   provider transport is allowed, but a fake worker cannot satisfy this case.
4. Ambient context/config/Skill/Plugin/Memory and native tool traps perform zero
   unauthorized reads, dispatches or side effects. Test the actual worker and
   declared containment boundary, including native cache paths.
5. Steer/answer/abort and restore use the same enabled-adapter conformance cases;
   early cancellation, lost replies, malformed frames, worker loss, cumulative
   budgets, pinned input and unique terminal/Eval ordering remain observable.
6. Package preparation verifies exact archives/native assets and runs the worker
   from packaged paths. Record each actual OS/architecture separately; an
   unsupported target is unavailable and remains a full-Goal blocker.

Each slice follows observed RED, minimal GREEN, focused regressions and review.
Do not prepare all hypothetical tests before the first real production tracer.

## Exit And Evidence

HF-02 is accepted only after dependency identity, actual upstream execution,
governed tools, all five required `start`/`steer`/`answer`/`abort`/restore
behaviors, isolation and lifecycle
evidence are reviewed on one fixed integration revision. Run related typechecks,
all existing Node/Python regressions, builds, privacy/dependency checks and the
relevant package smoke. Retain failures and evidence-mode distinctions.

The handoff must separately state deterministic transport, real provider,
packaged runtime and platform evidence. Full Desktop cutover, live business
approval/readback and official SWE-bench remain their own gates. No total Goal
completion or benchmark readiness claim follows from this ticket alone.

## Design Review Checkpoint

Sol Ultra reviewed this draft on 2026-08-30. Before the first selector/profile
slice, freeze the exact new/legacy snapshot shape and hash rules, plus the
selector truth table and typed unavailable result. The absent selector means
Pi inside the optional v2 Host, not a change to the Desktop Runtime. Resume
must follow the original admitted snapshot rather than the current selector.

The later worker slices must freeze their frame/answer protocol, shipped native
dependency graph, actual OS isolation boundary and shutdown ordering before
their implementation. These later details do not block a narrowly frozen
selector/profile slice, but unavailable controls or unverified platforms cannot
close the whole HF-02 ticket or the full Goal. This draft alone authorizes no
unfrozen worker implementation.
