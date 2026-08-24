# T05 · Harness Trace and Eval gates

## Depends on

T01–T04 event contracts.

## Goal

Project canonical events into live OTel-compatible Trace and gate releases with repeatable Contract and Quality Eval.

## Scope

- event-to-span projection aligned with ADR-003;
- live Trace cursor for Run/model/Tool/approval/retry/budget/Eval;
- honest token/cost rules;
- Contract Eval engine and versioned rubric-based Quality Eval;
- Smoke Set of 4 cases and Dev Set of 16 cases;
- failed-Trace classification and Regression Case materialization.

## Red tests

1. active model/Tool spans appear before Run terminal;
2. missing usage creates no zero value;
3. orphaned calls are explicit errors;
4. unknown event remains visible;
5. prohibited side effect fails Contract Eval even with a good Artifact;
6. Eval prompt/model/rubric version changes invalidate cached results.

## Acceptance

- Trace reconstructs one deterministic execution without frame guessing;
- all 4 Smoke cases pass;
- Dev Set report includes stability, quality, latency and available cost evidence;
- at least one deliberately bad candidate is blocked by the release gate.
