# T02 · Event Store and Channel Session

## Depends on

T00. May develop in parallel with T01.

## Goal

Implement the local canonical Event Store, channel-scoped repositories and crash-safe Run lifecycle.

## Scope

- Node SQLite Event Store with schema versioning and migrations.
- Channel, Run and Effect streams with per-stream monotonic sequence.
- command idempotency, optimistic version/fencing, projection receipts and one terminal event.
- ChannelSession and RunManager services with scope-bound repositories.
- cursor reads during active Runs and restart reconciliation.
- Store conformance suite runnable against in-memory and SQLite implementations.

## Red tests

1. unscoped read APIs do not exist;
2. a second terminal append is rejected idempotently;
3. duplicate command key does not create a second Run;
4. kill/reopen preserves events and reconstructs projections;
5. projection failure leaves source event unacknowledged;
6. two Channels cannot read each other's streams without a grant.

## Acceptance

- conformance suite passes both implementations;
- SQLite WAL/transaction behavior is documented;
- live cursor sees events before Run completion;
- no Pi JSONL file is required for recovery.
