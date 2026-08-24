# T07 Live Runbook

This runbook is for the real Review-to-Validated-Patch canary. It is not a fixture command.

## Required Inputs

The operator must provide all of these values:

| Input | Must be | Check |
| --- | --- | --- |
| `ANNA_T07_LIVE_SOURCE` | A separate clean Anna Git checkout | `git -C "$ANNA_T07_LIVE_SOURCE" status --porcelain` is empty |
| `ANNA_T07_LIVE_HEAD` | The exact `HEAD` of that checkout | `git -C "$ANNA_T07_LIVE_SOURCE" rev-parse HEAD` |
| `ANNA_T07_LIVE_BACKEND_ORIGIN` | A running real local backend origin | `/api/health`, runtime status and v2 capabilities |
| `ANNA_T07_LIVE_PROVIDER` | Provider/model identifier used by the backend | Runtime status reports `model.configured=true` |
| `ANNA_T07_LIVE_APPROVAL_ORIGIN` | A real Owner approval service origin | `GET /status`, `POST /decisions` |
| `ANNA_T07_LIVE_OWNER_ID` | The authenticated Owner identity | `/status.owner_id` and decision `actorId` must match |
| `ANNA_T07_LIVE_EVIDENCE_DIR` | An empty disposable evidence directory | Runner writes `preflight.json`, `summary.json`, `manifest.json` |

Do not use the dirty working directory as `ANNA_T07_LIVE_SOURCE`. Do not put provider tokens in this file or in the command transcript. The backend reads its provider secret from its local runtime configuration.

## Owner Contract

The Owner service must answer:

```http
GET /status
```

with:

```json
{"status":"ready","owner_id":"<ANNA_T07_LIVE_OWNER_ID>","decision_endpoint":"ready","durability":"durable"}
```

For every approval, it must accept:

```http
POST /decisions
Content-Type: application/json
x-anna-owner-id: <ANNA_T07_LIVE_OWNER_ID>
```

and return:

```json
{"approved":true,"actorId":"<ANNA_T07_LIVE_OWNER_ID>"}
```

The local durable bridge can be enabled in the Harness v2 sidecar with
`ANNA_HARNESS_V2_APPROVAL_BRIDGE_ENABLED=1`,
`ANNA_T07_LIVE_OWNER_ID`, and optionally
`ANNA_HARNESS_V2_APPROVAL_STORE_PATH` / `ANNA_HARNESS_V2_APPROVAL_PORT`.
It persists pending requests and decisions as JSONL, requires the
`x-anna-owner-id` header, and waits for an explicit operator decision at
`POST /requests/<request_id>/decision`. This proves the local HTTP and
durability boundary; it is not production T07 evidence until the external
provider, clean source checkout, backend, and operator inputs are supplied.

For a standalone Owner process that does not require model configuration:

```sh
npm run harness:v2:build
export ANNA_HARNESS_V2_APPROVAL_OWNER_ID=<owner-id>
export ANNA_HARNESS_V2_APPROVAL_PORT=9010
export ANNA_HARNESS_V2_APPROVAL_STORE_PATH=/tmp/anna-review-approval.jsonl
npm run harness:v2:approval-bridge
```

In another terminal, use `GET /requests` with the `x-anna-owner-id` header to
inspect pending decisions, then `POST /requests/<request_id>/decision` with
`{"ownerId":"<owner-id>","approved":true}`. Set
`ANNA_T07_LIVE_APPROVAL_ORIGIN=http://127.0.0.1:9010` for the T07 runner.

The request contains `ownerId` and one of `confirm_memory_candidate`, `approve_lane`, or `approve_effect`. The service must record the decision against the supplied trace/artifact identifiers and must reject a different owner.

## Execution

Prepare a separate checkout and verify it before running:

```sh
export ANNA_T07_LIVE_SOURCE=/absolute/path/to/clean-anna-checkout
export ANNA_T07_LIVE_HEAD="$(git -C "$ANNA_T07_LIVE_SOURCE" rev-parse HEAD)"
git -C "$ANNA_T07_LIVE_SOURCE" status --porcelain
```

Start the real backend and Owner service, then set only non-secret identifiers and origins:

```sh
export ANNA_T07_LIVE_BACKEND_ORIGIN=http://127.0.0.1:<backend-port>
export ANNA_T07_LIVE_PROVIDER=<provider-and-model-id>
export ANNA_T07_LIVE_APPROVAL_ORIGIN=http://127.0.0.1:<owner-port>
export ANNA_T07_LIVE_OWNER_ID=<owner-id>
export ANNA_T07_LIVE_EVIDENCE_DIR=/tmp/anna-t07-live-evidence
```

Run the preflight and live scenario from the repository that contains the T07 runner:

```sh
npm run live:t07
```

The command exits `0` only after the real provider Run, Owner decisions, isolated worktree patch, screenshot, tests, Trace/Eval and evidence manifest all pass. It exits `2` for missing inputs, dirty/mismatched source, unavailable backend/Owner, unconfigured provider, failed canary, or manifest failure. An exit `2` is a blocker, never a success result.

Verify the evidence without editing it:

```sh
npm run evidence:verify -- "$ANNA_T07_LIVE_EVIDENCE_DIR/manifest.json"
```

Required evidence includes the real provider Run summary, Owner actor IDs, artifact hashes, isolated worktree path under the disposable root, screenshot provenance, test exit code, Trace terminal sequence and `mergeReady=true`. Fixture evidence and a managed sidecar Run do not satisfy this gate.
