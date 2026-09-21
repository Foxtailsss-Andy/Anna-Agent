/**
 * useTaskOps · 操作组交互(popover/drawer 共用)——OpId → 真 API + refresh。
 *   简单操作即时执行;改派(选人)开就地内联选人;提交 → 开抽屉①区交付面板
 *   (可用性收束二批:产物区即交付区,不再有底部提交内联)。零捏造:无专用端点的
 *   「没空」落为 @owner 频道 say(偏差登记)。「去评审/去频道/看依赖」= P6 点名环。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AssignmentSuggestion } from "../../../lib/api/crew";
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

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface TaskOps {
  busy: boolean;
  error: string | null;
  pickerOpen: boolean;
  run(op: OpId): void;
  openPicker(): void;
  closePicker(): void;
  confirmReassign(memberId: string): void;
  suggestion: AssignmentSuggestion | null;
  suggestionPending: boolean;
  requestSuggestion(): void;
  cancelSuggestion(): void;
  adoptSuggestion(): void;
  suggestionAdopting: boolean;
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
  const [suggestion, setSuggestion] = useState<AssignmentSuggestion | null>(null);
  const [suggestionPending, setSuggestionPending] = useState(false);
  const [suggestionAdopting, setSuggestionAdopting] = useState(false);
  const suggestionRun = useRef<{
    requestId: string;
    controller: AbortController;
    projectId: string;
    taskId: string;
    cancel: () => Promise<void>;
  } | null>(null);
  const adopting = useRef(false);
  const adoptingOperation = useRef<{ generation: number; requestId: string; taskId: string; projectId: string } | null>(null);
  const scopeGeneration = useRef(0);
  const expiryTimer = useRef<number | null>(null);
  const cancelSuggestion = useCallback(() => {
    const current = suggestionRun.current;
    suggestionRun.current = null;
    scopeGeneration.current += 1;
    adopting.current = false;
    adoptingOperation.current = null;
    setSuggestionPending(false);
    setSuggestionAdopting(false);
    setBusy(false);
    setSuggestion(null);
    if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
    if (!current) return;
    current.controller.abort();
    void current.cancel().catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => {
      const current = suggestionRun.current;
      suggestionRun.current = null;
      if (!current) return;
      current.controller.abort();
      void current.cancel().catch(() => undefined);
    };
  }, [task.project_id, task.id]);

  useEffect(() => {
    scopeGeneration.current += 1;
    adopting.current = false;
    adoptingOperation.current = null;
    setBusy(false);
    setSuggestionAdopting(false);
    setSuggestion(null);
    setSuggestionPending(false);
    setSuggestionAdopting(false);
    if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
    setPickerOpen(false);
    setError(null);
  }, [task.project_id, task.id]);

  const requestSuggestion = useCallback(() => {
    if (suggestionPending || adopting.current || task.assignee_member_id || task.is_gate || !["todo", "blocked"].includes(task.status)) return;
    scopeGeneration.current += 1;
    const requestId = newRequestId();
    const controller = new AbortController();
    suggestionRun.current = {
      requestId,
      controller,
      projectId: task.project_id,
      taskId: task.id,
      cancel: () => actions.cancelAssignmentSuggestion(task.id, requestId),
    };
    setSuggestion(null);
    setSuggestionPending(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      if (suggestionRun.current?.requestId !== requestId) return;
      cancelSuggestion();
      setError("建议请求超时，请手动选择成员。");
    }, 6000);
    void actions.suggestAssignment(task.id, requestId, controller.signal)
      .then((result) => {
        if (suggestionRun.current?.requestId !== requestId) return;
        if (result.project_id !== task.project_id || result.task_id !== task.id || result.decision_id !== requestId) {
          setError("建议响应与当前任务不匹配，请重新生成。");
          return;
        }
        if (Date.parse(result.expires_at) <= Date.now()) {
          setSuggestion({ ...result, status: "unavailable", member_id: null, reason_code: "suggestion_expired" });
          return;
        }
        setSuggestion(result);
        const delay = Date.parse(result.expires_at) - Date.now();
        expiryTimer.current = window.setTimeout(() => {
          setSuggestion((current) => current?.decision_id === requestId
            ? { ...current, status: "unavailable", member_id: null, reason_code: "suggestion_expired" }
            : current);
        }, Math.max(0, delay));
      })
      .catch((e) => {
        if (suggestionRun.current?.requestId !== requestId || controller.signal.aborted) return;
        setError(friendlyTaskError(e));
        actions.refresh?.();
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (suggestionRun.current?.requestId === requestId) {
          setSuggestionPending(false);
        }
      });
  }, [actions, cancelSuggestion, suggestionPending, task.assignee_member_id, task.id, task.is_gate, task.project_id, task.status]);

  const adoptSuggestion = useCallback(() => {
    if (adopting.current || !suggestion?.member_id || suggestion.status !== "suggested") return;
    if (Date.parse(suggestion.expires_at) <= Date.now()) {
      setSuggestion({ ...suggestion, status: "unavailable", member_id: null, reason_code: "suggestion_expired" });
      return;
    }
    const operation = {
      generation: scopeGeneration.current,
      requestId: suggestion.decision_id,
      taskId: task.id,
      projectId: task.project_id,
    };
    adopting.current = true;
    adoptingOperation.current = operation;
    setSuggestionAdopting(true);
    setBusy(true);
    setError(null);
    void actions.assign(task.id, suggestion.member_id, suggestion.decision_id)
      .then(() => {
        if (adoptingOperation.current !== operation || scopeGeneration.current !== operation.generation) return;
        suggestionRun.current = null;
        if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
        setSuggestion(null);
        setPickerOpen(false);
        actions.close();
      })
      .catch((e) => {
        if (adoptingOperation.current !== operation || scopeGeneration.current !== operation.generation) return;
        setError(friendlyTaskError(e));
        actions.refresh?.();
      })
      .finally(() => {
        if (adoptingOperation.current !== operation || scopeGeneration.current !== operation.generation) return;
        adoptingOperation.current = null;
        adopting.current = false;
        setSuggestionAdopting(false);
        setBusy(false);
      });
  }, [actions, suggestion, task.id]);

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
      cancelSuggestion();
      setPickerOpen(false);
      void guard(() => actions.assign(task.id, memberId));
    },
    [actions, cancelSuggestion, task.id, guard],
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
    closePicker: () => {
      cancelSuggestion();
      setPickerOpen(false);
    },
    confirmReassign,
    suggestion,
    suggestionPending,
    suggestionAdopting,
    requestSuggestion,
    cancelSuggestion,
    adoptSuggestion,
    confirmSubmit,
  };
}
