/**
 * streamResume · 后台 run 订阅的断线重连状态机(L3b · 纯逻辑,无副作用)
 *
 * L3a 后端契约:GET /api/chat/runs/{id}/stream?from_seq=N 逐帧带 additive `seq`
 * (从 1 连续递增);先 replay > N 的帧,再跟随实时;终帧(done/error)后关闭。传输中断后
 * 用「上次见过的 seq」重连即精确续上(不重不漏)。本状态机只做纯决策:记录 last seq /
 * 是否见过终帧、给出下一次重连的退避时延与 fromSeq。副作用(计时/abort/fetch)由
 * useRunStream.startBackground 编排 —— 拆出纯逻辑便于 node 环境纯单测。
 *
 * 诚实纪律(ADR-002):重连只是「续看同一后台 run」,不伪造进度;见终帧即停不再重连;
 * 重连次数耗尽 → 交由编排层合成 error 帧如实收敛(「重连多次仍未恢复」)。
 */

/** 退避时延序列(ms):第 1..5 次重连;共 5 次,之后判定耗尽。 */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export interface ResumeState {
  /** 最近见过的 seq(0 = 尚未见任何带 seq 的帧);重连 fromSeq 取此值。 */
  lastSeq: number;
  /** 见过终帧(done/error)—— 见终即不再重连。 */
  sawTerminal: boolean;
  /** 自上次成功收帧以来的连续重连次数;收到任一帧即归零。 */
  attempts: number;
  /**
   * L4b:见过 run.suspended 事件帧(顶到 max_turns 挂起)。这是**诚实暂停**而非传输失败 ——
   * 后端把挂起如实落进流内一条审计事件帧后干净关流(无 done/error),故须与「断线」区分:
   * 见挂起即短路重连(不退避、不合成 error 帧),交由 UI 呈现「续办卡」。
   */
  suspended: boolean;
  /** First observed discontinuity in the durable sequence, if any. */
  sequenceGap?: { expected: number; actual: number };
}

export interface ReconnectPlan {
  delayMs: number;
  fromSeq: number;
}

/** L4b 挂起识别命中值:后端 run.suspended payload 的 turns_used 真值(无则省略,不猜)。 */
export interface SuspensionInfo {
  turnsUsed?: number;
}

export function initResumeState(): ResumeState {
  return { lastSeq: 0, sawTerminal: false, attempts: 0, suspended: false };
}

/**
 * 挂起识别(纯归约,L4b):从一帧真数据判断 run 是否顶到 max_turns 挂起(后端 run.suspended)。
 * 认两种真形态 —— ① 流内 wire 帧 `{type:"event", event:{type, payload}}`(实时/续帧路径);
 * ② run.audit_events 里的裸审计事件 `{type:"run.suspended", payload}`(回看路径)。
 * 命中 → `{turnsUsed?}`(payload.turns_used 数值真报,无则省略键);非挂起 / 畸形 → null(不猜)。
 * 诚实红线:只认真凭证(事件 type === "run.suspended"),绝不据「传输关闭」等旁证臆断挂起。
 */
export function detectSuspension(frame: Record<string, unknown>): SuspensionInfo | null {
  if (frame === null || typeof frame !== "object") return null;
  let audit: Record<string, unknown> | null = null;
  if (frame.type === "run.suspended") {
    // 裸审计事件形态(run.audit_events 项)
    audit = frame;
  } else if (frame.type === "event") {
    // wire 事件帧形态(SSE 逐帧)
    const ev = frame.event;
    if (ev !== null && typeof ev === "object" && (ev as Record<string, unknown>).type === "run.suspended") {
      audit = ev as Record<string, unknown>;
    }
  }
  if (audit === null) return null;
  const payload = audit.payload;
  const p = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const turns = p.turns_used;
  return typeof turns === "number" && Number.isFinite(turns) ? { turnsUsed: turns } : {};
}

/**
 * 记录一帧:更新 lastSeq(帧无数值 seq 则保持不变)、done/error 置 sawTerminal、
 * run.suspended 置 suspended(L4b);成功收帧即把重连计数归零(下次断线从最短退避重新起算)。
 * sawTerminal / suspended 一旦为真便黏住(后续过程帧不翻回)。
 */
export function trackSeq(state: ResumeState, frame: Record<string, unknown>): ResumeState {
  const seq = frame.seq;
  const hasSeq = typeof seq === "number" && Number.isFinite(seq);
  const terminal = frame.type === "done" || frame.type === "error";
  const sequenceGap = hasSeq
    && state.lastSeq > 0
    && seq !== state.lastSeq + 1
    ? state.sequenceGap ?? { expected: state.lastSeq + 1, actual: seq }
    : state.sequenceGap;
  return {
    lastSeq: hasSeq ? (seq as number) : state.lastSeq,
    sawTerminal: state.sawTerminal || terminal,
    attempts: 0,
    suspended: state.suspended || detectSuspension(frame) !== null,
    ...(sequenceGap === undefined ? {} : { sequenceGap }),
  };
}

/**
 * 下一次重连计划:挂起(L4b 诚实暂停)、见过终帧、或重连次数耗尽 → null(不再重连);
 * 否则给出本次退避时延(按 attempts 取 backoff)与 fromSeq(= lastSeq,精确续帧)。纯读:
 * 不改 state —— 编排层真正安排重连时调用 registerAttempt 递进计数。
 */
export function nextReconnect(state: ResumeState): ReconnectPlan | null {
  if (state.sequenceGap !== undefined) return null;
  if (state.suspended) return null; // L4b:顶到 max_turns 挂起 = 诚实暂停,不是断线,绝不重连
  if (state.sawTerminal) return null;
  if (state.attempts >= MAX_RECONNECT_ATTEMPTS) return null;
  return { delayMs: RECONNECT_BACKOFF_MS[state.attempts], fromSeq: state.lastSeq };
}

/** 递进一次重连计数(编排层在真正安排重连时调用)。 */
export function registerAttempt(state: ResumeState): ResumeState {
  return { ...state, attempts: state.attempts + 1 };
}
