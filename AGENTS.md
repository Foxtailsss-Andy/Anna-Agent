# Anna repository guidance

## Current initiative: general-Agent upgrade (2026-10-08)

- Active plan and records: `docs/superpowers/plans/2026-10-08-general-agent-upgrade/README.md` (spec, contracts, decisions). The 2026-09-21 Jev Crew Preview is accepted history; keep its metric boundaries and do not reopen its tickets.
- Anna is a **general-purpose Agent**. ERP/Hiker remain edge connectors. General capability (plan/todo, workdir tools, Sandbox exec, MCP, Session Goal, steer, streaming) must stay reachable through the normal Home/Cowork/Crew product flow and the single Node Host + OMP loop; no second model loop and no test-only helper paths.
- Latest user direction (2026-10-08) supersedes the earlier Astra/Luna role map: implementation, tests and evaluation tooling for this initiative are authored by Claude Opus 5.5 / xhigh; Codex performs process confirmation and independent final acceptance. Do not let a coding agent accept its own work for release.
- Use existing domain terms. Read `CONTEXT.md`; keep a typed decision distinct from an Agent Run. Jev is a model used by Anna, not another Agent or execution authority.
- Keep credentials (model, TypeSafe, MCP server secrets) in protected Host-only files outside this checkout and Agent-readable workdirs. Never pass a secret in a task prompt, tool output, URL, public evidence or commit. Evaluation uses synthetic data unless the user explicitly authorizes other data.
- Sandbox claims stay within evidence: `sandbox.exec` is a macOS seatbelt (`/usr/bin/sandbox-exec`) process sandbox, not a container or VM. Directory selection alone is not a sandbox.
- Use the local `tdd` and `code-review` skills at agreed seams; review against the recorded baseline including uncommitted candidate diffs. Preserve user work and unrelated branches. Final public claims require evidence from the actual candidate commit.

## Start here

- Read `CONTEXT.md` before changing architecture, telemetry, naming, or runtime behavior. It is the repository-wide terminology contract.
- Preserve the user's existing staged and untracked work. Do not clean, reset, re-stage, or commit it unless explicitly asked.
- Communicate in Chinese while keeping established English technical terms.

## Product and architecture invariants

- Anna is exactly one Agent: identity + judgment + memory.
- Business domains belong in connectors and run profiles. ERP and Hiker are edge connectors, not the Runtime core.
- Keep Runtime modules deep behind small interfaces. Treat connectors as adapters at edge seams; tests and callers should cross the same interface.
- Do not add domain-specific branches to the Harness core when an adapter or run profile can express the variation.
- Never invent business data, model output, tool output, telemetry, token counts, or success states. Missing evidence stays missing.
- Windows remains the long-term primary distribution target. Current Harness-first product validation is limited to macOS arm64; do not claim Windows/Linux release acceptance.

## Local development

- Preview configuration and state must remain separate from legacy `.anna/runtime.json` and Python databases. `.anna/` must stay out of Git; never print credentials.
- The normal desktop shell preserves Home/Cowork/Crew and uses one Node Harness Host with the verified Oh-my-Pi runtime. It must not fall back to a Python Agent loop. A managed pure business API/connector process may remain without model credentials or Agent execution authority. Normal launch: `npm run desktop:run`.
- The current scope is `docs/product/anna-harness-product-parity-goal-2026-08-31.md`. HF-PREVIEW-1.0 is superseded: do not hide existing product surfaces, reduce Create kinds, or disable Hiker business features to claim migration success.
- Detailed setup and recovery commands are in `DEVELOPMENT.md`.

## Required validation

Run the checks relevant to the change. Before a broad handoff, run all four:

```text
npm run typecheck
npm test -- --reporter=dot
# macOS/Linux
./.venv/bin/python -m pytest -q
# Windows
.\.venv\Scripts\python.exe -m pytest -q
npm run build
```

Windows tests that create symbolic links require Developer Mode or the Create symbolic links privilege. Report that environmental limitation; do not weaken the tests.

Python 3.12/3.13 is needed for the model-less business adapter and retained Python tests. It does not own Agent execution. Keep the original sources and data intact while migration continues.
