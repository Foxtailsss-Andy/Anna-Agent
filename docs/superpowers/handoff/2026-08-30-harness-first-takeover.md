# HF-00 Harness-first Takeover

Date: 2026-08-30
SPEC: [HF-SPEC-1.0](../../product/anna-harness-first-spec-2026-08-30.md)
Status: source census complete; source trees preserved; functional migration not claimed.

## Fixed points

| Source | Verified revision | Disposition |
| --- | --- | --- |
| GitHub Anna-Agent main | `df1bf0ccb954af7a174e7aa1671dae9379d07da0` | Integration baseline, fetched from the intended repository |
| Protected development | `df034523e62f3eebca3beb60d769c7b1bbcfcbf0` | Dirty; no edits, reset or automatic import |
| Protected candidate | `2f94d34796692d9a32932ba793e3cbd7f132cf2a` | Dirty; committed source used only for inspection |
| Shared development/candidate ancestor | `5aecdac8fc4f8bac1cfaa54a4f2b57a0fac2c936` | 19 development-only and 108 candidate-only commits |
| Integration branch | `codex/harness-first-20260830` | New worktree, initial source equals public main |

The public baseline differs from the protected development HEAD only in the two README files. The initial integration tree does not include the 2026-08-28 uncommitted Python Task API/Hiker changes or the candidate's uncommitted files.

## Source decisions

| Capability | Reference source | Integration rule |
| --- | --- | --- |
| Default Host and scoped Chat | Candidate Electron and Harness service | Select behavior after tests; do not import unsupported-surface regressions |
| Durable tool dispatch | Shared `createToolGateway`; candidate Run composition | Use existing public Gateway/Store contracts, not another implementation |
| Memory hydration | Candidate `run-runtime` and Pi context injection | Separate ticket; preserve current transcript/fingerprint/sequence constraints |
| Transcript restore/resume | Current Pi and durable Runtime | Retain existing tests while changing composition |
| Create/search | Current artifact/projection/activation and search adapters | Preserve current scoped behavior; no ambient upstream tools |
| Python Task API | Protected uncommitted prototype | Excluded; contracts may inform later Router/Connector tickets |
| Oh-my-Pi | Evaluated upstream source pin in SPEC | Not installed or activated in HF-00; runtime and license gates precede adoption |

## Evidence

- Read-only branch ancestry/status checks confirmed both source baselines.
- Tracked diff, untracked-file content and porcelain-status SHA256 snapshots were recorded privately before work; no protected content was copied into publication evidence.
- Fetched only the intended public `main` and created a new branch without changing either protected worktree.
- `npm ci --ignore-scripts` succeeded in the isolated integration tree from the existing lockfile; reported zero npm audit findings at installation time.
- Only Bun executable availability was observed. Docker executable was not found in this shell. No SWE-bench inference/evaluation was attempted or claimed.
- No real model/MCP credentials or local runtime databases were read for this takeover.

## Review and next ticket

Luna Max performed read-only takeover analysis. Sol Ultra reviewed the architecture and benchmark acceptance boundary. SPEC freeze and HF-01A coding approval are recorded separately in the implementation handoff after review.

HF-01A is limited to the actual production durable ToolGateway composition. Full default-Harness Desktop cutover, Oh-my-Pi activation, Memory hydration, live business calls, and benchmark readiness remain open.
