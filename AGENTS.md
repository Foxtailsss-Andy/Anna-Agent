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
- Windows is the primary distribution target. Windows and macOS local development both use Python 3.12 or 3.13.

## Local development

- Runtime configuration and secrets live in `.anna/runtime.json`; `.anna/` must stay out of Git and must not be printed in logs.
- The desktop shell starts the Python backend. Hiker, reimbursement, and the optional Associate ERP connector are configured as external MCP endpoints. Normal launch: `npm run desktop:run`.
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
