# Harness-first Preview Candidate

Date: 2026-08-31.
Scope: [HF-PREVIEW-1.0](../../product/anna-harness-first-preview-goal-2026-08-31.md).
Base: `f9f4e1ae06eb4fa54e6f5ebf2974de34ff341b64`.
Branch: `codex/harness-first-preview-20260831`.

This is a candidate handoff, not a completed release or a claim of full business migration.

## Default Path

`Electron -> one Node Preview Host -> actual Oh-my-Pi -> Host model transport / ToolGateway -> Contract Eval -> terminal event`.

- Default application mounts only the Preview task/settings/history UI.
- The Host serves `/api/preview/*` and the built UI on one loopback origin.
- Preview configuration and SQLite state are separate from legacy Python state.
- The admitted tool surface is read-only. Legacy business routes have no execution fallback.
- OMP implementation/runtime identity is verified using the accepted S2 contract.
- SSE carries canonical lifecycle/tool/transcript events. Per-token generation is not claimed.
- Completed history is read from the same scoped SQLite event store.

## Coding Evidence

GPT-5.6-Luna Max owned the Host and Desktop implementation. The owners reported:

| Area | Focused result |
| --- | --- |
| Preview HTTP boundary | 7 passed |
| Preview lifecycle/history/stop/SSE | 1 passed |
| Actual OMP, accepted Memory, file tool, Eval | 1 passed |
| Existing service compatibility | 33 passed |
| EventStore | 106 passed |
| Desktop/Preview smoke | 26 passed |
| SSE and punctuation | 4 passed |
| Existing frontend unit suites | 651 passed |

These are focused owner results, not a replacement for final candidate CI.
An interrupted long workspace run is not counted as passing evidence.

Root verification before review:

- `npm run typecheck`: passed across the frontend and all Harness workspaces.
- Independent pinned Bun worker strict typecheck: passed.
- `uv run pytest -q`: 1048 passed, 53 existing warnings. This maintains legacy sources; Python is not the default Preview runtime.
- `npm run build`: passed, 44 modules in the focused frontend bundle.
- Public source boundary scan included tracked and untracked candidate files: passed.
- `git diff --check`: passed.

## Actual Default-Entry Smoke

Root launched the normal Electron entry with an isolated test state directory.
The browser opened the same Preview Host URL served to Electron. Its process tree
had no Python or uvicorn child. Browser network requests used `/api/preview/*`.

The transport was a local HTTPS fixture with an explicitly generated test key and CA.
OMP, Bun, Host preparation, ToolGateway, filesystem reads, and SQLite were actual implementations.
This is deterministic integration evidence, not a live remote Provider result.

| Scenario | Observed result |
| --- | --- |
| No model configured | Settings and UI opened; status explicitly not ready |
| Read file | Actual witness file content reached the answer; two model responses, one tool dispatch, 22 contiguous Run events, Eval then one completed terminal |
| Stop waiting model | User pressed Stop; Provider request closed, no model response/tool, eight contiguous events, Eval then one cancelled terminal |
| Provider failure | No invented answer, eight contiguous events, Eval then one failed terminal |
| Named SSE regression | Initial UI stayed queued because the shared reader ignored `event: canonical`; corrected reader automatically displayed events/final answer and re-enabled input |

Initial detail/history rendering was also exercised through the public API and UI.
Final packaged/reopen and safety evidence must be recorded against the final candidate revision.

## Remaining Gates

- Real remote Provider smoke from the default UI using user-supplied local configuration (P2).
- Final scoped security, stop/reopen, and packaged smoke after source freeze.
- GPT-5.6-Sol Ultra Standards and Spec review, followed only by affected-line rechecks.
- Current-revision CI, public source/Preview build, and precise release notes.

Advanced controls, recovery matrices, business MCP migration, multiplatform distribution,
full coding tools, and SWE-bench remain in the [community backlog](../../product/anna-harness-first-community-backlog-2026-08-31.md).
The old S3 worktree and legacy data were retained; no reset, cleanup, or import was performed.
