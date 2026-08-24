/**
 * useTaskOps · 操作组交互(popover/drawer 共用)——OpId → 真 API + refresh。
 *   简单操作即时执行;改派(选人)开就地内联选人;提交 → 开抽屉①区交付面板
 *   (可用性收束二批:产物区即交付区,不再有底部提交内联)。零捏造:无专用端点的
 *   「没空」落为 @owner 频道 say(偏差登记)。「去评审/去频道/看依赖」= P6 点名环。
 */

import { useCallback, useState } from "react";

import { getProject } from "../../../lib/api/crew";
import type { CrewTask } from "../crewModel";
import type { OpId } from "./inspectModel";
import { dependencyChain, PRECHECK_OPS, precheckOp } from "./inspectModel";
import { friendlyTaskError } from "./friendlyError";
import type { InspectActions } from "./types";

/** 下游评审门(reviews_task_id 指向本任务的门);无 → null。 */
export function downstreamReviewGate(task: CrewTask, tasks: readonly CrewTask[]): CrewTask | null {
  return tasks.find((g) => g.is_gate && g.reviews_task_id === task.id) ?? null;
}

export interface TaskOps {
  busy: boolean;
  error: string | null;
  pickerOpen: boolean;
  run(op: OpId): void;
  openPicker(): void;
  closePicker(): void;
  confirmReassign(memberId: string): void;
  /** 交付区「提交产物」直连:走 DEV-1 前置校验 + submit API(抽屉①区就地,不再有底部提交内联)。 */
  confirmSubmit(artifact: string): void;
}

export function useTaskOps(
  task: CrewTask,
  tasks: readonly CrewTask[],
  byId: Map<string, CrewTask>,
  actions: InspectActions,
): TaskOps {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const guard = useCallback(
    async (fn: () => Promise<void>, precheck?: OpId) => {
      setBusy(true);
      setError(null);
      try {
        // DEV-1 前置校验:状态敏感动作(开始/执行/提交)触发前先拉 FRESH 快照复核可用性——
        // 诊断 2a:auto-pilot 已在 3s 轮询窗口内推进任务,陈旧 UI 会撞后端守卫。
        if (precheck && PRECHECK_OPS.has(precheck)) {
          try {
            const fresh = await getProject(task.project_id);
            const freshTask = fresh.tasks.find((t) => t.id === task.id);
            const chk = precheckOp(precheck, freshTask, actions.members);
            if (!chk.ok) {
              setError(chk.message);
              actions.refresh?.(); // 陈旧 → 推最新态,mutation 不发
              return;
            }
          } catch {
            /* 前置校验拉取失败 → fail-open:让真实动作去撞后端 C2 守卫(友好错误兜底) */
          }
        }
        await fn(); // 成功路径各 action 自带 .then(refresh)
      } catch (e) {
        setError(friendlyTaskError(e)); // C5:裸 JSON → 人话
        actions.refresh?.(); // DEV-1:失败路径也立即刷新
      } finally {
        setBusy(false);
      }
    },
    [task.project_id, task.id, actions],
  );

  const claimToSelf = useCallback(() => {
    if (!actions.sessionUserId) {
      setError("需登录后才能认领（桌面免登录无成员身份）");
      return;
    }
    void guard(() => actions.assign(task.id, actions.sessionUserId as string));
  }, [actions, task.id, guard]);

  const run = useCallback(
    (op: OpId) => {
      switch (op) {
        case "claim":
        case "preclaim":
          claimToSelf();
          break;
        case "start":
          void guard(() => actions.start(task.id), "start");
          break;
        case "submit":
          // 交付区即产物区(可用性收束二批):提交入口统一收敛到抽屉①区交付面板——
          // 轻检视/节点点「提交」→ 开抽屉(抽屉自动聚焦交付区);抽屉内则由 TaskDrawer
          // 本地拦截此 op 直接滚动聚焦(不再往返 openDrawer)。零底部提交内联。
          actions.openDrawer(task.id);
          break;
        case "execute":
          void guard(() => actions.runAgent(task.id), "execute");
          break;
        case "reassign":
          setPickerOpen(true);
          break;
        case "noTime":
          void guard(() => actions.say("没空，需协调", [actions.ownerUserId]));
          break;
        case "toReview": {
          // 可用性收束:优先进阅读器对照评审(一屏两键);未接线退化为点名环。
          // 门任务自身 → 自己就是门;待审任务 → 其下游门。
          const gate = task.is_gate ? task : downstreamReviewGate(task, tasks);
          if (gate && actions.openReview) {
            actions.openReview(gate.id);
          } else {
            actions.ring(gate ? gate.id : task.id);
          }
          actions.close();
          break;
        }
        case "toChannel":
          actions.ring(task.id);
          actions.close();
          break;
        case "seeDeps": {
          const { chain } = dependencyChain(task, byId);
          const firstUpstream = chain.find((c) => !c.self);
          if (firstUpstream) actions.ring(firstUpstream.id);
          actions.close();
          break;
        }
        case "fullDossier":
          actions.openDrawer(task.id);
          break;
      }
    },
    [actions, task, tasks, byId, claimToSelf, guard],
  );

  const confirmReassign = useCallback(
    (memberId: string) => {
      setPickerOpen(false);
      void guard(() => actions.assign(task.id, memberId));
    },
    [actions, task.id, guard],
  );

  const confirmSubmit = useCallback(
    (artifact: string) => {
      const text = artifact.trim();
      if (!text) return;
      void guard(() => actions.submit(task.id, text), "submit");
    },
    [actions, task.id, guard],
  );

  return {
    busy,
    error,
    pickerOpen,
    run,
    openPicker: () => setPickerOpen(true),
    closePicker: () => setPickerOpen(false),
    confirmReassign,
    confirmSubmit,
  };
}
