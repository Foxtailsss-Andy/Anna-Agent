# Upgrade contracts (owner-maintained; workers implement against these)

All JSON is snake_case on public `/api/*` routes. Missing evidence stays absent (never `0` or invented).

## 1. Desktop ↔ Product Host (`/api/workbench/*`) — owner implements Host, F2/F1 implement UI

### 1.1 Run projection additions (`GET /api/workbench/runs/:id`, `session.runs[]`)

```ts
interface WorkbenchRun {
  // existing fields unchanged …
  permission_mode: "readonly" | "contained-write";      // always present, default "readonly"
  goal_id?: string;                                      // run belongs to the session Goal
  trigger?: "user" | "goal_continuation";
  live_output?: {                                        // only while non-terminal and a model response is streaming
    text: string;                                        // assistant text streamed so far for the current model request
    reasoning_chars: number;                             // count only; reasoning text is not exposed
    request_index: number;                               // 1-based model request index inside the run
    updated_at: string;
  };
  plan?: {                                               // latest OMP todo snapshot of this run (absent if the model never used todo)
    phases: Array<{ name: string; tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked"; blocker?: string }> }>;
    updated_seq: number;
  };
  tools?: Array<{                                        // tool activity timeline, oldest first
    call_id: string;
    name: string;                                        // canonical tool id e.g. "workdir.write_file", "sandbox.exec", "mcp.fixture.echo"
    status: "running" | "succeeded" | "failed" | "unknown";
    started_at: string;
    ended_at?: string;
    summary?: string;                                    // short Host-authored summary e.g. "exit 0 · 120 ms", "wrote notes.md (2.1 KB)"
  }>;
  sandbox?: { kind: "macos-seatbelt"; network: "denied"; writable_roots: string[] };  // present when sandbox.exec was admitted
  usage?: { input_tokens?: number; output_tokens?: number };                          // provider-reported cumulative only
}
```

`session.messages[]` is unchanged (user prompt + assistant text per run). The UI must render `live_output.text` as the in-progress assistant message of the *current* run and drop it once the run's persisted assistant message appears or the run is terminal.

### 1.2 Run submission

`POST /api/workbench/sessions/:id/runs` body adds `permission_mode?: "readonly" | "contained-write"` (default readonly).
`contained-write` without exactly one `workdir:` resource ref → `422 {code:"permission_requires_workdir"}`.

### 1.3 Steer (interject into a running Run)

`POST /api/workbench/runs/:id/steer {text}` → `202 {run_id, status, accepted: boolean, consumed?: boolean}`. `accepted=false` when the run is already terminal. OMP consumes a steer at its next turn boundary; the Host waits up to 1.5 s and reports `consumed:true` if it was already taken into the transcript, otherwise `consumed:false` (queued). `409 {code:"harness_signal_unavailable"}` when the kernel rejects it.

### 1.4 Trace

`GET /api/workbench/runs/:id/trace` → `200 TraceDto` (identical shape to `apps/desktop/src/lib/api/trace.ts`: `{trace_id, surface, spans:[{span_id,parent_span_id,name,kind,start_time,end_time,duration_ms,status,attributes,events:[{name,time,attributes}]}]}`), kinds `agent|turn|inference|tool`. Token attributes only when provider-reported.

### 1.5 Session Goal (proactive continuation)

```ts
interface WorkbenchGoal {
  goal_id: string;
  objective: string;
  status: "active" | "paused" | "awaiting_review" | "completed" | "stopped" | "budget_exhausted" | "failed";
  max_runs: number;          // 1..8, default 4
  runs_used: number;
  run_ids: string[];
  permission_mode: "readonly" | "contained-write";
  last_reason?: string;      // "plan_incomplete" | "run_timed_out" | "plan_complete" | "final_answer_without_plan" | "run_cancelled" | "user_paused" | "user_stopped" | "budget_exhausted" | `run_failed:${code}`
  plan_progress?: { completed: number; total: number };
  created_at: string;
  updated_at: string;
}
// WorkbenchSession gains: goal?: WorkbenchGoal
```

| Route | Body | Result |
| --- | --- | --- |
| `POST /api/workbench/sessions/:id/goal` | `{objective, source_event_id, max_runs?, permission_mode?, resource_refs?}` | `201 {goal, run_id}`; `409 goal_already_active` |
| `POST /api/workbench/sessions/:id/goal/pause` | `{}` | `200 {goal}` (current run continues, no further continuation) |
| `POST /api/workbench/sessions/:id/goal/resume` | `{max_runs?}` | `200 {goal, run_id?}` from `paused`/`failed`/`budget_exhausted` (starts a continuation when no run is active; `max_runs` may raise the limit ≤ 8, else `409 goal_budget_exhausted`); other states `409 goal_not_resumable` |
| `POST /api/workbench/sessions/:id/goal/stop` | `{}` | `200 {goal}` (stops the active run; status `stopped`); from `active/paused/awaiting_review/budget_exhausted/failed` |
| `POST /api/workbench/sessions/:id/goal/complete` | `{}` | `200 {goal}` (only from `awaiting_review`; user confirmation) |

Continuation runs carry `trigger:"goal_continuation"`, `goal_id`, and a Host-authored prompt that starts with `【目标续跑 n/max】`. The UI should show it as a Host continuation (not as something the user typed).

## 2. Host ↔ Business (`/_business/crew/tools/call`) — owner calls, worker P implements

New tool name `crew.propose_changes` (same request envelope `CrewToolCallRequest` + optional `tool_call_id: str`).

```jsonc
// arguments
{
  "project_id": "proj_1",
  "summary": "≤500 chars, why these changes",
  "new_tasks": [            // 0..5
    { "title": "竞品调研", "role": "设计", "acceptance": "…",
      "depends_on": ["营销 Brief"],          // titles of other new_tasks or existing tasks this one waits for
      "insert_before": ["文案撰写"],          // titles of EXISTING tasks that must wait for this new task
      "assignee_id": "acc_andy" }            // optional member id
  ],
  "assignments": [          // 0..5, existing tasks
    { "task_id": "task_2_copy", "member_id": "acc_andy", "reason": "…" }
  ]
}
```

- At least one of `new_tasks`/`assignments` non-empty. Validation failures → HTTP 422 `{"detail": "<code>"}` with codes such as `project_not_found`, `unknown_task_title:<title>`, `insert_before_not_allowed:<title>` (target in_progress/review/done), `unknown_task:<id>`, `assignee_not_member:<id>`, `duplicate_title:<title>`, `empty_proposal`.
- Effect: write ONE channel row `kind="command"`, `author_kind="anna"`, body `Anna 提议：<summary>`, payload:
  `{drafts:[{title, role, depends_on, insert_before, acceptance, assignee_id}], assignments:[{task_id, member_id, reason}], origin:"anna_coordination", source:{type:"workbench_run", run_id, tool_call_id}, text: summary, suggested_assignee: null}`.
  No task/graph/assignment changes until the owner confirms.
- Response: `{"name":"crew.propose_changes","effect":"proposal","result":{"message_id": "...", "new_task_count": n, "assignment_count": m, "status": "awaiting_confirmation"}}`.
- Idempotent by `(run_id, tool_call_id)` when `tool_call_id` is given: repeat returns the same `message_id` without a second row.

Confirm: `POST /api/crew/projects/{id}/channel/command/confirm {message_id, draft_indexes?, assignment_indexes?}` (owner only, as today):
- creates chosen drafts (existing semantics) — `depends_on` resolves against chosen drafts then existing titles;
- for each created draft with `insert_before`, adds the new task id to each named existing task's `depends_on` (only tasks in `todo`/`blocked`; others are skipped and reported in the confirmation event body), then readiness is recomputed;
- for each created draft with `assignee_id`, assigns through the normal `assign` path (invalid/ghost → skipped, noted);
- applies chosen `assignments` through the normal `assign` path (invalid → skipped, noted);
- default when indexes are omitted: all drafts and all assignments.

`＋任务` drafter (`/channel/command`): drafts gain `insert_before`; the model is given existing task titles+status so “放在 X 之前” becomes `insert_before:["X"]`; the deterministic fallback stays `[]`.

## 3. Host-internal module interfaces — worker T / worker M implement, owner integrates

### 3.1 `apps/harness-service/src/workbench-files.ts` (T)

Keep `readRegisteredWorkdirFile` behaviour. Add, with the same `WorkbenchWorkdirResolutionOptions` + `AbortSignal` signature and `{status, output}` result:

- `listRegisteredWorkdir(input: {path?: string; depth?: 1..4}, options, signal)` → `{entries:[{path, type:"file"|"dir", bytes?}], truncated}` (≤ 500 entries, skips `.git`, `node_modules`, dot-dirs unless asked by path).
- `searchRegisteredWorkdir(input: {pattern: string; path?: string; max_results?: 1..200; regex?: boolean}, options, signal)` → `{matches:[{path, line, text}], truncated}` (UTF-8 text files ≤ 1 MiB, literal by default).
- `writeRegisteredWorkdirFile(input: {path: string; content: string; overwrite?: boolean}, options, signal)` → `{path, bytes, created: boolean}`; ≤ 1 MiB; refuses outside-root, symlink escapes, protected paths, existing file unless `overwrite:true`; creates parent dirs inside root.
- `editRegisteredWorkdirFile(input: {path: string; old_text: string; new_text: string}, options, signal)` → `{path, bytes, replacements: 1}`; requires exactly one occurrence.

### 3.2 `apps/harness-service/src/workbench-sandbox.ts` (T)

```ts
export interface SandboxDescriptor { kind: "macos-seatbelt"; network: "denied"; writable_roots: string[]; read_denied_roots: string[] }
export function sandboxSupport(): { available: true } | { available: false; reason: string };
export interface SandboxExecInput { command: string; cwd?: string; timeout_ms?: number }   // cwd relative to workdir; timeout ≤ 120000 (default 30000)
export interface SandboxExecOutput {
  exit_code: number | null; signal?: string; timed_out: boolean; duration_ms: number;
  stdout: string; stderr: string; stdout_truncated: boolean; stderr_truncated: boolean;
  sandbox: SandboxDescriptor;
}
export async function runSandboxedCommand(input: unknown, options: {
  workdirRoot: string;               // canonical admitted workdir
  protectedPaths: readonly string[]; // always read- and write-denied even if under an allowed root
  signal: AbortSignal;
  maxOutputBytes?: number;           // per stream, default 64 KiB
}): Promise<{ status: "succeeded" | "failed"; output: SandboxExecOutput | { reason: string } }>;
// status "succeeded" iff the process ran and exited 0; non-zero exit is status "failed" with full output.
```

### 3.3 `apps/harness-service/src/workbench-mcp.ts` (M)

```ts
export interface McpServerConfig { command?: string; args?: string[]; env?: Record<string,string>; cwd?: string; url?: string; headers?: Record<string,string>; timeout_ms?: number }
export interface McpToolDescriptor {
  capability_id: string;      // "mcp.<server>.<tool>" sanitized to [a-z0-9_.-], unique
  server_id: string; tool_name: string; description: string;
  input_schema: Record<string, unknown>;   // JSON Schema object (type:"object"), passthrough of server schema
  read_only: boolean;                       // annotations.readOnlyHint === true
}
export interface McpManager {
  start(): Promise<void>;                   // connect + initialize + tools/list for every server, bounded by timeout; failures recorded, never thrown
  tools(): readonly McpToolDescriptor[];    // synchronous snapshot
  status(): Array<{ server_id: string; state: "ready" | "failed" | "disabled"; tool_count: number; error?: string }>;
  call(capabilityId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ status: "succeeded" | "failed"; output: Record<string, unknown> }>;
  close(): Promise<void>;
}
export async function loadMcpConfig(path: string | undefined): Promise<Record<string, McpServerConfig>>;  // {"mcpServers": {...}}; missing path → {}
export function createMcpManager(servers: Record<string, McpServerConfig>, options?: { clientName?: string; now?: () => number }): McpManager;
```
`call` output: `{content: [...text/structured blocks...], is_error: boolean, structured_content?: …}` bounded to 64 KiB of text; protocol/transport errors → `{status:"failed", output:{reason:"mcp_transport_failed"|"mcp_tool_error"|"mcp_timeout"|"mcp_server_unavailable"}}`.

## 4. Implementation notes recorded by the owner (2026-10-08)

- The existing progressive capability catalog (`web_search`, `web_read`, `workdir.read_file`, `skills.load`, `crew.project.read`, `crew.channel.read`) is unchanged: catalog capabilities become active only after `capabilities.load`. New general tools are **direct Host tools** admitted by the Workbench profile and active from the first model request: `todo`; with a workdir `workdir.list`, `workdir.search`; with `contained-write` additionally `workdir.write_file`, `workdir.edit_file`, `sandbox.exec` (only where `sandboxSupport()` is available); with a Crew project `crew.propose_changes`; MCP tools (`read_only` always, others only in `contained-write`). The OMP kernel restore rule and the Host agree on this: tools outside the catalog are always active.
- Write/exec/proposal/MCP calls carry a Host effect key (`tool.effect.*` events), so an interrupted effect becomes `unknown` on restore instead of being replayed.
- OMP `todo.reminders` is disabled in the worker: OMP would otherwise inject a hidden developer reminder when a turn stops with open todo items, which the Host-owned history rejects (this made any Run that stopped with an open plan fail). Continuation of unfinished plans is the Session Goal's job.
- `POST /api/workbench/sessions/:id/goal` is idempotent by `source_event_id` (same id → `200` with the existing goal).
- `/v2/*` on the Product Host returns `404 {code:"review_api_not_served_by_product_host"}`.
