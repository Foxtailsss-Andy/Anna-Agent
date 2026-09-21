# Jev versus a single DeepSeek judgment · frozen result

Round `jev03-final-20260922-r1`, completed 2026-09-22 (Asia/Shanghai). All 96 A/C/D slots are present and unique. The 8 development cases and 24 heldout cases retain their original bytes, labels and candidate order. There were 29 actual requests per model, no automatic retries, no API/format errors, and no unknown usage. Raw records are retained privately; [public results](results.json), [verified metrics](verified-metrics.json), [settings](settings.json), [round/source hashes](round.json) and [budget snapshot](budget-after.json) are available here.

## Heldout: 24 cases, 22 eligible model inputs

Two hard-precheck cases were retained as `not_run` for C/D and are not model successes. The table compares the same 22 eligible cases. Label agreement includes correct abstention.

| Measure | A: existing role rules | C: DeepSeek single judgment | D: production Jev adapter |
| --- | ---: | ---: | ---: |
| Requested → returned model | No model | deepseek-v4-pro → deepseek-v4-pro | jev-1.13.0 → jev-1.13.0 |
| Provider calls | 0 | 22 | 22 |
| Label agreement | 12/22 (54.55%) | 22/22 (100%) | 22/22 (100%) |
| Correct recommendations / recommendation-label cases | 8/12 | 12/12 | 12/12 |
| Correct abstentions / must-abstain cases | 4/10 | 10/10 | 10/10 |
| Recommendations / abstentions | 14 / 8 | 12 / 10 | 12 / 10 |
| Wrong labels / API or format errors | 10 / N/A | 0 / 0 | 0 / 0 |
| Observed p50 / p95 (ms), n=22 | N/A | 2007.078 / 2692.501 | 296.349 / 421.889 |
| Reported input / output tokens | N/A | 4,887 / 2,873 | 11,233 / 1,026 |
| Reported total tokens | N/A | 7,760 | 12,259 |
| Estimated USD, peak/cache-miss reference | 0 | 0.017827920 | 0.000471786 |

D versus C: p50 **85.23% lower**, p95 **84.33% lower**, reference estimated cost **97.35% lower**. Label agreement is **tied**, not improved. Jev reported **57.98% more total tokens** (input +129.85%, output −64.29%); different tokenizers and request formats mean these counts are not equivalent compute units. No claim of token reduction is made.

DeepSeek used `thinking=enabled`, `reasoning_effort=high`, `max_tokens=4096`, JSON-only output, no tools or loop. D used the existing typed production adapter. Raw Jev choices and the final postguard decisions agreed with labels on all 22 heldout requests; the guard changed none of the 29 choices across this round. No heldout result changed a label, prompt or selection policy.

The timing boundary is the outer elapsed time for one group request, including its request/response handling and excluding Host startup; it is not UI end-to-end latency. Percentiles use nearest rank. This one small sequential round does not establish production accuracy or a stable p95. C is a direct model control, **not the earlier complete Crew matcher/Host/OMP product path (B)**; B and a new ready-Worker terminal demo remain unmeasured in this release.

## Development: 8 cases, 7 eligible model inputs

| Measure | A | C | D |
| --- | ---: | ---: | ---: |
| Label agreement, eligible subset | 2/7 | 7/7 | 7/7 |
| Recommendations / abstentions | 3 / 4 | 4 / 3 | 4 / 3 |
| Observed p50 / p95 (ms), n=7 | N/A | 2059.066 / 9533.392 | 304.053 / 695.813 |
| Input / output tokens | N/A | 1,553 / 1,481 | 3,581 / 327 |
| Estimated USD, same price reference | 0 | 0.007914720 | 0.000150402 |

One development hard-precheck case did not call C/D. The development set includes previously used smoke inputs and is not heldout. A separate single-case connectivity check preceded this round and is excluded from every figure above.

## Cost assumptions and provenance

The budget ledger uses the [DeepSeek official peak/cache-miss prices](https://api-docs.deepseek.com/quick_start/pricing/) ($1.32/M input, $3.96/M output) and [TypeSafe input pricing](https://docs.typesafe.ai/models) ($0.042/M input, output free), checked against documentation dated 2026-09-21. These are estimates, not invoices. This run occurred outside DeepSeek peak hours; applying off-peak rates while still assuming cache misses gives C **$0.008913960** and D **94.71% lower estimated cost**. Cache hits may reduce C further. The 97.35% figure is specifically the ledger's peak/cache-miss reference comparison.

Cumulative project ledger after the round: Jev39 requests, generation model30; estimated $0.027494142 total, zero reservations and no unknown usage. These totals include prior development/UI rounds and the connectivity check, not only this comparison.

The original local evidence and private commit history are preserved outside the publication tree. [Publication provenance](../publication-provenance.json) describes the normalized public export. Models do not receive expected labels, real identities, channel history, credentials or customer data.
