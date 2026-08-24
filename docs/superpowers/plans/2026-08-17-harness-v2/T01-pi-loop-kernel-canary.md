# T01 · Pi Loop Kernel canary

## Depends on

T00.

## Goal

Prove that pinned Pi can drive one Anna Run through the v2 contracts with incremental events, steer, abort, budgets and explicit terminal outcomes.

## Scope

- Pin `pi-agent-core` and `pi-ai` to `0.84.2`.
- Implement `PiLoopKernel`; no other module imports Pi.
- Disable built-in tools and register one fake typed read Tool.
- Use Pi event subscription to emit Anna events incrementally through `EventSink`.
- Support fake provider fixtures for completed, tool-use, steer, abort, timeout and provider-error paths.
- Run one live DeepSeek canary only after deterministic tests pass; redact content and credentials from evidence.

## Red tests

1. a blocked fake provider must emit progress before completion;
2. wall-time/turn budget produces `timed_out`, never unbounded `running`;
3. steer is delivered once at a valid turn boundary;
4. abort produces one terminal event;
5. Pi built-in Tool names are absent;
6. provider usage remains absent when the fake provider omits it.

## Acceptance

- all red tests turn green;
- event order is stable and cursor-friendly;
- no Pi transcript becomes canonical state;
- no file, Bash or network Tool is exposed;
- live canary reaches an explicit terminal outcome.
