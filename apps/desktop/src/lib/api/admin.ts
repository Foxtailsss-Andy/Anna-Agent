import { apiUrl } from "../runtime";
import { ApiError, apiJson } from "./client";

/**
 * 本机管理面。admin_runtime + governance(多数)端点**不带** X-Anna-* 头(A1 §1),
 * 故不走 `apiFetch`(那会注身份头 + 需 getIdentity),而是直接 `fetch(apiUrl(...))`。
 * 例外:`agent-runs/ledger`(与 memory,本轮未纳入)要带 X-Anna-* → 走 `apiJson`。
 */
async function adminJson<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export interface AddModelProfileInput {
  id: string;
  label: string;
  provider?: string;
  endpoint: string;
  model_name: string;
  api_key?: string;
}

export const getRuntimeStatus = () =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/status");
export const getRuntimeConfig = () =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/config");
/** J4 数据出境披露:数据会去哪、各自会收到什么(v1 纯披露,无计数)。 */
export const getEgress = () => adminJson<Record<string, unknown>>("/api/admin/egress");
export const putRuntimeConfig = (patch: Record<string, unknown>) =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/config", {
    method: "PUT",
    json: patch,
  });
export const addModelProfile = (p: AddModelProfileInput) =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/model-profiles", {
    method: "POST",
    json: p,
  });
export const deleteModelProfile = (id: string) =>
  adminJson<Record<string, unknown>>(`/api/admin/runtime/model-profiles/${id}`, {
    method: "DELETE",
  });
export const getSkills = () =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/skills");
export const validateRuntime = () =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/validate", { method: "POST" });
export const getValidationLedger = () =>
  adminJson<Record<string, unknown>>("/api/admin/runtime/validation-ledger");
export const getDomainReadiness = () =>
  adminJson<Record<string, unknown>>("/api/admin/harness/domain-readiness");
export const getGovernanceStatus = () =>
  adminJson<Record<string, unknown>>("/api/admin/governance/status");

/** 例外:需 X-Anna-*(A1 §2)→ 走 apiJson 注身份头。 */
export const getAgentRunsLedger = () =>
  apiJson<Record<string, unknown>>("/api/admin/agent-runs/ledger");
