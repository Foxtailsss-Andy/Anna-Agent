import { apiUrl } from "../runtime";
import { getIdentity, identityHeaders } from "./identity";

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body.slice(0, 200)}`);
  }
}

/** 统一入口:拼 base、注身份头、JSON 序列化。业务失败(200+run.failed)由调用侧读 run 字段。 */
export async function apiFetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
  const id = await getIdentity();
  const headers: Record<string, string> = {
    ...identityHeaders(id),
    ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res;
}

export async function apiJson<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  return (await (await apiFetch(path, init)).json()) as T;
}
