/**
 * inspect/types · 抽屉与轻检视共用的动作契约(DetailPage 装配真 API + refresh)。
 */

import type { MemoryItem, TeamMember } from "../../../lib/api/crew";

export interface InspectActions {
  /** 当前会话成员 id(认领到自己;桌面免登录 → null) */
  sessionUserId: string | null;
  /** 项目负责人(Boss)id */
  ownerUserId: string;
  /** 当前会话是否 Boss(共识写权) */
  isOwner: boolean;
  members: TeamMember[];
  /** 项目共识条目(命中溯源 + 届时注入 chips) */
  memory: MemoryItem[];

  assign(taskId: string, memberId: string): Promise<void>;
  start(taskId: string): Promise<void>;
  submit(taskId: string, artifact: string): Promise<void>;
  /** 触发 Agent 执行(run-agent;仅 agent-kind assignee 的 assigned|rework 任务) */
  runAgent(taskId: string): Promise<void>;
  /** 说点什么进频道(「没空」= @owner「没空,需协调」) */
  say(body: string, mentions: string[]): Promise<void>;
  /** 点名环(去频道/看依赖/去评审 —— P6 统一锚点语言) */
  ring(taskId: string): void;
  /** 转任务抽屉(全档案 / 双击) */
  openDrawer(taskId: string): void;
  /** 关闭当前浮层 */
  close(): void;

  /**
   * DEV-1:立即刷新项目/频道快照(动作失败 / 前置校验陈旧后拉最新态)。
   * 成功路径各 mutation 已自带 .then(refresh);此入口供失败与陈旧兜底。
   * 可选:页面(S-D1)装配时接线;缺省则退化为等画布 3s 轮询。
   */
  refresh?: () => void;

  /**
   * 可用性收束 · 一屏两键评审:打开阅读器对照评审态(左读被评审产物全文,
   * 底部钉「通过/驳回」)。参数=评审门任务 id。缺省 → 退化为点名环到评审卡。
   */
  openReview?: (gateId: string) => void;
}
