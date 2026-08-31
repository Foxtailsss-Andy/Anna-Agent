# Anna repository guidance

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
- Windows remains the long-term primary distribution target. The Harness-first Preview is currently validated only on macOS arm64; do not claim Windows/Linux release acceptance.

## Local development

- Preview configuration and state must remain separate from legacy `.anna/runtime.json` and Python databases. `.anna/` must stay out of Git; never print credentials.
- The normal Preview desktop shell starts one Node Harness Host with the verified Oh-my-Pi runtime. It must not start or fall back to the Python Agent backend. Normal launch: `npm run desktop:run`.
- The current scope is `docs/product/anna-harness-first-preview-goal-2026-08-31.md`. Hiker/MCP business writes and unmigrated legacy surfaces stay closed in this Preview.
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

Python 3.12/3.13 is needed for retained legacy tests, not for the default Preview runtime. Keep the legacy sources and data intact while migration continues.
