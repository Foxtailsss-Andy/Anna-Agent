# JEV-03 accepted evaluation and source-preview handoff

Owner: `01a0c3dd-cf77-71e0-a7a4-f9328035f42a`, Astra xhigh. Work is limited to the branch `codex/jev-crew-preview-20260921`; no other Anna/Workbench checkout was changed. [RELEASE_SCOPE](../RELEASE_SCOPE.md) records the final user authorization.

## Completed

- A/C/D fixed round:96 unique slots, 8development/24heldout unchanged; C/D29 requests each, zero API/format failures, no missing usage. On22 eligible heldout inputs, both raw and final C/D label agreement is22/22; rule A is12/22. Two hard-precheck heldout cases are not model successes.
- Heldout Jev vs single DeepSeek judgment: p50−85.23%, p95−84.33%; peak/cache-miss reference estimated cost−97.35%. Total reported tokens+57.98%; label agreement tied. [Results and limitations](../../../../../evals/jev-crew/jev03-final-20260922-r1/REPORT.md).
- Local full JavaScript1268 passed/7 skipped; typecheck/build exit0; real MemberPicker11 passed. Initial full Python1112passed/1metadata-egress failure, fixed by moving citation metadata to JSON; targeted egress8passed. Final evaluation CLI24passed. Relevant production hashes remained unchanged.
- Final independent Standards and Spec:zero P0/P1 blockers. [Review](../../../../../evals/jev-crew/jev03-final-20260922-r1/REVIEW.md) keeps non-blocking observations separate.
- All implementation write rights returned. Temporary live Host processes stopped normally; no further paid requests are required.

## Budget and preserved evidence

Same shared ledger after all rounds: Jev39 requests, generation model30, estimated total$0.027494142; reserved0, unknown=false. Limits were not raised or reset. Original logs, pre-publication capsules and private Git history are preserved in the operator archive and verified Git bundle/local archive ref. Public copies use portable paths and JSON exports. No heldout labels, prompts or selection policy changed after outputs were observed.

## Publication and remaining limits

Publication is authorized: reviewed clean tree → normal new-branch push/PR → green CI → merge → exact-main-SHA CI → source preview Release. The [Release record](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/tag/jev-crew-preview) is the canonical location for final published commit, PR and CI links, avoiding a metadata-only commit that would change the candidate after validation.

B complete old-workflow timing, a new ready Worker terminal demo, production accuracy, signed installers and Windows/Linux acceptance are outside this release's claims. Existing expanded asyncio-debug shutdown hanging was reproduced on the pre-change baseline and remains a recorded limitation. No OMP, permission-policy, bulk-dispatch or automatic-fallback expansion was made.
