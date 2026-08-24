# T06 · Scheduler and proactive Runs

## Depends on

T02, T04 and T05.

## Goal

Support bounded, explainable proactive Runs while the local service is available.

## Scope

- durable schedule records and due-time claims;
- unresolved-thread SLA, waiting-node deadline and registered monitor triggers;
- catch-up policy after application restart;
- Run creation with trigger, budget, permission and notification audience;
- schedule lifecycle events and cancellation.

## Red tests

1. same schedule occurrence starts at most one Run;
2. clock advance triggers deterministically without real sleeps;
3. missed occurrence follows explicit skip/catch-up policy;
4. cancelled schedule never triggers;
5. proactive Run cannot exceed Channel/Tool permissions;
6. every proactive notification links to trigger and Run.

## Acceptance

- ManualClock suite passes;
- restart retains schedules;
- no free ambient scan path exists;
- local-runtime limitation is exposed by API/UI.
