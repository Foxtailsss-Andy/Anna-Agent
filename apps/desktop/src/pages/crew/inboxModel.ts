/**
 * 收件箱纯逻辑(F5 · 设计稿 1e)· 报销四步 stepper 映射 · 三组标题
 * 零捏造:step 由后端投影真值(approvals_projection)驱动。
 */

/** 报销四步(前向顺序):提交 → 校验建单 → 审批 → 回读核验 */
export const STEPPER_LABELS = ["提交", "校验建单", "审批", "回读核验"] as const;

export type StepState = "done" | "current" | "todo";

export interface StepperModel {
  steps: { label: string; state: StepState }[];
  /** 步间连线(长度 3):done=已通过绿线 / idle=未达灰线 */
  connectors: ("done" | "idle")[];
}

/** 后端投影 step → 「最远确认里程碑」下标 */
const STEP_INDEX: Record<string, number> = {
  submitted: 0,
  drafted: 1,
  awaiting_approval: 2,
  verified: 3,
};

/**
 * 报销 run 的 step → 四步 stepper 视觉态。
 * · verified:四步全 done。
 * · 其余:< 当前下标 = done,= 当前下标 = current(实心+光环),> 当前 = todo(虚空点)。
 * · 连线:进入某步的线为绿,当且仅当该步为 done(设计 1e「校验建单✓—灰线→审批当前」)。
 */
export function reimbursementStepper(step: string): StepperModel {
  const current = STEP_INDEX[step] ?? 0;
  const allDone = step === "verified";
  const steps = STEPPER_LABELS.map((label, i) => ({
    label,
    state: (allDone ? "done" : i < current ? "done" : i === current ? "current" : "todo") as StepState,
  }));
  const connectors = [1, 2, 3].map((i) => (steps[i].state === "done" ? "done" : "idle")) as (
    | "done"
    | "idle"
  )[];
  return { steps, connectors };
}

/* ---------------- F6 · 卡片派生(origin / 版本 pill) ---------------- */

/**
 * 返工卡版本 pill:最新版 n → 下一版 n+1(1e Andy「v1→v2」)。
 * 无版本(null/undefined/<1)→ null(零捏造,不渲染 pill)。
 */
export function reworkVersionPill(version: number | null | undefined): string | null {
  if (version == null || version < 1) return null;
  return `v${version}→v${version + 1}`;
}

/** 任务是否由频道「+任务」生长(origin=channel);true → 呈现「由频道生长」行(1e)。 */
export function isChannelGrown(origin: string | null | undefined): boolean {
  return origin === "channel";
}

/* ---------------- 三组标题 ---------------- */

export type InboxLane = "todo" | "review" | "mentions";

const LANE_TITLE: Record<InboxLane, string> = {
  todo: "待我做",
  review: "待我审",
  mentions: "@我",
};

export function inboxLaneTitle(lane: InboxLane): string {
  return LANE_TITLE[lane];
}

/** 三组空态短句(空态即空态) */
export const LANE_EMPTY: Record<InboxLane, string> = {
  todo: "现在没有等你动手的事。",
  review: "没有待你评审的产物。",
  mentions: "没有人提到你。",
};
