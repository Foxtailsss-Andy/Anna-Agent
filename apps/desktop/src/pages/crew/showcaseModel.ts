export interface ShowcaseStage {
  id: string;
  title: string;
  owner: string;
  state: "done" | "active" | "blocked" | "waiting";
  detail: string;
}

export interface ShowcaseStep {
  title: string;
  detail: string;
}

export interface ShowcaseCapability {
  label: string;
  detail: string;
}

export const SHOWCASE_TITLE = "周会行动项闭环";

export const SHOWCASE_BADGES = ["内置案例", "示例数据", "3-5 分钟体验"];

export const SHOWCASE_STAGES: ShowcaseStage[] = [
  {
    id: "intake",
    title: "Anna 协调提案",
    owner: "Anna",
    state: "done",
    detail: "@Anna 将零散周会记录整理成确认前不落图的协调提案。",
  },
  {
    id: "actions",
    title: "行动项 v1 → v2",
    owner: "Scribe / Boss",
    state: "done",
    detail: "v1 只有事项，评审驳回后补齐 DRI、截止时间、验收和依赖。",
  },
  {
    id: "parallel",
    title: "看板草图 + 数据核对",
    owner: "Design / Andy",
    state: "done",
    detail: "协作看板和数据口径在行动项评审通过后并行完成。",
  },
  {
    id: "review",
    title: "纪要发布待评审",
    owner: "Boss",
    state: "active",
    detail: "看板草图已提交，当前停在负责人评审门。",
  },
  {
    id: "waiting",
    title: "下游同步待解锁",
    owner: "看板与群公告",
    state: "waiting",
    detail: "纪要未过审前，看板更新和群公告保持未解锁。",
  },
];

export const SHOWCASE_STEPS: ShowcaseStep[] = [
  {
    title: "打开完整案例",
    detail: "生成一个真实 Crew 项目，直接进入工作图。",
  },
  {
    title: "读频道编年史",
    detail: "查看 Anna 提案、行动项返工、并行推进、artifact 和评审卡。",
  },
  {
    title: "评审纪要发布",
    detail: "打开纪要发布评审门，阅读看板草图后通过或驳回。",
  },
  {
    title: "观察依赖解锁",
    detail: "通过评审后，下游看板更新和群公告才会解锁。",
  },
];

export const SHOWCASE_CAPABILITIES: ShowcaseCapability[] = [
  { label: "Coordination Proposal", detail: "Anna 起草协作变更，确认前不改图。" },
  { label: "Versioned Artifact", detail: "行动项从 v1 返工到 v2，产物历史保留。" },
  { label: "Parallel Work", detail: "看板草图与数据口径核对在同一评审后并行推进。" },
  { label: "Human Gate", detail: "纪要发布由负责人评审后才能继续。" },
  { label: "Dependency Unlock", detail: "下游同步任务等待评审门通过后解锁。" },
];

export function showcaseStateLabel(state: ShowcaseStage["state"]): string {
  switch (state) {
    case "done":
      return "已完成";
    case "active":
      return "待处理";
    case "blocked":
      return "需恢复";
    case "waiting":
      return "等待中";
  }
}
