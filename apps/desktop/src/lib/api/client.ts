import { apiUrl } from "../runtime";
import { getIdentity, getToken, identityHeaders } from "./identity";

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API ${status}: ${body.slice(0, 200)}`);
  }
}

/** 统一入口:拼 base、注身份头、JSON 序列化。业务失败(200+run.failed)由调用侧读 run 字段。 */
export async function apiFetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
  const id = await getIdentity();
  // Headers normalizes names case-insensitively, so an explicit caller header
  // can override identity defaults without producing duplicate Authorization
  // fields. The token is request-only; it never enters the URL or payload.
  const headers = new Headers(identityHeaders(id));
  if (init?.json !== undefined) headers.set("Content-Type", "application/json");
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const token = getToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
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
