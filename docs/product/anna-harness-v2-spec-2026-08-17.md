# Anna Harness v2 · Product and Architecture Spec

> Status: accepted for implementation planning  
> Product decision session: 2026-08-17  
> First release: macOS local developer preview

## 1. Outcome

Harness v2 enables one channel-scoped Anna to coordinate several bounded, parallel Runs while preserving channel isolation, durable evidence, human control and explicit terminal states.

The first release must complete a real product-development loop in an isolated Anna repository worktree:

```text
Product review notes
→ decision extraction
→ PRD delta
→ UI proposal and rendered screenshot
→ development patch
→ automated tests
→ Eval and human review
→ merge-ready candidate
```

The release does not push, merge, deploy or write to external business systems automatically.

## 2. Product invariants

1. Every Channel has exactly one Anna and one Channel Session.
2. Context and Memory are channel-scoped by default.
3. Parallel pipelines are Runs/Lanes controlled by the channel Anna.
4. A Run has a source, RunProfile, budget, permission scope, stop condition and terminal state.
5. Parallel Lanes submit Proposal, Artifact and Memory Candidate events; shared facts merge through one serialized projector or a Human Gate.
6. Missing evidence remains missing. Token, cost, success, Tool output and test results are never inferred.
7. All external effects pass through ToolGateway.
8. Every operation has a complete canonical event trail before it can appear as a successful product state.

## 3. Canonical objects

### Anna

The only coordinating Agent in one Channel. Anna owns channel judgment and governs Worker Profiles and Runs.

### Channel Session

The durable boundary for channel Context, Memory, authorization, schedules, Runs and Artifact references.

### Run

A bounded execution for one goal. A Run can complete, await input/approval, fail, time out or be cancelled.

### Lane

An ordered execution branch for one Run. Several Lanes may execute concurrently without directly mutating shared channel facts.

### Worker Profile

A named role configuration containing instructions, Skill access, Tool policy, Artifact contract, model policy and budget defaults. It has no independent global identity or Memory.

### Artifact

A versioned, reviewable deliverable with kind, URI/blob reference, hash, producer Run, validation status and review state.

### Memory Candidate

A provenance-bearing proposal to promote information from a Run or channel event into durable Channel Memory.

### RunProfile

A versioned policy bundle selecting Pi model configuration, context transformation, Skills, Tools, budgets, Eval policy and terminal rules.

## 4. Target architecture

```text
Electron / Channel UI
        |
        | HTTP + SSE/Event cursor
        v
Anna Control Plane (TypeScript)
  Channel Session / Scheduler / Run Manager
  Budget / Permission / Approval
  Memory Policy / Eval Gate / Artifact Registry
        |
        +-----------> Anna Event Store (Node SQLite local)
        |                    |
        |                    +--> OTel Trace projection
        |                    +--> Activity / UI projection
        |                    +--> Regression evidence
        v
PiLoopKernel adapter
  pi-agent-core Agent + pi-ai 0.84.2
  Model stream / tool protocol / steer / abort / compaction seam
        |
        v
Anna ToolGateway
  schema / scope / policy / approval / sandbox / effect / audit
        |
        v
Typed Tools and Connectors
```

## 5. Pi integration contract

`PiLoopKernel` is the only module that imports Pi packages.

```ts
interface LoopKernel {
  start(command: StartRun, sink: EventSink, signal: AbortSignal): Promise<RunOutcome>;
  steer(runId: RunId, message: ChannelMessage): Promise<void>;
  answer(runId: RunId, answer: HumanAnswer): Promise<void>;
  abort(runId: RunId, reason: string): Promise<void>;
}
```

Constraints:

- Pin `pi-agent-core` and `pi-ai` to `0.84.2` without caret ranges.
- Do not import Pi from domain, storage, Tool, Memory, Eval or UI modules.
- Disable Pi built-in tools.
- Convert Pi model/tool/message events to Anna canonical events incrementally.
- Preserve raw provider usage when reported; missing values stay absent.
- Pi session files, when used by a diagnostic canary, are not canonical product state.
- `AgentHarness v2` remains outside the release dependency until its public operations and restore path are implemented and pass Anna conformance.

## 6. Event Store

The local Event Store uses Node SQLite behind interfaces that can be reimplemented for a cloud database.

Required streams:

- Channel stream: messages, proposals, Artifact reviews, Memory decisions and schedules;
- Run stream: lifecycle, model, Tool, budget, Eval and terminal events;
- Effect stream: Tool intent, approval, execution and outcome;
- Projection receipts: idempotent Channel/UI/Artifact/Memory projections.

Every row includes `workspace_id`, `channel_id`, `stream_id`, monotonic `seq`, event type, timestamp, schema version and JSON payload.

Required guarantees:

1. Per-stream ordering;
2. idempotent command keys;
3. one terminal Run event;
4. optimistic version/fencing for projector writes;
5. cursor reads during a running Run;
6. crash-safe transaction boundaries;
7. append-only source events and rebuildable projections;
8. channel-scoped repository objects that cannot issue unscoped reads.

## 7. Run lifecycle and budgets

Run states:

```text
queued → running → completed
                 → awaiting_input
                 → awaiting_approval
                 → failed
                 → timed_out
                 → cancelled
```

Each RunProfile defines limits for:

- wall time;
- turns;
- input/output tokens;
- cost when provider usage is available;
- Tool calls;
- retry attempts;
- concurrent child Lanes.

Budgets accumulate across retry, answer, steer, compaction and restart. Reaching a limit prevents the next expensive action and emits an explicit terminal or awaiting event.

## 8. ToolGateway and Sandbox

Tool flow:

```text
Tool request
→ schema validation
→ channel and Worker Profile scope
→ policy decision
→ approval when required
→ Sandbox execution
→ effect ledger
→ Tool result event
→ Pi observation
```

Policies:

- typed read-only Tools may run automatically inside granted scope;
- file mutation is restricted to an approved isolated worktree;
- external writes require approval;
- irreversible operations require second confirmation or an explicit compensation contract;
- unknown Tool outcomes are visible and never replayed automatically;
- repeated effect keys produce at most one external effect;
- arbitrary Bash, unrestricted network and host-home access are unavailable in the local preview.

Sandbox is an interface with a deterministic fake for tests. A host path allowlist alone does not satisfy the production Sandbox contract.

## 9. Skills and RunProfiles

Skills follow the Agent Skills `SKILL.md` convention and include stable identity, version/hash, provenance and allowed Tool declarations.

RunProfile resolution combines:

- Channel policy;
- Worker Profile;
- Skill set;
- model and reasoning policy;
- Tool policy;
- Memory policy;
- budget;
- Eval and Artifact contract.

The resolved profile is snapshotted on Run creation. A running Run does not silently switch models, Tools, Skills or policies.

## 10. Memory

### Run Context

Transient working information required to continue one Run. Compaction may transform it while preserving goal, constraints, pending Tool calls and provenance.

### Channel Memory

Durable rules, decisions, preferences and project background accepted by the Channel Owner. Items are inspectable, editable and deletable.

### Workspace Memory

Optional shared knowledge. A Channel receives read access through an explicit grant; source Channel and provenance remain visible.

### Promotion

Anna may emit `memory.candidate.proposed`. Local preview requires Owner acceptance before `memory.accepted`. Failed Runs, unreviewed model claims and test fixtures cannot silently enter Memory.

## 11. Eval and Trace

Canonical events project to ADR-003-compatible OTel spans. Trace is available while a Run is active and contains model, context, Tool, approval, retry, budget, Eval and terminal evidence.

Eval layers:

1. Contract Eval: deterministic lifecycle, permission, Tool, Artifact and side-effect constraints;
2. Quality Eval: rubric-based Artifact scoring, calibrated model Judge and Human review when confidence/risk requires it.

Development sets:

- Smoke Set: 4 fixed tasks on every relevant change;
- Dev Set: 16 tasks, split between protected Regression and Capability cases;
- Live canary: the real product-iteration scenario in an isolated Anna worktree.

Every failed Trace is classified as INFRA, ADAPTER, CONTEXT, PLAN, TOOL_SELECT, TOOL_EXEC, RECOVERY, STOP, OUTPUT, MODEL or GRADER before becoming a Regression Case.

## 12. Scheduler and proactive Runs

Local preview supports:

- explicit schedules;
- unresolved-thread SLA checks;
- registered Connector events;
- waiting-node deadlines;
- user-created monitors.

Every proactive Run records trigger, target Channel, budget, permission scope, stop condition and notification audience. The local service runs with the desktop app; schedules missed while the app is closed are reported on restart and require an explicit catch-up policy.

## 13. First live scenario: Review-to-Validated-Patch

### Inputs

- real or sanitized product-review meeting notes;
- current PRD Markdown;
- current React UI and local preview URL;
- repository and documented validation commands;
- Channel members and approval owner.

### Flow

1. Product Owner posts review notes to the Channel.
2. Anna extracts confirmed decisions, open questions and constraints.
3. Anna proposes Memory Candidates with source references.
4. PRD Lane prepares a versioned PRD patch.
5. UI Lane prepares the UI change and rendered screenshot.
6. Product Owner reviews PRD/UI Artifacts and approves or requests rework.
7. After approval, ToolGateway creates an isolated Git worktree.
8. Development Lane applies the approved code patch.
9. Test Lane writes/runs relevant tests and records raw evidence.
10. Contract and Quality Eval run against the original review decisions.
11. Anna posts a merge-ready summary, remaining risks and a scheduled follow-up.
12. Human chooses whether to merge outside Harness v2.

### Real-scene evidence

- actual PRD file diff;
- actual UI source diff;
- screenshot produced from the changed UI;
- actual implementation diff;
- tests created or changed and executed;
- exact commands, exit codes and relevant output;
- one Trace connecting every Artifact to its Run and review decision;
- no writes outside the isolated worktree;
- no push, merge or deployment.

CI uses a deterministic fixture repository with the same contract. Release acceptance repeats the flow against Anna's real repository in a disposable worktree.

## 14. Release stages

### R0 · Kernel canary

Fake provider + fake read Tool; Pi events stream into Anna Event Store; steer, abort and terminal states pass.

### R1 · Durable local Harness

Node SQLite Store, restart recovery, budgets, cursor replay and unique terminal events pass.

### R2 · Controlled Tools

ToolGateway, approval, fake Sandbox and isolated-worktree file Tools pass effect/idempotency tests.

### R3 · Memory / Eval / Trace

Memory Candidate review, OTel Trace projection and release gates pass Smoke/Dev sets.

### R4 · Product iteration live canary

Review-to-Validated-Patch completes against Anna in an isolated worktree and produces all real-scene evidence.

### R5 · Desktop developer preview

Electron uses Harness v2 for the accepted surface; legacy Python path is disabled for that surface. GitHub release documentation states local-runtime limitations explicitly.

## 15. Non-goals for local preview

- app-closed cross-day execution;
- cloud multi-tenancy;
- automatic cross-channel Memory access;
- unrestricted ambient scanning;
- arbitrary shell access;
- automatic Git push, merge, release or deployment;
- Pi `AgentHarness v2` adoption;
- Crew feature development.

## 16. Migration and deletion rule

Harness v2 is built in new TypeScript modules. Existing Python code supplies black-box behavior and regression evidence only.

For each migrated surface:

1. freeze old behavior contract;
2. implement v2 path;
3. run differential and regression tests;
4. switch the caller;
5. delete the replaced Python implementation and compatibility path.

No permanent dual write, dual execution or fallback that can silently change the runtime fact source is allowed.
