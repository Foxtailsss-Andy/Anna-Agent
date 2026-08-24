---
status: accepted
---

# Pi loop kernel behind a new TypeScript control plane

Anna Harness v2 will use pinned `pi-agent-core` and `pi-ai` behind an Anna-owned `PiLoopKernel` adapter, while a new TypeScript Control Plane owns Channel Session, durability, policy, Memory, Eval and Trace. The old Python Harness is frozen and replaced through API/event contracts; Pi is neither embedded as another Python subprocess nor forked, and Pi's unfinished `AgentHarness v2` is not a release dependency.
