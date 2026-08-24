/**
 * railState · 折叠导轨状态机(2b · 设计说明 §四「侧栏折叠」)
 *
 * 规格:断点 <1280 自动折叠;手动切换(快捷键 [ / 折叠钮)优先——
 * 一旦手动,本会话不再随视口自动切换(manual 闩)。纯函数,便于单测。
 */

export const RAIL_BREAKPOINT = 1280;

export interface RailState {
  collapsed: boolean;
  /** 手动闩:置位后 viewport 事件不再改变折叠态 */
  manual: boolean;
}

export type RailEvent = { type: "toggle" } | { type: "viewport"; width: number };

export function initialRailState(width: number): RailState {
  return { collapsed: width < RAIL_BREAKPOINT, manual: false };
}

export function railReducer(state: RailState, event: RailEvent): RailState {
  switch (event.type) {
    case "toggle":
      return { collapsed: !state.collapsed, manual: true };
    case "viewport":
      // 手动优先:已手动切换过 → 忽略断点。
      return state.manual ? state : { ...state, collapsed: event.width < RAIL_BREAKPOINT };
  }
}
