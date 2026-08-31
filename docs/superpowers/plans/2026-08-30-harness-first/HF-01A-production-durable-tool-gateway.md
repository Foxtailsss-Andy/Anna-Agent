# HF-01A: Production DurableToolGateway

Date: 2026-08-30
Spec: [HF-SPEC-1.0](../../../product/anna-harness-first-spec-2026-08-30.md)
Code base: `7c5ca7f7a6797604b82a853eee5c4652b375e318`
Coding: GPT-5.6-Luna Max. Review: GPT-5.6-Sol Ultra.
Status: implemented by Luna Max and accepted by Sol Ultra Standards and Spec review. See the [verification and limitations](../../../product/anna-harness-first-update-2026-08-30.md).

## Outcome

The existing `createLiveHarnessV2Runtime` production path invokes the existing durable `createToolGateway`. The handwritten execution object is no longer the production policy authority. Binding is derived from the immutable admitted Run/Profile, never from an untrusted Tool request alone.

Coverage is limited to HF-050, the Tool policy part of HF-030/031 and Tool evidence part of HF-070. This ticket does not close full Host loading, Router, Memory, recovery, Oh-my-Pi, or Desktop migration requirements.

## Owned files

- `apps/harness-service/src/production.ts`
- Necessary small production Tool catalog/adapter module under `apps/harness-service/src/`
- Matching focused production/Gateway tests under `apps/harness-service/test/`
- `packages/pi-loop-kernel/src/pi-loop-kernel.ts` and matching tests only if production Create effect identity or effective worker binding needs an adapter change; record the reason before editing.
- Development handoff `docs/superpowers/handoff/2026-08-30-hf-01a-durable-tool-gateway.md`

Any other ownership expansion requires a recorded main-Agent decision before edits. No Python, Desktop startup, dependency, Memory, SPEC or release-document changes belong to the coding Agent.

### Ownership amendment: local Artifact effects

Approved by the main Agent on 2026-08-30 after Sol Ultra's focused contract review, before the core edit. Existing `allow + effectKey` fails with `invalid_tool_combination`; the existing effect ledger is otherwise usable. A local draft Artifact does not require activation approval, and the implementation must not fabricate an approval to use that ledger.

- Additional owned files: `packages/harness-v2/src/tool-gateway.ts` and `packages/harness-v2/test/tool-gateway.test.ts` only.
- Permit `allow` with a nonempty effect key and an explicit `safe` or `never` replay policy to invoke the existing `executeEffect`. Keep the current `allow + safe + no key` read path and the entire `require_approval` path unchanged. Missing policy, missing/empty identity and unsupported combinations remain fail-closed.
- Local Artifact generation uses `replayPolicy: never`: its exclusive filesystem write is not safely repeatable. A persisted success returns its original result; an uncertain dispatched effect is reported unknown and is not rewritten. Activation and external business writes retain their separate approval requirements.
- Add RED/GREEN tests for this new allowed combination and for invalid/denied/unapproved combinations, duplicate/changed-intent effects and unknown outcomes. Do not change shared effect-ledger implementation or weaken existing approval tests.
- Production policy must also bind Run and parent/Lane attribution to the captured admitted command. A request cannot select another Run that happens to share a worker.

## Required behavior

1. Preserve existing `read_only`, configured `web_search`, and `create_artifact` output/validation contracts.
2. Bind Gateway scope and worker to the admitted Run snapshot. Cross-Workspace/Channel/Run/worker requests and tools absent from the effective profile fail before adapter I/O.
3. Validate typed Tool input before file/network/Artifact access; unknown tools never reach adapters.
4. Persist `tool.requested`, policy and terminal result evidence using the same scoped Event Store as the production Runtime.
5. Artifact effects use a stable scoped identity and existing effect ledger semantics; replay must not duplicate Artifact writes or silently replace output. Activation approval remains outside generation.
6. Preserve Pi transcript/resume, canonical sequence and existing Contract Eval ordering. Do not fix this by removing guards or dropping lifecycle evidence.
7. Production must use the new composition, not only an exported helper that tests invoke independently.

## Public test boundaries

- Existing production Runtime public start/read-events contract with a real scoped SQLite Store and actual Pi adapter where feasible. Provider transport may be deterministic and explicitly labeled.
- Existing `ToolGateway.execute` as bound by the production factory, with real policy/Store and controlled tool I/O.
- Real Artifact filesystem output under temporary directories for generation/replay tests.

## RED and acceptance

Record the observed RED before each changed behavior and the corresponding GREEN command. At minimum verify:

- valid read returns the existing result and durable lifecycle;
- invalid input never accesses the adapter;
- unknown or Profile-disabled Tool does not execute;
- cross-scope and worker mismatch cannot execute;
- Create uses its own effective worker/profile and still yields a validated Artifact;
- configured/unconfigured/failed WebSearch preserves its truthful boundary;
- reopen/replay preserves durable Tool evidence and does not duplicate effects;
- production factory integration invokes this Gateway, and existing Pi/Runtime/Create regressions pass.

No real MCP or paid Provider request is required for this deterministic ticket. No fixture success is reported as live evidence.

## Handoff and review

Run focused suites and relevant typechecks. Main Agent runs repository, package and release gates after integration. Handoff includes exact files, commands/results, RED/GREEN chronology, source reuse and remaining requirements. Sol Ultra reviews Standards and Spec independently. Fix P0/P1 and correctness-related P2 before commit; no automatic push by the coding Agent.
