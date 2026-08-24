# T03 · ToolGateway and Sandbox seam

## Depends on

T01 and T02.

## Goal

Make ToolGateway the only path from Pi Tool calls to effects.

## Scope

- typed Tool catalog and schema validation;
- Channel/Worker Profile scope and policy decision;
- durable approval request/answer;
- effect key ledger with never/safe replay policy;
- deterministic fake Sandbox;
- approved isolated-worktree `read_workspace` and bounded patch Tool;
- Tool lifecycle events and Pi observation mapping.

## Red tests

1. Pi cannot call an unregistered or built-in Tool;
2. denied Tool produces no effect;
3. approval-required Tool has zero effect before approval;
4. duplicate effect key executes once;
5. unknown outcome never replays automatically;
6. path escape, symlink escape and writes outside approved worktree fail;
7. cancellation reaches Sandbox and records a terminal Tool result.

## Acceptance

- effect/property tests pass;
- approval survives restart;
- all Tool calls are represented in canonical events and Trace;
- production Sandbox remains explicitly unimplemented until a real containment adapter exists.
