import { apiJson } from "./client";

export type WorkbenchSurface = "chat" | "create" | "hiker" | "reimbursement" | "crew";

export interface WorkbenchSession {
  schema_version?: 2;
  session_id: string;
  workspace_id?: string;
  actor_user_id?: string;
  channel_id?: string;
  project_id?: string;
  surface: string;
  created_at?: string;
  updated_at?: string;
  runs?: WorkbenchRun[];
  messages?: WorkbenchMessage[];
  /** CONTRACTS §1.5: the session-scoped, user-authorized Goal (absent when none was created). */
  goal?: WorkbenchGoal;
  watermark?: Record<string, unknown>;
}

/** CONTEXT.md permission mode vocabulary; Workbench admits these two. */
export type WorkbenchPermissionMode = "readonly" | "contained-write";

export interface WorkbenchLiveOutput {
  /** Assistant text streamed so far for the current model request. */
  text: string;
  /** Count only; reasoning text is never exposed. */
  reasoning_chars: number;
  request_index: number;
  updated_at: string;
}

export type WorkbenchPlanTaskStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface WorkbenchPlan {
  phases: Array<{
    name: string;
    tasks: Array<{ content: string; status: WorkbenchPlanTaskStatus; blocker?: string }>;
  }>;
  updated_seq: number;
}

export interface WorkbenchToolActivity {
  call_id: string;
  name: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  started_at: string;
  ended_at?: string;
  summary?: string;
}

export interface WorkbenchSandbox {
  kind: "macos-seatbelt";
  network: "denied";
  writable_roots: string[];
}

export interface WorkbenchRun {
  run_id: string;
  session_id?: string;
  surface?: string;
  prompt?: string;
  source_event_id?: string;
  skill_id?: string;
  agent_id?: string;
  model_profile_id?: string;
  status: string;
  admission_status?: string;
  admission_error?: string;
  result?: WorkbenchResult;
  created_at?: string;
  updated_at?: string;
  watermark?: Record<string, unknown>;
  /** Always present on the Host projection (CONTRACTS §1.1); absent on submit responses. */
  permission_mode?: WorkbenchPermissionMode;
  goal_id?: string;
  trigger?: "user" | "goal_continuation";
  /** Only while non-terminal and a model response is streaming. */
  live_output?: WorkbenchLiveOutput;
  plan?: WorkbenchPlan;
  tools?: WorkbenchToolActivity[];
  sandbox?: WorkbenchSandbox;
  /** Provider-reported cumulative usage only; each count may be missing. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type WorkbenchGoalStatus =
  | "active"
  | "paused"
  | "awaiting_review"
  | "completed"
  | "stopped"
  | "budget_exhausted"
  | "failed";

export interface WorkbenchGoal {
  goal_id: string;
  objective: string;
  status: WorkbenchGoalStatus;
  max_runs: number;
  runs_used: number;
  run_ids: string[];
  permission_mode: WorkbenchPermissionMode;
  last_reason?: string;
  plan_progress?: { completed: number; total: number };
  created_at: string;
  updated_at: string;
}

export interface WorkbenchMessage {
  run_id: string;
  event_id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  source_event_id?: string;
}

export interface WorkbenchEvent {
  run_id: string;
  event_id: string;
  type: string;
  seq: number;
  timestamp: string;
  status?: string;
  reason?: string;
  error_code?: string;
  message?: { role: "assistant"; content: string };
  capability_ids?: string[];
  tool_name?: string;
}

export interface WorkbenchResult {
  assistant_message?: string;
  capabilities?: string[];
  tools?: unknown[];
  [key: string]: unknown;
}

export interface WorkbenchRunEvents {
  run_id: string;
  events: WorkbenchEvent[];
  watermark?: Record<string, unknown>;
}

export async function createWorkbenchSession(options: {
  surface?: WorkbenchSurface;
  projectId?: string;
} = {}): Promise<WorkbenchSession> {
  return apiJson<WorkbenchSession>("/api/workbench/sessions", {
    method: "POST",
    json: {
      ...(options.surface === undefined ? {} : { surface: options.surface }),
      ...(options.projectId === undefined ? {} : { project_id: options.projectId }),
    },
  });
}

export function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  return apiJson<WorkbenchSession>(`/api/workbench/sessions/${encodeURIComponent(sessionId)}`);
}

export function listWorkbenchSessions(options: { projectId?: string } = {}): Promise<{ sessions: WorkbenchSession[] }> {
  const query = options.projectId === undefined ? "" : `?project_id=${encodeURIComponent(options.projectId)}`;
  return apiJson<{ sessions: WorkbenchSession[] }>(`/api/workbench/sessions${query}`);
}

export async function submitWorkbenchRun(
  sessionId: string,
  body: {
    prompt: string;
    sourceEventId: string;
    surface?: WorkbenchSurface;
    parentRunId?: string;
    resourceRefs?: string[];
    skillId?: string;
    agentId?: string;
    modelProfileId?: string;
    requestedArtifact?: "skill" | "prompt" | "python_tool";
    /** Omitted → Host default `readonly`. `contained-write` needs exactly one `workdir:` ref. */
    permissionMode?: WorkbenchPermissionMode;
  },
): Promise<WorkbenchRun> {
  return apiJson<WorkbenchRun>(`/api/workbench/sessions/${encodeURIComponent(sessionId)}/runs`, {
    method: "POST",
    json: {
      prompt: body.prompt,
      source_event_id: body.sourceEventId,
      ...(body.surface === undefined ? {} : { surface: body.surface }),
      ...(body.parentRunId === undefined ? {} : { parent_run_id: body.parentRunId }),
      resource_refs: body.resourceRefs ?? [],
      ...(body.skillId === undefined ? {} : { skill_id: body.skillId }),
      ...(body.agentId === undefined ? {} : { agent_id: body.agentId }),
      ...(body.modelProfileId === undefined ? {} : { model_profile_id: body.modelProfileId }),
      ...(body.requestedArtifact === undefined ? {} : { requested_artifact: body.requestedArtifact }),
      ...(body.permissionMode === undefined ? {} : { permission_mode: body.permissionMode }),
    },
  });
}

export function getWorkbenchRun(runId: string): Promise<WorkbenchRun> {
  return apiJson<WorkbenchRun>(`/api/workbench/runs/${encodeURIComponent(runId)}`);
}

export function getWorkbenchRunEvents(runId: string, afterSeq = -1): Promise<WorkbenchRunEvents> {
  return apiJson<WorkbenchRunEvents>(
    `/api/workbench/runs/${encodeURIComponent(runId)}/events?after_seq=${afterSeq}`,
  );
}

export function stopWorkbenchRun(
  runId: string,
  reason?: string,
): Promise<{ run_id: string; status: string }> {
  return apiJson<{ run_id: string; status: string }>(`/api/workbench/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    ...(reason === undefined ? {} : { json: { reason } }),
  });
}

export interface WorkbenchSteerResult {
  run_id: string;
  status: string;
  /** false when the Run was already terminal; the text did not enter the Run. */
  accepted: boolean;
  /** true once OMP took the text into the transcript; false = queued for its next turn. */
  consumed?: boolean;
}

export interface WorkbenchHostTools {
  sandbox: { available: boolean; kind?: string; network?: string; reason?: string };
  mcp_servers: Array<{
    server_id: string;
    state: string;
    transport: string;
    tool_count: number;
    error?: string;
    tools: Array<{ capability_id: string; tool_name: string; read_only: boolean }>;
  }>;
}

/** Host tool availability (Sandbox support, configured MCP servers) for permission prompts. */
export function getWorkbenchTools(): Promise<WorkbenchHostTools> {
  return apiJson<WorkbenchHostTools>("/api/workbench/tools");
}

/** MCP tools that write to external systems; admitted only together with contained-write. */
export function mcpWriteToolNames(tools: WorkbenchHostTools | null): string[] {
  return (tools?.mcp_servers ?? [])
    .filter((server) => server.state === "ready")
    .flatMap((server) => server.tools.filter((tool) => !tool.read_only).map((tool) => `${server.server_id}/${tool.tool_name}`));
}

/** Interject into a running Run (CONTRACTS §1.3). 409 `harness_signal_unavailable` surfaces as ApiError. */
export function steerWorkbenchRun(runId: string, text: string): Promise<WorkbenchSteerResult> {
  return apiJson<WorkbenchSteerResult>(`/api/workbench/runs/${encodeURIComponent(runId)}/steer`, {
    method: "POST",
    json: { text },
  });
}

export interface WorkbenchGoalResponse {
  goal: WorkbenchGoal;
  /** Present when the Host started a Run for this action (create, and resume when idle). */
  run_id?: string;
}

/** Create the session Goal and its first Run (CONTRACTS §1.5). 409 `goal_already_active`. */
export function createWorkbenchGoal(
  sessionId: string,
  body: {
    objective: string;
    sourceEventId: string;
    maxRuns?: number;
    permissionMode?: WorkbenchPermissionMode;
    resourceRefs?: string[];
  },
): Promise<WorkbenchGoalResponse & { run_id: string }> {
  return apiJson<WorkbenchGoalResponse & { run_id: string }>(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/goal`,
    {
      method: "POST",
      json: {
        objective: body.objective,
        source_event_id: body.sourceEventId,
        ...(body.maxRuns === undefined ? {} : { max_runs: body.maxRuns }),
        ...(body.permissionMode === undefined ? {} : { permission_mode: body.permissionMode }),
        ...(body.resourceRefs === undefined ? {} : { resource_refs: body.resourceRefs }),
      },
    },
  );
}

function goalAction(
  sessionId: string,
  action: "pause" | "resume" | "stop" | "complete",
  json: Record<string, unknown> = {},
): Promise<WorkbenchGoalResponse> {
  return apiJson<WorkbenchGoalResponse>(`/api/workbench/sessions/${encodeURIComponent(sessionId)}/goal/${action}`, {
    method: "POST",
    json,
  });
}

/** The current Run continues; no further continuation is started. */
export const pauseWorkbenchGoal = (sessionId: string) => goalAction(sessionId, "pause");
/** Starts a continuation (returns `run_id`) when no Run is active; `maxRuns` raises the Run limit (≤ 8). */
export const resumeWorkbenchGoal = (sessionId: string, maxRuns?: number) =>
  goalAction(sessionId, "resume", maxRuns === undefined ? {} : { max_runs: maxRuns });
/** Stops the active Run; the Goal becomes `stopped`. */
export const stopWorkbenchGoal = (sessionId: string) => goalAction(sessionId, "stop");
/** User confirmation; only valid from `awaiting_review`. */
export const completeWorkbenchGoal = (sessionId: string) => goalAction(sessionId, "complete");
