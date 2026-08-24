import { apiUrl } from "../runtime";

export interface AnnaIdentity {
  workspaceId: string;
  userId: string;
  role: string;
  displayName: string;
  source: "token" | "local-runtime";
}

const TOKEN_KEY = "anna.session.token";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

let cached: AnnaIdentity | null = null;

/** GET /api/session/current:带 token 走 token 身份,否则本地回落(桌面免登录)。 */
export async function getIdentity(force = false): Promise<AnnaIdentity> {
  if (cached && !force) return cached;
  const token = getToken();
  const res = await fetch(apiUrl("/api/session/current"), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`session/current ${res.status}`);
  const body = (await res.json()) as Record<string, string>;
  cached = {
    workspaceId: body.workspace_id!,
    userId: body.user_id!,
    role: body.role ?? "",
    displayName: body.user_display_name ?? body.user_id!,
    source: body.source === "token" ? "token" : "local-runtime",
  };
  return cached;
}

export const identityHeaders = (id: AnnaIdentity): Record<string, string> => ({
  "X-Anna-Workspace-ID": id.workspaceId,
  "X-Anna-User-ID": id.userId,
});
