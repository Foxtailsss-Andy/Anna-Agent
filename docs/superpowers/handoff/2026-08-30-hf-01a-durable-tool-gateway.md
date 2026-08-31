# HF-01A Durable Tool Gateway Handoff

Date: 2026-08-30
Branch: `codex/harness-first-20260830`
Coding agent: GPT-5.6-Luna Max
Status: implementation complete; no commit, push, or merge performed.

## Delivered

- `createLiveHarnessV2Runtime` now creates a production `ToolGateway` from
  each admitted `StartRun`. The gateway captures Workspace, Channel, Run,
  parent/Lane attribution, worker, and the immutable profile Tool allowlist.
- The production catalog keeps `read_only`, `web_search`, and
  `create_artifact`. Input schemas run before adapter I/O. Scope, worker,
  Run, parent/Lane, and profile-disabled requests fail closed.
- All production Tool lifecycle events use the Runtime's scoped Event Store.
  Artifact generation uses the existing `createSkillArtifact` adapter and a
  stable Pi-generated scoped effect key with `replayPolicy: never`.
- The production Create replay test closes the initial SQLite Store, reopens
  the same database, recreates the Gateway, and verifies the persisted result
  is returned without a second Artifact write.
- The existing effect ledger is reused for explicitly allowed `safe`/`never`
  effects. The `require_approval` path and ledger implementation are unchanged.
  The new explicitly allowed-effect path requires non-empty string identities;
  ledger replay is checked before cancellation, so persisted success/unknown
  remains authoritative with an aborted signal. A fresh cancelled request
  records `started -> cancelled` while dispatching zero adapter I/O.
- `create_artifact` rechecks cancellation at its adapter entry. Cancellation
  observed after `tool.effect.started` is persisted and before that entry guard
  returns `failed/cancelled` without creating a file. This does not promise
  rollback of filesystem operations after the adapter has already started.
- Pi tools use a Gateway and worker identity resolved from the admitted Run
  snapshot, while the static Gateway option remains source-compatible for
  existing callers.

## Owned files

- `apps/harness-service/src/production.ts`
- `apps/harness-service/src/production-tools.ts`
- `apps/harness-service/test/production-tools.test.ts`
- `packages/pi-loop-kernel/src/pi-loop-kernel.ts`
- `packages/pi-loop-kernel/test/pi-loop-kernel.test.ts`
- `packages/harness-v2/src/tool-gateway.ts`
- `packages/harness-v2/test/tool-gateway.test.ts`

The working tree also contains main-Agent documentation/README changes. They
were not modified by this implementation.

## RED to GREEN evidence

- The first allowed Artifact effect previously returned
  `invalid_tool_combination`; the new allow branch now executes through the
  existing ledger and deduplicates (`tool-gateway.test.ts`, 23 passed).
- A runtime array `effectKey` previously entered the allowed effect path and
  executed the adapter. The new `typeof key === "string"` guard returns
  `invalid_tool_combination` with zero effect events.
- For the cancellation race, removing the production adapter guard produced
  a failing test (`exit 1`): the result was `status: "succeeded"` and an
  Artifact file existed after `tool.effect.started` aborted the signal.
  Restoring the guard makes the same test pass (`1 passed`); it returns
  `failed/cancelled`, records `started -> cancelled`, and leaves no file.
- The correction RED reproduced three durable replay regressions: an aborted
  success replay and aborted unknown replay both returned `failed/cancelled`,
  while a fresh pre-abort had no effect receipt. The final dispatch guard makes
  all three pass: persisted results are reused, and fresh cancellation has a
  durable `started -> cancelled` receipt with zero adapter execution.
- The Pi static-Gateway regression had a Run snapshot worker of
  `fixture-worker` but a Gateway bound to `worker-profile-1`, yielding zero
  adapter requests. Binding the test fixture and Pi request to the admitted
  worker restores the real request; the full Pi focused test is `27 passed`.
- Allowed-effect duplicate, concurrent, changed-intent, orphan-to-unknown,
  invalid-identity, and pre-cancelled cases are covered by the focused
  harness-v2 suite.

## Verification

All commands were run serially from the integration worktree:

```text
npm run test --workspace=@anna/harness-service -- --run test/production-tools.test.ts
  Test Files 1 passed; Tests 16 passed
npm run test --workspace=@anna/harness-v2 -- --run test/tool-gateway.test.ts
  Test Files 1 passed; Tests 23 passed
npm run test --workspace=@anna/pi-loop-kernel -- --run test/pi-loop-kernel.test.ts
  Test Files 1 passed; Tests 27 passed
npm run typecheck --workspace=@anna/harness-service && \
  npm run typecheck --workspace=@anna/pi-loop-kernel && \
  npm run typecheck --workspace=@anna/harness-v2
  exit 0
git diff --check
  exit 0
```

Production integration tests use temporary real SQLite stores, temporary
workspace files, the actual `PiLoopKernel`, and deterministic `pi-ai` stream
fixtures. No paid Provider, live MCP, real credentials, or real business data was used.

## Remaining scope

This handoff does not claim HF-01B Memory loading, Host/Router completion,
recovery ownership, Oh-my-Pi integration, Desktop cutover, Legacy removal, or
release readiness. The main Agent should run the repository/package/release
gates and obtain the independent Sol Ultra Standards and Spec review before
commit.
