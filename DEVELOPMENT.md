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

## RC1 source preview

Use `npm run desktop:run` for the RC1 product flow. `npm run dev` alone starts Vite and does not start the Product Host or its business peer. Ordinary conversations use the Host's `/api/workbench` Session/Run API; they require the same authenticated identity and protected state as the desktop product.

After launch, start an ordinary question in Home/Create, continue the same conversation, and use session history to reopen it. Choose a workdir explicitly before asking Anna to read its files. Cowork dashboards and existing business actions remain available independently of ordinary conversation; Crew conversation is scoped to the selected project. Stop targets the selected Run. A missing provider configuration is an explicit failure, not a generated answer.

The [RC1 release record](docs/releases/rc1-developer-preview.md) separates deterministic external transports, real local OMP execution, and outstanding live/provider and platform checks. RC1 added no installer or broad recovery guarantee; the Sandbox scope is described under General-Agent capabilities below.

## General-Agent capabilities

Ordinary Home and Crew requests run as Workbench Runs on the same Host + OMP loop. What a Run may do is fixed by its profile at admission:

- **Plan:** the OMP `todo` tool is always admitted; its latest snapshot is shown as the Run's plan (“过程”).
- **Workdir (read):** after you choose a workdir, `workdir.list`, `workdir.search` and the `workdir.read_file` capability read inside it only. Workdirs that overlap Host/business configuration or state are rejected.
- **Modify + Sandbox:** turn on “允许 Anna 在此工作目录内修改文件并运行命令（沙箱）” for the Run (`permission_mode: contained-write`). This admits `workdir.write_file`, `workdir.edit_file`, `sandbox.exec` and every configured MCP tool that is not marked read-only (the toggle names those MCP tools). File tools resolve each path segment inside the workdir before opening (a symlinked directory cannot lead outside, nothing is created outside) and refuse files with a second hard link.
- **Sandbox scope:** `sandbox.exec` runs `/bin/sh -c` under `/usr/bin/sandbox-exec` with a deny-default seatbelt profile: no network, no desktop/system services (LaunchServices, Apple Events, pasteboard, preferences daemons; only user/group lookups are allowed), writes only inside the workdir and a per-call scratch directory, reads of other user data roots denied, scrubbed environment, timeout ≤ 120 s. When the command returns, times out or is stopped, the Host terminates its process group, the root's descendants and detached (`setsid`) processes that still hold the per-call marker descriptor. A process that closes every inherited descriptor and detaches is not tracked; it remains under the same profile. It is a process sandbox, not a container; on platforms without `sandbox-exec` the tool is not admitted.
- **Crew changes:** in a Crew project, Anna proposes graph/assignment changes with `crew.propose_changes`. The proposal card in the Channel changes nothing until the project owner adopts it.
- **Steer:** while a Run is active, the composer sends “补充说明” to that Run instead of starting another.
- **Goal mode (目标模式):** a user-authorized objective with a run limit (1–8). The Host starts the next Run only while the todo plan has open, unblocked items (or a Run ran out of its single-Run budget), pauses when only blocked items remain, and stops at `awaiting_review` for your confirmation. Stop/pause/resume/stop-goal are on the Goal card; at the run limit “再给 1 轮” raises it. Runs that a previous Host process left queued or running are settled as failed (`process_restarted`) when the Host starts, so their Goal can be resumed.
- **Run budget:** a Workbench Run that can act through tools beyond the plan/catalog gets 24 model turns, 96 tool calls and 5 minutes of wall time; a Goal continues across Runs when one Run's budget is not enough.

### MCP servers

Declare MCP servers in a protected Host-only JSON file and pass its path:

```bash
ANNA_HARNESS_MCP_CONFIG_PATH=/absolute/protected/path/mcp.json npm run desktop:run
```

```json
{ "mcpServers": {
  "fixture": { "command": "node", "args": ["/abs/path/to/tools/mcp-fixture-server/server.mjs", "--notes-dir", "/abs/notes"] },
  "remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer <secret>" }, "timeout_ms": 20000 }
} }
```

The Host connects in the background once it is ready (servers in parallel; stdio or Streamable HTTP; loopback `http://` or `https://` only), so a slow or broken server becomes `failed` without delaying launch. Tools are admitted as `mcp.<server>.<tool>` to Runs that start after the server is ready. stdio servers get only `PATH`, `HOME`/`TMPDIR` (scratch) and `LANG` plus their configured `env`; they never inherit the Host environment. Server status is written to the Host diagnostics log. Keep this file outside any workdir; it is a protected path.

### Diagnostics

The launcher appends Host and business-service stderr to `<ANNA_HARNESS_STATE_ROOT>/logs/{host,business}.stderr.log` (mode 0600, rotated once at 5 MiB), so failures after startup remain diagnosable.

## Optional Jev Crew suggestions

Jev is disabled by default. To enable the experimental single-task suggestion, store a TypeSafe key as plain UTF-8 in a protected file outside the repository and the Agent-readable workspace, with file permission `0600` and parent directory permission `0700`. Pass only its path to the launcher:

```bash
ANNA_JEV_ENABLED=1 ANNA_JEV_API_KEY_FILE=/absolute/protected/path/typesafe.key npm run desktop:run
```

Only the Node Host receives this key reference. The request model is pinned to `jev-1.13.0`. A generation-model configuration is not required for Jev suggestions; ready Worker execution still requires the existing Host model configuration and execution policy.

In Crew, open an unassigned, non-gate `todo` or `blocked` task and click **建议人选**. Opening the picker alone makes no model request. When Jev is needed, the explicit request sends the project goal, task title/description/role/acceptance criteria, and candidate local IDs/roles/kinds to TypeSafe. Names, email addresses, channel history and memory are excluded. A unique exact-role match uses a rule and makes no Jev request. Missing configuration, no suitable candidate or provider failure leaves manual selection available.

Inspect the source and click **采纳指派** to commit the assignment. Human tasks do not start a Worker; blocked Workers wait for dependencies. Ready Workers follow the existing execution policy. The displayed **判断耗时** covers the Host decision, excluding UI/API overhead and human thinking time. See the [preview candidate record](docs/releases/jev-crew-preview.md) for evaluation evidence and limits.

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
