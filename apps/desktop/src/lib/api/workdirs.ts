/**
 * workdirs · 工作空间(本地文件夹)客户端(Home 合并轮 M2 · V2 H-07)
 *
 * UI 名「工作空间」;API 名 workdir(避开租户 workspace_id)。
 * pickFolder:Electron 原生对话框(preload 注入);浏览器 dev 环境返回 null,
 * 由弹层回退为路径输入(路径真伪由后端 POST 校验,不做假文件树)。
 */

import { apiFetch, apiJson } from "./client";

export interface Workdir {
  id: string;
  name: string;
  path: string;
  last_used_at?: string;
}

export const listWorkdirs = () =>
  apiJson<{ workdirs: Workdir[] }>("/api/workdirs");

export const addWorkdir = (path: string, name?: string) =>
  apiJson<Workdir>("/api/workdirs", { method: "POST", json: { path, name } });

export const touchWorkdir = (id: string) =>
  apiJson<Workdir>(`/api/workdirs/${id}/touch`, { method: "POST" });

export const removeWorkdir = (id: string) =>
  apiFetch(`/api/workdirs/${id}`, { method: "DELETE" });

/** Electron 环境弹原生选文件夹;浏览器环境无此能力 → null(调用方走路径输入回退)。 */
export async function pickFolder(): Promise<string | null> {
  const fn = typeof window !== "undefined" ? window.__ANNA_RUNTIME__?.pickFolder : undefined;
  if (!fn) return null;
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

/** 是否有原生选文件夹能力(决定弹层显示「打开本地文件夹…」还是路径输入)。 */
export function canPickFolder(): boolean {
  return typeof window !== "undefined" && typeof window.__ANNA_RUNTIME__?.pickFolder === "function";
}
