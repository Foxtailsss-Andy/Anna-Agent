# R2 · 流层底座(identity + SSE + v1→v2 归一化 + 域客户端)

**目标:** 建 `lib/api/` 五件套,让任何页面能以三行代码开一条真流并得到 v2 `Frame[]`;归一化规则 = A2 §4,全部 vitest 锁定。
**边界:** 纯 lib 层,不动 UI;不实现 L3 懒加载后端(B2),但 `fetchToolResult` 留签名。

**前置:** R1 完成(`@/lib/frames` 等在位)。**读 A1(端点/鉴权)与 A2(帧映射)后再动手。**

**Files:**
- Create: `apps/desktop/src/lib/api/identity.ts`、`client.ts`、`sse.ts`、`normalize.ts`、`chat.ts`、`finance.ts`、`hiker.ts`、`reimbursement.ts`、`create.ts`、`admin.ts`
- Test: `apps/desktop/src/lib/api/normalize.test.ts`、`sse.test.ts`、`fixtures/live-chat-frames.json`(真流采集)

**Interfaces(Produces,后续切片依赖):**
- `getIdentity(): Promise<AnnaIdentity>`;`identityHeaders(id): Record<string,string>`(X-Anna-* 两头)
- `apiFetch(path, init?): Promise<Response>`(拼 `apiUrl` + JSON 头;**不吞业务失败**,只在网络/非 2xx 抛 `ApiError{status,body}`)
- `readSse(response, onFrame: (raw: Record<string,unknown>) => void): Promise<void>`
- `createNormalizer(): (raw: Record<string,unknown>) => Frame[]`
- 域客户端(全部返回 `Response` 的流启动函数命名 `stream*`;非流式返回解析后的类型):
  - chat: `streamChatRun(body)`、`listChatRuns()`、`getChatRun(id)`、`saveChatRun(id)`、`getModelProfiles()`、`getPromptTemplates()`
  - finance: `createFinanceDashboardRun(period)`、`streamFinanceAssistant(period, question)`
  - hiker: `createHikerDashboardRun()`、`streamHikerAssistant(question)`
  - reimbursement: `streamReimbursementRun(inputText, attachments)`、`streamAnswers(runId, answers)`、`streamApprove(approvalId)`、`rejectApproval(approvalId)`、`listRuns()`、`getRun(id)`、`uploadAttachment(name, blob)`、`getAudit(runId)`
  - create: `createDraft(prompt, kind)`、`listDrafts()`、`activateDraft(runId)`
  - admin: `getRuntimeStatus()`、`getRuntimeConfig()`、`putRuntimeConfig(patch)`、`addModelProfile(p)`、`deleteModelProfile(id)`、`getSkills()`、`validateRuntime()`、`getValidationLedger()`、`getDomainReadiness()`、`getGovernanceStatus()`、`getAgentRunsLedger()`
- 留位签名(B2 前恒 reject):`fetchToolResult(runId: string, stepId: string): Promise<string>`

## Task 1: identity + client

- [ ] **Step 1: `identity.ts`**

```ts
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
```

- [ ] **Step 2: `client.ts`**

```ts
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
```

- [ ] **Step 3: `npx tsc --noEmit` → 0 error;commit** `feat(fe): R2 — identity + api client 底座`

## Task 2: SSE 读取器(TDD)

- [ ] **Step 1: 失败测试 `sse.test.ts`**(用 `new Response(ReadableStream)` 造分片:跨 chunk 的半帧、一 chunk 多帧、非 data 行忽略)

```ts
import { describe, expect, it } from "vitest";
import { readSse } from "./sse";

const stream = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
  );

describe("readSse", () => {
  it("跨 chunk 半帧拼接 + 一 chunk 多帧 + 忽略非 data 行", async () => {
    const got: unknown[] = [];
    await readSse(stream(['data: {"type":"a"}\n\ndata: {"ty', 'pe":"b"}\n\n: keepalive\n\ndata: {"type":"c"}\n\n']), (f) => got.push(f));
    expect(got.map((f) => (f as { type: string }).type)).toEqual(["a", "b", "c"]);
  });
  it("非 2xx / 无 body 抛错", async () => {
    await expect(readSse(new Response("boom", { status: 500 }), () => {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测(FAIL:readSse 未定义)→ Step 3: 实现 `sse.ts`**

```ts
/** SSE 读取器:data: <json>\n\n 逐帧回调。与旧 agentStream 同算法(getReader/decode/split),但不做语义分发。 */
export async function readSse(
  response: Response,
  onFrame: (raw: Record<string, unknown>) => void,
): Promise<void> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `stream failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      onFrame(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
    }
  }
}
```

- [ ] **Step 4: 跑测 PASS;commit** `feat(fe): R2 — SSE 读取器(TDD)`

## Task 3: 真流 fixture 采集(实现归一化前的现实校准)

- [ ] **Step 1: 起后端**(`python -m services.api.app.main`),用脚本采一条真 chat 流存 `apps/desktop/src/lib/api/fixtures/live-chat-frames.json`(数组,每元素一原始帧)。node 一次性脚本(不入库,存 scratch 即可;fixture 文件入库):

```js
const res = await fetch("http://127.0.0.1:8000/api/chat/runs/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Anna-Workspace-ID": WS, "X-Anna-User-ID": USER },
  body: JSON.stringify({ workspace_id: WS, actor_user_id: USER, message: "请用 plan.update 规划并生成一个简单页面" }),
});
// readSse 同算法收集 → JSON.stringify(frames, null, 2) 写文件
```

- [ ] **Step 2: 人工检视 fixture,确认并在文件头注释记录**:①`mcp.tool.called` 审计帧相对 `tool_done` 的先后(A2 §4 的 ok 查表方向依据);②plan.updated payload 形状;③model.call.* payload 字段。**若与 A2 表述不符,改 A2 并在 commit message 记录。**(若本机模型 key 未配,run 会 failed——failed 流同样是合法 fixture,另采一条并保留两份。)

## Task 4: 归一化层(TDD,规格 = A2 §4)

- [ ] **Step 1: 失败测试 `normalize.test.ts`**(合成帧逐规则断言 + 真 fixture 端到端)

```ts
import { describe, expect, it } from "vitest";
import { createNormalizer } from "./normalize";
import type { Frame } from "../frames";
import live from "./fixtures/live-chat-frames.json";

const runAll = (raws: Record<string, unknown>[]): Frame[] => {
  const n = createNormalizer();
  return raws.flatMap((r) => n(r));
};

describe("createNormalizer(v1→v2,真数据形态映射)", () => {
  it("text/delta 改名 + step 直通并更新 turn 上下文", () => {
    const out = runAll([
      { type: "step", phase: "analyze", intent: "理解需求", tool: null, turn: 1 },
      { type: "text_delta", text: "你" },
      { type: "delta", text: "好" },
      { type: "tool_start", name: "plan.update" },
    ]);
    expect(out[0]).toMatchObject({ type: "step", intent: "理解需求", turn: 1 });
    expect(out[1]).toMatchObject({ type: "text_delta", delta: "你" });
    expect(out[2]).toMatchObject({ type: "text_delta", delta: "好" });
    expect(out[3]).toMatchObject({ type: "tool_start", tool: "plan.update", turn: 1 });
  });
  it("plan.updated 审计事件解包为一等帧;其余审计事件转 EventFrame{name}", () => {
    const out = runAll([
      { type: "event", event: { type: "run.created", run_id: "r", payload: {}, created_at: "2026-07-09T00:00:00Z" } },
      { type: "event", event: { type: "plan.updated", run_id: "r", payload: { count: 2, done_count: 1, items: [{ id: "1", title: "a", status: "done" }, { id: "2", title: "b", status: "in_progress" }] }, created_at: "2026-07-09T00:00:01Z" } },
    ]);
    expect(out[0]).toMatchObject({ type: "event", name: "run.created" });
    expect(out[1]).toMatchObject({ type: "plan.updated", plan: [{ id: "1", status: "done" }, { id: "2", status: "in_progress" }] });
  });
  it("tool_done 的 ok 来自 mcp.tool.called 审计;无审计默认 true", () => {
    const out = runAll([
      { type: "tool_start", name: "erp.query" },
      { type: "event", event: { type: "mcp.tool.called", run_id: "r", payload: { tool_name: "erp.query", input_hash: "x", status: "error", error: "timeout" }, created_at: "t" } },
      { type: "tool_done", name: "erp.query" },
      { type: "tool_start", name: "plan.update" },
      { type: "tool_done", name: "plan.update" },
    ]);
    const dones = out.filter((f) => f.type === "tool_done");
    expect(dones[0]).toMatchObject({ tool: "erp.query", ok: false });
    expect(dones[1]).toMatchObject({ tool: "plan.update", ok: true });
  });
  it("done(成功)聚合 usage(审计真报)+ 缺省字段兜底;failed run 收敛为 error 帧", () => {
    const okOut = runAll([
      { type: "event", event: { type: "model.call.started", run_id: "r", payload: { model_name: "deepseek-chat", context_percent_left: 88 }, created_at: "t" } },
      { type: "event", event: { type: "model.call.completed", run_id: "r", payload: { input_tokens: 100, output_tokens: 50 }, created_at: "t" } },
      { type: "done", run: { id: "run1", status: "succeeded", artifacts: [{ id: "a1", kind: "page", title: "x", content: "<p/>" }], plan: [] } },
    ]);
    const done = okOut.find((f) => f.type === "done");
    expect(done).toMatchObject({ run: { runId: "run1", usage: { tokens: 150, model: "deepseek-chat" } } });
    const failOut = runAll([{ type: "done", run: { id: "run2", status: "failed", error_code: "model_not_configured", error_message: "上游未配置" } }]);
    expect(failOut).toHaveLength(1);
    expect(failOut[0]).toMatchObject({ type: "error", message: "上游未配置" });
  });
  it("usage 无审计 → tokens null(不显示,不猜)", () => {
    const out = runAll([{ type: "done", run: { id: "r", status: "succeeded" } }]);
    expect(out[0]).toMatchObject({ run: { usage: { tokens: null } } });
  });
  it("真流 fixture 端到端:全帧可归一,无 throw,终止帧恰一个", () => {
    const out = runAll(live as Record<string, unknown>[]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.filter((f) => f.type === "done" || f.type === "error")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测 FAIL → Step 3: 实现 `normalize.ts`**(按 A2 §4 表;结构:闭包持 `turn=1`、`toolStatus: Map<string,boolean>`、`usage={in:0,out:0,reported:false,model?:string}`、`ctxPercent?`、`startedAt=performance.now()`;导出 `createNormalizer` 与 `NormalizedContext` 读取器 `getCtxPercent()` 供 W5 CTX 环用)。**注意**:`awaiting_approval` 直通 + 注入 turn;未知 type `console.warn` 返回 `[]`;`event` 帧中 `model.call.*`/`mcp.tool.called` 既喂上下文**也**照发 EventFrame(审计在时间线可见,系统步)。
- [ ] **Step 4: 跑测 PASS;`npx tsc --noEmit` 0 error;commit** `feat(fe): R2 — v1→v2 帧归一化(A2 规格,真流 fixture 锁定)`

## Task 5: 域客户端(薄封装,类型对齐 A1)

- [ ] **Step 1: 按 Interfaces 节实现六文件**;每个函数 = 一端点;流启动函数返回 `Response`(交给 readSse);请求体 `workspace_id`/`actor_user_id` 从 `getIdentity()` 取(与头一致,403 契约)。示例(chat.ts,其余同型):

```ts
import { apiFetch, apiJson } from "./client";
import { getIdentity } from "./identity";

export interface ModelProfileOption { id: string; label: string; provider: string; model_name: string }

export async function streamChatRun(message: string, opts?: { templateId?: string; modelProfileId?: string; skillId?: string }): Promise<Response> {
  const id = await getIdentity();
  return apiFetch("/api/chat/runs/stream", {
    method: "POST",
    json: {
      workspace_id: id.workspaceId,
      actor_user_id: id.userId,
      message,
      template_id: opts?.templateId,
      model_profile_id: opts?.modelProfileId,
      skill_id: opts?.skillId,
    },
  });
}

export const getModelProfiles = () =>
  apiJson<{ profiles: ModelProfileOption[]; default_profile_id: string }>("/api/chat/model-profiles");
export const listChatRuns = () => apiJson<Record<string, unknown>[]>("/api/chat/runs");
export const getChatRun = (id: string) => apiJson<Record<string, unknown>>(`/api/chat/runs/${id}`);
```

  reimbursement.ts 另有:`uploadAttachment(name, blob)` 用 raw body + `X-Anna-Attachment-Name: encodeURIComponent(name)`;admin.ts 全部端点**不带** X-Anna-* 头(本机管理面,直接 `fetch(apiUrl(...))`,例外:agent-runs/ledger 与 memory 要带)。
- [ ] **Step 2: `fetchToolResult` 留位(lib/api/drilldown.ts)**

```ts
/** B2 后端通道就绪前恒 reject;LoopCard 无 l3 时不出箭头,此函数暂无调用方。 */
export function fetchToolResult(_runId: string, _stepId: string): Promise<string> {
  return Promise.reject(new Error("L3 下钻通道未上线(B2)"));
}
```

- [ ] **Step 3: 四门 + commit** `feat(fe): R2 — 六域类型化客户端`

## 风险

- **帧顺序假设错**(mcp.tool.called 在 tool_done 之后到):Task 3 fixture 检视是唯一防线;若顺序相反,ok 判定改为「tool_done 先发 ok:true,审计到达时不回改」并把该局限记录进 A2(B1 原生 ok 字段修复)。
- **chat 遗留 `delta` type**:归一化已吸收;新写代码禁再依赖 `delta`。
- **admin 端点鉴权混杂**:见 A1 §2(admin_runtime 无头;governance 的 ledger/memory 要 X-Anna-*),客户端注释标明。
