# PV-01 Default Entry Contract

Scope: [HF-PREVIEW-1.0](../../../product/anna-harness-first-preview-goal-2026-08-31.md).
This is a local, single-user Preview API, not a new multi-user authentication system.

## Bootstrap

- Desktop starts one Node Harness Preview Host and loads its `apiBase`.
- The Host serves the built `dist/` application and `/api/preview/*` on the same loopback origin.
- Existing legacy API routes are not part of the default Preview application.
- No model configuration must not prevent `/health`, settings or the application from opening.
- Runtime state/config paths and the pinned OMP runtime root are explicit launcher inputs.
- Use a Preview-specific state directory. Do not rewrite legacy Python databases.

## HTTP

All bodies are closed JSON, bounded by 1 MiB. JSON mutations reject cross-origin
browser requests and unsupported content types. Bind only to loopback.
The Host derives the local workspace/channel scope; clients cannot submit a replacement scope/profile/kernel.

```typescript
type PreviewSettings = {
  model_name: string;
  model_endpoint: string;
  workspace_root: string;
  has_api_key: boolean;
};
type PreviewStatus = {
  protocol: "anna-harness-preview/1";
  kernel: "omp";
  configured: boolean;
  ready: boolean;
  reason?: string;
};
type PreviewRunSummary = {
  run_id: string;
  goal: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
  created_at: string;
  updated_at: string;
};
```

| Method / Path | Request | Response |
| --- | --- | --- |
| `GET /health` | none | `{status:"ok", protocol:"anna-harness-preview/1"}` |
| `GET /api/preview/status` | none | `PreviewStatus` |
| `GET /api/preview/settings` | none | `PreviewSettings`; never returns the key |
| `PUT /api/preview/settings` | `{model_name, model_endpoint, workspace_root, model_api_key?}` | `PreviewSettings`; omitted/empty key preserves the saved key |
| `GET /api/preview/runs` | none | `{runs: PreviewRunSummary[]}` for the active workspace |
| `POST /api/preview/runs` | `{run_id, command_id, goal}` | 202 `{run_id,status}`; identical retry does not create another Run |
| `GET /api/preview/runs/:id` | none | `{run: PreviewRunSummary, events: CanonicalEvent[]}` |
| `GET /api/preview/runs/:id/events?after_seq=N` | none | SSE `event: canonical`, JSON canonical events with increasing seq |
| `POST /api/preview/runs/:id/stop` | `{}` | 202 `{run_id,status:"cancelling"}`; terminal Run returns its existing status without new execution |

Use `{code, message?}` for errors. 400 invalid input, 404 unknown scoped Run,
409 missing configuration/active settings conflict, 503 unavailable OMP.
Do not return raw provider errors containing credentials.

SSE streams real lifecycle/tool/final-message events. Per-token text streaming is
not a first-release gate; the UI must not invent tokens or progress percentages.
The stream ends after the final canonical terminal event and supports read-only reconnect by seq.

## Execution

- Reuse the accepted S2 production Host/OMP/Memory/Gateway/Eval path.
- Force the new Run profile's kernel to the verified OMP descriptor. Derive it from
  existing `currentOmpImplementation` plus the prepared runtime manifest and fixed upstream identity.
- Keep one live Runtime instance for the current settings; reject settings changes
  while a Run is active and drain/close before replacing that instance.
- Stop targets the admitted scoped Run's AbortController, not a user-supplied PID
  or an unscoped search. No new steer/answer/control protocol is required.
- Preserve the original Run/Profile/Memory and single terminal/Eval contracts.

## Ownership

- Host owner: `apps/harness-service` Preview bootstrap/API/settings/history/static
  serving and the narrow existing Runtime stop hook; service build configuration.
- Desktop owner: normal Electron startup/packaging and a focused Preview UI/API client.
- Root: integration contract, dependency/runtime preparation, real smoke, final gates and publication.

Each owner first proves the missing public behavior, then implements the smallest vertical.
Do not import the unfinished S3 worktree or recreate its full control protocol.
