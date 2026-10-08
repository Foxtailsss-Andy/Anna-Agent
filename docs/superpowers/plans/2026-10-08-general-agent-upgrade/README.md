# General-Agent upgrade (2026-10-08)

Owner: Kiro · Claude Opus 5.5 / xhigh (user mandate 2026-10-08). Independent final acceptance: Codex.
Baseline: `4697d5c` (= `f8f5f82` + the candidate reviewed on 2026-10-07). Contracts: [CONTRACTS.md](CONTRACTS.md).
Private delivery records (status, worker sessions, logs, live evidence): `/Users/foxtailsss/Desktop/Anna/Anna-Opus-Delivery-20261008/` — not part of the repository.

## Problem

The 2026-10-07 independent review ran the real desktop product with DeepSeek and Jev and found, among others: @Anna proposals failing silently (`NameError` on the product path), Enter with `@member` sending a read-only Anna Run instead of a channel message, no graph-editing/assignment ability for Anna in Crew, lost Crew Anna session after remount/restart, `window.prompt` breaking template project creation in Electron, unreadable narrow tables and no chart rendering, broken Trace surfaces (`/v2` returning SPA HTML, Workbench runs without trace), ~4 s fixed pre-model latency, no streaming, ignored “before X” ordering. Beyond repairs, the user asked for Anna to be a general-purpose Agent: useful tools, MCP, a real Sandbox, long-task goal retention and authorized proactive continuation, with a fuller use of Oh My Pi.

## Decisions

1. **Keep OMP 18.0.11, use it more.** The required capabilities live on the Host side of the `anna-omp/1` protocol. OMP keeps the loop, native `todo` plan state and the steer queue; Host proxies every other tool. The worker change is limited to disabling `todo.reminders` (see the OMP assessment addendum).
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

## Work graph (all writers Opus 5.5 / xhigh, one writer per file)

| Ticket | Scope | Result |
| --- | --- | --- |
| P | Python Crew repairs, `crew.propose_changes`, ordering, background @Anna answers | done, tests added |
| F1 | Crew UI routing/restore/steer, template dialog, proposal card, GFM tables, chart blocks | done, tests added |
| F2 | Home history/streaming/plan/tools/trace/steer/permission/Goal UI | done, tests added |
| T | workdir list/search/write/edit, seatbelt Sandbox | done, tests added |
| M | Host MCP client + fixture server | done (owner completed after worker exits) |
| H (owner) | Host composition: profile/tools/routing, live output, trace, Goal supervisor, steer, manifest cache, diagnostics logs, Electron link routing | done, Host integration tests |

Verification and acceptance evidence are recorded in the delivery directory (`STATUS.md`, `HANDOFF.md`).
