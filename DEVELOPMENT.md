# Anna local development

The Harness-first Preview uses a React/Vite/Electron shell, one Node Harness Host, and the pinned Oh-my-Pi worker. The default Preview does not start Python. This release is scoped to macOS arm64; Windows remains a long-term distribution target.

Run all commands from the repository root. Platform-specific `.venv`, `node_modules`, build output, and `.anna` runtime state are local-only and must not be copied between operating systems or committed.

## Launch the desktop app

Requirements: macOS arm64 and Node.js >=22.19.0. Prepare the pinned Bun/OMP runtime once in a fresh checkout:

```bash
npm ci
ANNA_OMP_BUN_ARCHIVE_URL=https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip npm run harness:omp:prepare
```

```text
npm run desktop:run
```

The command builds the frontend and Harness service, then starts Electron and one Preview Host. The Host serves the UI and `/api/preview/*` on the same loopback origin. No provider key is required to open Settings. Configure a model, an OpenAI-compatible endpoint, an API key, and an existing workspace there. The key is not returned by the settings API.

The runtime preparation command intentionally refuses to overwrite an existing bound runtime. Keep the prepared runtime in `build/omp-runtime/darwin-arm64`; do not copy a runtime prepared from another worker revision. There is no fallback to Python or Pi when OMP verification fails.

This Preview supports text tasks, admitted read-only workspace tools, stop, canonical event streaming, and completed history. Crew/Create/Cowork/Hub and external MCP business operations are not exposed. See the [current Goal](docs/product/anna-harness-first-preview-goal-2026-08-31.md) and [community backlog](docs/product/anna-harness-first-community-backlog-2026-08-31.md).

## Data and rollback

Preview uses a separate configuration and state directory. Existing `.anna/runtime.json`, Python databases, and legacy artifacts are preserved and are not imported or written by the Preview. Quit Preview before launching an older release in its own checkout. Do not point the Preview state path at a legacy database.

Choose a workspace that does not contain Preview state or configuration files, including their filesystem aliases. Preview rejects unsafe overlap before a Runtime can read its own credentials. Invalid persisted settings remain unavailable until a safe configuration is supplied.

The macOS Preview build is unsigned and unnotarized. Other platforms, live business connectors, full coding tools, and SWE-bench results have no release acceptance in this version.

## Legacy live scripts

The following retained scripts exercise the legacy Python API, not `/api/preview/*`. They are not Preview acceptance commands. Run them only against a deliberately started legacy development environment:

```powershell
$env:ANNA_LIVE_CHAT_MESSAGE = '请只回复：Anna 验收通过'
npm run live:chat
```

```bash
ANNA_LIVE_CHAT_MESSAGE='请只回复：Anna 验收通过' npm run live:chat
```

## Validation

```text
npm run typecheck
npm test -- --reporter=dot
npx --no-install playwright install chromium
npm run frontend:preview-smoke
# macOS/Linux
./.venv/bin/python -m pytest -q
# Windows
.\.venv\Scripts\python.exe -m pytest -q
npm run build
```

Two symlink-creation tests need Windows Developer Mode or the Create symbolic links privilege. They may fail with `WinError 1314` when that OS capability is disabled.

## Fresh-machine recovery

The default Preview needs only the Node and pinned OMP preparation above. To maintain or run the retained legacy tests, use Python 3.12 or 3.13 and create dependencies natively on the current OS:

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

Restore `.anna` only through a trusted local channel because it contains credentials, SQLite data, conversation artifacts, and attachments. After moving between Windows and macOS, review path-valued fields such as connector working directories and saved workdirs before enabling them. Configure MCP endpoint URLs in `.anna/runtime.json`; never commit that file.

## Source-control baseline

The migration preserves the original `fix/pi-level-loop` branch, staged PRD moves, and the existing untracked planning/evaluation files. Treat them as user-owned work until their intended commits are reviewed.
