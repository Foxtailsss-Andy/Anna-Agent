# Anna

Anna is a local-first desktop AI agent for enterprise Cowork workflows. This repository is published as a **Developer Preview**: it is useful for inspecting the architecture, running the local UI/runtime, and exercising deterministic fixture gates. It is not a production connector, hosted service, or security certification.

## Release documentation

- [中文发布说明](docs/public/ANNA-RELEASE-ZH.md)
- [English release brief](docs/public/ANNA-RELEASE-EN.md)

## Repository history

This GitHub repository was created on April 2, 2026 for a retired book project and was repurposed for Anna on August 24, 2026. Anna's first public software release is the `0.2.0` Developer Preview; the repository creation date is not the Anna software release date.

## External project boundary

Anna includes an independently maintained connector and UI integration for **Hiker**, an external collaborative project authored by [kc8zshnt6n-gif](https://github.com/kc8zshnt6n-gif). Hiker itself is not included in this repository and is not currently open source. Anna's MIT License applies only to the Anna-side integration code and other files committed here.

## Preview scope

The first public path is the macOS source checkout with the current desktop shell, Chat/Create Home surface, Cowork reimbursement surface, runtime takeover view, and the opt-in Harness v2 bridge. The default runtime stays fail-closed when an external model or MCP connector is not configured.

The preview does not claim completed Legacy-to-Harness-v2 migration, production reimbursement submission, signed/notarized installers, Windows validation, or an external web-search connector. Those items are tracked as post-release tickets in [the release ticket list](docs/superpowers/plans/2026-08-23-github-developer-preview/00-tickets.md).

## Quick start

Requirements:

- Node.js `>=22.19.0`
- Python `>=3.12,<3.14`
- macOS is the only desktop platform validated for this preview

```bash
npm ci
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
npm run desktop:run
```

`uv.lock` records a hash-pinned Python resolution for contributors using uv (`uv sync --locked --extra dev`). The CI job also runs `pip-audit` against the installed Python environment.

The desktop app can run without provider credentials. In that mode it must show an explicit `not_configured`/unsupported state and must not invent model or connector results. Configure local runtime values through the app's settings/runtime configuration; never commit secrets.

To opt into the local Harness v2 sidecar for development:

```bash
ANNA_HARNESS_V2_BRIDGE_ENABLED=1 npm run desktop:run
```

This switch is a development boundary, not evidence that every domain has completed cutover.

## Verification

Run the smallest release checks first:

```bash
npm run typecheck
npm test -- --reporter=dot
npm run frontend:smoke
python -m pytest -q
npm run build
npm run release:verify
```

For the desktop packaging smoke, use `npm run desktop:package` followed by `npm run desktop:smoke-asar`. The packaged smoke intentionally runs without secrets and therefore reports model/MCP as `not_configured`.

The release boundary, supported claims, evidence rules, and follow-up work are documented in [Wayfinder](docs/product/anna-github-developer-preview-wayfinder-2026-08-23.md), [Spec](docs/product/anna-github-developer-preview-spec-2026-08-23.md), and [Tickets](docs/superpowers/plans/2026-08-23-github-developer-preview/00-tickets.md).

## Contributions and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Do not include runtime state, databases, generated packages, provider responses, API keys, or real enterprise data. Report suspected vulnerabilities through a private GitHub Security Advisory once repository security reporting is enabled; do not publish exploit details in an issue.

Anna is released under the [MIT License](LICENSE). Third-party dependency notices are described in [NOTICE.md](NOTICE.md).
