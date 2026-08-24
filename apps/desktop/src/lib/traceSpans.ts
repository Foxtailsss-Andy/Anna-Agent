/**
 * traceSpans · TraceDto → 瀑布图行(纯归约,零 React,vitest 可测)。
 * 条形几何:以 agent span 起止为 100%,offset/width 取百分比;
 * duration<1% 的行给最小宽度 1%(旧 run 秒粒度下 "<1s" 仍可见)。零捏造:token 缺就不显示。
 */
import type { TraceDto, TraceSpanDto } from './api/trace';

export interface WaterfallRow {
  id: string;
  kind: TraceSpanDto['kind'];
  label: string;
  status: TraceSpanDto['status'];
  durationMs: number;
  offsetPct: number;
  widthPct: number;
  tokensIn?: number;
  tokensOut?: number;
  intent?: string;
  span: TraceSpanDto;
}

export interface WaterfallGroup {
  turnId: string;
  title: string;
  status: TraceSpanDto['status'];
  rows: WaterfallRow[];
  /** 判断层/治理事件 chip(Q7):已知名走中文映射,未知原名直显——零编造 */
  chips: { name: string; label: string }[];
}

/** 已核实的事件名→chip 文案(标签映射允许,编造禁止,ADR-002)。映射外原名直显。 */
const CHIP_LABELS: Record<string, string> = {
  'context.compaction.applied': '压缩',
  'context.autocompact.applied': '压缩·摘要',
  'run.queued': '排队',
  'run.evaluation.started': '评审',
};

export interface WaterfallSummary {
  model?: string;
  turns: number;
  /** 汇总语义:只累加真正带该属性的 span;无一 span 带它 → undefined(缺失不补 0);真测得的 0 仍是 0。 */
  tokensIn: number | undefined;
  tokensOut: number | undefined;
  durationMs: number;
  status: TraceSpanDto['status'];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function toWaterfall(doc: TraceDto): { summary: WaterfallSummary; groups: WaterfallGroup[] } {
  const agent = doc.spans.find((s) => s.kind === 'agent');
  const turns = doc.spans.filter((s) => s.kind === 'turn');
  const t0 = agent ? Date.parse(agent.start_time) : 0;
  const total = agent ? Math.max(1, agent.duration_ms) : 1;

  const groups: WaterfallGroup[] = turns.map((turn) => ({
    turnId: turn.span_id,
    title: turn.name,
    status: turn.status,
    chips: turn.events
      .filter((e) => !e.name.startsWith('step.'))
      .map((e) => ({ name: e.name, label: CHIP_LABELS[e.name] ?? e.name })),
    rows: doc.spans
      .filter((s) => s.parent_span_id === turn.span_id)
      .map((s) => {
        const offset = agent ? ((Date.parse(s.start_time) - t0) / total) * 100 : 0;
        const width = (s.duration_ms / total) * 100;
        return {
          id: s.span_id,
          kind: s.kind,
          label: s.name,
          status: s.status,
          durationMs: s.duration_ms,
          offsetPct: Math.max(0, Math.round(offset)),
          widthPct: Math.max(1, Math.round(width)),
          tokensIn: num(s.attributes['gen_ai.usage.input_tokens']),
          tokensOut: num(s.attributes['gen_ai.usage.output_tokens']),
          intent: typeof s.attributes['anna.step.intent'] === 'string'
            ? (s.attributes['anna.step.intent'] as string) : undefined,
          span: s,
        };
      }),
  }));

  const infer = doc.spans.filter((s) => s.kind === 'inference');
  // 只对真正带该属性的 span 求和;一个都没有 → undefined,而非 0(见 WaterfallSummary 语义注)。
  const sum = (k: string): number | undefined =>
    infer.reduce<number | undefined>((a, s) => {
      const v = num(s.attributes[k]);
      return v === undefined ? a : (a ?? 0) + v;
    }, undefined);
  return {
    summary: {
      model: infer.length
        ? (infer[0].attributes['gen_ai.request.model'] as string | undefined) : undefined,
      turns: turns.length,
      tokensIn: sum('gen_ai.usage.input_tokens'),
      tokensOut: sum('gen_ai.usage.output_tokens'),
      durationMs: agent?.duration_ms ?? 0,
      status: agent?.status ?? 'unset',
    },
    groups,
  };
}
