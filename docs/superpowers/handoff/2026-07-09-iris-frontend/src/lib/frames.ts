/**
 * Anna · 帧契约(SSE 权威事件帧)
 * 来源:《设计交接文档》§1.3 + 《Runtime 三级下钻 Brief 2026-07-09》§5/§6
 *
 * 诚实纪律(ADR-002):所有过程性文案(intent、事件名、消耗)来自这些帧,
 * 前端只做「事件名→中文标签」的呈现映射,不编造过程。
 * L3 素颜红线:args/result/stdout/推理原文一字不改;脱敏在后端产出侧完成。
 */

export type PlanItemStatus = 'pending' | 'in_progress' | 'done';

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
}

export interface RunArtifact {
  id: string;
  title: string;
  kind: 'page' | 'document' | string;
  createdAt?: number;
}

export interface RunUsage {
  /** provider 真报才有;null = 不显示(诚实纪律:不猜) */
  tokens: number | null;
  model?: string;
}

export interface RunSummary {
  runId: string;
  artifacts: RunArtifact[];
  plan: PlanItem[];
  usage?: RunUsage;
  durationMs?: number;
}

/**
 * L3 下钻预览通道(后端新增;《Runtime Brief》§6)
 * 后端已脱敏(密钥/金额/PII);truncated 时全文按需懒加载。
 */
export interface ToolDrilldown {
  /** 真请求 args(脱敏后原文,截断预览) */
  argsPreview?: string;
  /** 真 result / stdout(脱敏后原文,截断预览) */
  resultPreview?: string;
  /** 如 "Exit code 143 · Command timed out after 2m 0s" */
  exitText?: string;
  bytes?: number;
  truncated?: boolean;
  /** 视角门:非 run owner / 非开发者 → 只见脱敏摘要 */
  restricted?: boolean;
  /** 工具合同版本 + hash,如 "v1 · 3f9c…e2" */
  contract?: string;
}

export interface ModelCallDetail {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** 可见工具清单 */
  visibleTools?: string[];
}

/* ---------------- 帧(discriminated union) ---------------- */

export type Frame =
  | StepFrame
  | ThinkingFrame
  | PlanUpdatedFrame
  | TextDeltaFrame
  | ToolStartFrame
  | ToolDoneFrame
  | EventFrame
  | AwaitingApprovalFrame
  | DoneFrame
  | ErrorFrame;

/** W1:权威步骤帧。intent 为引擎生成的中文意图,原样示人,禁止改写 */
export interface StepFrame {
  type: 'step';
  phase: 'analyze' | 'tool' | 'deliver';
  intent: string;
  tool?: string;
  turn: number;
  at?: number;
  detail?: ModelCallDetail;
}

/** 流式推理文本(思考步的 L3 原文,可长) */
export interface ThinkingFrame {
  type: 'thinking';
  delta: string;
  turn: number;
  at?: number;
}

export interface PlanUpdatedFrame {
  type: 'plan.updated';
  plan: PlanItem[];
  at?: number;
}

/** 回合间叙述 / 最终回答(模型正文,权威) */
export interface TextDeltaFrame {
  type: 'text_delta';
  delta: string;
  turn?: number;
}

export interface ToolStartFrame {
  type: 'tool_start';
  tool: string;
  turn: number;
  at?: number;
}

export interface ToolDoneFrame {
  type: 'tool_done';
  tool: string;
  ok: boolean;
  turn: number;
  at?: number;
  drilldown?: ToolDrilldown;
}

/** 审计事件:run.created / skill.loaded / memory.hit / context.compacted … → 系统步,无 L3、不可掀 */
export interface EventFrame {
  type: 'event';
  name: string;
  at?: number;
  turn?: number;
}

export interface AwaitingApprovalFrame {
  type: 'awaiting_approval';
  reason: string;
  detail: Record<string, unknown>;
  turn?: number;
  at?: number;
}

export interface DoneFrame {
  type: 'done';
  run: RunSummary;
  at?: number;
}

export interface ErrorFrame {
  type: 'error';
  /** error 帧原文,mono 呈现,不改写 */
  message: string;
  provider?: string;
  turn?: number;
  retryable?: boolean;
  at?: number;
  /** 已产生消耗(如实展示) */
  consumedTokens?: number | null;
}
