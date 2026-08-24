/**
 * ActivityRow · R2 频道「正在执行」活动行(3d 版式;在飞三处同源同拍之一)
 *
 * ActivityRows(容器)= 单一 1s 计时器驱动全部活动行的 elapsed 本地推进;
 * 每个在飞 agent 任务一行:编年脊线结点(Agent 方 14px)+ 抬头(Agent 名 + 时刻)
 *   +「正在执行」pill(runPulse 脉点 + 任务 chip + elapsed mono「已运行 MM:SS」)。
 * 任务离开在飞集 → 行消失(产物卡接棒,cardRise 由 ChannelColumn 给新产物卡)。
 * reduced-motion:脉点静止(CSS),elapsed 仍推进(功能信息不降级)。
 */

import { useEffect, useState } from "react";

import type { TeamMember } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import { elapsedLabel, selectActiveTasks } from "./activityRow";

function GearIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </svg>
  );
}

function timeOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ActivityRow({
  task,
  members,
  nowMs,
}: {
  task: CrewTask;
  members: TeamMember[];
  nowMs: number;
}) {
  const assignee = task.assignee_member_id
    ? members.find((m) => m.id === task.assignee_member_id)
    : undefined;
  const agentName = assignee?.display_name?.trim() || "Agent";
  const startTime = timeOf(task.run_started_at);
  const elapsed = elapsedLabel(task.run_started_at, nowMs);

  return (
    <div className="ir-chan-activity">
      <span className="ir-chan-activity__spine" aria-hidden="true" />
      <span className="ir-chan-activity__knot" aria-hidden="true" />
      <div className="ir-chan-activity__head">
        <span className="ir-chan-activity__by">{agentName}</span>
        {startTime && <span className="ir-chan-activity__time">{startTime}</span>}
        <span className="ir-chan-activity__ref">{task.key} · activity</span>
      </div>
      <div className="ir-chan-activity__pill">
        <span className="ir-chan-activity__dot" aria-hidden="true" />
        <span className="ir-chan-activity__label">正在执行</span>
        <span className="ir-chan-activity__task">
          <GearIcon />
          <span className="ir-chan-activity__tasktitle">{task.title}</span>
        </span>
        <span className="ir-chan-activity__sep" aria-hidden="true" />
        <span className="ir-chan-activity__elapsed">{elapsed}</span>
      </div>
    </div>
  );
}

export interface ActivityRowsProps {
  tasks: CrewTask[];
  members: TeamMember[];
}

/** 在飞 agent 任务的活动行集合;单一 1s 计时器推进 elapsed。无在飞 → 不渲染。 */
export function ActivityRows({ tasks, members }: ActivityRowsProps) {
  // 活动行只投影 Agent 在飞(人类执行以小时计,「刚刚开始」常挂即误导——真机 Andy 案)
  const agentIds = new Set(members.filter((m) => m.kind === "agent").map((m) => m.id));
  const active = selectActiveTasks(tasks, agentIds);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (active.length === 0) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length]);

  if (active.length === 0) return null;
  return (
    <div className="ir-chan-activityset">
      {active.map((t) => (
        <ActivityRow key={t.id} task={t} members={members} nowMs={nowMs} />
      ))}
    </div>
  );
}

export default ActivityRows;
