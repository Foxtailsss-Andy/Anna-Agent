/**
 * chartSpec · ```chart 代码块的数据契约(纯函数,零依赖)。
 *
 * {"type":"bar"|"line","title"?:string,"labels":string[],"series":[{"name":string,"values":number[]}],"unit"?:string}
 * - labels 1..50,series 1..8,每个系列 values 与 labels 等长且全为有限数;
 * - 任何一处不合 → null(调用方回落原代码块 +「图表数据无效」),不猜、不补、不改写数值。
 */

export const MAX_CHART_LABELS = 50;
export const MAX_CHART_SERIES = 8;

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: "bar" | "line";
  title?: string;
  labels: string[];
  series: ChartSeries[];
  unit?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function parseChartSpec(source: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { type, title, labels, series, unit } = raw;
  if (type !== "bar" && type !== "line") return null;
  if (title !== undefined && typeof title !== "string") return null;
  if (unit !== undefined && typeof unit !== "string") return null;
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_CHART_LABELS) return null;
  if (!labels.every((l): l is string => typeof l === "string")) return null;
  if (!Array.isArray(series) || series.length === 0 || series.length > MAX_CHART_SERIES) return null;
  const parsed: ChartSeries[] = [];
  for (const s of series) {
    if (!isRecord(s) || typeof s.name !== "string" || !Array.isArray(s.values)) return null;
    if (s.values.length !== labels.length) return null;
    if (!s.values.every((v): v is number => typeof v === "number" && Number.isFinite(v))) return null;
    parsed.push({ name: s.name, values: [...s.values] });
  }
  return {
    type,
    ...(title === undefined || title.trim() === "" ? {} : { title }),
    labels: [...labels],
    series: parsed,
    ...(unit === undefined || unit.trim() === "" ? {} : { unit }),
  };
}

/** 坐标轴「好看」刻度:覆盖 [min,max] 且含 0,约 4 段,步长取 1/2/2.5/5×10^k。 */
export function niceTicks(minValue: number, maxValue: number, target = 4): number[] {
  let lo = Math.min(0, minValue);
  let hi = Math.max(0, maxValue);
  if (lo === hi) hi = lo + 1;
  const rough = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** 数值显示:去掉浮点尾噪,保留原精度(不四舍五入成别的数)。 */
export function formatValue(v: number): string {
  return String(Number(v.toPrecision(12)));
}
