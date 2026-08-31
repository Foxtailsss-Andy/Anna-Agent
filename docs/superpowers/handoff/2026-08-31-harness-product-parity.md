# Harness Product-Parity Validation

Date: 2026-08-31. Goal: HF-PARITY-1.0.
Updated after the local date changed to 2026-09-01.
Status: release candidate under validation; the complete Goal is not yet accepted.

## Product Boundary

The original Home, Cowork and Crew product is retained. The UI reference is
`f9f4e1ae06eb4fa54e6f5ebf2974de34ff341b64`, before the separate Preview entry.
Node owns Agent execution through verified Oh-my-Pi; Python retains model-less
business APIs, identity, stores, state machines and connector operations.

## Observed Evidence

| Check | Evidence | Boundary |
| --- | --- | --- |
| Original product | Actual login, Home workdir mounting, Cowork dashboard, Crew graph, artifact reader, review and dependency unlock were exercised | Preserves the original interface; not a replacement Preview panel |
| Home model task | `chat_run_002` returned `HOME_OMP_DEEPSEEK_OK` through OMP and real DeepSeek V4 Pro High; provider usage input 2010/output 125; Contract Eval passed before `run.completed` | A real single-turn task, not proof of all Home features |
| Crew contextual Anna | A new, real Anna response correctly identified the newly approved review and the unlocked downstream node in the existing Showcase project | The project seed is synthetic; the added response is an actual model execution |
| Hiker dashboard | Public Product API returned HTTP 200/ready, seven KPI fields and three audited MCP read calls; business mode reported Host execution and absent model credentials | Genuine connector reads; no write was performed |
| Native Todo and steer restore | Root ran `omp-resume-native-steer.test.ts`: two passing real SDK/kernel restore cases | Bounded restore evidence, not an exhaustive fault matrix |
| Type checking | Root repository `npm run typecheck` passed after the product integration | Runtime and live acceptance remain separate gates |
| Python regression | Root `.venv/bin/python -m pytest -q`: 1072 passed, 53 warnings | Current business/legacy regression, not live model or write proof |

The first live Home attempt received a valid provider response but failed in the
OMP reasoning-stream projection. The visible failure and its canonical history
were retained. The conversion was fixed and the second live task completed.

The original Trace button also exposed an incompatible API response. The Python
adapter now projects canonical events into the existing `TraceDoc` contract;
its focused regression passed. A fresh UI recheck is still required.

## Open Gates

- Home native Todo, actual file read, formal document artifact and next-turn context.
- Hiker assistant execution through the model/tool loop.
- A real Crew Worker artifact, beyond the deterministic Showcase seed.
- Current JavaScript regression, packaged application smoke and CI.
- Final Sol review of the corrected integration and canonical GitHub merge.
- **External blocker:** the configured Hiker server advertises eleven read tools
  and `write_tools_enabled=false`. Authorized synthetic write/readback acceptance
  cannot pass until the server exposes an approved write capability. A read test
  must never be reported as a successful write.

No provider key, connector credential, raw provider reasoning, real business
record, private configuration or runtime database is included in this evidence.
