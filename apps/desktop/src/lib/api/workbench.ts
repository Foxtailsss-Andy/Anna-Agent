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
  watermark?: Record<string, unknown>;
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
