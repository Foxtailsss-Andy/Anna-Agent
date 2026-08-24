# Contributing

Anna is currently accepting focused Developer Preview contributions. Keep changes small and explain the user-facing behavior or contract they change.

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
