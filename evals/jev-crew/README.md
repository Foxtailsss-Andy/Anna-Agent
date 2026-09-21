# Jev Crew evidence

The [final frozen A/C/D comparison](jev03-final-20260922-r1/REPORT.md) contains the requested/returned models, eligible denominators, raw and final choices, measured latency, tokens and dated cost assumptions. The [real UI report](jev02-ui-r1/REPORT.md) separately covers explicit suggestion, adoption and SQLite readback. Neither establishes a new complete Worker run.

The published heldout set has now been used. Re-running it is a reproduction/diagnostic check, not fresh generalization evidence. Keep its labels and bytes unchanged; new generalization claims require a new independently labeled heldout set.

An operator can reproduce the command against protected configuration and an existing private ledger:

```bash
ANNA_JEV_API_KEY_FILE=/protected/typesafe.key \
ANNA_HARNESS_HOST_CONFIG_PATH=/protected/host.json \
node scripts/jev-crew-eval.mjs --mode comparison --live \
  --round operator-reproduction --split all --groups A,C,D --final-freeze \
  --output-dir /private-evaluation/runs --ledger /private-evaluation/budget-ledger.json
```

Replace these portable placeholders with protected local paths. Continue the same budget ledger; do not reset an existing ledger. Jev is capped at500 requests or$2, the generation model at100 requests, and all models at$10. Unknown usage stops further paid batches. The command outputs raw JSONL privately; published results here are sanitized JSON arrays.

Original command logs, machine-specific launch capsules and private pre-publication commits are retained in the operator archive. [Publication provenance](publication-provenance.json) lists archived raw paths and JSON conversions. Old candidate/build manifests refer to their explicitly named historical rounds, not the final current checkout; use the final round and release CI for current validation. Raw log paths in old worklogs identify archived evidence, not files shipped in this public tree.
