# WB-00 baseline

This directory freezes the AWB-1.2 evaluation dataset and the redacted baseline evidence for WB-00. Dataset `wb00-dataset-v1.1` is an additive update to the original `wb00-dataset-v1`: the baseline family ID stays `wb00-baseline-20260910`, while L-04/L-05/L-06/L-12 now carry static synthetic project, technical-plan, board, worker, review, and dependency facts. These fixtures are comparison inputs, not live MCP or connector evidence.

The original v1 bytes are retained at `fixtures/dataset-v1.json` for historical rounds whose evidence predates per-round snapshots. That fallback is accepted only when the historical result declares `wb00-dataset-v1` and its `datasetSha256` matches the fallback bytes.

Run the deterministic OMP-backed baseline and generate a new, immutable evaluation round with:

```bash
npm run workbench:baseline
npm run workbench:baseline:verify
```

Each run writes to `runs/<evalRoundId>/evidence`; the verifier checks the newest round. Set `ANNA_WB00_EVAL_ROUND_ID` or `ANNA_WB00_OUTPUT_DIR` when a CI job needs an explicit round path. The round directory is created exclusively before the focused test starts, so an existing round ID fails without modifying its files. Every new round stores the exact source bytes as `evidence/dataset-snapshot.json`; verification uses that round-owned snapshot and checks its full SHA-256 plus every slot's expected outcome, source window, and input fixture.

The focused TypeScript test crosses the public Product Profile, OMP Kernel, Product Host, Runtime, EventStore, worker and external model transport seams. The transport is a deterministic boundary fixture; it does not replace the OMP worker, EventStore, Gateway or permission state. The product observation command is kept separate so its Home/Create, Cowork and Crew results can be labelled with their actual evidence mode.

Evidence uses the repository's existing `scripts/build-evidence-manifest.mjs` and `scripts/verify-evidence-manifest.mjs`. Model usage and external live quality are `unavailable` or `blocked` when the provider/connector is not configured; no missing value is changed to zero or pass.
