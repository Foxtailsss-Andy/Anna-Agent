# GitHub Developer Preview · Tickets

> Wayfinder: `docs/product/anna-github-developer-preview-wayfinder-2026-08-23.md`
> Spec: `docs/product/anna-github-developer-preview-spec-2026-08-23.md`

## T01 · Release boundary and public file inventory

**Goal:** produce an explicit allowlist/denylist for the public tree without touching the existing working tree state.

**Acceptance:** `.anna/`, generated output, secrets, absolute paths, private migration materials and unverified business data are detected or excluded; the inventory is reviewable.

## T02 · Public repository minimum

**Goal:** add README, MIT LICENSE, SECURITY, CONTRIBUTING and CHANGELOG with the preview claim and known limitations.

**Acceptance:** a new reader can install, configure, launch and understand the unsupported boundaries without private context.

## T03 · Reproducible CI gate

**Goal:** add GitHub Actions for Node typecheck/tests/build, Python tests, evidence verification and a no-secret configuration check.

**Acceptance:** CI uses only checked-in files and declared runtimes; it does not require a provider, MCP server, `.anna` state or signing identity.

## T04 · Desktop smoke path repair

**Goal:** make the maintained desktop smoke test resolve the current `apps/desktop/src/pages` tree, or remove stale tests from the release gate with a documented replacement.

**Acceptance:** the maintained desktop smoke command passes against current source paths and catches a broken shell import.

## T05 · Dependency and version disclosure

**Goal:** document Node/Python version floors, current audit scope, open Python lockfile/audit limitation, package version and unsigned macOS package status.

**Acceptance:** README and CHANGELOG do not imply a stronger supply-chain or packaging guarantee than the evidence supports.

## T06 · Release candidate verification

**Goal:** run T01-T05 together with the full local gates and produce a redacted release evidence index.

**Acceptance:** all required gates pass or are explicitly classified as a non-blocking known limitation; no remote write is performed.

## Post-release tickets

- T07: Review-to-Validated-Patch production Owner canary;
- T08: domain Legacy cutover and Desktop migration;
- T09: signed/notarized macOS and Windows package acceptance;
- T10: Python lockfile and dependency audit;
- T11: external WebSearch and provider restore evidence.
