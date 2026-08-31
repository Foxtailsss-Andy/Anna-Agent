# Anna local development

The product uses the original React/Vite/Electron Home, Cowork and Crew interface, one Node Harness Host, and the pinned Oh-my-Pi worker. A managed Python business service retains identity, stores, business state machines and connectors. It receives no model credentials and must not execute the old Agent loop. The current desktop validation target is macOS arm64.

Run all commands from the repository root. Platform-specific `.venv`, `node_modules`, build output, and `.anna` runtime state are local-only and must not be copied between operating systems or committed.

## Launch the desktop app

Requirements: macOS arm64, Node.js >=22.19.0, Python 3.12 and `uv`. Prepare dependencies in a fresh checkout:

```bash
npm ci
uv python install 3.12
uv sync --locked --extra dev
ANNA_OMP_BUN_ARCHIVE_URL=https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip npm run harness:omp:prepare
```

```text
npm run desktop:run
```

The launcher builds the frontend and Harness service and starts Electron, a Node Product Host and its business peer. The Host serves the original UI and explicitly routes the original business APIs on one loopback origin. Agent operations submit whole tasks to the token-protected Host contract; they do not proxy one model call into an old Python Agent loop.

Keep the prepared runtime in `build/omp-runtime/darwin-arm64`. Worker or protocol source changes require a fresh, verified runtime; do not reuse an artifact from another revision. OMP verification failure must remain an explicit error, with no Python or Pi Agent fallback.

Home Chat/Create, Cowork and Crew are retained product requirements. See the [current Goal and live gates](docs/product/anna-harness-product-parity-goal-2026-08-31.md). The [community backlog](docs/product/anna-harness-first-community-backlog-2026-08-31.md) covers deeper recovery combinations, additional platforms and future capabilities, not removal of existing product functions.

## Configuration ownership

The product launcher accepts these local paths:

| Variable | Owner |
| --- | --- |
| `ANNA_HARNESS_HOST_CONFIG_PATH` | Node model endpoint, model name, secret and reasoning settings |
| `ANNA_HARNESS_BUSINESS_CONFIG_PATH` | Business connector configuration, without model credentials |
| `ANNA_HARNESS_STATE_ROOT` | Canonical Harness state and product metadata |
| `ANNA_HARNESS_HOST_WORKSPACE_ROOT` | Agent-readable task files, separate from protected configuration/state |
| `ANNA_HARNESS_RUNTIME_INFO_PATH` | Current local Host address and process information |

DeepSeek V4 Pro uses the OpenAI-compatible transport with `model_name=deepseek-v4-pro`, thinking enabled and high reasoning effort. Configure secrets locally; never put them in shell history, source, public evidence or a task prompt. The generated internal service token authenticates the business peer and must not be exposed to the browser or model.

Hiker reads and writes are separate acceptance gates. When the connected server reports `write_tools_enabled=false`, report the write gate as blocked. Do not invent a tool, modify a real business record for a smoke test, or label a read as a write.

## Data and rollback

Preserve existing configuration, Python business databases, artifacts and the old checkout. Use an isolated data directory for migration acceptance. Reusing existing business data does not convert old Agent histories into canonical Harness histories. Never point the Harness Event Store at a legacy database.

Choose a workspace that does not contain Host or business configuration and state, including filesystem aliases. The product must reject unsafe overlap before a Runtime can read its own credentials.

The macOS build remains unsigned and unnotarized. Other platforms and SWE-bench results have no release acceptance in this Goal. External connector credentials, data and deployments are not distributed with Anna.

## Live acceptance

Use the address reported by the current Product Host, not a retained legacy server. Validate original-UI Home tasks and next-turn context through actual OMP/DeepSeek, a real Hiker read and an authorized synthetic write with readback, and contextual Anna/Worker execution in Crew. The built-in Showcase is explicitly synthetic and only proves the preserved demonstration workflow. Keep live responses and business data out of public logs; publish sanitized outcomes and exact source/test references.

## Validation

```text
npm run typecheck
npm test -- --reporter=dot
npm run frontend:product-smoke
# macOS/Linux
./.venv/bin/python -m pytest -q
# Windows
.\.venv\Scripts\python.exe -m pytest -q
npm run build
```

Two symlink-creation tests need Windows Developer Mode or the Create symbolic links privilege. They may fail with `WinError 1314` when that OS capability is disabled.

## Fresh-machine recovery

The managed business peer and its regression tests use Python 3.12 or 3.13. Create dependencies natively on the current OS; the current desktop package preparation uses the pinned 3.12 runtime:

```bash
python3.12 -m venv .venv
./.venv/bin/python -m pip install -e '.[dev]'
npm ci
```

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
npm ci
```

Restore private data only through a trusted local channel because it contains credentials, SQLite data, conversation artifacts and attachments. Review connector paths and saved workdirs after changing machines. Keep MCP configuration in the protected business configuration and model credentials in the Host configuration; neither belongs in Git.

## Source-control baseline

The migration preserves the original `fix/pi-level-loop` branch, staged PRD moves, and the existing untracked planning/evaluation files. Treat them as user-owned work until their intended commits are reviewed.
