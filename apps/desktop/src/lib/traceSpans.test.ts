import { describe, expect, it } from 'vitest';
import { toWaterfall } from './traceSpans';
import type { TraceDto } from './api/trace';

const doc: TraceDto = {
  trace_id: 'r1',
  surface: 'chat',
  spans: [
    { span_id: 's1', parent_span_id: null, name: 'invoke_agent chat', kind: 'agent',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:10', duration_ms: 10000,
      status: 'ok', attributes: { 'anna.turns': 1 }, events: [] },
    { span_id: 's2', parent_span_id: 's1', name: 'turn 1', kind: 'turn',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:10', duration_ms: 10000,
      status: 'ok', attributes: {},
      events: [
        { name: 'context.compaction.applied', time: '2026-08-05T09:00:01', attributes: {} },
        { name: 'run.judgment.custom', time: '2026-08-05T09:00:02', attributes: {} },
      ] },
    { span_id: 's3', parent_span_id: 's2', name: 'chat deepseek-chat', kind: 'inference',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:03', duration_ms: 3000,
      status: 'ok',
      attributes: { 'gen_ai.usage.input_tokens': 900, 'gen_ai.usage.output_tokens': 40 }, events: [] },
    { span_id: 's4', parent_span_id: 's2', name: 'execute_tool erp.finance.query', kind: 'tool',
      start_time: '2026-08-05T09:00:04', end_time: '2026-08-05T09:00:06', duration_ms: 2000,
      status: 'ok', attributes: { 'gen_ai.tool.name': 'erp.finance.query' }, events: [] },
  ],
};

describe('toWaterfall', () => {
  it('分组到 turn、条形按总时长归一化、汇总真数', () => {
    const w = toWaterfall(doc);
    expect(w.summary.turns).toBe(1);
    expect(w.summary.tokensIn).toBe(900);
    expect(w.summary.tokensOut).toBe(40);
    expect(w.summary.durationMs).toBe(10000);
    expect(w.groups).toHaveLength(1);
    const rows = w.groups[0].rows;
    expect(rows.map((r) => r.kind)).toEqual(['inference', 'tool']);
    expect(rows[0].offsetPct).toBe(0);
    expect(rows[0].widthPct).toBe(30);
    expect(rows[1].offsetPct).toBe(40);
    expect(rows[1].widthPct).toBe(20);
    expect(w.groups[0].chips).toEqual([
      { name: 'context.compaction.applied', label: '压缩' },
      { name: 'run.judgment.custom', label: 'run.judgment.custom' },
    ]);
  });

  it('推理 span 全无 usage 属性 → 汇总 token 为 undefined,不补 0(ADR-002)', () => {
    const noUsage: TraceDto = {
      ...doc,
      spans: doc.spans.map((s) => (s.kind === 'inference' ? { ...s, attributes: {} } : s)),
    };
    const w = toWaterfall(noUsage);
    expect(w.summary.tokensIn).toBeUndefined();
    expect(w.summary.tokensOut).toBeUndefined();
  });

  it('空 spans → 空瀑布不造数', () => {
    const w = toWaterfall({ trace_id: 'r1', surface: 'chat', spans: [] });
    expect(w.groups).toHaveLength(0);
    expect(w.summary.durationMs).toBe(0);
  });
});
