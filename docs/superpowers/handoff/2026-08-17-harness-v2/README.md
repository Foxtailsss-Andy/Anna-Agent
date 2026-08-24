# Anna Harness v2 · Next Session Handoff

> Created: 2026-08-17  
> Current branch: `rewrite/harness-v2`  
> Protected Computer-3 checkpoint: `b02c5e9271bb9fe62eedd3970dbcb89f88b1fcf2` on `checkpoint/computer3-import`  
> This handoff starts implementation; the previous Session was product/architecture decision only.

## 1. Objective

Build Anna Harness v2 as a new TypeScript control plane using pinned Pi Agent as the Loop Kernel. Keep Crew and the legacy Python Harness frozen until a v2 surface passes differential/regression gates, then replace and delete the corresponding legacy path.

First product outcome: a real “Review-to-Validated-Patch” loop that turns product-review notes into a versioned PRD update, UI change and screenshot, development patch, automated tests, Eval evidence and a Human-approved merge-ready candidate in an isolated Git worktree.

## 2. Required model and review workflow

- Development Subagent: `gpt-5.5`, reasoning `high`.
- Independent reviewer: `gpt-5.6-sol`, reasoning `xhigh`.
- Each ticket uses a fresh context and stops after its own acceptance gate.
- Implementation uses the `tdd` Skill: red → green → refactor.
- Review uses the `code-review` Skill on both Standards and Spec axes.
- Address actionable findings, rerun checks, then write the ticket handoff.

Do not start T01 before T00 has passed independent review.

## 3. Read in this order

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/adr/ADR-003-trace-and-terminology.md`
4. `docs/adr/ADR-005-channel-scoped-anna.md`
5. `docs/adr/ADR-006-pi-loop-kernel-and-typescript-control-plane.md`
6. `docs/adr/ADR-007-local-preview-before-cloud-runtime.md`
7. `docs/adr/ADR-008-event-store-is-the-runtime-fact-source.md`
8. `docs/adr/ADR-009-tools-run-only-through-anna-tool-gateway.md`
9. `docs/product/anna-harness-v2-spec-2026-08-17.md`
10. `docs/product/anna-harness-v2-wayfinder-2026-08-17.md`
11. `docs/superpowers/plans/2026-08-17-harness-v2/00-plan.md`
12. the current ticket file.

Crew freeze evidence remains in:

- `docs/product/claude-tag-buzz-anna-development-gate-2026-08-17.md`
- `docs/product/crew-harness-capability-roadmap-2026-08-16.md`

## 4. Frozen decisions

### Product model

- Every Channel has exactly one Anna.
- A Channel Session owns channel Context, Memory, authorization, schedules and Run references.
- Parallel pipelines are Runs/Lanes governed by the same Anna.
- Parallel Lanes submit Proposal, Artifact or Memory Candidate; one serialized Projector/Human Gate merges shared facts.
- Cross-channel Context/Memory access is deny-by-default and grant-based.

### Architecture

- New TypeScript Harness v2 package and local Node service in the existing repo.
- Old Python Harness remains frozen; do not add new compatibility branches inside it.
- Use HTTP/event contracts for strangler cutover.
- Do not Fork Pi and do not run Pi as a subprocess behind the legacy Python Runtime.
- Production Loop Kernel uses pinned `pi-agent-core` and `pi-ai` `0.84.2` behind `PiLoopKernel`.
- Pi `coding-agent AgentSession` is reference/canary only.
- Pi `AgentHarness v2` is currently an unfinished scaffold and is not a release dependency.
- Pi built-in tools are disabled.

### Runtime truth and safety

- Anna Event Store is the canonical runtime fact source.
- Local Store is Node SQLite with mandatory Channel scope and conformance tests.
- OTel Trace and Pi transcript are projections.
- ToolGateway is the only effect path.
- Local preview allows approved typed Tools; no arbitrary Bash, host-home writes, unrestricted network, push, merge or deploy.
- Long-term Memory begins as provenance-bearing Memory Candidate and requires Channel Owner confirmation in local preview.

### Release shape

- First release is a macOS local developer preview.
- Background work runs while the desktop/local service is running.
- App-closed cross-day work is a later cloud Runtime milestone.
- First live canary uses a disposable Anna Git worktree.

## 5. Root cause evidence

The legacy seam is terminal-batch:

```python
LoopAdapter.run(snapshot, signals) -> LoopResult
```

A deterministic diagnostic ran twice. While the Adapter was actively blocked, the Event Store contained only:

```text
execution.started
execution.claimed
```

No progress event can be persisted until `LoopResult` returns. The production Crew adapter likewise appends QueryEngine frames to an in-memory list and converts them only after the engine ends. This explains the observed complex Run that stayed `running` for 90 seconds with no durable progress.

Direct provider and bounded-loop evidence were healthy:

- DeepSeek provider: 1.63-second minimal response with reported usage;
- minimal real Crew Worker: 5 seconds, `done`, 282-character Artifact, 163 frames and a real Memory hit;
- multi-role complex Run: auto-triggered and restart-visible, but still `running` with no Artifact after 90 seconds.

Conclusion: model connectivity and bounded Pi-style looping are viable; canonical events, budgets, recovery and platform seams require replacement.

## 6. Pi source evidence

Verified on 2026-08-17:

- npm latest: `@earendil-works/pi-coding-agent@0.84.2`;
- inspected source commit: `58302d34e703e0453ea13bdd10c7e423589ce177`;
- license: MIT;
- repository: `https://github.com/earendil-works/pi`.

The stable Agent/AI packages provide model streaming, tool-call protocol, steering, abort and usage. The newly exported `packages/agent/src/harness/AgentHarness` rejects core public operations with `HarnessNotImplemented`; do not build on it.

## 7. Start with T00 only

Ticket:

`docs/superpowers/plans/2026-08-17-harness-v2/T00-contracts-and-workspace.md`

T00 creates:

- `packages/harness-v2` for Pi-free domain/contracts;
- `apps/harness-service` for the local Node service shell;
- npm workspace wiring and focused TypeScript/Vitest commands;
- branded IDs and schemas;
- `LoopKernel`, `EventSink`, `EventStore`, `ToolGateway`, `SandboxAdapter`, `MemoryPolicy`, `EvalGate` and `Scheduler` interfaces;
- dependency-boundary tests preventing Pi/legacy imports in domain contracts.

T00 explicitly excludes Pi calls, SQLite, Crew changes and runtime cutover.

## 8. Baseline and commands

Project root:

`<repo-root>`

Before editing:

```bash
git status --short --branch
git rev-parse HEAD
git branch --show-current
```

Expected branch: `rewrite/harness-v2`. Expected clean worktree.

Baseline validation previously passed on the migrated Mac:

```bash
npm run typecheck
npm test -- --reporter=dot
./.venv/bin/python -m pytest -q
npm run build
```

Recorded results: 629 Vitest tests and 1040 Pytest tests passed; Electron/backend health also passed. Re-run the relevant baseline before T00 and report any drift rather than weakening tests.

Known non-blocking baseline issues:

- npm audit reported 18 dependency findings (1 critical, 16 high, 1 low); dependency remediation is outside T00 unless workspace wiring makes one directly relevant.
- Electron development mode reports an insecure CSP warning; outside T00.
- migrated `.anna/runtime.json` contains one Windows connector path; `.anna/` is ignored and must never be printed or committed.

## 9. Git safety

- No GitHub remote exists yet; `migration-bundle` points to the local migration bundle.
- Do not push, merge, rebase or rewrite the checkpoint branch.
- Do not delete legacy code during T00–T07.
- Commit each reviewed ticket separately on `rewrite/harness-v2`.
- Never add `.anna/`, `.venv/`, `node_modules/`, `dist/`, credentials or runtime databases.
- Preserve unrelated user work and the frozen Crew behavior.

## 10. Ticket sequence

1. T00 Contracts and workspace
2. T01 Pi Loop Kernel canary
3. T02 Event Store and Channel Session
4. T03 ToolGateway and Sandbox seam
5. T04 Skills, RunProfiles and Memory
6. T05 Trace and Eval
7. T06 Scheduler and proactive Runs
8. T07 Review-to-Validated-Patch
9. T08 Desktop cutover and legacy deletion

Follow dependencies in `00-plan.md`; T01 and T02 may use separate worktrees only after T00 review.

## 11. Handoff completion for each ticket

Every ticket must leave:

- exact branch/commit and diff scope;
- files added/changed/deleted;
- red test observed before implementation;
- tests and commands with results;
- Standards/Spec review findings and resolutions;
- known gaps and evidence still missing;
- explicit next-ticket inputs;
- confirmation that no Crew behavior, secret or unrelated file changed.

## 12. First prompt for the next Session

```text
You are implementing Anna Harness v2 T00 only.

Read the handoff at docs/superpowers/handoff/2026-08-17-harness-v2/README.md,
then read the listed context, ADRs, spec, plan and T00 ticket in order.

Use a GPT-5.5 high development subagent and the tdd Skill. Keep Crew and the
legacy Python Harness frozen. Implement only T00, run its acceptance checks,
then invoke a separate GPT-5.6 Sol xhigh reviewer using the code-review Skill
against both repository standards and the Harness v2 spec. Address actionable
findings, rerun checks, commit the reviewed T00 change, and write its handoff.
Do not start T01 in the same context.
```
