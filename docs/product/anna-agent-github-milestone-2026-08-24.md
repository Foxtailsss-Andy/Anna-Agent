# Anna Agent GitHub Milestone - 2026-08-24

Status: completed

## Milestone decision

On August 24, 2026, Anna completed its first public GitHub release and established the following repository as the canonical source for future public development and version maintenance:

- Repository: [Foxtailsss-Andy/Anna-Agent](https://github.com/Foxtailsss-Andy/Anna-Agent)
- Default branch: `main`
- First public software release: [`v0.2.0` Developer Preview](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/tag/v0.2.0)
- Release baseline commit: `633dfae649331c6302216d30bec4b567be36b003`
- Verified CI run: [32687200444](https://github.com/Foxtailsss-Andy/Anna-Agent/actions/runs/32687200444)

From this milestone forward, GitHub `main` is the public source of truth for Anna's code, documentation, version tags, and release history. Local migration bundles, older working branches, and historical checkouts remain useful as archives or engineering references, but they do not define the published version.

## Repository history

The GitHub repository was originally created on April 2, 2026 for a book project that is no longer maintained. It was repurposed for Anna on August 24, 2026, published as the `0.2.0` Developer Preview, and then renamed from `Anna` to `Anna-Agent`.

The repository creation timestamp was intentionally preserved:

- Repository created: April 2, 2026 at 17:15:33 UTC+8
- First Anna Release published: August 24, 2026 at 10:58:08 UTC+8

The creation timestamp describes the GitHub repository container. The Anna software release history begins with `v0.2.0`.

## Naming boundary

- `Anna-Agent` is the GitHub repository and public project name.
- `Anna` remains the desktop application and in-product assistant name.
- Existing `@anna/*` packages, `ANNA_*` environment variables, API headers, database names, and runtime identifiers remain stable unless a later technical migration explicitly changes them.

This naming boundary keeps the public repository easy to identify without introducing an unnecessary runtime or compatibility migration.

## Future maintenance workflow

All public updates should follow this sequence:

1. Start from the latest `main` on `Foxtailsss-Andy/Anna-Agent`.
2. Make the smallest scoped code or documentation change on a dedicated branch.
3. Run the checks appropriate to the change and record any unverified boundary.
4. Land the reviewed change on `main` only after required CI checks pass.
5. Create version tags and GitHub Releases from a green `main` commit.
6. Keep release notes, limitations, security boundaries, and external-project attribution synchronized with the released code.

The current repository gate includes dependency installation and audit, public-preview boundary verification, TypeScript checks, JavaScript tests, maintained frontend smoke, web and Harness v2 builds, and Python tests.

## Hiker boundary

Hiker is an external collaborative project authored by [kc8zshnt6n-gif](https://github.com/kc8zshnt6n-gif) and is not currently open source. The Anna-Agent repository contains only the Anna-side Hiker connector and UI integration. The repository's MIT License does not extend to the Hiker platform, server implementation, deployment, data, or other unpublished materials.

## Current release boundary

`v0.2.0` remains a Developer Preview. The public source, local verification path, CI, and unsigned macOS packaging smoke have been validated. Signed and notarized distribution, production provider/MCP configuration, and complete production Runtime/domain cutover remain later release work and must not be inferred from this milestone.

