# Anna Harness Product-Parity Goal

ID: HF-PARITY-1.0. Date: 2026-08-31.
Status: approved direction for implementation by the user's latest instruction.
This replaces HF-PREVIEW-1.0 as the current development scope.

## Goal

Preserve the existing Home, Cowork and Crew product, and migrate all Agent execution to one Oh-my-Pi Harness using DeepSeek V4 Pro High Effort. Keep the original interface, workflows, business rules and data. The model must receive actual runtime/context state, maintain a durable Todo/Plan, use tools and Hiker MCP, observe results through hooks, use authorized Memory, produce a verified result and continue with context on the next turn.

Do not ship the separate Preview panel as Anna's product. Do not remove, hide or reduce existing features to pass a migration gate. Do not rebuild pure business CRUD or redesign the UI to change the Agent runtime.

## Product Baseline And Rationale

UI/source baseline: `f9f4e1ae06eb4fa54e6f5ebf2974de34ff341b64`, before the incorrect Preview App takeover. Reuse the verified Host/OMP/security work through `92a40fe6b3e610bd3f12932578a5398cbfc772f5` selectively, preserving the old S3 worktree and original data.

| Surface | Preserve | Replace |
| --- | --- | --- |
| Home | Chat/Create shared conversation UI, LoopCard, history, workdirs, attachments, Skill/Agent/model profiles, permission controls, stop/interject/continue, Trace, canvas/files and skill/prompt/python_tool artifacts | Python Agent/model execution; adapt canonical Harness results/events to the existing UI contract |
| Cowork | Actual Hiker dashboard snapshots, disconnected/source/refresh states, assistant side panel, reimbursement information/approval/readback/history | Hiker assistant and other Agent generation/execution paths; expose scoped Hiker tools to the same OMP loop |
| Crew | Graph x Channel x Memory, SOP/project/task/member models, assignment/dependencies, review/rework, artifact versions, inbox/notifications, consensus and existing Showcase | Worker execution, contextual Anna, decomposition/matching/task drafting and remaining direct model calls |

Authorities: [Home merge](../superpowers/plans/2026-07-11-home-merge/00-plan.md), [Cowork dashboards](../superpowers/plans/2026-07-09-iris-rebuild/05-cowork-dashboards.md), [Crew PRD](Anna_Crew_PRD_V1_0.md), [Crew implementation](../superpowers/plans/2026-07-17-crew-build/00-master-plan.md).
Unapproved later product sketches are not new implementation requirements.

## Ownership Contract

- One Node Harness Host is the public application entry and the sole Agent execution authority. OMP owns model/tool iteration; existing product routes and views are retained as adapters/projections.
- Python identity, business stores, state machines, schemas, deterministic dashboards and connector code may remain as a managed business adapter. It receives no model credentials and cannot run the old Agent Loop or independently complete an Agent task.
- All Agent paths, including less visible Crew model calls and approval continuations, must submit whole tasks to the Harness. A single-model-call proxy inside the old Python loop does not meet this goal.
- Model requests use `deepseek-v4-pro`, thinking enabled and `reasoning_effort=high`; required reasoning/message fields survive multi-tool turns. Runtime configuration contains the secret; source, public logs and evidence do not.
- Tools and MCP stay scoped, typed and governed. Preserve approval/idempotency/readback rules. Hiker write verification uses identifiable synthetic records and does not alter real business records.
- Preserve one canonical Agent history/Trace. Existing business projections are derived from it. Session/next-turn context must not reset to an empty Run; project/channel context must not leak across scopes.
- Prefer OMP's existing Todo/tool/hook mechanisms and existing Anna business APIs. Do not introduce another generic orchestration framework.

## Hard Acceptance

| Gate | Required current-revision evidence |
| --- | --- |
| G1 Product parity | Original login/shell/Home/Cowork/Crew/Hub/Settings remain reachable. Existing features and Create kinds are not removed or replaced by Preview |
| G2 Home real completion | Original Home completes real DeepSeek V4 Pro High tasks through actual OMP, with model-selected Todo/tool actions, live Trace, actual artifacts where required, stop and next-turn context/history |
| G3 Cowork Hiker | Original dashboard reads real Hiker data. Anna uses the same Harness for a scoped query and an authorized synthetic write, then verifies the result by readback |
| G4 Crew demo and context | Existing Showcase is preserved; graph/channel/inbox/Memory/review operations work. Actual Anna understands prior channel/project context, and a Worker produces a real reviewed artifact via Harness |
| G5 Honest authority and safety | Legacy Agent execution is trapped/disabled in product mode, no model/key/success fabrication, no credential exposure, scope/approval protection, durable terminal and basic reopen behavior |
| G6 Delivery | Focused regressions and Sol Ultra review pass, current commit CI passes, original-UI build is verified, correct branch is merged/published to the canonical GitHub repository with truthful release notes |

Primary execution roles: GPT-5.6-Luna Max coding; GPT-5.6-Sol Ultra product/architecture control and final review. Keep review bounded to correctness and these acceptance gates. Defer exhaustive combinations, performance work and unapproved feature growth, not the functionality above.

## Delivery Order

1. Freeze original feature/contracts and restore the original product entry.
2. Complete one real Home vertical through OMP/DeepSeek with Todo, tools, context and Trace.
3. Reuse that Host for Hiker and Crew, retaining business APIs/state machines.
4. Verify the original UI, real Home/Hiker/Crew scenarios, security and the build, then merge/publish.

An unavailable credential or external system is reported as a specific blocker; it is never replaced by a fabricated successful demo.
