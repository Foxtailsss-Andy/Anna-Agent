# General-Agent upgrade (2026-10-08)

Owner: Codex, following the user’s 2026-10-08 takeover instruction. Kiro’s Opus implementation and independent reviews form the input baseline; Codex integrates fixes, validates the final candidate and publishes it.
Baseline: `4697d5c` (= `f8f5f82` + the candidate reviewed on 2026-10-07). Contracts: [CONTRACTS.md](CONTRACTS.md).
Private session records, credentials and raw live-provider captures remain outside the repository. Public verification is recorded in the release notes.

## Problem

The 2026-10-07 independent review ran the real desktop product with DeepSeek and Jev and found, among others: @Anna proposals failing silently (`NameError` on the product path), Enter with `@member` sending a read-only Anna Run instead of a channel message, no graph-editing/assignment ability for Anna in Crew, lost Crew Anna session after remount/restart, `window.prompt` breaking template project creation in Electron, unreadable narrow tables and no chart rendering, broken Trace surfaces (`/v2` returning SPA HTML, Workbench runs without trace), ~4 s fixed pre-model latency, no streaming, ignored “before X” ordering. Beyond repairs, the user asked for Anna to be a general-purpose Agent: useful tools, MCP, a real Sandbox, long-task goal retention and authorized proactive continuation, with a fuller use of Oh My Pi.

## Decisions

1. **Keep OMP 18.0.11, use it more.** The required capabilities live on the Host side of the `anna-omp/1` protocol. OMP keeps the loop, native `todo` plan state and the steer queue; Host proxies every other tool. The worker disables `todo.reminders`; the Host owns continuation and handles malformed tool arguments as explicit failures before any effect.
2. **One loop, one authority.** All new capability is reachable through ordinary Workbench Runs from Home/Crew; no second model loop.
3. **Permission modes:** `readonly` (default) and `contained-write` (requires one bound workdir) — see `CONTEXT.md` §6.
4. **Sandbox:** macOS seatbelt via `/usr/bin/sandbox-exec` per command (no network, writable workdir + scratch only, user data roots unreadable, scrubbed env, process-group timeout). Not a container; not admitted where unavailable.
5. **MCP:** Host-side client (stdio + Streamable HTTP, no new dependency), servers from a protected Host file; tools admitted as `mcp.<server>.<tool>`.
6. **Capabilities:** the existing progressive catalog stays (restore-tested); new general tools are direct Host tools active from the first request. Instructions tell the model to search the catalog once with an empty query.
7. **Session Goal:** user-authorized objective, `max_runs` ≤ 8, Host supervisor decides continuation from durable evidence only; completion needs the user's confirmation.
8. **Streaming:** ephemeral `live_output` on the run projection; canonical events unchanged.
9. **Trace:** OMP-aware projection in `@anna/trace`, served for Workbench runs; `/v2/*` is JSON 404 on the Product Host.
10. **Crew:** structured-mention routing; `crew.propose_changes` → Coordination Proposal card → owner confirm (ordering via `insert_before`, assignments through the normal assign path); legacy @Anna intent path repaired with visible failure rows; @Anna always gets an answer, card or failure row.
11. **Latency:** runtime manifest verified fully once per Host process, metadata fingerprint per Run.
12. **Run budget:** a Workbench Run admitted with any direct tool beyond `todo`/the catalog gets 24 turns, 96 tool calls, 300 s wall time (the earlier 12-turn ceiling ended ordinary write→run→verify tasks; live L04 needed 8 model requests, L07 Goal Runs 8–10). Longer work continues through the Session Goal, which counts each Run against `max_runs`.
13. **Review corrections:** workdir write/edit containment is segment-wise with inode re-verification and hard-link refusal; regex search runs in a worker with a time budget; the seatbelt profile is deny-default (no Mach/XPC desktop services) and the Host sweeps observed descendants and marker-inode holders on return, timeout or Stop, subject to the limits in CONTRACTS §3.2; interrupted Runs are settled at Host start so Goals cannot stay `active` forever; MCP connects in the background; the desktop shell never opens a second window for a link; only blocked plan items pause a Goal (`plan_blocked`).

## Work graph (Opus baseline; Codex fixes and independent release review)

| Ticket | Scope | Result |
| --- | --- | --- |
| P | Python Crew repairs, `crew.propose_changes`, ordering, background @Anna answers | implemented; source-preview gates and scoped product checks passed |
| F1 | Crew UI routing/restore/steer, template dialog, proposal card, GFM tables, chart blocks | implemented; source-preview gates and scoped product checks passed |
| F2 | Home history/streaming/plan/tools/trace/steer/permission/Goal UI | implemented; source-preview gates and scoped product checks passed |
| T | workdir list/search/write/edit, seatbelt Sandbox | implemented; concurrency/cleanup regressions and independent review passed |
| M | Host MCP client + fixture server | implemented; local fixture/integration tests passed |
| H (owner) | Host composition: profile/tools/routing, live output, trace, Goal supervisor + restart settlement, steer, manifest cache, diagnostics logs, Electron link routing | implemented; Host gates and real Goal recovery passed |

Final source-preview verification and its limits are recorded in [the release note](../../../releases/general-agent-20261008.md). Private session logs and raw provider captures remain outside Git. Independent Standards/Spec reviews and the local gates are complete; packaged and cross-platform distribution remain outside this handoff.
