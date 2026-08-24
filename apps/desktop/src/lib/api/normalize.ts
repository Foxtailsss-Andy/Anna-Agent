/**
 * v1(后端现状)→ v2(`lib/frames.ts` Iris 契约)帧归一化。
 * 规格 = 附录 A2 §4。纪律(ADR-002):只做真数据的形态映射与解包,禁止编造
 * —— 无审计 usage → tokens null;无 drilldown → 不填;未知 type → 丢弃 + warn。
 *
 * 有状态:`createNormalizer()` 返回一个 `(raw) => Frame[]` 的闭包(附带 `getCtxPercentLeft()`),
 * 内部跟踪:当前 turn(最近 step.turn,缺省 1)、最近一次 `mcp.tool.called` 状态(按 tool_name)、
 * usage 累计(来自 model.call.* 审计)、context_percent_left(W5 CTX 环)、首帧时间。
 */
import type {
  AwaitingApprovalFrame,
  DoneFrame,
  ErrorFrame,
  EventFrame,
  Frame,
  PlanItem,
  PlanItemStatus,
  PlanUpdatedFrame,
  RunArtifact,
  RunUsage,
  StepFrame,
  TextDeltaFrame,
  ThinkingFrame,
  ToolDoneFrame,
  ToolStartFrame,
} from "../frames";

/** `createNormalizer()` 的返回:可调用 + `getCtxPercentLeft()`(供 W5 CTX 环读真数据)。 */
export interface Normalizer {
  (raw: Record<string, unknown>): Frame[];
  /**
   * 最近 `model.call.started` 的 `context_percent_left` 原始透传(后端语义 = 剩余百分比);
   * 无审计 → null(不猜)。注意:设计契约 CTX 环用的是「已用百分比」,调用方(useRunStream)
   * 负责 100 - left 换算,此处只诚实转发后端真值,不做单位转换。
   */
  getCtxPercentLeft(): number | null;
  /**
   * 累计 usage(与 `done.run.usage` 同源):tokens 来自 `model.call.completed` 真报(无则 null),
   * model 来自 `model.call.started`(无则不填)。W5/CTX 环与 usageText 读真数据用。
   */
  getUsage(): { tokens: number | null; model?: string };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const toPlanItem = (v: unknown): PlanItem => {
  const r = asRecord(v);
  return {
    id: asStr(r.id) ?? "",
    title: asStr(r.title) ?? "",
    status: (asStr(r.status) as PlanItemStatus) ?? "pending",
  };
};

const parseAt = (v: unknown): number | undefined => {
  const s = asStr(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

const toArtifact = (v: unknown): RunArtifact => {
  const r = asRecord(v);
  // createdAt:诚实透传 —— raw.created_at(ISO 字符串,Date.parse)优先,否则 raw.createdAt(已是数字);
  // 都无则不填(不编造)。
  const createdAt = parseAt(r.created_at) ?? asNum(r.createdAt);
  return {
    id: asStr(r.id) ?? "",
    title: asStr(r.title) ?? "",
    kind: asStr(r.kind) ?? "document",
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
};

export function createNormalizer(): Normalizer {
  let turn = 1;
  const toolStatus = new Map<string, boolean>();
  const usage = { in: 0, out: 0, reported: false, model: undefined as string | undefined };
  let ctxPercent: number | null = null;
  const startedAt = performance.now();
  /** C2:最近 plan.updated 审计载荷(count/done_count/items 真值),供 plan.update 工具步合成 L3 */
  let lastPlan: { count: number; done: number; titles: string[] } | null = null;

  const tokens = (): number | null => (usage.reported ? usage.in + usage.out : null);
  const runUsage = (): RunUsage => ({
    tokens: tokens(),
    ...(usage.model !== undefined ? { model: usage.model } : {}),
  });
  const errorFrame = (message: string): ErrorFrame => ({
    type: "error",
    message,
    consumedTokens: tokens(),
  });

  const normalize = (raw: Record<string, unknown>): Frame[] => {
    const type = asStr(raw.type);
    switch (type) {
      case "step": {
        const t = asNum(raw.turn);
        if (t !== undefined) turn = t;
        const frame: StepFrame = {
          type: "step",
          phase: (asStr(raw.phase) as StepFrame["phase"]) ?? "analyze",
          intent: asStr(raw.intent) ?? "",
          turn,
          ...(asStr(raw.tool) !== undefined ? { tool: asStr(raw.tool) } : {}),
        };
        return [frame];
      }
      case "delta":
      case "text_delta": {
        // M-2:形态兼容 —— v1 用 raw.text,v2 原生用 raw.delta(B1 灰度期两形态并存)。
        const frame: TextDeltaFrame = {
          type: "text_delta",
          delta: asStr(raw.delta) ?? asStr(raw.text) ?? "",
          turn,
        };
        return [frame];
      }
      case "tool_start": {
        // M-2:v1 用 raw.name,v2 原生用 raw.tool。
        const frame: ToolStartFrame = { type: "tool_start", tool: asStr(raw.tool) ?? asStr(raw.name) ?? "", turn };
        return [frame];
      }
      case "tool_done": {
        // M-2:v1 用 raw.name,v2 原生用 raw.tool。
        const name = asStr(raw.tool) ?? asStr(raw.name) ?? "";
        // ok = 最近 mcp.tool.called{tool_name=name}.status !== "error";查无审计则 true。
        // 审计帧在 wire 上先于 tool_done 到达(orchestrator flush-before-yield,见 fixture notes),故此查表有效。
        const ok = toolStatus.has(name) ? toolStatus.get(name)! : true;
        const frame: ToolDoneFrame = { type: "tool_done", tool: name, ok, turn };
        // C2(校对基准 P-03):plan.update 的 L3 凭证由 plan.updated 审计真值合成
        // (审计帧先于本帧到达);resultPreview 逐字来自 payload,pendingNote 如实说明缺口。
        if (name === "plan.update" && lastPlan) {
          frame.drilldown = {
            resultPreview: [
              `plan.updated · ${lastPlan.count} 项写入${lastPlan.done ? ` · ${lastPlan.done} 项已完成` : ""}`,
              ...lastPlan.titles.map((t) => `- ${t}`),
            ].join("\n"),
            pendingNote: "入参、回执全文 · 待审计载荷扩展（B2）",
          };
        }
        return [frame];
      }
      case "thinking": {
        // M-2:v2 原生帧,真透传(turns.ts 已消费 thinking 帧);turn 缺省回落当前上下文。
        const t = asNum(raw.turn);
        const frame: ThinkingFrame = { type: "thinking", delta: asStr(raw.delta) ?? "", turn: t ?? turn };
        return [frame];
      }
      case "event": {
        const ev = asRecord(raw.event);
        const name = asStr(ev.type) ?? "";
        const payload = asRecord(ev.payload);
        const at = parseAt(ev.created_at);
        // plan.updated:解包真计划为一等帧,不再另发 EventFrame。
        if (name === "plan.updated") {
          const items = Array.isArray(payload.items) ? payload.items : [];
          const plan = items.map(toPlanItem);
          lastPlan = {
            count: asNum(payload.count) ?? plan.length,
            done: asNum(payload.done_count) ?? 0,
            titles: plan.map((p) => p.title).filter(Boolean),
          };
          const frame: PlanUpdatedFrame = {
            type: "plan.updated",
            plan,
            ...(at !== undefined ? { at } : {}),
          };
          return [frame];
        }
        // model.call.* / mcp.tool.called:喂上下文(usage/ok/ctx),仍原样发 EventFrame(系统步,审计可见)。
        if (name === "mcp.tool.called") {
          const toolName = asStr(payload.tool_name);
          if (toolName !== undefined) toolStatus.set(toolName, asStr(payload.status) !== "error");
        } else if (name === "model.call.started") {
          const model = asStr(payload.model_name);
          if (model !== undefined) usage.model = model;
          const pct = asNum(payload.context_percent_left);
          if (pct !== undefined) ctxPercent = pct;
        } else if (name === "model.call.completed") {
          const inTok = asNum(payload.input_tokens);
          const outTok = asNum(payload.output_tokens);
          // 仅 provider 真报(键在)才累加并置 reported;无键 → 不动(诚实纪律,不伪造 0)。
          if (inTok !== undefined || outTok !== undefined) {
            usage.in += inTok ?? 0;
            usage.out += outTok ?? 0;
            usage.reported = true;
          }
        }
        // 载荷原样透传(有键才带):turns.ts 的标签判定需要它区分同名不同事的事件
        // —— 见 EventFrame.payload。无载荷 → 不带键(诚实纪律,不补空对象)。
        const frame: EventFrame = {
          type: "event",
          name,
          ...(at !== undefined ? { at } : {}),
          ...(Object.keys(payload).length > 0 ? { payload } : {}),
        };
        return [frame];
      }
      case "awaiting_approval": {
        const frame: AwaitingApprovalFrame = {
          type: "awaiting_approval",
          reason: asStr(raw.reason) ?? "",
          detail: asRecord(raw.detail),
          turn,
        };
        return [frame];
      }
      case "done": {
        const run = asRecord(raw.run);
        // 失败 run 收敛为 error 帧(只发 error,不发 done)。
        if (asStr(run.status) === "failed") {
          return [errorFrame(asStr(run.error_message) ?? asStr(run.error_code) ?? "unknown_error")];
        }
        const frame: DoneFrame = {
          type: "done",
          run: {
            // M-2:v1 用 run.id,v2 原生用 run.runId。
            runId: asStr(run.runId) ?? asStr(run.id) ?? "",
            artifacts: Array.isArray(run.artifacts) ? run.artifacts.map(toArtifact) : [],
            plan: Array.isArray(run.plan) ? run.plan.map(toPlanItem) : [],
            usage: runUsage(),
            durationMs: Math.round(performance.now() - startedAt),
          },
        };
        return [frame];
      }
      case "error": {
        const run = raw.run !== undefined ? asRecord(raw.run) : undefined;
        const message =
          (run && asStr(run.error_message)) ?? asStr(raw.message) ?? "unknown_error";
        return [errorFrame(message)];
      }
      default:
        console.warn(`[normalize] 未知帧 type 丢弃：${String(type)}`);
        return [];
    }
  };

  const normalizer = normalize as Normalizer;
  normalizer.getCtxPercentLeft = () => ctxPercent;
  normalizer.getUsage = () => runUsage();
  return normalizer;
}
