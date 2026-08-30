# HF-02 S0 Kernel Identity Selection Handoff

Date: 2026-08-30
Ticket: HF-02 S0 Kernel Identity and Admission
Implementation status: accepted by independent Standards and Spec review.
No commit, push, or merge was performed by this coder.

## Delivered Boundary

- `RunProfile` and `ResolvedRunProfile` accept an optional closed `PiKernelDescriptorV1`.
  The parser rejects unknown or missing fields, null records, unsupported literals,
  malformed lowercase SHA-256 source identity, and malformed SHA-512 SRI. Parsed
  descriptors are deep-frozen. Descriptor-bearing profiles participate in the
  existing recursively key-sorted UTF-8 SHA-256 profile hash.
- An absent `kernel` remains the legacy parser/hash shape. A literal pre-S0
  snapshot and hash round-trip without a default kernel injection.
- The Pi adapter owns source identity. The frozen ordered inputs are
  `packages/pi-loop-kernel/src/index.ts` and
  `packages/pi-loop-kernel/src/pi-loop-kernel.ts`; each raw-byte digest is
  aggregated from the compact ordered manifest. Development loading verifies
  installed upstream versions and matching root lockfile SRI.
- Production general/Create profiles are resolved with the actual Pi descriptor.
  Trusted `harness_v2_kernel` admission accepts absent/`pi`, rejects `omp` as
  `kernel_unavailable`, and rejects all other values as
  `kernel_selection_invalid`. The guard runs after request/profile parsing but
  before command claim or durable runtime start. HTTP start/resume maps only
  these typed errors to the exact 503 bodies.
- Resume validates scope and route surface first, then compares a persisted Pi
  descriptor with the currently available descriptor. Legacy Runs retain Pi;
  the current selector is not consulted for an existing command. Identity drift
  rejects before runtime resume or new events.
- The Vite production build captures one source identity snapshot, embeds its
  digest in the bundle, emits the matching `pi-kernel-descriptor.json` sidecar,
  verifies upstream package/lock identity, and rechecks source identity before
  output. Packaged loading reads only the sidecar and fails closed on invalid,
  mismatched, missing, or stale metadata. Bundle dependencies are self-contained
  for the source-less smoke path.

## RED/GREEN Evidence

Initial RED:

```text
npm run test --workspace=@anna/harness-service -- --run test/kernel-selection.test.ts -t "explicit OMP"
expected 503, received 202
```

Focused GREEN commands and output:

```text
npm run test --workspace=@anna/harness-v2 -- --run test/kernel-descriptor.test.ts
Test Files 1 passed; Tests 10 passed

npm run test --workspace=@anna/pi-loop-kernel -- --run test/kernel-descriptor.test.ts
Test Files 1 passed; Tests 6 passed

npm run test --workspace=@anna/harness-service -- --run \
  test/kernel-selection.test.ts test/kernel-resume-selection.test.ts test/kernel-sidecar.test.ts
Test Files 3 passed; Tests 14 passed

npm run typecheck --workspace=@anna/harness-v2
npm run typecheck --workspace=@anna/pi-loop-kernel
npm run typecheck --workspace=@anna/harness-service
exit 0

npm run build --workspace=@anna/harness-service
vite: 1110 modules transformed; dist/main.js and dist/pi-kernel-descriptor.json emitted; exit 0
```

The service tests include real SQLite and actual Pi/faux transport. They cover
absent/explicit Pi descriptor equality, explicit OMP and invalid selector
503/zero-claim behavior, body-error precedence, legacy and descriptor-bearing
SQLite close/reopen resume after selector change, valid rehashed identity drift,
consumed transcript plus Host Memory snapshot/usage recovery, no duplicate user
or tool dispatch, valid-format SRI/source-hash sidecar tamper, corrupt/missing
sidecar, and source-less HTTP startup. The consumed-resume loss is injected
after the real `run.usage.updated` append; Pi usage logic was not changed.

The sidecar smoke runs the built service from a temporary source-less layout
with `NODE_ENV=development`, performs a real HTTP OMP admission request, then
uses a complete source checkout as cwd while testing corrupt, stale, and missing
sidecars. All metadata failures exit before readiness.

## Owned Files

- `apps/harness-service/src/index.ts`
- `apps/harness-service/src/production.ts`
- `apps/harness-service/src/runtime.ts`
- `apps/harness-service/src/kernel-selection.ts`
- `apps/harness-service/src/pi-kernel-build-identity.ts`
- `apps/harness-service/vite.config.ts`
- `apps/harness-service/test/kernel-selection.test.ts`
- `apps/harness-service/test/kernel-resume-selection.test.ts`
- `apps/harness-service/test/kernel-sidecar.test.ts`
- `packages/harness-v2/src/index.ts`
- `packages/harness-v2/src/run-profile.ts`
- `packages/harness-v2/src/kernel-descriptor.ts`
- `packages/harness-v2/test/kernel-descriptor.test.ts`
- `packages/pi-loop-kernel/src/index.ts`
- `packages/pi-loop-kernel/src/kernel-source.ts`
- `packages/pi-loop-kernel/src/kernel-descriptor.ts`
- `packages/pi-loop-kernel/test/kernel-descriptor.test.ts`

## Root Integration Checkpoint

The frozen 17 source/test files above, sorted by path, have aggregate SHA-256
`1f4f49724a0784b985fd08fa0e71f9ead4c31317bbec93d2ef6b52fb652bf8b2`.
The aggregate is SHA-256 of compact JSON entries `{path,sha256}`, with each
entry digest computed from the file's raw bytes. Documentation is excluded.

Root verification on 2026-08-30:

| Check | Observed result |
| --- | --- |
| `npm test` | 1,032 passed, 7 gated skips; includes the actual sidecar build/startup test |
| `npm run typecheck` | All workspaces passed |
| `./.venv/bin/python -m pytest -q` | 1,048 passed, 53 existing deprecation warnings |
| `git diff --check` | Passed |
| Public-preview scan, tracked plus untracked candidate files | 1,094 files; zero violations |
| `npm run desktop:package` | macOS arm64 directory package passed; unsigned, existing chunk-size warnings retained |
| `npm run desktop:smoke-asar` | Served index and health passed; model/MCP both `not_configured` |

Final review found two test-evidence defects on the previous candidate
`dfd3bf7bed1653f5a026016791caf5e1d883c446ee173efa527153d0457a0ee9`: the consumed
resume test rewrites a successful Gateway result into `approval_required`, and
the source-hash tamper case omits the required `packageName` field. Those cases
did not establish the claimed real-success recovery and valid-shape stale
source rejection. Both tests are now corrected without product-source changes.
Focused verification passed both cases; root independently reran consumed
recovery. Actual first-attempt model dispatch count is one: the persisted usage
ACK failure stops execution before another model dispatch. An intermediate test
incorrectly waited for a second dispatch and timed out; that test error is not
evidence of a product model-dispatch leak. The repeated full JavaScript suite
passed with 1,032 tests and 7 gated skips on the corrected fingerprint. Sol
Ultra Standards and Spec each accepted this exact fingerprint with zero open
P0/P1/P2 findings. Spec independently reran consumed recovery successfully.
The package
smoke still launches the existing Python default; it does not prove Host
cutover, configured provider/MCP execution, Windows support or publication.

## Remaining Boundary

S0 does not execute OMP, add workers/process pools/protocols, change Desktop
defaults, alter Legacy/Python/UI, or attest the entire bundle/Node/Bun/native
runtime. Root-owned docs and unrelated dirty files are outside this handoff.
Root should rerun the complete workspace test/typecheck/package gate at the
frozen tree.
