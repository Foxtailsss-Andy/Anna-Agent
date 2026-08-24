# T00 · Contracts and TypeScript workspace

## Goal

Create an isolated TypeScript Harness v2 workspace and freeze public contracts before Pi or storage implementation.

## Scope

- Add `packages/harness-v2` for domain/contracts with no Pi dependency.
- Add `apps/harness-service` as the future local Node service shell.
- Configure npm workspaces and focused TypeScript/Vitest commands without changing existing desktop behavior.
- Define branded IDs and schemas for ChannelSession, Run, Event, Artifact, MemoryCandidate, Budget and terminal outcomes.
- Define `LoopKernel`, `EventSink`, `EventStore`, `ToolGateway`, `SandboxAdapter`, `MemoryPolicy`, `EvalGate` and `Scheduler` interfaces.
- Add architecture dependency tests ensuring domain/contracts do not import Pi, Electron or legacy Python assets.

## Red tests

1. invalid/unscoped Event and Run commands are rejected;
2. terminal-state union excludes plain `running` as a terminal result;
3. package-boundary test rejects a Pi import in domain/contracts;
4. existing root typecheck/test/build remain green.

## Non-goals

- no Pi model call;
- no SQLite;
- no HTTP behavior beyond health/version shell;
- no Crew changes.

## Acceptance

- focused package tests pass;
- root lockfile is deterministic;
- public contracts match the source spec vocabulary;
- no legacy runtime code is copied into the new package.
