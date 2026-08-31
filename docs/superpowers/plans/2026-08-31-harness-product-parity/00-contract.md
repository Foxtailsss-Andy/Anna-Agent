# Product-Parity Integration Contract

Scope: [HF-PARITY-1.0](../../../product/anna-harness-product-parity-goal-2026-08-31.md).
Original UI/API contracts at `f9f4e1` remain authoritative. This contract is for the internal integration, not a replacement frontend API.

## Process And Route Ownership

- Node Host owns the public loopback API and serves the original application.
- A managed Python business service may retain existing identity, CRUD, workflow and connector routers. It is started explicitly in Harness-backed product mode, with no model API key and no legacy Agent scheduler/loop.
- Public Agent routes either execute in the Host or use an explicitly Harness-backed business adapter. Maintain an explicit route map; no unexamined catch-all fallback to a legacy Agent API.
- Internal calls require the startup-generated `x-anna-service-token` and loopback transport. Browser requests cannot supply a replacement trusted identity/profile or invoke private routes.

## Whole-Task Host API

The internal prefix is `/_harness`. The Node/facade owner implements it; the business owner consumes it. Before changing a shared field, notify the other owner.

`POST /_harness/runs` accepts a validated, JSON-safe task:

```typescript
type ProductTask = {
  run_id: string;
  workspace_id: string;
  actor_user_id: string;
  surface: "chat" | "create" | "hiker" | "reimbursement" | "crew";
  prompt: string;
  channel_id?: string;
  conversation_id?: string;
  system_prompt?: string;
  context?: Record<string, unknown>;
  workdir_path?: string;
  permission_mode?: "readonly" | "ask" | "contained-write" | "full";
  model_profile_id?: string;
  source_event_id?: string;
};
```

- 202 response: `{run_id, status}`.
- `GET /_harness/runs/:id`: `{run_id, status, result?, events}` with canonical events and truthful assistant result.
- `GET /_harness/runs/:id/events?after_seq=-1`: canonical SSE.
- `POST /_harness/runs/:id/stop`: scoped cancellation.
- Continuation/interjection/approval preserve the original UI contract; attach to the original session/task and explicit Harness continuation rather than creating untracked parallel work.
- Scope comes from the authenticated product adapter; `context` is untrusted task data, not authority. No model credentials belong in this payload.

## Business Tools And Context

- Business owner exposes narrow token-protected `/_business` adapters for admitted Hiker tools and scoped project/channel context, using existing connectors and stores.
- Hiker discovery publishes only admitted names/schemas/effect classes. Calls carry the Host's workspace/user/Run identity; remote actor credentials come from protected configuration, never model arguments.
- External writes preserve approval and readback. Test writes carry a synthetic marker and a recoverable record ID.
- Crew context includes the existing project/task graph, relevant prior channel messages and authorized project Memory. Replies/outputs return to the existing channel/artifact schema.

## Coding Ownership

- Kernel owner: OMP package/protocol/worker, native Todo/hooks, dynamic admitted tools, reasoning/message transport and conversation-seed hook; `omp-model-transport.ts`.
- Product Host owner: original App/launcher, Node public facade and `/_harness` API, product Run/Profile/tools/session persistence, Home/Create compatibility. Owns service `production.ts` integration; coordinate kernel extension points.
- Business owner: Python business mode/bridges, Hiker and Crew adapters including hidden model-call paths, existing workflow/data compatibility.
- Root: protected configuration, original-product evidence, integration/gates, CI/docs/GitHub. Sol Ultra controls scope and fixed-candidate review.

No owner installs/replaces the bound OMP runtime or builds shared artifacts without coordinating with root. Do not edit the old S3 worktree. Do not log credentials or use fake responses as live evidence.
