---
status: accepted
---

# Anna Event Store is the runtime fact source

Channel Session, Run, Event, Checkpoint, Schedule, Memory and Eval state are recorded through one channel-scoped Anna Event Store. Pi transcripts and OTel Trace are projections rather than competing sources of truth; the local implementation uses Node SQLite behind a portable conformance-tested Store interface.
