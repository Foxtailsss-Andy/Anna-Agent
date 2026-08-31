# HF-02 Upstream Preflight

Date: 2026-08-30
Status: source/dependency preflight only; no worker implementation or compatibility acceptance.
Source pin: `can1357/oh-my-pi@51f03804476c3fd3c15748ae07e4849d1efc883b`.
Reviewer: GPT-5.6-Sol Ultra.

## Required Worker Contract

1. Use a managed Bun SDK worker, initially one Run per worker. The selected
   coding-agent package is `18.0.11`, requires Bun `>=1.3.14`, and depends on
   native modules and `bun:sqlite`. Do not load it directly into Electron Node
   without evidence. The locally found Bun `1.3.6` is not sufficient.
2. Correlate Run, command, profile and message identities with bounded frame
   sizes/order. Subscribe before prompting. A prompt RPC success is admission,
   and `agent_end.isTerminal=false` is not a Host Run terminal.
3. Explicitly map steer, follow-up and answers to pending request IDs. There
   is no interchangeable generic `answer` RPC. Do not expose the whole native
   RPC command set, including bash, login or session switching.
4. Inject model/auth/registry/settings, cwd/agentDir and Host-owned context,
   Skills/workspace tree. Disable unused templates/commands/discovery.
   Restricted mode still probes repository/advisor/watchdog state, so empty
   HOME/environment controls and actual OS isolation must be independently tested.
5. Register only Gateway proxy tools with restrictive tool-name/custom-tool
   settings; disable native MCP/LSP/extension discovery. `set_host_tools` is
   additive to the native tool system and is not proof that builtins are absent.
6. Use explicit in-memory sessions and disable upstream Memory/autolearning.
   Do not use continue-recent or arbitrary session paths. Canonical Host
   history, input fingerprints, budgets and pending tools govern restore.
7. `abort()` awaits cooperative settlement; it is not a process kill. Gate
   new commands before disposal and define Host timeout, worker-exit and
   descendant cleanup. Lost outcomes remain unknown, never automatic replay.
8. Native loading uses HOME/XDG caches and can extract/clean files on import,
   independently of agentDir. Pin and verify per-platform native/Bun artifacts;
   Linux GNU/musl, macOS and Windows need their own evidence.

## Sources

Paths below are relative to the exact upstream pin, not floating main:

- `packages/coding-agent/package.json`
- `docs/sdk.md`, `docs/rpc.md`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` and `rpc-mode.ts`
- `packages/coding-agent/src/session/session-manager.ts` and `agent-session.ts`
- `packages/coding-agent/src/session/title-index.ts`
- `packages/natives/native/loader-state.js`
- `scripts/bazel-natives.ts`, `docs/natives-build-release-debugging.md`

The initial source-only preflight executed no upstream code, installed no
dependencies, changed no configuration and inspected no credentials.
HF-02 must still freeze its owned
files, worker protocol, packaging/isolation approach and conformance tests.
The SDK's controls are implementation inputs, not proof that Anna has migrated.

## Published Package Mapping

Main-Agent read-only registry checks on 2026-08-30 found that the published
`@oh-my-pi/pi-coding-agent@18.0.11` is available with this integrity value:

```text
sha512-3H90cCc+3yLtvSKM2RooIvkhG+77OFFoXD6+9GPZDF3PQ3FF6uCnPP57OaUa8VZ8YwOm9Eio5ZmfdFuvwLn+VA==
```

The registry has no `gitHead` for this package. Its decoded SLSA provenance
statement names `b8ce33a58911c26bed1d84f0db9a5e2e727c49a2` as the source
dependency. Decoding is not cryptographic verification: these initial
registry-only checks did not verify a signature or downloaded archive.
The later isolated verification results are recorded below.

The GitHub comparison reports that the published-source claim is an ancestor
of the original inspected pin: `51f0380` is ahead by 31 commits. The changed
paths include AI transport, authentication, provider catalogs and model
resolution. The SDK, RPC protocol, SessionManager, AgentSession implementation
and native-loader files examined above have no changes in that comparison.
Identical package version strings do not establish identical implementations.

Before HF-02 coding, freeze either the original source build or the published
package with its actual reviewed source mapping. Verify archive integrity and
provenance as separate evidence, lock transitive dependencies, and rerun actual
model/tool conformance against the chosen installed implementation. Do not
describe an npm install as execution of `51f0380` without proving that mapping.

The official Bun `1.3.14` release API lists these candidate archive digests:

| Archive | SHA-256 |
| --- | --- |
| `bun-darwin-aarch64.zip` | `d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620` |
| `bun-linux-x64.zip` | `951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f` |
| `bun-windows-x64.zip` | `0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922` |

These are upstream metadata, not local download/hash or platform smoke results.
No global Bun installation was performed. The later npm-cache deviation is
recorded below rather than claiming that all tools left HOME untouched.

Read-only commands: `npm view @oh-my-pi/pi-coding-agent@18.0.11 ... --json`,
the npm registry attestations API, both directions of the GitHub comparison
API for the exact commits above, and the Bun `bun-v1.3.14` release API.

## Isolated Package Verification

GPT-5.6-Luna Max downloaded the exact package with lifecycle scripts disabled
and installed an audit-only dependency tree under the ignored
`.tmp-tests/omp-package-preflight/`. No OMP, Bun or native module was executed.
This temporary installation is not Anna's production dependency lock.

- The archive is 11,561,535 bytes; independent SHA-512 matches the SRI above.
  Main-Agent recomputation also matched. The installed and locked package both
  report `18.0.11`; no installed-source claim uses `51f0380`.
- `npm audit signatures --ignore-scripts` reported 95 verified registry
  signatures and 64 verified attestations, with no invalid/missing entries.
  Main-Agent reran the JSON form: `invalid: []`, `missing: []`, exit zero.
  The verified SLSA statement's subject digest matches the archive and names
  `b8ce33a58911c26bed1d84f0db9a5e2e727c49a2`. Optional platform packages were
  omitted and are not covered by this installation's verification result.
- Main-Agent compared archive bytes to the exact published-source revision for
  `sdk.ts`, both RPC files, `session-manager.ts`, `agent-session.ts` and
  `title-index.ts`. All six SHA-256 comparisons matched. This is not a claim
  about every generated file or transitive dependency.
- The temporary audit lock SHA-256 is
  `d0c2d9654c5be9f86c188c97ae25426bcb3f9c410dc369cd3a571a741467f1cc`.
  HF-02 must create/review the actual worker lock and verify that graph again.

The unrestricted lock-graph security audit (`npm audit --omit=dev --json`)
exited nonzero with **5 high** findings, associated with the optional
`@huggingface/transformers` tree, `onnxruntime-node`, `sharp` and `adm-zip`.
The audit with both `--omit=dev --omit=optional` reported zero vulnerabilities.
Main-Agent verified that those four packages are physically absent from the
audit-only installation. These are different scopes, not contradictory results
or permission to describe the entire lock graph as clean.

The native platform packages are also optional upstream dependencies and were
not installed. A minimal worker distribution must explicitly include and
verify its required native artifact while excluding unused native-Memory/audio
backends. Test actual imports and disabled-feature behavior before accepting
that distribution; do not merely hide findings with an audit flag. Preserve
the full-graph findings until the shipped dependency boundary is established.

Process deviation: one subagent `npm exec` used the default npm cache and
created an approximately 17 MB temporary npm CLI cache outside the assigned
directory. The subagent moved that newly created directory intact into
`.tmp-tests/omp-package-preflight/removed-npm-exec-cache-778e2a9d4b99c7e3/`.
Subsequent npm checks use an explicit project-local cache. No global Bun or
Anna runtime configuration was modified; no general HOME-unchanged claim is
made. The cache remains recoverable, and no unrelated user files were removed.

Remaining: managed Bun download/hash, required native package identity and
runtime load, actual SDK/model/tool/control/restore conformance, package paths
and per-platform containment/cleanup. The HF-02 ticket remains unaccepted.
