# Anna Harness v2 · Implementation Ticket Map

> Source spec: `docs/product/anna-harness-v2-spec-2026-08-17.md`  
> Development model: GPT-5.5 high  
> Independent review model: GPT-5.6 Sol xhigh

## Dependency map

```text
T00 Contracts and workspace
 ├─ T01 Pi Loop Kernel canary
 └─ T02 Event Store and Channel Session
      ├─ T03 ToolGateway and Sandbox seam
      ├─ T04 Skills, RunProfiles and Memory
      └─ T05 Trace and Eval
           └─ T06 Scheduler and proactive Runs
                └─ T07 Review-to-Validated-Patch live scenario
                     └─ T08 Desktop cutover and legacy deletion
```

T01 and T02 may proceed in separate worktrees after T00. T03–T06 must integrate through the contracts frozen by T00/T02. T07 begins only after T03–T06 pass their own gates.

## Ticket discipline

Each ticket runs in a fresh Agent context:

1. read `AGENTS.md`, `CONTEXT.md`, relevant ADRs and the source spec;
2. confirm the fixed-point diff and protect user work;
3. use red → green → refactor;
4. run ticket checks plus the repository four-gate suite relevant to the diff;
5. produce a handoff with changed files, tests, unresolved evidence and next ticket inputs;
6. request GPT-5.6 Sol xhigh review along Standards and Spec axes;
7. address only actionable review findings before closing the ticket.

No ticket may modify Crew product behavior unless T08 explicitly switches an accepted surface.
