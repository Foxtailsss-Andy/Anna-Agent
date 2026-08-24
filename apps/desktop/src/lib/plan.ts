/**
 * Anna · 计划归约(纯函数,可 vitest 单测)
 * plan.updated 帧驱动;无计划 = PlanRail 整个不渲染(诚实纪律)
 */

import type { PlanItem } from './frames';

export interface PlanProgress {
  items: PlanItem[];
  done: number;
  total: number;
  /** 进行中项标题;无则 undefined */
  currentTitle?: string;
  /** 0–1,用于进度条宽度 */
  ratio: number;
}

export function planProgress(items: PlanItem[]): PlanProgress | null {
  if (!items.length) return null;
  const done = items.filter((i) => i.status === 'done').length;
  const current = items.find((i) => i.status === 'in_progress');
  // 进行中的项按半项计,与设计稿 2/3 → 62% 一致
  const ratio = Math.min(1, (done + (current ? 0.5 : 0)) / items.length);
  return {
    items,
    done,
    total: items.length,
    currentTitle: current?.title,
    ratio,
  };
}
