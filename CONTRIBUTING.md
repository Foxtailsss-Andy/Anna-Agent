# Contributing

Anna is currently accepting focused Developer Preview contributions. Keep changes small and explain the user-facing behavior or contract they change.

## Canonical repository

[Foxtailsss-Andy/Anna-Agent](https://github.com/Foxtailsss-Andy/Anna-Agent) is the public source of truth. Start new public work from its latest `main`, use a scoped branch, and land changes only after the required checks pass. Version tags and GitHub Releases must point to a green `main` commit.

Older local histories, migration bundles, and working branches are reference material rather than release authority. The repository transition and maintenance decision are recorded in [Anna Agent GitHub Milestone - 2026-08-24](docs/product/anna-agent-github-milestone-2026-08-24.md).

## Local checks

```bash
npm ci
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
npm run typecheck
npm test -- --reporter=dot
npm run frontend:smoke
python -m pytest -q
npm run release:verify
```

Do not commit `.anna/`, databases, JSONL runtime logs, `dist/`, `release/`, Python environments, provider output, real customer data, or credentials. Add a redacted deterministic fixture when a behavior needs evidence.

Pull requests should state which surface is covered, which checks were run, and which claims remain unverified. Changes to Runtime, tool permissions, approval, persistence, or release packaging need a regression test and an explicit limitation note.
