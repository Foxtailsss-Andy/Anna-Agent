/**
 * CrewInboxPage · 收件箱双视角(F5 · 设计稿 1e)
 *
 * 三组「待我做 / 待我审 / @我」,当前身份视角(Boss 与成员自然不同,数据由后端按 session 过滤)。
 *   待我做:返工卡(驳回理由引文条)/ 排队解锁行 / 常规待办。
 *   待我审:评审门卡(去评审/看节点)/ 报销投影卡(四步 stepper + 去审批深链)。
 *   @我:引文 + 回到频道上下文。
 * 每行动作直达 = 深链导航(bus,画布点名环接管);空态即空态;失败降级不造数。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { useShellBus } from "../../components/shell/AnnaShell";
import { useCrewNotifications } from "../../components/shell/crewNotifications";
import {
  getInbox,
  listTeam,
  type CrewInbox,
  type MentionCard,
  type ReviewCard,
  type TeamMember,
  type TodoCard,
} from "../../lib/api/crew";
import {
  inboxLaneTitle,
  isChannelGrown,
  LANE_EMPTY,
  reimbursementStepper,
  reworkVersionPill,
} from "./inboxModel";
import "./crew.css";

const EMPTY: CrewInbox = { todo: [], review: [], mentions: [] };

/** 深链到项目并点名环接管目标节点(F2 画布监听 crew:ring-call) */
function useOpenTask() {
  const bus = useShellBus();
  return useCallback(
    (projectId: string, taskId?: string | null) => {
      bus.openCrewProject(projectId);
      if (taskId) {
        window.setTimeout(
          () => window.dispatchEvent(new CustomEvent("crew:ring-call", { detail: { taskId } })),
          360,
        );
      }
    },
    [bus],
  );
}

/* ---------------- 状态章(色盲安全靠形状) ---------------- */

function Seal({ variant }: { variant: "assigned" | "rework" | "queued" | "gate" }) {
  if (variant === "gate") {
    return (
      <span className="ir-ibx-seal ir-ibx-seal--gate" aria-hidden="true">
        审
      </span>
    );
  }
  if (variant === "rework") {
    return (
      <span className="ir-ibx-seal ir-ibx-seal--rework" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M17 9a6 6 0 1 0 1.1 4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M17.6 5.5V9.4H13.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (variant === "queued") {
    return <span className="ir-ibx-seal ir-ibx-seal--queued" aria-hidden="true" />;
  }
  return <span className="ir-ibx-seal ir-ibx-seal--assigned" aria-hidden="true" />;
}

/** 由频道「+任务」生长的溯源行(与画布节点溯源行同语汇,1e) */
function OriginRow() {
  return (
    <div className="ir-ibx-origin">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="6" cy="6" r="2.6" />
        <circle cx="6" cy="18" r="2.6" />
        <circle cx="18" cy="12" r="2.6" />
        <path d="M6 8.6v6.8M8.6 6.8c4.8 1 8 2.4 8 5.2" />
      </svg>
      由频道生长
    </div>
  );
}

/* ---------------- 报销四步 stepper ---------------- */

function Stepper({ step }: { step: string }) {
  const model = reimbursementStepper(step);
  return (
    <div className="ir-ibx-step" aria-hidden="true">
      {model.steps.map((s, i) => (
        <span key={s.label} className="ir-ibx-step__cell">
          {i > 0 && <span className={`ir-ibx-step__line ir-ibx-step__line--${model.connectors[i - 1]}`} />}
          <span className="ir-ibx-step__node">
            <span className={`ir-ibx-step__dot ir-ibx-step__dot--${s.state}`}>
              {s.state === "done" && (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12.5 10 17 19 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span className={`ir-ibx-step__label ir-ibx-step__label--${s.state}`}>{s.label}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/* ---------------- 卡片 ---------------- */

function TodoItem({ card, openTask }: { card: TodoCard; openTask: ReturnType<typeof useOpenTask> }) {
  const grown = isChannelGrown(card.origin);
  if (card.card_kind === "rework") {
    const verPill = reworkVersionPill(card.artifact_version);
    return (
      <div className="ir-ibx-card ir-ibx-card--rework">
        <div className="ir-ibx-card__row">
          <Seal variant="rework" />
          <span className="ir-ibx-card__title">{card.title}</span>
          {verPill && <span className="ir-ibx-ver">{verPill}</span>}
          <span className="ir-ibx-card__state ir-ibx-card__state--danger">返工</span>
        </div>
        {card.rework_reason && (
          <div className="ir-ibx-quote">
            <span className="ir-ibx-quote__k">驳回理由</span>
            <span>“{card.rework_reason}”</span>
          </div>
        )}
        {grown && <OriginRow />}
        <div className="ir-ibx-card__sub">{card.project_goal}</div>
        <div className="ir-ibx-card__acts">
          <button type="button" className="ir-ibx-act ir-ibx-act--primary" onClick={() => openTask(card.project_id, card.task_id)}>
            继续返工
          </button>
          <button type="button" className="ir-ibx-act" onClick={() => openTask(card.project_id, card.task_id)}>
            看批注全文
          </button>
        </div>
      </div>
    );
  }
  if (card.card_kind === "queued") {
    return (
      <div className="ir-ibx-card ir-ibx-card--queued">
        <div className="ir-ibx-card__row">
          <Seal variant="queued" />
          <span className="ir-ibx-card__title">{card.title}</span>
          <span className="ir-ibx-card__state">排队中</span>
        </div>
        {grown && <OriginRow />}
        <div className="ir-ibx-card__sub">
          {card.project_goal}
          {card.unlocked_after ? ` · ${card.unlocked_after}并通知你` : " · 等待解锁"}
        </div>
      </div>
    );
  }
  return (
    <div className="ir-ibx-card">
      <div className="ir-ibx-card__row">
        <Seal variant="assigned" />
        <span className="ir-ibx-card__title">{card.title}</span>
        <span className="ir-ibx-card__role">{card.role_required}</span>
      </div>
      {grown && <OriginRow />}
      <div className="ir-ibx-card__sub">{card.project_goal}</div>
      <div className="ir-ibx-card__acts">
        <button type="button" className="ir-ibx-act ir-ibx-act--primary" onClick={() => openTask(card.project_id, card.task_id)}>
          去处理
        </button>
      </div>
    </div>
  );
}

function ReviewItem({
  card,
  openTask,
  name,
}: {
  card: ReviewCard;
  openTask: ReturnType<typeof useOpenTask>;
  name: (id: string) => string;
}) {
  const bus = useShellBus();
  if (card.card_kind === "reimbursement") {
    return (
      <div className="ir-ibx-card ir-ibx-card--reim">
        <div className="ir-ibx-card__row">
          <span className="ir-ibx-card__title">差旅报销 · {name(card.applicant)}</span>
          <span className="ir-ibx-card__amount">
            {card.currency} {card.amount.toFixed(2)}
          </span>
        </div>
        <Stepper step={card.step} />
        <div className="ir-ibx-card__acts">
          <button
            type="button"
            className="ir-ibx-act ir-ibx-act--primary"
            onClick={() => bus.navigate("cowork", "reimbursement")}
          >
            去审批
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="ir-ibx-act ir-ibx-act--stub" aria-disabled="true">
            就地批 · P1
          </span>
          <span className="ir-ibx-card__note">Cowork 流程投影 · 同源审计</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ir-ibx-card ir-ibx-card--gate">
      <div className="ir-ibx-card__row">
        <Seal variant="gate" />
        <span className="ir-ibx-card__title">评审 · {card.gate_title}</span>
      </div>
      {card.reviews_title && <div className="ir-ibx-card__sub">对象 · {card.reviews_title}</div>}
      <div className="ir-ibx-card__sub ir-ibx-card__sub--quiet">{card.project_goal}</div>
      <div className="ir-ibx-card__acts">
        <button
          type="button"
          className="ir-ibx-act ir-ibx-act--primary"
          onClick={() => openTask(card.project_id, card.gate_task_id)}
        >
          去评审
        </button>
        <button type="button" className="ir-ibx-act" onClick={() => openTask(card.project_id, card.gate_task_id)}>
          看节点
        </button>
      </div>
    </div>
  );
}

function MentionItem({
  card,
  openTask,
  name,
}: {
  card: MentionCard;
  openTask: ReturnType<typeof useOpenTask>;
  name: (id: string) => string;
}) {
  return (
    <div className="ir-ibx-card">
      <div className="ir-ibx-card__row">
        <span className="ir-ibx-card__title">
          {card.author_member_id ? name(card.author_member_id) : "有人"} 在频道提到你
        </span>
      </div>
      <div className="ir-ibx-quote ir-ibx-quote--plain">“{card.body}”</div>
      <div className="ir-ibx-card__acts">
        <button
          type="button"
          className="ir-ibx-act ir-ibx-act--primary"
          onClick={() => openTask(card.project_id, card.task_id)}
        >
          回到频道上下文
        </button>
      </div>
    </div>
  );
}

/* ---------------- 页 ---------------- */

export function CrewInboxPage() {
  const openTask = useOpenTask();
  const { unreadCount } = useCrewNotifications();
  const [inbox, setInbox] = useState<CrewInbox | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getInbox()
      .then((r) => setInbox({ todo: r.todo ?? [], review: r.review ?? [], mentions: r.mentions ?? [] }))
      .catch(() => setInbox(EMPTY))
      .finally(() => setLoading(false));
    listTeam()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const name = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m.display_name]));
    return (id: string) => map.get(id) ?? id;
  }, [members]);

  const todo = inbox?.todo ?? [];
  const review = inbox?.review ?? [];
  const mentions = inbox?.mentions ?? [];

  return (
    <div className="ir-crew-page">
      <div className="ir-crew-page__scroll">
        <div className="ir-crew-page__col ir-crew-page__col--wide">
          <div className="ir-crew-page__head">
            <div>
              <div className="ir-crew-page__eyebrow">CREW</div>
              <div className="ir-crew-page__title">
                收件箱
                {unreadCount > 0 && <span className="ir-crew-page__count">未读 {unreadCount}</span>}
              </div>
            </div>
            <button type="button" className="ir-crew-page__refresh" onClick={load} disabled={loading}>
              刷新
            </button>
          </div>

          {loading && !inbox ? (
            <StateNote kind="loading" text="正在装载收件箱" />
          ) : (
            <div className="ir-crew-inbox">
              <section className="ir-crew-inbox__group">
                <div className="ir-crew-inbox__grouphead">
                  <span className="ir-crew-inbox__grouplabel">{inboxLaneTitle("todo")}</span>
                  {todo.length > 0 && <span className="ir-crew-inbox__groupn">{todo.length}</span>}
                </div>
                {todo.length === 0 ? (
                  <div className="ir-crew-inbox__empty">{LANE_EMPTY.todo}</div>
                ) : (
                  todo.map((c) => <TodoItem key={c.task_id} card={c} openTask={openTask} />)
                )}
              </section>

              <section className="ir-crew-inbox__group">
                <div className="ir-crew-inbox__grouphead">
                  <span className="ir-crew-inbox__grouplabel">{inboxLaneTitle("review")}</span>
                  {review.length > 0 && <span className="ir-crew-inbox__groupn">{review.length}</span>}
                </div>
                {review.length === 0 ? (
                  <div className="ir-crew-inbox__empty">{LANE_EMPTY.review}</div>
                ) : (
                  review.map((c) => (
                    <ReviewItem
                      key={c.card_kind === "reimbursement" ? c.run_id : c.gate_task_id}
                      card={c}
                      openTask={openTask}
                      name={name}
                    />
                  ))
                )}
              </section>

              <section className="ir-crew-inbox__group">
                <div className="ir-crew-inbox__grouphead">
                  <span className="ir-crew-inbox__grouplabel">{inboxLaneTitle("mentions")}</span>
                  {mentions.length > 0 && <span className="ir-crew-inbox__groupn">{mentions.length}</span>}
                </div>
                {mentions.length === 0 ? (
                  <div className="ir-crew-inbox__empty">{LANE_EMPTY.mentions}</div>
                ) : (
                  mentions.map((c) => <MentionItem key={c.message_id} card={c} openTask={openTask} name={name} />)
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CrewInboxPage;
