---
status: accepted
---

# Anna is channel-scoped

Each Channel has exactly one Anna and one Channel Session. Parallel pipelines are Runs/Lanes governed by that Anna, not additional Annas; Context and Memory are isolated by Channel unless an explicit cross-channel grant exists. This preserves a single coordinator for every shared collaboration space without creating a globally omniscient Agent.
