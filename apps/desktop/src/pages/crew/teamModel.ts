/**
 * 花名册纯逻辑(F5 · 设计稿 1g + 设计说明 §五 P4)
 *
 * 负载真值:从 projects 任务真聚合(在手圆点:进行中=实/返工=红/空位=空)。
 * Agent 图元:三 Agent 由职能识别(Scribe=三横/Design=圆叠方/Check=对勾)。
 * 技能字段后端 roster 无 skills 列 → 由职能派生最小 chips(登记偏差,不造假数据)。
 */

import type { CrewProject } from "./crewModel";

/* ---------------- 负载聚合 ---------------- */

/** 在手圆点态:active=进行中(实) / rework=返工(红) / idle=已派未启(空) */
export type LoadDot = "active" | "rework" | "idle";

export interface MemberLoad {
  /** 在手圆点(不含排队 blocked;那是「排队」chip) */
  dots: LoadDot[];
  /** 进行中(running / in_review / submitted) */
  active: number;
  /** 返工 */
  rework: number;
  /** 排队(预派 blocked,等解锁) */
  queued: number;
  /** 我 owner 的项目里就绪的评审门数(等我处理) */
  awaiting: number;
  /** 执行中任务名(Agent shimmer 用;取第一条 running) */
  executingTitle: string | null;
  /** 在手总数 = dots.length */
  total: number;
}

const ACTIVE_STATUS = new Set(["running", "in_review", "submitted"]);

/** 内置案例是确定性示例数据,不参与真人/Agent 团队负载。 */
export function isOperationalProject(project: CrewProject): boolean {
  return project.source !== "showcase";
}

/** 单成员负载:跨全部项目聚合其 assignee 任务 + 其 owner 项目的就绪评审门。 */
export function deriveMemberLoad(memberId: string, projects: CrewProject[]): MemberLoad {
  const dots: LoadDot[] = [];
  let active = 0;
  let rework = 0;
  let queued = 0;
  let awaiting = 0;
  let executingTitle: string | null = null;

  for (const project of projects) {
    if (!isOperationalProject(project)) continue;
    for (const task of project.tasks) {
      if (task.assignee_member_id === memberId) {
        const s = task.status;
        if (s === "running") {
          active += 1;
          dots.push("active");
          if (executingTitle == null) executingTitle = task.title;
        } else if (ACTIVE_STATUS.has(s)) {
          active += 1;
          dots.push("active");
        } else if (s === "rework") {
          rework += 1;
          dots.push("rework");
        } else if (s === "blocked") {
          queued += 1;
        } else if (s === "assigned") {
          dots.push("idle");
        }
      }
    }
    // owner 视角:就绪的评审门(等我处理)
    if (project.owner_user_id === memberId) {
      for (const task of project.tasks) {
        if (task.is_gate && (task.status === "todo" || task.status === "assigned")) {
          awaiting += 1;
        }
      }
    }
  }

  return { dots, active, rework, queued, awaiting, executingTitle, total: dots.length };
}

/* ---------------- 负载 → chips ---------------- */

export type LoadChipTone = "danger" | "warn" | "exec" | "quiet";
export interface LoadChip {
  tone: LoadChipTone;
  text: string;
}

/** 负载 → chips(零值隐藏)。agent 优先显执行中/待命;human 显返工·排队/待处理。 */
export function loadChips(load: MemberLoad, isAgent: boolean): LoadChip[] {
  if (isAgent) {
    if (load.executingTitle) {
      return [{ tone: "exec", text: `执行中 · ${load.executingTitle}` }];
    }
    return [{ tone: "quiet", text: load.total > 0 ? `${load.total} 单 · 待命` : "待命" }];
  }
  const chips: LoadChip[] = [];
  if (load.rework > 0 || load.queued > 0) {
    const parts = [
      load.rework > 0 ? `返工 ${load.rework}` : null,
      load.queued > 0 ? `排队 ${load.queued}` : null,
    ].filter(Boolean);
    chips.push({ tone: "danger", text: parts.join(" · ") });
  }
  if (load.awaiting > 0) {
    chips.push({ tone: "warn", text: `待处理 ${load.awaiting}` });
  }
  if (chips.length === 0 && load.total === 0) {
    chips.push({ tone: "quiet", text: "暂无在手" });
  }
  return chips;
}

/* ---------------- Agent 图元 ---------------- */

export type AgentGlyph = "scribe" | "design" | "check" | "generic";

/** 由职能(优先)或名称识别三 Agent 图元 */
export function agentGlyph(member: { role: string; display_name: string }): AgentGlyph {
  const hay = `${member.role} ${member.display_name}`;
  if (/文案|scribe/i.test(hay)) return "scribe";
  if (/设计|design/i.test(hay)) return "design";
  if (/验收|check|校验/i.test(hay)) return "check";
  return "generic";
}

/* ---------------- 职能派生技能(后端无 skills 列) ---------------- */

const SKILL_MAP: Record<string, string[]> = {
  产品: ["需求", "评审"],
  工程: ["前端", "后端"],
  文案: ["起草", "改写"],
  设计: ["布局", "视觉草案"],
  验收: ["校验", "回归"],
};

/** 职能 → 最小技能 chips(派生,非真实 skills 数据;空职能返空,不造假) */
export function deriveSkills(role: string): string[] {
  return SKILL_MAP[role.trim()] ?? [];
}
