# Anna Harness-first Goal

| Field | Value |
| --- | --- |
| Goal ID | HF-GOAL-1.0 |
| Date | 2026-08-30 |
| Status | Active; registered as the thread's Goal |
| Authority | [HF-SPEC-1.0](anna-harness-first-spec-2026-08-30.md) |
| Execution | [SDD plan](../superpowers/plans/2026-08-30-harness-first/00-plan.md) |
| Starting code | `25e70a94811c41cf3ebb9a2a0cae1e1b019ddc41` |
| Completed baseline | HF-00 and HF-01A; [verified milestone](anna-harness-first-update-2026-08-30.md) |
| Main coder | GPT-5.6-Luna Max |
| Independent review and correction | GPT-5.6-Sol Ultra, Standards and Spec axes |
| Goal/plan review | Sol Ultra accepted the scope, ownership, gate ledger and dependency classification on 2026-08-30; implementation remains pending |

## Outcome

Complete the execution-substrate replacement so Anna's supported Desktop and
headless tasks run through one default Anna Harness Host. That Host owns
admission, immutable RunProfiles, Context/Memory, Skills/Plugins, Tools,
Trace/Eval, scheduling, recovery and truthful terminal decisions.

Oh-my-Pi must actually execute behind a pinned, governed LoopKernel Adapter.
Pi Core remains an explicitly selected reference adapter. Missing capabilities
are unavailable, without silent Pi/Python fallback or a second canonical store.
General work executes within its bounded profile. Hiker/business work uses
typed remote MCP, approved effects and real readback under the same Host.

The Goal includes the supported surface contracts in SPEC section 10, data
migration, default Desktop cutover and deletion of replaced Legacy execution.
It is not closed by a completed module, an optional sidecar or a green ticket.

## Remaining Work

Ten main tickets remain. These are different-sized work packages, not equal
units of effort or a basis for a completion percentage. The implementation
inventory and unmerged candidate are reusable inputs, not acceptance evidence.

| Stage | Tickets | Required result |
| --- | --- | --- |
| 1. Host and kernel | HF-01B, HF-02 | Actual Host Memory hydration and sequence ownership; governed Oh-my-Pi worker/conformance |
| 2. Interaction and loading | HF-03, HF-04 | Full Chat lifecycle; bounded Router; complete effective profile and actual resource loading |
| 3. Business and coding | HF-05, HF-06 | Live MCP approval/effect/readback; isolated coding tools, predictions and official evaluation |
| 4. Product and supervision | HF-07, HF-08 | Complete Create, Crew, Hub/Settings, unified Supervisor, Scheduler and recovery |
| 5. Default cutover | HF-09 | Data migration, one default Desktop Host, native Windows/macOS package validation |
| 6. Final acceptance | HF-10 | Legacy execution deletion, all global gates, current evidence and verified GitHub delivery |

No reliable calendar estimate is asserted yet. The remaining uncertainty is
concentrated in the pinned upstream integration, cross-surface migration and
real verification environments. Refine effort after the HF-01B/HF-02 design
and conformance evidence; do not infer duration from the number of tests.

## Implementation Ownership

- HF-04 owns the complete HF-030 policy snapshot, Skill/Plugin catalog and
  actual loading receipts. HF-02 owns governed consumption inside the adapter.
  HF-01A and HF-01B cover only their stated Tool and Context subsets.
- HF-08 owns the unified Supervisor and full HF-072 crash-point matrix.
  HF-03 supplies the Chat lifecycle integration and consumes that authority.
  Recheck the Chat recovery cases after HF-08; HF-03 alone cannot close AC-07.
- HF-08 owns Hub/Settings Host-backed contracts and projections; HF-09 owns
  their default Desktop client switch and native package validation.
- HF-10 verifies the completed implementation. It is not a substitute for an
  implementation owner or a place to hide unassigned work.

HF-09 preparation may proceed independently, but the default Desktop cutover
waits for HF-01B and HF-02..HF-08 convergence and acceptance. HF-10 is the final
verification after that cutover, not a parallel shortcut around its dependencies.

## Global Acceptance Ledger

Each row must eventually reference the actual integration HEAD, frozen case
IDs/configuration, commands, result artifacts and independent review. An open
or partial row cannot be converted to accepted by aggregate test counts.

| Gate | Primary owner | Baseline status | Required closing evidence |
| --- | --- | --- | --- |
| AC-01 Runtime authority | HF-09/10 | Open: default remains Python | Clean launch and every supported surface execute through one Host; replaced execution removed |
| AC-02 Loading | HF-04, with HF-01B/02 | Partial: v2 Tool composition only | Complete effective snapshot and actual Skill/Plugin/Tool/Memory loading in the same Run |
| AC-03 Kernel | HF-02 | Open: no OMP adapter | Pinned upstream, conformance, governed tools, isolation, abort and restore |
| AC-04 Memory | HF-01B/03 | Open: no accepted production loading gate | Owner lifecycle, next-Run retrieval, restart, deletion/revocation/isolation negatives |
| AC-05 Effects | HF-05/07 | Partial: HF-01A local Tool/Artifact evidence | Real scoped MCP read/write, Owner approval, durable intent/outcome/readback and unknown handling |
| AC-06 Trace/Eval | HF-03/08 | Partial: component and v2 slice evidence | In-flight cursor-readable Trace and required Eval before success across surfaces |
| AC-07 Recovery | HF-08 | Partial: existing persistence/adapter foundations | Full crash matrix preserves profile, budgets, effects and one terminal |
| AC-08 Surface parity | HF-03..09 | Open: Legacy surfaces remain | Frozen API/UI workflow cases for every SPEC section-10 row |
| AC-09 Benchmark | HF-06 | Open: no official run | Isolated actual patch, valid prediction, pinned Linux x86_64 official reports and honest performance accounting |
| AC-10 Publication | HF-10 | Partial: HF-01A publication only | Final reviewed integration, fresh gates/privacy scan, exact remote SHA and green CI |

The Goal closes only after all ten rows are accepted and these quantitative
conditions from the SPEC hold:

1. Four distinct product Smoke and sixteen distinct Dev cases have independent
   expected assertions/source mappings. Deterministic safety and lifecycle
   assertions pass 100%; no safety failure is averaged away.
2. Critical real-provider behavior passes three consecutive repetitions under
   fixed settings, with failures and variance retained.
3. Memory is proposed, accepted by its Owner, survives restart and is used in
   the next Run; failure, zero-hit, reject/delete/revoke and isolation are tested.
4. Four coding smoke cases execute read/edit/test/diff. At least one real
   SWE-bench instance goes through the pinned official Linux x86_64 evaluator.
   Interface readiness, evaluator readiness and resolved fraction are distinct;
   no full-dataset score or unrequested performance target is invented.
5. Default cutover and migration pass Windows/macOS native package checks;
   removed Legacy paths are followed by fresh regression and publication gates.

## Verification Dependencies

| Dependency | Current observation | Required resolution |
| --- | --- | --- |
| Managed Bun | Local `1.3.6`; chosen OMP source requires `>=1.3.14` | HF-02 selects and verifies a compatible pinned worker runtime and package lifecycle |
| Docker/Linux x86_64 | Docker not found in the local PATH; local host is Darwin arm64 | HF-06 establishes an actual Linux x86_64 evaluator executor; ARM local smoke is insufficient |
| Windows | Current CI covers macOS only | HF-09 provides Windows execution and packaged workflow evidence |
| Real Provider and Hiker | Credentials/access not preflighted for this Goal; isolated package smoke deliberately had none | Authorized private configuration and real read-only preflight before live cases |
| External writes | No specific live test action approved by creating this Goal | Obtain Owner approval for identified test objects/actions; no real-business write is inferred |

Missing inputs remain visible as unresolved evidence. Continue independent
work while resolving dependencies; never substitute fixtures or fabricated
receipts. Raw credentials/business data remain private and out of Git.

## Execution and Change Control

Use SDD and the available Matt Pocock TDD/implementation/two-axis review
principles. For every ticket: freeze owned files and public test boundaries,
observe RED, implement minimally, verify, independently review, correct and
record the accepted result before moving its status to complete.

Maintain original dirty worktrees unchanged. No broad historical-branch import,
force push, automatic production deployment or formal installer Release is
authorized by this Goal. Source branch/PR updates retain their exact scope and
reviewed evidence. Do not lower a gate after discovering a failure.

The next implementation ticket is HF-01B. The overall Goal remains active
through individual ticket completions and unresolved external verification.
