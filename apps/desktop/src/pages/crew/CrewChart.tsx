/**
 * CrewChart · ```chart 代码块的内联 SVG 渲染(零新依赖)。
 *
 * - 柱状(分组柱)/ 折线;y 轴「好看」刻度含 0 基线(负值画在基线下,不截断);
 * - 可访问:<svg role="img" aria-label="柱状图：标题">;每根柱子 / 每个点带 <title>(悬停可读值);
 *   >1 系列给 HTML 图例;<details> 数据表给出原值(读屏与精确值的事实源)。
 * - 数值原样显示(formatValue 只去浮点尾噪),不插值、不补点。
 */

import { formatValue, niceTicks, type ChartSpec } from "./chartSpec";

const W = 280;
const H = 170;
const M = { top: 12, right: 8, bottom: 30, left: 40 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const MAX_X_LABELS = 7;
const X_LABEL_CHARS = 6;

const r2 = (v: number) => Math.round(v * 100) / 100;
const shortLabel = (label: string) =>
  [...label].length > X_LABEL_CHARS ? `${[...label].slice(0, X_LABEL_CHARS - 1).join("")}…` : label;

export function CrewChart({ spec }: { spec: ChartSpec }) {
  const { type, title, labels, series, unit } = spec;
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => r2(M.top + PLOT_H * (1 - (v - yMin) / (yMax - yMin)));
  const groupW = PLOT_W / labels.length;
  const xCenter = (i: number) => r2(M.left + groupW * (i + 0.5));
  const labelEvery = Math.ceil(labels.length / MAX_X_LABELS);
  const unitSuffix = unit ? ` ${unit}` : "";
  const tip = (i: number, name: string, v: number) => `${labels[i]} · ${name}：${formatValue(v)}${unitSuffix}`;
  const kind = type === "bar" ? "柱状图" : "折线图";
  const label = `${kind}：${title ?? series.map((s) => s.name).join("、")}`;

  const innerW = groupW * 0.72;
  const barW = innerW / series.length;

  return (
    <figure className="crew-chart">
      {title && <figcaption className="crew-chart__title">{title}</figcaption>}
      {unit && <div className="crew-chart__unit">单位：{unit}</div>}
      <svg className="crew-chart__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="crew-chart__grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="crew-chart__tick" x={M.left - 5} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {formatValue(t)}
            </text>
          </g>
        ))}
        <line className="crew-chart__zero" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />

        {type === "bar"
          ? series.map((s, si) =>
              s.values.map((v, i) => {
                const x = M.left + groupW * i + (groupW - innerW) / 2 + barW * si;
                const top = Math.min(y(v), y(0));
                return (
                  <rect
                    key={`${si}-${i}`}
                    className={`crew-chart__bar crew-chart__s${si}`}
                    x={r2(x)}
                    y={top}
                    width={r2(Math.max(barW - 1, 1))}
                    height={r2(Math.abs(y(v) - y(0)))}
                  >
                    <title>{tip(i, s.name, v)}</title>
                  </rect>
                );
              }),
            )
          : series.map((s, si) => (
              <g key={si}>
                <polyline
                  className={`crew-chart__line crew-chart__s${si}`}
                  points={s.values.map((v, i) => `${xCenter(i)},${y(v)}`).join(" ")}
                />
                {s.values.map((v, i) => (
                  <circle key={i} className={`crew-chart__point crew-chart__s${si}`} cx={xCenter(i)} cy={y(v)} r={2.6}>
                    <title>{tip(i, s.name, v)}</title>
                  </circle>
                ))}
              </g>
            ))}

        {labels.map((l, i) =>
          i % labelEvery === 0 ? (
            <text key={i} className="crew-chart__xlabel" x={xCenter(i)} y={H - M.bottom + 14} textAnchor="middle">
              {shortLabel(l)}
            </text>
          ) : null,
        )}
      </svg>

      {series.length > 1 && (
        <ul className="crew-chart__legend" aria-label="图例">
          {series.map((s, si) => (
            <li key={si}>
              <span className={`crew-chart__swatch crew-chart__s${si}`} aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      )}

      <details className="crew-chart__data">
        <summary>数据表</summary>
        <div className="crew-md__tablewrap" tabIndex={0} role="region" aria-label="图表数据">
          <table className="crew-md__table">
            <thead>
              <tr>
                <th scope="col">{unit ? `单位：${unit}` : ""}</th>
                {series.map((s, si) => (
                  <th key={si} scope="col">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={i}>
                  <th scope="row">{l}</th>
                  {series.map((s, si) => (
                    <td key={si}>{formatValue(s.values[i])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export default CrewChart;
