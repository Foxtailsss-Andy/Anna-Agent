/**
 * Anna · 三级下钻归约(纯函数,可 vitest 单测)
 * 《Runtime 三级下钻 Brief 2026-07-09》§3:
 *   分组单元 = 回合(loop 一轮 = 一次模型思考 + 它触发的那批工具)
 *   L1 折叠行 → L2 回合步骤 → L3 真原文(args / stdout / 推理)
 *
 * 硬规则:一个 Step 当且仅当有「超出标签之外的留存原文」才可掀。
 *   工具步(有 args/result)→ 可掀;思考步(有推理原文)→ 可掀;
 *   系统/note 步 → 无 L3、不出箭头。运行时没有第三级,就不需要展开。
 */

import type { Frame, PlanItem, RunSummary, ToolDrilldown } from './frames';

/* ---------------- 输出模型 ---------------- */

export type StepKind = 'thinking' | 'tool' | 'system' | 'error';
export type StepStatus = 'running' | 'ok' | 'fail' | 'waiting' | 'none';

/** L3 · 工具凭证(素颜:一字不改) */
export interface StepL3Tool {
  form: 'tool';
  argsPreview?: string;
  resultPreview?: string;
  exitText?: string;
  bytes?: number;
  truncated?: boolean;
  restricted?: boolean;
  contract?: string;
}

/** L3 · 长文本(思考推理原文 / error 帧原文 / 审批 payload) */
export interface StepL3Text {
  form: 'text';
  text: string;
  tone?: 'default' | 'danger';
}

export type StepL3 = StepL3Tool | StepL3Text;

export interface Step {
  id: string;
  kind: StepKind;
  /** 第一级标签:step.intent 引擎原文 / 工具中文名 / 事件标签 */
  label: string;
  status: StepStatus;
  durationText?: string;
  /** 无 l3 = 不出箭头、不可掀 */
  l3?: StepL3;
  /** 失败步默认掀到 L3 留证 */
  defaultOpen?: boolean;
}

export type TurnStatus = 'running' | 'ok' | 'fail' | 'awaiting';

export interface Turn {
  id: string;
  /** 0 = 准备(run.created / skill.loaded);1..n = 回合 */
  index: number;
  status: TurnStatus;
  steps: Step[];
  toolCount: number;
  hasThinking: boolean;
  durationText?: string;
  /** 回合间叙述(模型正文 = 权威,非 flavor) */
  narration?: string;
}

export type RunState = 'idle' | 'running' | 'awaiting' | 'done' | 'error';

export interface RunTree {
  state: RunState;
  turns: Turn[];
  /** 「当下」行文案 = 最近 step.intent(引擎原文) */
  nowIntent: string;
  plan: PlanItem[];
  answerText: string;
  run?: RunSummary;
  error?: {
    message: string;
    provider?: string;
    turn?: number;
    retryable?: boolean;
    consumedTokens?: number | null;
  };
  approval?: { reason: string; detail: Record<string, unknown> };
}

/* ---------------- 呈现映射(允许:标签映射;禁止:编造内容) ---------------- */

export type ToolLabels = Record<string, string>;

export const DEFAULT_TOOL_LABELS: ToolLabels = {
  'plan.update': '更新任务计划',
  'chat.emit_page': '生成网页产物',
  'chat.emit_document': '生成文档产物',
  'erp.query': '查询财务数据',
  'shell.run': '执行命令',
};

const EVENT_LABELS: Record<string, string> = {
  'run.created': '接下任务',
  'skill.loaded': '装载 Skill',
  'context.compacted': '压缩 · 上下文已整理', // W5 预留
  'memory.hit': '记忆 · 命中业务记忆',       // W6 预留
};

export function toolLabel(tool: string, labels: ToolLabels = DEFAULT_TOOL_LABELS): string {
  return labels[tool] ?? tool;
}

export function fmtDuration(ms: number): string {
  if (ms < 100) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/** mm:ss(.d) 计时,如 00:34.2 */
export function fmtClock(ms: number, tenths = false): string {
  const m = Math.floor(ms / 60_000);
  const s = (ms % 60_000) / 1000;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : Math.floor(s).toString().padStart(2, '0');
  return `${m.toString().padStart(2, '0')}:${ss}`;
}

/** L1 聚合摘要:「思考 · 调用 2 次工具」(真值聚合,非编造) */
export function turnSummary(turn: Turn): string {
  const parts: string[] = [];
  if (turn.hasThinking) parts.push('思考');
  if (turn.toolCount > 0) parts.push(`调用 ${turn.toolCount} 次工具`);
  if (!parts.length) parts.push(`${turn.steps.length} 步`);
  return parts.join(' · ');
}

/* ---------------- 主归约 ---------------- */

export function reduceTurns(frames: Frame[], labels: ToolLabels = DEFAULT_TOOL_LABELS): RunTree {
  const turns: Turn[] = [];
  let state: RunState = frames.length ? 'running' : 'idle';
  let nowIntent = '';
  let plan: PlanItem[] = [];
  let answerText = '';
  let run: RunSummary | undefined;
  let error: RunTree['error'];
  let approval: RunTree['approval'];
  let seq = 0;

  const turnStart = new Map<number, number>(); // turn index → 首帧 at
  const openTools = new Map<string, { step: Step; at?: number }>();

  function getTurn(index: number): Turn {
    let t = turns.find((x) => x.index === index);
    if (!t) {
      t = { id: `t${index}`, index, status: 'running', steps: [], toolCount: 0, hasThinking: false };
      turns.push(t);
      turns.sort((a, b) => a.index - b.index);
    }
    return t;
  }

  function touchTime(index: number, at?: number) {
    if (at == null) return;
    if (!turnStart.has(index)) turnStart.set(index, at);
    const t = getTurn(index);
    t.durationText = fmtDuration(at - (turnStart.get(index) as number));
  }

  function currentTurn(): Turn | undefined {
    return turns.length ? turns[turns.length - 1] : undefined;
  }

  for (const f of frames) {
    switch (f.type) {
      case 'event': {
        const idx = f.turn ?? 0;
        const t = getTurn(idx);
        touchTime(idx, f.at);
        // 系统步:无 L3,不可掀(硬规则)
        t.steps.push({
          id: `s${seq++}`,
          kind: 'system',
          label: EVENT_LABELS[f.name] ?? f.name,
          status: 'ok',
        });
        break;
      }
      case 'step': {
        nowIntent = f.intent;
        const t = getTurn(f.turn);
        touchTime(f.turn, f.at);
        if (f.phase === 'analyze' || f.phase === 'deliver') {
          t.hasThinking = true;
          t.steps.push({
            id: `s${seq++}`,
            kind: 'thinking',
            label: f.intent, // 引擎原文,禁止改写
            status: 'ok',
            // l3 由 thinking 帧原文填充;无原文则保持不可掀
          });
        }
        break;
      }
      case 'thinking': {
        const t = getTurn(f.turn);
        // 找本回合最近的思考步;没有则建一个(引擎只发 thinking 不发 step 的兜底)
        let step = [...t.steps].reverse().find((s) => s.kind === 'thinking');
        if (!step) {
          t.hasThinking = true;
          step = { id: `s${seq++}`, kind: 'thinking', label: '推理与规划', status: 'ok' };
          t.steps.push(step);
        }
        const l3 = (step.l3 as StepL3Text | undefined) ?? { form: 'text' as const, text: '' };
        l3.text += f.delta;
        step.l3 = l3; // 有推理原文 → 可掀
        break;
      }
      case 'tool_start': {
        const t = getTurn(f.turn);
        touchTime(f.turn, f.at);
        const step: Step = {
          id: `s${seq++}`,
          kind: 'tool',
          label: toolLabel(f.tool, labels),
          status: 'running',
        };
        t.steps.push(step);
        t.toolCount += 1;
        openTools.set(`${f.turn}:${f.tool}`, { step, at: f.at });
        break;
      }
      case 'tool_done': {
        const key = `${f.turn}:${f.tool}`;
        touchTime(f.turn, f.at);
        const open = openTools.get(key);
        const l3 = f.drilldown ? drilldownToL3(f.drilldown) : undefined;
        if (open) {
          open.step.status = f.ok ? 'ok' : 'fail';
          open.step.l3 = l3;
          open.step.defaultOpen = !f.ok && !!l3; // 失败步默认掀到 L3 留证
          if (open.at != null && f.at != null) open.step.durationText = fmtDuration(f.at - open.at);
          openTools.delete(key);
        } else {
          const t = getTurn(f.turn);
          t.steps.push({
            id: `s${seq++}`,
            kind: 'tool',
            label: toolLabel(f.tool, labels),
            status: f.ok ? 'ok' : 'fail',
            l3,
            defaultOpen: !f.ok && !!l3,
          });
          t.toolCount += 1;
        }
        if (!f.ok) getTurn(f.turn).status = 'fail';
        break;
      }
      case 'plan.updated': {
        plan = f.plan; // 计划条即时刷新,不占步骤行
        break;
      }
      case 'text_delta': {
        answerText += f.delta;
        // 回合间叙述:挂在当下回合之后(模型正文 = 权威)
        const t = f.turn != null ? getTurn(f.turn) : currentTurn();
        if (t) t.narration = (t.narration ?? '') + f.delta;
        break;
      }
      case 'awaiting_approval': {
        state = 'awaiting';
        approval = { reason: f.reason, detail: f.detail };
        const t = f.turn != null ? getTurn(f.turn) : currentTurn() ?? getTurn(1);
        t.status = 'awaiting';
        t.steps.push({
          id: `s${seq++}`,
          kind: 'system',
          label: `等您示下 · ${f.reason}`,
          status: 'waiting',
          // 原始 payload = 留存原文 → 可掀(§6.4「▸ 原始 payload」)
          l3: { form: 'text', text: JSON.stringify(f.detail, null, 2) },
        });
        break;
      }
      case 'done': {
        state = 'done';
        run = f.run;
        if (f.run.plan.length) plan = f.run.plan;
        break;
      }
      case 'error': {
        state = 'error';
        error = {
          message: f.message,
          provider: f.provider,
          turn: f.turn,
          retryable: f.retryable,
          consumedTokens: f.consumedTokens ?? null,
        };
        // 运行中的工具步转失败,error 帧原文进其 L3,默认掀开
        for (const { step } of openTools.values()) {
          step.status = 'fail';
          step.defaultOpen = true;
          step.l3 = step.l3 ?? { form: 'text', text: f.message, tone: 'danger' };
        }
        openTools.clear();
        const t = f.turn != null ? getTurn(f.turn) : currentTurn();
        if (t) t.status = 'fail';
        break;
      }
    }
  }

  // 收尾:所有仍 running 的回合按终态定性
  for (const t of turns) {
    if (t.status === 'running' && state !== 'running') {
      t.status = state === 'error' ? (t.index === (error?.turn ?? -1) ? 'fail' : 'ok') : 'ok';
    }
    if (t.status === 'running' && t !== turns[turns.length - 1]) t.status = 'ok';
  }

  return { state, turns, nowIntent, plan, answerText, run, error, approval };
}

function drilldownToL3(d: ToolDrilldown): StepL3Tool | undefined {
  const has = d.argsPreview || d.resultPreview || d.exitText || d.restricted;
  if (!has) return undefined; // 没有留存原文 → 无 L3 → 不出箭头
  return {
    form: 'tool',
    argsPreview: d.argsPreview,
    resultPreview: d.resultPreview,
    exitText: d.exitText,
    bytes: d.bytes,
    truncated: d.truncated,
    restricted: d.restricted,
    contract: d.contract,
  };
}
