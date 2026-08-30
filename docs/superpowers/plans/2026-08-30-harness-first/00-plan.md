# Harness-first SDD Plan

Date: 2026-08-30
Spec: [HF-SPEC-1.0](../../../product/anna-harness-first-spec-2026-08-30.md)
Publication baseline: `df1bf0ccb954af7a174e7aa1671dae9379d07da0`
Coding: GPT-5.6-Luna Max. Independent review/correction: GPT-5.6-Sol Ultra.

## Delivery rule

The overall migration is not complete until all SPEC acceptance gates pass. Today's GitHub update can contain the frozen SPEC, takeover evidence and an independently reviewed implementation ticket. It must say which paths are still Legacy and must not claim Oh-my-Pi or SWE-bench readiness prematurely.

## Dependency map

```text
HF-00 Protected takeover + source mapping
  -> HF-01A Production durable ToolGateway composition
  -> HF-01B Host Memory hydration and sequence ownership
     -> HF-02 Oh-my-Pi isolation and kernel conformance
     -> HF-03 Chat lifecycle + Context/Memory integration
        -> HF-04 Harness Router + typed Connector admission
           -> HF-05 Hiker/business MCP + approvals/effects
           -> HF-06 Coding tools + sandbox + benchmark adapter
           -> HF-07 Create/Artifact workflow
        -> HF-08 Crew/Lanes/Hub + Scheduler
  -> HF-09 State migration + Desktop single authority
  -> HF-10 Legacy deletion + release/benchmark acceptance
```

No ticket imports an entire historical branch. A referenced old commit is a source candidate; the new integration tests are acceptance evidence.

## Ticket register

| Ticket | Requirements | Owned area | Public RED boundary | Exit gate |
| --- | --- | --- | --- | --- |
| HF-00 | HF-010..013 | takeover handoff/source map only | Git ancestry/status/hash inventory, no product tests needed | Protected trees unchanged; integration base and source decisions reproducible |
| HF-01A | HF-030/031 Tool-policy subset, HF-050, HF-070 Tool evidence subset | Production Gateway composition and focused service tests | Production-bound ToolGateway/Runtime start/events with real SQLite | Existing production tools run through durable Gateway; cross-scope/worker/undeclared/invalid requests do zero I/O; Create/search/read behavior remains intact |
| HF-01B | HF-040/044, HF-030 Context subset, HF-070/072 sequence/restore subset | Host Context/Memory composition, Pi context inputs, event sequencing tests | Same Run Memory hit before real Pi model turn; SQLite reopen | Host/Kernel sequence ownership explicit; required retrieval failure invokes zero model calls; accepted context/fingerprint/budget survive restart |
| HF-02 | HF-020..025 | New Oh-my-Pi adapter/managed worker; dependency boundary tests | LoopKernel conformance + governed custom tool + abort/restore | No ambient discovery/builtin bypass; actual pinned upstream executes, no fake alias |
| HF-03 | HF-040..044,060..062,070..072 | Chat client/API, history, Trace, Memory loading | Submit/stream/stop/continue/interject/history with restart | Full Chat lifecycle uses one Run/Store and shows explicit unavailable states |
| HF-04 | HF-031..033 | Router/RunProfile resolver | End-user goal -> catalog-bound profile/clarification | Business evidence cannot be downgraded to generic answer; no dynamic permission grant |
| HF-05 | HF-050..054 | MCP edge adapter and business profiles | Governed remote I/O contract + approved live canary | Typed read/error receipts; approved writes/readback/idempotence; no Python Agent loop |
| HF-06 | HF-053,080..085 | Coding tools, sandbox, prediction exporter | Isolated repo -> actual patch -> official evaluator | Smoke4 coding loop; prediction/evaluator/performance reported separately |
| HF-07 | HF-060..062,071 | Create/Artifact/activation | Create/edit/list/activate through Host | Versioned artifacts, approval, non-target preservation and error recovery |
| HF-08 | HF-033,060,070..073 | Crew/Channel/Lane/Hub/Scheduler | Parallel Runs, Human signals and scheduled admission | No independent execution store; idempotent projections and occurrence keys |
| HF-09 | HF-001..003,043,061..062 | migration tooling and Desktop launch | Clean install + migration report + process/API trace | Default Host-only Agent Runtime; no hot fallback or lost history/effects |
| HF-10 | all AC rows | deletion, CI, release evidence | Run all supported workflows after removing Legacy imports | Full acceptance; actual OS/benchmark/live gaps remain blockers |

## Per-ticket protocol

1. Record base SHA, scope, owned files and the exact Spec requirements before editing.
2. Read local AGENTS, CONTEXT and applicable ADRs. No frozen source-worktree edits.
3. Demonstrate one observable RED at a public boundary. Implement that slice only, then repeat.
4. Run focused tests and related regressions. Use actual Gateway/Store for lifecycle and permission evidence.
5. Run typecheck, root and workspace tests, Python tests, build and publication checks at the integrated code revision.
6. Review Standards and Spec independently using Sol Ultra; fix P0/P1 and correctness-relevant P2 before closing.
7. Record a handoff with commands, evidence mode, hashes, closed/open requirements, process deviations and next ticket.
8. Commit only owned reviewed files. Push to the explicitly verified Anna-Agent repository; no force push or direct production deployment.

## Initial test boundaries

The first implementation is confined to the existing `createLiveHarnessV2Runtime` / `createDurableHarnessV2Runtime` public start/read-events contract and the existing scoped SQLite Store. Model transport may be deterministic; Memory/Gateway/EventStore/Eval behavior is real. No new UI and no Python runtime feature is part of HF-01.

HF-01A does not implement autonomous routing (HF-032), the complete supervisor crash matrix (HF-072), or Memory hydration. HF-01B cannot claim the Memory Owner UI, grants UI, or overall HF-03 lifecycle complete. This split is fixed before coding because Memory retrieval requires a started Run and the existing Pi adapter owns local sequence advancement.

Approval for this boundary follows the user's explicit Harness-first and SDD instruction. If investigation changes the boundary or expands ownership, record an amendment before continuing.

## HF-00 takeover decisions

- Integration starts from current verified public main, preserving its README/diary and release history.
- Existing development/candidate dirty changes remain in their original worktrees, excluded by default.
- Reference candidate Host/Memory/Gateway implementations by commit/path. Preserve current transcript/resume/Create/search behavior when transplanting.
- The 2026-08-28 Python Task API stays excluded from the integration baseline; port useful contracts/tests into HF-04/05.
- First publication is a reviewed feature branch/PR. Default runtime cutover is not forced merely to meet today's publication date.

## Verification commands

```text
npm run typecheck
npm test
./.venv/bin/python -m pytest -q
npm run build
npm run harness:v2:build
npm run evidence:verify:all
npm run release:verify
git diff --check
```

Run the repository's current security checks and desktop package smoke when relevant to the changed runtime/dependencies. Use workspace-specific Vitest scripts; root Vitest only selects Desktop tests. On Windows use the matching Python executable and test symlink requirements without weakening assertions.

Source-level smoke, deterministic transport, live provider, live MCP, packaged app and benchmark evidence are separate categories. Successful `npm test` does not satisfy missing live or package gates.

## Milestone status

- SPEC: reviewed by Sol Ultra; no P0/P1; HF-01A/B split and Memory lookup semantics clarified before coding.
- HF-00: integration tree created from verified GitHub main; branch census and protected-source fingerprints captured.
- HF-01A: completed by Luna Max; accepted by independent Sol Ultra Standards and Spec reviews. Final local gates and retained risks are recorded in the [2026-08-30 update](../../../product/anna-harness-first-update-2026-08-30.md).
- HF-01B: pending; no Memory hydration completion claimed by HF-01A.
- HF-02..HF-10: planned, not implemented by this document.

Update each status as its evidence becomes available. Do not close all tickets on the strength of the first green slice.
