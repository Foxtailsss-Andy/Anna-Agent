/**
 * TraceWaterfall · 组件测试(Task 6 Step 6)。
 *
 * 环境说明(仓库约定,见根 vitest.config.ts 顶注 + chat/useRunStream.test.ts:24-31):vitest 跑
 * node 环境,无 jsdom/testing-library、无组件渲染栈;本轮 Global Constraints 明令"零新第三方
 * 依赖……前端不加包"(docs/superpowers/plans/2026-08-05-trace-round/00-plan.md:14)。include 也
 * 只收 *.test.ts(不含 .test.tsx)。
 *
 * 故本测试用已在 dependencies 里的 react-dom/server(renderToStaticMarkup:纯 Node、零 DOM 依赖、
 * 不产生 hydration 注释)对真组件 TraceWaterfall / RowDetail 做服务端渲染,断言真实输出的 HTML
 * 字符串——真组件、真数据管线(toWaterfall 在组件内部被真实调用),不 mock、不重复实现映射表。
 * 用 React.createElement 而非 JSX,使本文件保持 .test.ts 后缀以命中 vitest include。
 *
 * 唯一无法覆盖的一环:"点击"是 DOM 事件,SSR 无法派发,故行展开改以两段真值合证:
 *   ①默认(未点击)渲染 = 零 trace-detail,证明初始折叠;
 *   ②直接对真 RowDetail 组件 SSR,证明展开时显示的内容就是该行 span 的 attributes/events 本身。
 * 即:被覆盖的是"折叠态渲染"与"展开态内容"这两个真实渲染出来的半边。
 * onClick→setOpenId 这一段 state 切换未被任何自动化点击覆盖——上述 repo 硬约束(node 环境、
 * include 只收 *.test.ts、零新依赖不得引入 jsdom/testing-library)下做不到;真实浏览器手动点击
 * 验证也评估过,因需先起后端并造一条真 run 才有 trace 数据,判断投入产出比不划算而主动放弃。
 * 故这一段既无自动化验证、也无人工验证,如实登记为残余缺口(详见 task-6-report.md)。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceDto } from '../../../lib/api/trace';
import { RowDetail, TraceWaterfall } from '../TraceWaterfall';

/** React SSR 偶在相邻文本子节点间插入 hydration 用注释;渲染既非 hydrate 目标,断言前先滤掉。 */
const strip = (html: string) => html.replace(/<!--.*?-->/g, '');

const doc: TraceDto = {
  trace_id: 'r1',
  surface: 'chat',
  spans: [
    {
      span_id: 's1', parent_span_id: null, name: 'invoke_agent chat', kind: 'agent',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:10', duration_ms: 10000,
      status: 'ok', attributes: {}, events: [],
    },
    {
      span_id: 's2', parent_span_id: 's1', name: 'turn 1', kind: 'turn',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:10', duration_ms: 10000,
      status: 'ok', attributes: {},
      events: [
        { name: 'context.compaction.applied', time: '2026-08-05T09:00:01', attributes: {} },
        { name: 'run.judgment.custom', time: '2026-08-05T09:00:02', attributes: {} },
      ],
    },
    {
      span_id: 's3', parent_span_id: 's2', name: 'chat deepseek-chat', kind: 'inference',
      start_time: '2026-08-05T09:00:00', end_time: '2026-08-05T09:00:03', duration_ms: 3000,
      status: 'ok',
      attributes: { 'gen_ai.usage.input_tokens': 900, 'gen_ai.usage.output_tokens': 40 }, events: [],
    },
    {
      span_id: 's4', parent_span_id: 's2', name: 'execute_tool erp.finance.query', kind: 'tool',
      start_time: '2026-08-05T09:00:04', end_time: '2026-08-05T09:00:06', duration_ms: 2000,
      status: 'error', attributes: { 'anna.step.intent': '查询往来单位余额' }, events: [],
    },
  ],
};

const render = (d: TraceDto) => strip(renderToStaticMarkup(createElement(TraceWaterfall, { doc: d })));

describe('TraceWaterfall · L1 摘要条(真组件真数据,零 mock)', () => {
  it('回合数 · 耗时 · tokens 同框显示', () => {
    const html = render(doc);
    expect(html).toContain('1 回合');
    expect(html).toContain('10.0s'); // fmtMs(10000)
    expect(html).toContain('tokens 900↑ 40↓');
    expect(html).toContain('trace-status--ok');
  });
});

describe('TraceWaterfall · 每 span 一行 + 中文 tag', () => {
  it('inference→思考、tool→调用;intent 覆盖原始 label;error 行落错误条形色', () => {
    const html = render(doc);
    expect((html.match(/class="trace-row"/g) ?? []).length).toBe(2); // s3 + s4 两行
    expect(html).toContain('>思考<');
    expect(html).toContain('>调用<');
    expect(html).toContain('查询往来单位余额'); // row.intent 优先于 row.label(执行意图人话)
    expect(html).toContain('trace-row__fill--error'); // s4 status=error
  });

  it('未知 kind(如未来 invoke_agent 子代理)→ 原样透出,不臆断映射', () => {
    const withUnknownKind: TraceDto = {
      ...doc,
      spans: doc.spans.map((s) => (s.span_id === 's4' ? { ...s, kind: 'invoke_agent' } : s)),
    };
    expect(render(withUnknownKind)).toContain('>invoke_agent<');
  });
});

describe('TraceWaterfall · 行内 token chip(缺失不补零,ADR-002)', () => {
  /** 只取行内 chip 的文本,避免把 L1 摘要条里的 tokens 文本也算进来。 */
  const rowChips = (html: string) =>
    [...html.matchAll(/<span class="trace-row__chip">(.*?)<\/span>/g)].map((m) => m[1]);

  /** L1 摘要条里的 tokens 段(无类名,靠字面前缀定位);缺失时整段不渲染 → undefined。 */
  const summaryTokens = (html: string) => /<span>tokens (.*?)<\/span>/.exec(html)?.[1];

  it('两个 token 都在 → ↑ 与 ↓ 同框', () => {
    expect(rowChips(render(doc))).toEqual(['900↑ 40↓']);
  });

  it('只有 input_tokens(中断/报错的推理)→ 只渲染 ↑,不把未测量的输出显示成 0↓', () => {
    const inputOnly: TraceDto = {
      ...doc,
      spans: doc.spans.map((s) => (s.span_id === 's3'
        ? { ...s, attributes: { 'gen_ai.usage.input_tokens': 900 } } : s)),
    };
    const html = render(inputOnly);
    const chips = rowChips(html);
    expect(chips).toEqual(['900↑']);
    expect(chips[0]).not.toContain('0↓');
    // L1 摘要条同规则:输入测到、输出没测到 → 只出 ↑ 段,不把未测量的输出显示成 0↓
    expect(summaryTokens(html)).toBe('900↑');
  });
});

describe('TraceWaterfall · turn 头部 chip(已核实名映射 / 未知名原样,ADR-002)', () => {
  it('context.compaction.applied → 压缩;未映射的事件名逐字透出', () => {
    const html = render(doc);
    expect((html.match(/class="trace-chip"/g) ?? []).length).toBe(2);
    expect(html).toContain('压缩');
    expect(html).toContain('run.judgment.custom');
  });
});

describe('TraceWaterfall · 行展开(点击=DOM 事件,SSR 下两段真值合证,见文件顶注)', () => {
  it('默认折叠:未点击时零 trace-detail 块', () => {
    expect(render(doc)).not.toContain('trace-detail');
  });

  it('RowDetail 真实渲染内容 = 该行 span 的 attributes/events,非捏造', () => {
    const row = {
      id: 's3', kind: 'inference', label: 'chat deepseek-chat', status: 'ok' as const,
      durationMs: 3000, offsetPct: 0, widthPct: 30,
      tokensIn: 900, tokensOut: 40, span: doc.spans[2],
    };
    const html = strip(renderToStaticMarkup(createElement(RowDetail, { row })));
    expect(html).toContain('trace-detail');
    expect(html).toContain('gen_ai.usage.input_tokens');
    expect(html).toContain('900');
  });
});

describe('TraceWaterfall · 空 trace(零捏造)', () => {
  it('零 span → 空态文案,不装配瀑布', () => {
    const html = render({ trace_id: 'r1', surface: 'chat', spans: [] });
    expect(html).toContain('该 run 暂无可装配的执行帧');
  });
});
