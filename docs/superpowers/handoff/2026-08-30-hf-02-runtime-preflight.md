# HF-02 Runtime Preflight

Date: 2026-08-30
Scope: isolated dependency/runtime experiments, not a production worker.
Application baseline: `b724c7d`; S0 contract: `6407790`.
All experimental dependencies and runtime state are in ignored `.tmp-tests/`.
No real credentials, provider calls, business tools or application configuration
were used. Root application manifests/lockfiles were not changed.

## Verified Runtime Inputs

- Official `bun-v1.3.14/bun-darwin-aarch64.zip`: 23,586,433 bytes;
  SHA-256 `d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620`.
  Downloaded bytes matched the release metadata. Isolated `bun --version`
  returned `1.3.14`; no global installation was performed.
- Added exact `@oh-my-pi/pi-natives-darwin-arm64@18.0.11` to the audit-only
  installation with scripts disabled and unrelated optional packages omitted.
  Registry SRI:
  `sha512-4XWCl30DLxRKRpcfi6OdtWhc5d7lh/f2fPkDO0xdo5n8yTkObJ+ZR9KlhJiyJI9T+e3zeztBtBMbU9ZmIgXOmg==`.
- The actual native file is 161,935,504 bytes; SHA-256
  `e4e59e6cdaf475d2484755e237490f0637c937dfa06b48fcc59e25103e6c8b8b`.
- `npm audit signatures --ignore-scripts`: 96 verified registry signatures,
  65 verified attestations. The updated temporary lock SHA-256 is
  `d47db8e909ba4116817bea8148d616ed96ce387092a6a587d53a277d5c2f0211`.
- The explicitly installed non-optional graph including that native package
  reported zero vulnerabilities with `--omit=dev --omit=optional`. The previous
  full-lock optional inference findings remain recorded in the package
  preflight; this narrower result does not erase them.

## Actual Loading

Executed Bun with a minimal environment, dedicated HOME/XDG/temp directories,
network denied and writes restricted to the runtime experiment directory.
User-home file data outside the two approved experiment/dependency directories
was denied while path metadata remained visible.

1. Importing the actual native entrypoint exited zero. It exposed the expected
   `__piNativesV18_0_11` function sentinel and 100 exports.
2. Importing the installed coding-agent `src/sdk.ts` exited zero. It exposed
   `createAgentSession` as a function and 32 exports.

These are module-load results. The later constructor-only experiment below
checks session setup separately. No built-in shell, MCP, native Memory or
Plugin was enabled by either experiment.

## Constructor and Disposal Probe

The actual SDK also completed `createAgentSession`, `beginDispose` and awaited
`dispose` in the restricted process, without submitting a prompt. It used real
in-memory AuthStorage, an explicit ModelRegistry with network rejection, isolated
Settings and SessionManager, explicit empty resources/tools and disabled
discovery. Settings disabled Memory/autolearn, compaction, retry, advisor,
prewalk, Goal, async work, title refresh and unexpected-stop detection;
`PI_NO_TITLE=1` was set in the worker environment.

Observed: zero custom-model dispatches, zero fetches, empty active tools, no
session file and successful disposal/exit. Model-cache SQLite files, Bun cache,
a GPU cache and OMP logs were nevertheless created within approved temporary
roots. They are disposable state, not another canonical Anna store.

An initial attempt to register a custom transport under the reserved
`openai-completions` name failed. A dedicated custom API name was used instead;
the reserved-name failure was not ignored or treated as successful setup.

This probe does not prove provider request accounting. Static review found
provider-internal retries independent of session retry settings, and the SDK's
`onFirstChatDispatch` callback is a one-time marker. The managed worker must
account for every actual transport attempt through Host governance; disabling
session retries is not sufficient evidence of one network request per turn.

The OMP `AgentSession` event emitter explicitly does not await asynchronous
subscribers and converts listener failures into log warnings. This differs from
the currently used reference Pi listener contract. A worker cannot obtain
durability by simply awaiting `sink.append` inside a subscription callback.
Its protocol needs explicit pending-event/ACK tracking, awaited barriers before
the next model/tool dispatch and terminal settlement, and fail-closed handling
when Host persistence fails. The public `agent.addBeforeModelCallHook` is
awaited and is a possible model-boundary gate; provider-internal retry accounting
still requires the separate transport boundary described above.

## Isolation Probes and Retained Failures

- A stricter global file-read allowlist aborted Bun with SIGABRT even for
  `--version`. It is not a working containment implementation and is not used
  as a passed gate. The narrower user-home guard allowed startup.
- With the narrower guard, reading a harmless repository file outside approved
  roots and writing outside the experiment directory both failed with access
  denial. The attempted output file was not created.
- Bun reported ECONNREFUSED for a network-denied local connection, rather than
  EPERM. An initial errno-only assertion therefore failed and was insufficient.
  A controlled listening server observed zero connections from the restricted
  child, while an unrestricted control using the same Bun reached the server
  once. This establishes the measured loopback-denial behavior.
- The first unrestricted control had an unhandled ECONNRESET in its disposable
  server. After handling socket shutdown correctly, the control exited zero
  with one accepted connection. The failed control is not counted as proof.

The experimental sandbox permits system reads outside user-home and has not
proven complete filesystem containment, descendant cleanup, network allowlists,
IPC protection or any Windows/Linux boundary. HOME redirection and these probes
cannot substitute for the full HF-024/HF-053 isolation requirements.

## Next Required Evidence

Freeze and implement the managed worker protocol and SDK session configuration;
disable hidden title/retry/compaction/model work, ambient discovery, native
Memory and tools outside Gateway. Then prove actual model/tool/model execution,
abort/dispose/restore and the final packaged artifact graph. This record does
not close HF-02, change Desktop's default Runtime or satisfy SWE-bench gates.
