# Anna GitHub Developer Preview · Spec

> 对应 Wayfinder：`docs/product/anna-github-developer-preview-wayfinder-2026-08-23.md`
> 首发类型：macOS local Developer Preview

## 1. Public interface

### Source checkout

Required tools:

- Node.js `>=22.19.0`;
- Python `>=3.12,<3.14`;
- `npm ci`;
- Python development install from `pyproject.toml`.

### Local launch

```sh
npm run desktop:run
```

The default launch must fail closed when `.anna/runtime.json` is absent. A missing provider or MCP connector must appear as `not_configured`, not as a fabricated successful run.

### Optional Harness v2 bridge

The Harness v2 sidecar is opt-in. A clean checkout may enable it with `ANNA_HARNESS_V2_BRIDGE_ENABLED=1`; without that setting the API must expose an explicit unsupported boundary rather than silently switching Runtime implementations.

## 2. Supported preview behavior

- local Chat request/stream lifecycle;
- durable Run/Event Store behavior exposed through the Harness v2 bridge;
- scoped read-only ToolGateway behavior;
- canonical event cursor and resume behavior;
- Trace/Eval evidence when a provider is configured;
- honest empty configuration and failure states;
- deterministic fixture evidence separated from live evidence.

## 3. Explicitly unsupported in this release

- automatic GitHub push, merge or deploy;
- production Review-to-Validated-Patch approval;
- domain-specific Cowork/Crew/Create/Hub migration completion;
- unrestricted Bash, host-home writes or arbitrary network access;
- signed/notarized macOS distribution;
- Windows package acceptance;
- guaranteed external WebSearch or MCP availability.

## 4. Release hygiene contract

The public tree must not contain:

- `.anna/`, runtime JSON, SQLite state, attachments or generated package output;
- API keys, tokens, credentials or provider transcripts;
- absolute workstation paths;
- customer, employee or financial data unless explicitly synthetic and documented;
- internal migration bundles or private-session artifacts.

Fixtures and evidence shipped in the preview must contain synthetic data, a declared evidence mode, and a verifiable hash manifest. Live evidence must not contain prompts, model responses or secrets.

## 5. Verification contract

The release candidate must run, in a clean environment where applicable:

```sh
npm run typecheck
npm test -- --reporter=dot
./.venv/bin/python -m pytest -q
npm run build
npm run harness:v2:build
npm run evidence:verify:all
npm run desktop:package
npm run desktop:smoke-asar
```

The CI job must not require `.anna/runtime.json`, a private MCP endpoint, a model API key, a signed macOS identity or a running desktop session.
