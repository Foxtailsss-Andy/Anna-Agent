# Anna Harness-first SPEC

| Field | Value |
| --- | --- |
| Spec ID | HF-SPEC-1.0 |
| Date | 2026-08-30 |
| Status | Accepted direction for SDD; implementation and release gates remain open |
| Publication baseline | Anna-Agent main `df1bf0ccb954af7a174e7aa1671dae9379d07da0` |
| Development baseline | rewrite/harness-v2 `df034523e62f3eebca3beb60d769c7b1bbcfcbf0` |
| Unmerged candidate | ticket/env-01-import-20260821 `2f94d34796692d9a32932ba793e3cbd7f132cf2a` |
| Shared ancestor | `5aecdac8fc4f8bac1cfaa54a4f2b57a0fac2c936` |
| Main coding role | GPT-5.6-Luna, reasoning Max |
| Review/correction role | GPT-5.6-Sol, reasoning Ultra |
| Execution plan | [Harness-first SDD plan](../superpowers/plans/2026-08-30-harness-first/00-plan.md) |

This document is the development contract. It is not a claim that Anna already has a complete Harness-first runtime, an Oh-my-Pi integration, or a SWE-bench result. A dated milestone may be published while the overall migration remains incomplete, provided its exact support boundary is explicit.

## 1. Problem

Anna currently has a Python Agent Runtime and a separate TypeScript Harness v2 path. The Desktop, Chat, business orchestrators, Memory, and execution stores do not share one runtime owner. A functioning page, a successful model response, package health, and component tests cannot demonstrate that the product is using Harness v2.

There is also an unmerged candidate with useful default-v2 Desktop, Chat, Memory injection, and durable ToolGateway work. Its independent history and dirty working tree cannot be treated as deployed behavior. Rebuilding all of that work or merging it wholesale would both introduce avoidable risk.

The previous workspace-scoped Python Task API is not the target foundation. Its contract and security regressions may be reused; its Python orchestration must not become a third Agent Runtime.

## 2. Goal and non-negotiable outcome

**HF-001: One Anna Harness Host owns every Agent execution.** Memory, Skills, Plugins, Tools, Context, Artifact validation, Trace, Eval, Scheduler, and recovery are composed by that Host from a Channel Session and an immutable RunProfile. No product surface owns a parallel model loop or independent success decision.

**HF-002: Oh-my-Pi is the target coding adapter, not a second control plane.** Its coding/session/tool capabilities are integrated behind an Anna-owned LoopKernel Adapter. Pi Core remains the minimal conformance/reference adapter. A Run selects exactly one adapter/version before execution. Missing or failed Oh-my-Pi configuration is an explicit unavailable state, never an automatic fallback to Pi or Python.

**HF-003: Replace the execution substrate end to end.** The final supported Desktop paths use the Harness Host by default. Replaced Python Agent loops, orchestrators, Memory wiring, execution stores, and compatibility execution routes are removed. Python may remain inside a bounded Connector or tool process without owning planning, Memory promotion, permissions, or Run completion.

## 3. Meaning of autonomous execution

| Capability | Required behavior | Explicit boundary |
| --- | --- | --- |
| Self-execution | Anna performs bounded tool/model iterations through the selected kernel and Gateway | No unbounded retries or ambient host access |
| Self-judgment | Anna chooses continuation, verification, clarification, approval, or terminal state using the task contract and Eval | Model prose cannot mark a side effect or task verified |
| Self-loading | The Host resolves allowed Skills, Plugins, Tools, Memory, and model from catalogs and Channel policy | No model-installed plugin, credential discovery, or permission expansion |
| Learning | Runs may propose provenance-bearing Memory Candidates | Owner acceptance is required before durable promotion |
| Business routing | Anna selects a Connector-backed RunProfile when business evidence is required | A failed Connector cannot be replaced by an unsupported model answer |

Hiker is an external system reachable by MCP. Anna keeps responsibility for the Run and its evidence; it does not delegate its own authority to a remote service.

## 4. Architecture and ownership

```text
Desktop / headless benchmark client
                 |
                 v
Anna Harness Host: one public runtime API and authority
  Channel Session -> Router -> resolved RunProfile snapshot
  Context Builder -> accepted Memory / Skills / Plugin manifests
  Run Supervisor -> budgets / queues / cancellation / recovery
                 |
                 v
LoopKernel Adapter [Oh-my-Pi coding | Pi Core conformance]
                 |
                 v
Durable ToolGateway -> Sandbox -> local tools / remote MCP
                 |
                 v
Artifact -> Contract / Quality Eval -> truthful terminal

Canonical Event Store underlies all lifecycle and projections
  -> live Trace / UI history / Memory decisions / Scheduler receipts
```

One logical Runtime does not mean one OS process. A managed Bun worker, sandbox container, or Python Connector is allowed. Such workers cannot have a separate authorization policy, canonical Memory store, Run terminal authority, or user-facing fallback API.

| Owner | Responsibility |
| --- | --- |
| Harness Host | Admission, task classification, scope, profile resolution, lifecycle, recovery |
| LoopKernel Adapter | Model/tool iteration, normalized messages and events, steering/abort protocol |
| ToolGateway | Typed argument validation, scope, policy, approval, effect ledger, tool outcome |
| Sandbox | Actual file/process/network containment and process-tree cleanup |
| Memory repository | Candidate decisions, accepted state, grants, retrieval and provenance |
| Eval Gate | Contract obligations and task/profile-specific quality acceptance |
| Product surfaces | User input and projections; no model loop or independent execution state |

This SPEC extends ADR-006's adapter direction to Oh-my-Pi. It retains ADR-005/008/009 scope, fact-source, and ToolGateway guarantees. No broad compatibility exception satisfies the final migration gate.

## 5. Current state and takeover rules

**HF-010:** Capture both protected worktrees and the publication baseline before changes. The two source branches have 19 and 108 exclusive commits at the recorded baseline. Recompute ancestry, status, and file hashes during HF-00; these counts are observations, not acceptance constants.

**HF-011:** Begin an integration branch from verified GitHub main. Select changes by behavior and dependency, not by copying a branch's working directory. Never import a candidate's dirty files without separate review and provenance.

**HF-012:** Candidate reuse priorities are Host supervision, scope/identity guards, Chat history and Trace projections, production Memory hydration, and durable Gateway composition. Preserve current-line transcript restoration, budget accounting, Create projections/activation, and bounded search behavior where verified. Each transplant needs regression and differential evidence.

**HF-013:** Existing user changes, secrets, local databases, caches, attachment data, and release artifacts remain outside the publication diff. No reset, clean, forced branch replacement, or silent deletion is authorized by this plan.

## 6. Kernel and Oh-my-Pi integration

**HF-020:** Only the kernel adapter package imports Pi/Oh-my-Pi. The Host, domain contracts, Memory, Eval, and product UI stay implementation-independent. Persist kernel identity, exact version/source, and relevant protocol version with the RunProfile when that adapter is introduced.

**HF-021:** Implement and test `start`, `steer`, `answer`, `abort`, and resume semantics through the existing LoopKernel contract. An optional capability must be advertised as unavailable until implemented. Restore validates the original profile/model/Skill/kernel fingerprints and cumulative budgets.

**HF-022:** Pin the upstream source and lock resolved dependencies. Review runtime requirements, native binaries, lifecycle cleanup, license notices, and supported OS/architecture. Oh-my-Pi may require a managed Bun worker; compatibility with Electron's Node process must be proven, not assumed.

**HF-023:** Embedding must override ambient SDK defaults. Explicitly own model/auth, cwd, agent directory, session storage, context sources, Skills, extension discovery, custom commands, MCP and tools. SDK `toolNames` alone is not an allowlist; restrictive settings and observable zero-dispatch tests are required.

**HF-024:** Upstream read/search/edit/shell/Plugin capabilities are reusable implementations only when every execution crosses Anna Gateway and Sandbox. If a capability cannot be intercepted and governed, keep it unavailable. Plugin lifecycle hooks cannot access host filesystem, credentials, or networks outside their declared capabilities.

**HF-025:** Upstream session files and Memory backends are disposable caches/projections or explicitly mapped adapters. They must not become independent canonical product state. Native memory reflection/autolearning must be disabled unless routed through the Anna Candidate/Owner policy.

## 7. RunProfile and capability loading

**HF-030:** Resolve and persist the complete effective policy before the first model call: Channel scope, worker identity, kernel/model policy, Skill versions/hashes, Plugin manifests, typed Tool catalog, Memory policy, budgets, Artifact contract, Eval policy, and terminal rules. Migrations use explicit schema versions; no runtime hot substitution.

**HF-031:** Compute effective permissions by intersection of Channel, worker, RunProfile, Skill and Plugin grants. Caller-supplied profiles or model arguments cannot widen scope. The Host must record which resources were actually loaded, not only which names were configured.

**HF-032:** The Router itself executes as a bounded Harness Run. It selects a declared RunProfile/Connector or asks for missing context. Business verification cannot be bypassed by classifying a failed business query as generic text. Routing decisions retain source, chosen catalog version, and reason codes.

**HF-033:** All new Runs and proactive Runs enter the same admission/supervision path. Budgets persist across retries, cancellation, steering, resumption, and process restart.

## 8. Memory within the Harness

**HF-040:** For `read: channel`, retrieve only accepted, authorized Memory before the relevant model turn. Carry hits as untrusted context plus provenance. Persist `run.started`, then `memory.hit`, before the first model call under one coordinated sequence owner. The `read: channel` mode itself requires this lookup: storage, scope or policy failure blocks the Run; a valid zero-hit result allows it to continue. Do not introduce an implicit second `required` flag or silently convert a lookup failure into empty context.

**HF-041:** For `write: propose`, only propose candidates with real source Run/Event references. An accepted Owner decision is required for promotion. Failed Runs, fixtures, arbitrary plugin output, and generated claims cannot silently become accepted Memory.

**HF-042:** Candidate accept/reject/edit/delete, accepted Memory edit/delete, grant/revoke, restart, and deletion tombstones must be observable through one scoped API. Revocation and deletion affect the next retrieval, including after restart.

**HF-043:** Legacy project Memory maps to its project Channel; workspace Memory requires an explicit import Channel and grants. Preserve legacy IDs, source and hashes. Do not broadcast old workspace rows to every Channel or keep permanent double writes.

**HF-044:** Empty/ambiguous retrieval queries must not accidentally recall all Channel Memory. Freeze recall semantics and limits in tests. Semantic indexing may be added behind the repository later; changing the memory engine is not a substitute for these lifecycle guarantees.

## 9. ToolGateway, Sandbox, and remote business work

**HF-050:** Every tool request carries Workspace, Channel, Run, worker and tool-call identity. Validate arguments before any I/O. No domain Orchestrator or upstream builtin may bypass the durable Gateway.

**HF-051:** Hiker uses an allowlisted, typed MCP adapter. Discover configured capabilities and bind remote actor credentials in the Host, not in model arguments. The effect policy comes from the registry, not remote tool descriptions alone. Tool errors, protocol errors and application-level failure payloads cannot be recorded as successful evidence.

**HF-052:** External writes need Owner approval, effect key, intent fingerprint, durable outcome, and readback/compensation contract. Unknown outcome is visible and never automatically replayed. Read-only calls are still scoped and audited.

**HF-053:** Coding Profiles require read/search, bounded editing, process execution, diff collection and test execution inside a real isolated environment. A host path allowlist is not an OS containment proof. Cancellation and timeout must terminate descendant processes and close file/network handles.

**HF-054:** Business payloads, provider responses, keys and endpoints do not enter public evidence. Preserve local raw evidence under explicit retention policy and publish redacted identifiers, hashes, status and counts only.

## 10. Product migration

| Surface | Required replacement before cutover |
| --- | --- |
| Chat | Submit, live events, history/detail, Trace, stop/continue/interject, conversation continuity, save-as-Memory proposal |
| Create | Generation/edit, Artifact versions, list/detail, validation, activation approval, history and failed-state recovery |
| Cowork/Hiker | Business routing, typed remote MCP, verified results and errors in the same Harness Run |
| Reimbursement/Associate | Intent, approval, effect ledger, readback, unknown outcome, recovery |
| Crew | Channel/Task/WorkerProfile to Run/Lane mapping, decomposition, coordination, parallel work and review projections |
| Hub/Settings | Canonical Run/Artifact projections and Host-owned capabilities, model/profile settings and lifecycle |

**HF-060:** Product clients use one Host API. Pure CRUD may remain in an application service, but no model execution is hidden there. No unsupported surface is routed to the old runtime merely to keep the page looking functional.

**HF-061:** For each surface freeze input/output/event/error contracts, replay fixed cases, implement the adapter, compare behavior, switch new Run admission, then delete the replaced execution path. Do not demand identical model wording; compare obligations, tools, artifacts, provenance, terminal, latency and cost separately.

**HF-062:** Existing active Runs are drained/cancelled or recreated with `migrated_from`; do not hot-swap their Runtime. Imported terminal history stays history, not a fabricated resumable v2 Run. Retain approval/effect records before enabling migrated write tools.

## 11. Trace, Eval, and recovery

**HF-070:** Canonical events are appended during execution; a terminal-batch transcript is insufficient. Trace must be cursor-readable while a model/tool is blocked and include scope, loading, context, model, tool, approval, budget, Memory, Eval and terminal evidence.

**HF-071:** Contract Eval completes before success becomes visible. Quality Eval is required only where the frozen task/Profile requires it, with explicit rubric and calibrated reviewer. Disabled policy cannot count as a passed required gate; LLM judgment does not replace business readback or executable tests.

**HF-072:** A production supervisor reconciles queued/running/awaiting Runs on restart. Preserve one terminal, cumulative budget, original profile and safe resume points. Test crash points before/after model output, tool dispatch, effect persistence, approval, projection, and terminal append.

**HF-073:** Scheduler uses the same scoped Run admission path. Persist trigger, notification audience, occurrence/effect keys and catch-up policy. Closed-app execution is not promised by the local preview.

## 12. SWE-bench readiness

SWE-bench does not require Pi or Oh-my-Pi by name. The replacement is a product architecture decision; benchmark readiness is established independently by the following requirements.

**HF-080:** Freeze dataset/subset/revision, instance IDs, repository `base_commit`, model/provider version, kernel/Skill/Plugin versions, budgets, sandbox image digest and evaluator revision. Keep inference and official evaluation isolated.

**HF-081:** For each instance, Anna checks out the base repository in an isolated sandbox, reads the issue, edits code, runs allowed development tests, and exports the actual final diff. Produce official prediction fields `instance_id`, `model_name_or_path`, and `model_patch`.

**HF-082:** Never supply the gold patch, hidden evaluator tests, future commit solution, or prior instance solution Memory to the agent. Trial namespaces and Memory are isolated. No tool may edit the external grader or synthesize its result.

**HF-083:** Evaluate patches with the pinned official Docker harness. Record build, apply, FAIL_TO_PASS, PASS_TO_PASS, logs and report hashes. Distinguish infrastructure/adapter/grader faults, model failure, and unresolved tasks. Missing Docker/image/provider configuration is a blocker, not a zero score or fabricated run.

**HF-084:** Separate three gates: interface readiness (valid/applicable prediction), evaluator readiness (official reports generated), and task performance (resolved fraction with denominator). A gold-patch evaluator check proves infrastructure only. A synthetic task or one solved issue is not an official benchmark score.

**HF-085:** Before claiming coding-profile readiness, run 4 frozen synthetic smoke cases through read/edit/test/diff and at least one real benchmark instance through the official evaluator. Dataset-wide claims require the full declared subset and all failure accounting. ARM/macOS local smoke cannot replace Linux x86_64 benchmark evidence.

## 13. Test boundaries and acceptance matrix

Primary public boundaries are (A) Host HTTP/streaming API, (B) LoopKernel/ToolGateway contract, and (C) official prediction/evaluator interface. Use the real scoped SQLite Event Store for persistence assertions. Model and remote I/O may be deterministic fakes in tests, explicitly labeled as such. Do not mock away Gateway, authorization, projection or Eval merely to obtain green tests.

| Gate | Required evidence | Reject when |
| --- | --- | --- |
| AC-01 Runtime authority | Clean launch, process tree and API trace for every supported surface | A Python Agent Runtime or silent fallback executes a task |
| AC-02 Loading | Effective profile snapshot + actual Skill/Plugin/Tool/Memory loading events in one Run | Catalog names exist but production never consumes them |
| AC-03 Kernel | Same conformance cases for each enabled adapter, real governed tool cycle, abort and restore | Hidden builtin/Plugin bypasses Gateway or changes policy |
| AC-04 Memory | Propose -> accept -> restart -> next Run hit; reject/delete/revoke/isolation negatives | Candidate leaks, required retrieval silently fails, or second canonical Memory store exists |
| AC-05 Effects | Scope/approval/idempotency/readback/unknown-outcome tests | Unapproved or duplicate external side effect |
| AC-06 Trace/Eval | In-flight cursor Trace and pre-terminal required Eval | Terminal text precedes verified obligations |
| AC-07 Recovery | Crash-point suite preserves profile, budget, effect ledger and one terminal | Budget resets, duplicate writes, or zombie Run |
| AC-08 Surface parity | Frozen API/UI cases for every row in section 10 | Controls remain pointed at unsupported Legacy routes |
| AC-09 Benchmark | Prediction validation, official evaluator reports, scope-correct performance report | Fixture/gold/partial tests described as agent benchmark success |
| AC-10 Publication | Reviewed integration HEAD, fresh gates, privacy scan, exact remote SHA/CI | Dirty worktree/old package counts used as release evidence |

Deterministic safety and lifecycle cases must pass 100%. The initial product suite is 4 distinct Smoke and 16 distinct Dev cases, with independent expected assertions and source mappings; copied synthetic events do not count as distinct tasks. For critical real-provider behaviors, require 3 consecutive successful runs under fixed settings and report variance. No aggregate pass rate overrides a safety failure.

Full migration acceptance requires every AC row, plus zero remaining production references/start paths to replaced Legacy execution. Do not erase truthful `partial` diagnostics or rename endpoints to satisfy a text scan. Inspect observed runtime ownership and behavior.

## 14. SDD execution and change control

- Freeze this SPEC before functional coding; each ticket references requirement/gate IDs, base SHA, owned files and public test boundaries.
- Luna Max performs vertical RED -> minimal GREEN cycles. Sol Ultra independently reviews Standards and Spec, requests corrections, and rechecks fixes.
- Record exact observed RED/GREEN commands. Do not reconstruct or invent historical RED results; a missing record is an explicit process gap.
- Reuse Matt Pocock's `to-spec`, `implement`, TDD and two-axis review principles. This document is the local issue/spec source; no unavailable Skill invocation or installation is claimed.
- Full-repository gates run after integration. Changes to scope or ownership require a recorded amendment before coding; never lower an acceptance threshold after a failed test.
- No original/candidate dirty worktree is used as an implicit code source. Work only in the isolated integration tree after HF-00.
- GitHub branch/PR updates are authorized for this milestone. Force push, history replacement, production deployment and a formal installer Release are not.
- Overall completion remains open while any final gate is blocked. A milestone can close its own ticket without closing the migration.

## 15. Rollout, migration and rollback

Use offline replay first, then shadow evaluation with no double writes, then controlled new-Run canaries. Freeze Runtime choice at admission; never retry a failed v2 Run in Legacy. Data migration outputs counts, mapping hashes, orphan/rejected rows and sampled readback, without public sensitive payloads.

Rollback affects future Runs only. Preserve v2 history and the complete external effect ledger. After Legacy deletion, use a previous verified application version and compatible state snapshot; no reverse dual write or replay of unknown effects.

## 16. Source references and present limitations

- Existing Anna architecture: `docs/product/anna-harness-v2-spec-2026-08-17.md`, ADR-005/006/008/009, current package/source contracts.
- Unmerged candidate evidence: `ticket/env-01-import-20260821@2f94d34`; claims must be rerun at the new integration HEAD.
- Oh-my-Pi source inspected 2026-08-30: `can1357/oh-my-pi@51f03804476c3fd3c15748ae07e4849d1efc883b`, `packages/coding-agent/package.json` reports `18.0.11`, Bun `>=1.3.14`; `docs/sdk.md` describes explicit restricted-tool and discovery controls; root `LICENSE` is MIT. This is an evaluated source pin, not an installed Anna dependency or compatibility claim.
- Official evaluator reference: `SWE-bench/SWE-bench@7a21e05772954cc81471ae19d56f436cecf43c54`; README and evaluation/inference contracts. Confirm the exact pinned command/API before running it.
- The current GitHub baseline remains Developer Preview. Oh-my-Pi activation, broad coding tools, full Desktop cutover, live Hiker and benchmark evaluation are not made available by publishing this SPEC.
