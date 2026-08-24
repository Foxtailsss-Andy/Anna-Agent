/**
 * TraceWaterfall · 执行过程瀑布图(§6):L1 摘要条 → turn 分组行 → 行内条形+token chip。
 * 纯展示:数据来自 toWaterfall;点击行展开 span attributes/events(等宽降噪)。零捏造。
 *
 * 侦察对照(Task 6 Step 1):容器/tag/等宽块语汇照抄 crew/inspect(TraceLevels.tsx + inspect.css
 * 的 .ir-tl 三级 Trace 容器);trace-* 类名保持不变,样式变量换成 App.css 引入的真 tokens.css
 * 名字(--panel/--line/--line-strong/--ink-2/--iris/--ok/--danger 等,不存在 --border/--text-muted/
 * --accent)。RowDetail 导出以便零依赖(react-dom/server)组件测试直接渲染断言(见
 * __tests__/TraceWaterfall.test.ts 顶注)。
 */
import { useState } from 'react';
import type { TraceDto } from '../../lib/api/trace';
import { toWaterfall, type WaterfallRow } from '../../lib/traceSpans';

const KIND_TAG: Record<string, string> = { inference: '思考', tool: '调用' };

function fmtMs(ms: number): string {
  if (ms < 1000) return ms > 0 ? `${ms}ms` : '<1s';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RowDetail({ row }: { row: WaterfallRow }) {
  return (
    <pre className="trace-detail">
      {JSON.stringify({ attributes: row.span.attributes, events: row.span.events }, null, 2)}
    </pre>
  );
}

export function TraceWaterfall({ doc }: { doc: TraceDto }) {
  const { summary, groups } = toWaterfall(doc);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!groups.length) return <div className="trace-empty">该 run 暂无可装配的执行帧。</div>;
  return (
    <div className="trace-waterfall">
      <div className="trace-summary">
        {summary.model ? <span>{summary.model}</span> : null}
        <span>{summary.turns} 回合</span>
        <span>{fmtMs(summary.durationMs)}</span>
        {/* 与行 chip 同规则(traceSpans.ts:42-43):两段各自可缺,只渲染真实存在的那部分——缺失不补 0。 */}
        {summary.tokensIn != null || summary.tokensOut != null ? (
          <span>
            tokens {[
              summary.tokensIn != null ? `${summary.tokensIn}↑` : null,
              summary.tokensOut != null ? `${summary.tokensOut}↓` : null,
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
        ) : null}
        <span className={`trace-status trace-status--${summary.status}`}>
          {summary.status === 'ok' ? '完成' : summary.status === 'error' ? '失败' : '进行中'}
        </span>
      </div>
      {groups.map((group) => (
        <section key={group.turnId} className="trace-turn">
          <header className="trace-turn__title">
            {group.title}
            {group.chips.map((chip) => (
              <span key={chip.name + chip.label} className="trace-chip" title={chip.name}>
                {chip.label}
              </span>
            ))}
          </header>
          {group.rows.map((row) => (
            <div key={row.id}>
              <button type="button" className="trace-row" onClick={() => setOpenId(openId === row.id ? null : row.id)}>
                <span className="trace-row__tag">{KIND_TAG[row.kind] ?? row.kind}</span>
                <span className="trace-row__label">{row.intent ?? row.label}</span>
                <span className="trace-row__bar">
                  <span
                    className={`trace-row__fill trace-row__fill--${row.status}`}
                    style={{ marginInlineStart: `${row.offsetPct}%`, inlineSize: `${row.widthPct}%` }}
                  />
                </span>
                <span className="trace-row__ms">{fmtMs(row.durationMs)}</span>
                {/* 两个 token 各自可缺(traceSpans.ts:16-17),只渲染真实存在的那部分——缺失不补 0(零捏造)。 */}
                {row.tokensIn != null || row.tokensOut != null ? (
                  <span className="trace-row__chip">
                    {[
                      row.tokensIn != null ? `${row.tokensIn}↑` : null,
                      row.tokensOut != null ? `${row.tokensOut}↓` : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                ) : null}
              </button>
              {openId === row.id ? <RowDetail row={row} /> : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
