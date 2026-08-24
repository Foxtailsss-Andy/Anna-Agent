# T07 · Review-to-Validated-Patch real scenario

## Depends on

T01–T06.

## Goal

Run the high-frequency product-review-to-tested-development loop end to end with real Artifacts in an isolated Git worktree.

## Scope

- deterministic fixture repository for CI;
- live Anna repository canary in a disposable worktree;
- real review notes, PRD delta, React UI change, rendered screenshot, implementation patch and automated tests;
- PRD/UI review and development approval Gates;
- MemoryCandidate confirmation and scheduled follow-up;
- final merge-ready summary with links to Trace and evidence.

## Red tests

1. development cannot begin before PRD/UI approval;
2. parallel PRD/UI Lanes cannot directly mutate shared facts;
3. worktree mutation cannot escape its root;
4. failed tests block merge-ready outcome;
5. screenshot must come from changed UI build;
6. Artifact hashes/producers/versions remain stable after restart;
7. no push, merge or deployment command is available.

## Acceptance

- CI fixture completes deterministically;
- live canary produces actual diffs, screenshot and passing test evidence;
- every Artifact and Gate is connected by one Trace;
- Human retains final merge decision;
- all generated work can be discarded by deleting the disposable worktree.
