# General-Agent repair preview — 2026-10-08

Anna remains one Agent on the Node Harness Host + Oh-my-Pi loop. This source preview extends the existing Home/Cowork/Crew surfaces with workdir tools, a macOS process sandbox, configured MCP tools, streaming/Trace, and bounded Session Goals. ERP and Hiker are connectors at the edge.

## Repairs

- Malformed provider tool JSON is retained as an explicit argument-error record. It produces a failed tool result with no execution; the model can correct its next call. Native todo state, usage accounting and durable restore are preserved. A captured failing request was replayed with the same input digest before the repair.
- Workdir opens check every path component in the kernel. Directory enumeration/creation uses a verified pinned working directory; writes are also constrained by the OS. APFS casing/Unicode aliases work, and concurrent swaps cannot redirect the tested reads/writes outside the selected directory.
- Sandbox cleanup follows marker device/inode identity even after unlink, checks process identity before signalling, and reaps ordinary background members of the original process group after the leader exits.
- Crew history, graph/assignment proposals, tables/charts, live output and Trace are retained. Queued steering is visibly distinguished from consumption. Unconfigured Review Inspector navigation is hidden; actual Run traces remain available.
- Loopback/unspecified URL aliases cannot create an app window or be opened as public links. Runtime preparation rejects stale worker/protocol caches instead of silently running older code.
- The Python lockfile now uses urllib3 2.8.0, resolving the three advisories reported by the release dependency audit. See the [upstream security fixes](https://github.com/urllib3/urllib3/releases/tag/2.8.0).

## Verification

Local final verification on macOS arm64:

| Check | Result |
| --- | --- |
| JavaScript, Host and kernel suites (`npm test -- --reporter=dot`) | **1,426 passed, 7 skipped**, exit 0 |
| Python suite | **1,138 passed**, exit 0 |
| Python dependency audit (`pip-audit`) | No known vulnerabilities after the lockfile update |
| Product shell/runtime smoke | **10 passed**, exit 0 |
| Focused Crew browser + link regressions | **14 passed** |
| Typecheck, frontend build, Host build, public-boundary scan | Passed |
| Independent Standards and Spec reviews | Passed after follow-up corrections |

The real desktop resumed the previously failed synthetic Goal using DeepSeek V4 Pro, reached a complete 4/4 plan and `awaiting_review` in **28.5 seconds**, then accepted the tester’s explicit confirmation. This measures that one recovery interaction, not a before/after speedup. Canonical events contain `run.completed` and a passing contract evaluation.

A real Crew run produced a new task proposal. Before confirmation it was absent from the graph; confirmation returned HTTP 200, assigned the new task to the requested member, and added it as a predecessor of the requested existing task. The old channel message, new member mention and both Anna conversations remained after remount. All data was synthetic. Earlier scoped live checks covered file editing + sandbox tests and the local MCP fixture; arbitrary production connectors and new packaged-app distribution are not claimed.

The regression set includes actual intermediate-directory swaps, APFS aliases, marker unlink + setsid at return/timeout/Stop, ordinary background processes with closed marker descriptors, parallel sandbox isolation, strict/permissive malformed-tool inputs, native todo preservation, SQLite reopen, Crew Enter/history/remount, and stale runtime preparation.

## Boundaries

- Validation and strict workdir/Sandbox support are macOS arm64 only. Strict file tools fail closed on unsupported platforms. A directory selected in the UI is not itself a sandbox.
- The sandbox restricts process access; it is not a container or VM. Fully detached processes that close all inherited descriptors before discovery can remain alive under those same restrictions. macOS/Node offers no atomic pidfd signalling, leaving a narrow process-ID reuse window. No guarantee covers every possible descendant.
- Concurrent directory changes can fail an operation; a safe create may leave an empty in-root file. Filename spelling in write/edit results follows the caller under a canonical parent directory.
- Goal continuation is bounded by `max_runs` (at most 8). Pause prevents later rounds; the current round may finish. Stop cancels active work. Completion awaits explicit user review. A Host restart settles interrupted Runs as failed; continuing a Goal starts another Run.
- MCP fixture tests prove the Host path, not access to any arbitrary remote service. Real ERP mutations and cross-platform release acceptance are outside this validation.
- The existing [Jev comparison](../../evals/jev-crew/jev03-final-20260922-r1/REPORT.md) is unchanged: 24 heldout cases, 22 eligible judgments; equal 22/22 label agreement, p50 lower by 85.23%, off-peak/cache-miss estimated cost lower by 94.71%, reported total tokens higher by 57.98%. These figures are historical judgment-level measurements, not a measured speedup or cost reduction for the new general-Agent workflows.

## Updating a prepared checkout

Stop Anna before replacing a materialized runtime. If `npm run harness:omp:prepare` reports stale worker/protocol/lock inputs, move `build/omp-runtime/darwin-arm64` aside and prepare it again using the documented pinned Bun archive. See [DEVELOPMENT.md](../../DEVELOPMENT.md). Credentials, private state and raw provider captures remain outside the repository.
