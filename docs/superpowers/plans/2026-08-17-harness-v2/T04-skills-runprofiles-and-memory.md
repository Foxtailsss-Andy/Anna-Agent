# T04 · Skills, RunProfiles and Memory

## Depends on

T02; integrates with T01/T03 contracts.

## Goal

Create versioned capability/configuration objects and channel-scoped learning with human-controlled promotion.

## Scope

- Skill catalog for Agent Skills `SKILL.md` with hash/version/provenance;
- Worker Profile and RunProfile resolution/snapshot;
- Run Context builder and compaction invariants;
- Channel Memory repository and explicit Workspace Memory grants;
- MemoryCandidate proposal, accept, reject, edit and delete;
- memory-hit provenance events.

## Red tests

1. running Run keeps its snapshotted profile after configuration changes;
2. failed Run cannot silently write Memory;
3. unaccepted MemoryCandidate is absent from future context;
4. Channel isolation and grant revocation hold after restart;
5. deletion removes future retrieval while retaining an audit tombstone;
6. compaction preserves goal, constraints, pending Tool calls and provenance.

## Acceptance

- deterministic retrieval fixture passes;
- memory hits are visible in Trace;
- Skills cannot broaden Tool permissions;
- no automatic Workspace Memory write exists.
