/**
 * PlanRail · 右栏任务进程(《设计说明 · Iris》§6.5)
 * plan.updated 引擎权威帧驱动;无计划 = 整个组件不渲染(诚实纪律)。
 * 完成/失败后动效全停:传 still 停掉进行中项的呼吸环。
 */

import type { PlanProgress } from '../../lib/plan';
import './PlanRail.css';

export interface PlanRailProps {
  progress: PlanProgress | null;
  /** true = 动效全停(done/error) */
  still?: boolean;
  title?: string;
}

export function PlanRail({ progress, still = false, title = '任务进程' }: PlanRailProps) {
  if (!progress) return null;
  return (
    <div className="plr">
      <div className="plr__head">
        <span className="plr__title">{title}</span>
        <span className="plr__count">{progress.done}/{progress.total}</span>
      </div>
      <div className="plr__track">
        <div className="plr__fill" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
      </div>
      {progress.items.map((item) => (
        <div className="plr__item" key={item.id}>
          {item.status === 'done' ? (
            <span className="plr__mark--done" aria-hidden="true">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M2 6.2 5 9 10 3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          ) : item.status === 'in_progress' ? (
            <span
              className="plr__mark--current"
              style={still ? { animation: 'none' } : undefined}
              aria-hidden="true"
            />
          ) : (
            <span className="plr__mark--pending" aria-hidden="true" />
          )}
          <span
            className={`plr__label${item.status === 'done' ? ' plr__label--done' : item.status === 'in_progress' ? ' plr__label--current' : ''}`}
          >
            {item.title}
          </span>
          {item.status === 'in_progress' && <span className="plr__now">进行中</span>}
        </div>
      ))}
      <div className="plr__foot">plan.updated · 引擎权威帧驱动</div>
    </div>
  );
}

export default PlanRail;
