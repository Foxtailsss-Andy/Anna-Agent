# Third-party notices

Anna's JavaScript and Python dependencies remain governed by their own licenses. The committed `package-lock.json` is the source of truth for npm package versions and license metadata; Python dependencies are declared in `pyproject.toml` and are intentionally kept separate from runtime state.

Before distributing a binary or enabling additional connectors, re-run the dependency/license audit for the exact lockfiles and build artifacts used for that distribution.

## Hiker

Hiker is a complete ERP system for small teams, with integrated finance, supply-chain, and marketing capabilities. Anna connects to the ERP services exposed by Hiker through MCP for data retrieval, business analysis, and governed operations. Hiker is an external collaborative project authored by [kc8zshnt6n-gif](https://github.com/kc8zshnt6n-gif); the Hiker platform and its source code are not included in this repository and are not currently open source.

The MIT License in this repository covers the Anna-side MCP connector, user-interface integration, and other committed Anna code only. It does not grant rights to Hiker, its service implementation, deployment, data, or other unpublished materials.
