# Anna local development

Anna uses a React/Vite/Electron desktop shell with a Python 3.12 FastAPI backend. Windows remains the primary distribution target; local development is supported on Windows and macOS.

Run all commands from the repository root. Platform-specific `.venv`, `node_modules`, build output, and `.anna` runtime state are local-only and must not be copied between operating systems or committed.

## Launch the desktop app

```text
npm run desktop:run
```

The command builds the frontend, starts Electron, and starts the Anna Python backend. Connector endpoints are external MCP services configured in `.anna/runtime.json`; Runtime details are written under `.anna/`.

With the desktop app running, the live E2E commands automatically discover the project-local Runtime. For example:

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
# macOS/Linux
./.venv/bin/python -m pytest -q
# Windows
.\.venv\Scripts\python.exe -m pytest -q
npm run build
```

Two symlink-creation tests need Windows Developer Mode or the Create symbolic links privilege. They may fail with `WinError 1314` when that OS capability is disabled.

## Fresh-machine recovery

Use Python 3.12 or 3.13. Create dependencies natively on the current OS:

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
