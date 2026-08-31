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
| Home task | `chat_run_005` completed five real DeepSeek V4 Pro High turns, native Todo (2/2), `workdir.read_file` and `chat.emit_document`; the original UI rendered the formal document and working Trace panel | Synthetic file only; total provider usage input 19426/output 1631; Contract Eval passed |
| Home next turn | `chat_run_006` recalled the user-only delivery marker plus the earlier file's project code and color, without another tool call | Genuine preceding-user context; provider usage input 2598/output 117 |
| Home stop | Original Stop control cancelled `chat_run_007` after its model request; canonical history ends with Eval/pass and `run.cancelled` | No completed response or tool effect was persisted; does not claim zero provider billing |
| Home Create | `create_run_001` used the original Prompt creation path and produced a reviewable meeting-note Prompt through OMP/DeepSeek; the final UI readback showed validation passed and the Prompt registered in the artifact center | Only the Prompt path was exercised; this is not live coverage of every Create kind or executable capability activation |
| Crew contextual Anna | A new real Anna response identified the approved v2, the instruction not to claim external reminders/synchronization, and the newly unlocked follow-up task | The project seed is synthetic; the added response is an actual model execution |
| Crew Worker and review | Original UI reassignment and execution produced real v1; rejection with explicit criteria led to real v2, which passed the original review and unlocked the next node (8/9). The list automatically displayed v2 after the polling fix | Model usage v1 input 4725/output 712, v2 input 7857/output 1673. These are local demonstration documents, not external synchronization |
| Hiker dashboard | Public Product API returned HTTP 200/ready, seven KPI fields and three audited MCP read calls; business mode reported Host execution and absent model credentials | Genuine connector reads; no write was performed |
| Hiker Agent loop | Fresh UUID Run `hiker_assistant_run_d744fe62a50145a5af85f937484cb04f` completed two model turns around a successful real `hiker.system.list_capabilities` call | Canonical tool result was succeeded/success=true and returned `write_tools_enabled=false`; this does not prove a write |
| Native Todo and steer restore | After aligning the test's admitted Todo profile, `omp-resume-native-steer.test.ts` passed both real SDK/kernel restore cases on the corrected worker | Bounded restore evidence, not an exhaustive fault matrix |
| Type checking | Root repository `npm run typecheck` passed after the product integration | Runtime and live acceptance remain separate gates |
| Python regression | Current metadata changes: `.venv/bin/python -m pytest -q`, 1079 passed, 53 warnings, exit 0 | Business/legacy regression, not live model or write proof |
| Original product smoke | `npm run frontend:product-smoke`: 9 passed, including a real child writing 4 MiB to stdout before health readiness | Verifies the launcher drain and existing product boundaries; not full live task acceptance |
| Packaged application | Fresh unsigned macOS arm64 package and branded ASAR smoke both exited 0; original UI and five product surfaces were available with Host and business health checks passing | Bundled Python 3.12.13/uvicorn; 21465 OMP files verified with zero missing files or byte mismatches; no Windows/Linux or signing claim |

The first live Home attempt received a valid provider response but failed in the
OMP reasoning-stream projection. The visible failure and its canonical history
were retained. The conversion was fixed and the second live task completed.

The original Trace button also exposed an incompatible API response. The Python
adapter now projects canonical events into the existing `TraceDoc` contract.
The actual Home recheck displayed all five model turns, two Gateway tools and
their real usage/timing records without the previous UI crash.

The full JavaScript run reported 1159 passed, 5 failed and 7 skipped. A source-only
SDK import and one Todo fixture profile were corrected; all five failing files
then passed their six focused cases. The current worker is materialized with
manifest `d3ff0284f9d7a4489d66e78fb5b1d3819471a59f4c9dcd01d0e118b6994a241d`.
This is not a claim that the new commit's complete CI has passed.

CI on `21f172e50d4371c45637bc741c6d8e6bb77f6faa` exposed cold-start
deadlines: the sidecar child could exceed five seconds, and the packaged Product
Host could exceed fifteen seconds while verifying its pinned runtime. Product
startup now has a thirty-second deadline; integrity checks, fail-closed child
exits and model Run budgets are unchanged. The focused sidecar test, a fresh
package and its ASAR smoke passed locally with the adjusted startup allowance.
The subsequent commit must still pass its own complete CI.

Subsequent live failures found provider-incompatible dotted function names,
process-local Hiker Run ID reuse, missing read metadata and missing local Artifact
effect keys. These adapter defects were fixed without changing internal tool IDs,
Host idempotence or shared Gateway policy. The mounted Home workdir was separated
from the protected internal Host directory; no directory protection was removed.
Failed live tasks are retained as failures and were not counted as successful reads.

## Open Gates

- Complete CI for the current commit and the canonical GitHub merge.
- **External blocker:** the configured Hiker server advertises eleven read tools
  and `write_tools_enabled=false`. Authorized synthetic write/readback acceptance
  cannot pass until the server exposes an approved write capability. A read test
  must never be reported as a successful write.

No provider key, connector credential, raw provider reasoning, real business
record, private configuration or runtime database is included in this evidence.
