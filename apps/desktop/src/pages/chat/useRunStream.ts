/**
 * useRunStream · 运行流核心 hook(R4;R5/R6 复用)
 *
 * 职责:开一条 SSE(open 回调)→ `createNormalizer()` 逐帧归一化 → 累进 `frames` →
 * `reduceTurns` 实时得 `RunTree` → 供 LoopCard 四态。计时是前端职责(mm:ss);
 * ctx/usage 从 normalizer 上下文真读(无真报 → undefined,站位)。
 *
 * 纪律:
 *  ① `stop()` = 前端主动断流(AbortController → 关连接,后端按 client_disconnected 处理);
 *     **不伪造 done/error** —— tree.state 停在当下,页面对已中断 run 显示素文案「已停止」。
 *  ② HTTP/网络层失败(流未及产出终帧)→ 合成 error 帧,tree 收敛为 error(message = 真实原文)。
 *  ③ 组件真卸载 abort;keep-alive(display:none)不卸载 → 流不中断(R3 保活)。
 *
 * 偏差记录(D-R4-stream):`start(open)` 的 open 回调收一个 `AbortSignal` 入参
 * (brief 示例为零参 thunk)。理由:stop() 必须真正关闭 fetch 连接才能触发后端
 * client_disconnected;唯有把 signal 透进 fetch 才能在「模型慢调用、帧间空档」也即时中断。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createNormalizer, type Normalizer } from "../../lib/api/normalize";
import { readSse } from "../../lib/api/sse";
import type { Frame } from "../../lib/frames";
import {
  detectSuspension,
  initResumeState,
  nextReconnect,
  registerAttempt,
  trackSeq,
  type ResumeState,
  type SuspensionInfo,
} from "../../lib/streamResume";
import { fmtClock, reduceTurns, type RunTree, type ToolLabels } from "../../lib/turns";

/** 后台 run 订阅器:begin() 得 runId 后,startBackground/continueRun 复用同一签名跟随续帧。 */
type SubscribeFn = (
  runId: string,
  fromSeq: number,
  onFrame: (raw: Record<string, unknown>) => void,
  signal: AbortSignal,
) => Promise<void>;

/** 可被 abort 打断的等待:超时或 abort 都 resolve(调用方随后查 signal.aborted 决定去留)。
 *  两条路径都清掉自身(clearTimeout / removeEventListener),不留计时器与监听器。 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunUsageLite {
  tokens: number | null;
  model?: string;
}

/** usage → "~N tokens"(真报才有,null → undefined:不显示、不猜)。
 *  V2 修订 ①(Home 合并轮):模型名全站不入 UI 文案 —— 观测行只报 tokens。 */
export function formatUsageText(usage: RunUsageLite): string | undefined {
  if (usage.tokens == null) return undefined;
  return `~${usage.tokens.toLocaleString()} tokens`;
}

/**
 * 剩余百分比(后端 `context_percent_left` 真值)→ 已用百分比(设计契约 ctxPercent:
 * AgentComposer/ACCEPTANCE §G,>80 转琥珀)。null(无审计)→ undefined(不猜、不显示)。
 * 换算同一真值,仅单位翻转,夹在 [0, 100] 防越界。
 */
export function usedPercent(left: number | null): number | undefined {
  if (left == null) return undefined;
  return Math.max(0, Math.min(100, Math.round(100 - left)));
}

export interface RunStream {
  /** reduceTurns(frames) 的实时结果 */
  tree: RunTree;
  /** v2 帧数组(回看/调试用) */
  frames: Frame[];
  /** mm:ss 计时(前端职责) */
  elapsedText: string;
  /** W5:已用百分比(design 契约,>80 琥珀)。后端报剩余,useRunStream 换算;无审计 → undefined(站位) */
  ctxPercent: number | undefined;
  /** "~N tokens",无真报则 undefined(V2 ①:模型名不入 UI) */
  usageText: string | undefined;
  /** 原始 usage(tokens/model 真值;办妥 mono 行等自行组稿) */
  usage: RunUsageLite;
  running: boolean;
  /** 用户手动 stop() 过(中断非错误,页面据此显素文案) */
  stopped: boolean;
  /** L3b:断线重连进行中(首帧到达即清)。真话 —— 后台 run 仍在跑,只是连接断了,不伪造进度。 */
  reconnecting: boolean;
  /** L3b follow-up:停止指令未送达(stopChatRun RPC 失败)。真话 —— 本地已停跟随,但后端 run 可能仍在跑,不伪称已停止。 */
  stopUndelivered: boolean;
  /**
   * L4b:顶到 max_turns 挂起(诚实暂停,非失败、非断线)。null = 未挂起;
   * `{turnsUsed?}` = 后端 run.suspended 真报的已跑回合数(无则省略)。仅在见到流内 run.suspended
   * 事件帧时置(不据传输关闭臆断);start/startBackground/continueRun/stop/reset 均清零,防陈卡。
   */
  suspended: SuspensionInfo | null;
  /**
   * 开一条流。`{ append: true }`(R6 续流):不清 frames、沿用同一 normalizer 实例,
   * 新段帧追加到既有时间线 —— 同一 run 的「创建段 + 审批/补录恢复段」拼成一条旅程
   * (usage/ctx 继续累计,计时不重置)。默认(不传或 false)= 全新一条 run,清空重来。
   */
  start: (open: (signal: AbortSignal) => Promise<Response>, opts?: { append?: boolean }) => Promise<void>;
  /**
   * L3b 后台 run:begin() 提交(或解析既有 runId,仅一次、不重试以免重复建 run)得 runId →
   * subscribe(runId, fromSeq, onFrame, signal) 订阅(replay + 跟随)。传输中断且未见终帧 →
   * 按 streamResume 退避重连(从上次 seq 续帧);见终帧正常收束;重连耗尽 → 合成 error 帧收敛。
   * 帧归一化 / tree / 计时与 start 复用同一套内部机器。
   */
  startBackground: (begin: () => Promise<string>, subscribe: SubscribeFn) => Promise<void>;
  /**
   * L4b 续办:恢复顶到 max_turns 挂起(awaiting_continue)的 run。`resume` = POST continue
   * (后端幂等,同 run_id/journal 续跑),成功后**接着既有时间线**从上次 seq 续帧(沿用同一
   * normalizer,turn/usage/ctx 接续、不清 frames);进入续跑即清 suspended。若无既有 normalizer
   * (异常兜底)则新建 + 从 0 全量 replay。runId = 挂起的那条 run;subscribe 同 startBackground。
   */
  continueRun: (runId: string, resume: () => Promise<unknown>, subscribe: SubscribeFn) => Promise<void>;
  /** AbortController;中断 = 前端主动断流(后端按 client_disconnected 处理) */
  stop: () => void;
  /** L3b follow-up:标记停止指令未送达(stopChatRun 失败时调用);语义见 stopUndelivered。 */
  noteStopUndelivered: () => void;
  reset: () => void;
}

export function useRunStream(toolLabels?: ToolLabels): RunStream {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [ctxRaw, setCtxRaw] = useState<number | null>(null);
  const [usageRaw, setUsageRaw] = useState<RunUsageLite>({ tokens: null });
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // L3b follow-up:停止指令未送达(stopChatRun RPC 失败)—— 诚实标记,后台 run 可能仍在跑。
  const [stopUndelivered, setStopUndelivered] = useState(false);
  // L4b:顶到 max_turns 挂起(诚实暂停)。null = 未挂起;仅见到流内 run.suspended 事件帧时置。
  const [suspended, setSuspended] = useState<SuspensionInfo | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // 归一化器实例:append 续流时沿用(有状态 —— turn/usage/ctx 上下文接续),否则每次新建。
  const normalizerRef = useRef<Normalizer | null>(null);
  // L4b:最近见过的 seq(挂起后仍留存),续办 continueRun 从此值 +1 续帧,不重不漏。
  const lastSeqRef = useRef(0);

  // 计时器:running 时 500ms 步进;done/error/stop → running=false → 停(动效纪律)。
  useEffect(() => {
    if (!running || startAt == null) return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, [running, startAt]);

  // 组件真卸载 → abort(keep-alive 隐藏不卸载,故流不中断)。
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    async (open: (signal: AbortSignal) => Promise<Response>, opts?: { append?: boolean }) => {
      const append = opts?.append === true && normalizerRef.current !== null;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      // append:沿用同一 normalizer(接续 turn/usage/ctx 上下文),不清 frames、不重置计时。
      const normalize = append ? (normalizerRef.current as Normalizer) : createNormalizer();
      normalizerRef.current = normalize;
      const t0 = performance.now();
      if (!append) {
        setFrames([]);
        setCtxRaw(null);
        setUsageRaw({ tokens: null });
        setStartAt(t0);
        setNow(t0);
      }
      setStopped(false);
      setStopUndelivered(false);
      setSuspended(null); // L4b 复位纪律:新一条流不留陈挂起卡
      setRunning(true);
      try {
        const res = await open(ac.signal);
        await readSse(res, (raw) => {
          const out = normalize(raw);
          if (out.length) setFrames((prev) => [...prev, ...out]);
          setCtxRaw(normalize.getCtxPercentLeft());
          setUsageRaw(normalize.getUsage());
        });
      } catch (err) {
        if (ac.signal.aborted) return; // stop():主动断流,非错误(页面显素文案)
        // 流未及产出终帧就断:合成 error 帧收敛 tree。message = 真实错误原文,不臆造。
        const message = err instanceof Error ? err.message : String(err);
        setFrames((prev) => [...prev, { type: "error", message, consumedTokens: normalize.getUsage().tokens }]);
      } finally {
        setNow(performance.now()); // 定格最终耗时
        setRunning(false);
      }
    },
    [],
  );

  /**
   * 后台 run 跟随机器(L3b 断线重连 + L4b 挂起短路;startBackground/continueRun 共用)。
   * subscribe(replay+跟随)→ trackSeq 记 seq/终帧/挂起 → normalize 逐帧累进 tree。传输中断且
   * 未见终帧/未挂起 → 按退避续帧;见终帧正常收束;见 run.suspended 事件帧 → 短路重连、置挂起、
   * 不合成 error(交续办卡);重连耗尽 → 合成 error 帧如实收敛。normalize/ac/fromSeq 由调用方
   * 备好(startBackground 全新从 0,continueRun 续接同一 normalizer 从上次 seq)。
   */
  const followLoop = useCallback(
    async (
      runId: string,
      subscribe: SubscribeFn,
      normalize: Normalizer,
      ac: AbortController,
      fromSeq: number,
    ) => {
      let resume: ResumeState = { ...initResumeState(), lastSeq: fromSeq };
      for (;;) {
        try {
          await subscribe(
            runId,
            resume.lastSeq,
            (raw) => {
              resume = trackSeq(resume, raw);
              if (resume.sequenceGap !== undefined) {
                throw new Error(
                  `SSE sequence gap: expected ${resume.sequenceGap.expected}, got ${resume.sequenceGap.actual}`,
                );
              }
              lastSeqRef.current = resume.lastSeq; // 续办从此续帧
              setReconnecting(false); // 首帧到达即清重连提示(honest:连上了)
              const susp = detectSuspension(raw);
              if (susp) setSuspended(susp); // 诚实挂起(真凭证:run.suspended 事件帧)
              const out = normalize(raw);
              if (out.length) setFrames((prev) => [...prev, ...out]);
              setCtxRaw(normalize.getCtxPercentLeft());
              setUsageRaw(normalize.getUsage());
            },
            ac.signal,
          );
        } catch {
          if (ac.signal.aborted) return; // stop()/卸载:主动断流,非错误
          // 传输中断(未见终帧则落到下方重连决策)
        }
        if (ac.signal.aborted) return;
        const plan = nextReconnect(resume);
        if (plan === null) {
          // 见终帧 → normalizer 已产出 done/error 帧,正常收束;挂起 → 诚实暂停(续办卡已现);
          // 二者均不合成 error;否则重连次数耗尽 → 合成 error 帧如实收敛(不伪造)。
          if (!resume.sawTerminal && !resume.suspended) {
            setFrames((prev) => [
              ...prev,
              {
                type: "error",
                message: resume.sequenceGap === undefined
                  ? "连接中断，重连多次仍未恢复"
                  : `流序号断档，已停止自动重连（应为 ${resume.sequenceGap.expected}，实际为 ${resume.sequenceGap.actual}）`,
                consumedTokens: normalize.getUsage().tokens,
              },
            ]);
          }
          break;
        }
        resume = registerAttempt(resume);
        setReconnecting(true);
        await sleepAbortable(plan.delayMs, ac.signal);
        if (ac.signal.aborted) return; // 退避期间被停/卸载 → 不再重订阅
      }
    },
    [],
  );

  const startBackground = useCallback<RunStream["startBackground"]>(
    async (begin, subscribe) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      // 后台 run 每次都是全新一条:新 normalizer + 清 frames + 重置计时(不 append)。
      const normalize = createNormalizer();
      normalizerRef.current = normalize;
      lastSeqRef.current = 0;
      const t0 = performance.now();
      setFrames([]);
      setCtxRaw(null);
      setUsageRaw({ tokens: null });
      setStartAt(t0);
      setNow(t0);
      setStopped(false);
      setReconnecting(false);
      setStopUndelivered(false);
      setSuspended(null); // L4b 复位纪律:新 run 不留陈挂起卡
      setRunning(true);
      try {
        let runId: string;
        try {
          runId = await begin(); // 仅一次,失败不重试(避免重复建 run)
        } catch (err) {
          if (ac.signal.aborted) return; // stop()/卸载:主动断流,非错误
          const message = err instanceof Error ? err.message : String(err);
          setFrames((prev) => [...prev, { type: "error", message, consumedTokens: normalize.getUsage().tokens }]);
          return;
        }
        if (ac.signal.aborted) return;
        await followLoop(runId, subscribe, normalize, ac, 0);
      } finally {
        setNow(performance.now()); // 定格最终耗时
        setRunning(false);
        setReconnecting(false);
      }
    },
    [followLoop],
  );

  const continueRun = useCallback<RunStream["continueRun"]>(
    async (runId, resumePost, subscribe) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      // 续办 = 接着既有时间线跑:沿用同一 normalizer(turn/usage/ctx 接续)、不清 frames、从上次
      // seq 续帧。无既有 normalizer(异常兜底,如回看态直接续)→ 新建 + 清 frames + 从 0 全量 replay。
      const existing = normalizerRef.current;
      const fresh = existing === null;
      const normalize = existing ?? createNormalizer();
      let fromSeq = lastSeqRef.current;
      if (fresh) {
        normalizerRef.current = normalize;
        lastSeqRef.current = 0;
        fromSeq = 0;
        const t0 = performance.now();
        setFrames([]);
        setCtxRaw(null);
        setUsageRaw({ tokens: null });
        setStartAt(t0);
        setNow(t0);
      }
      setSuspended(null); // 进入续跑 —— 撤下挂起卡
      setStopped(false);
      setStopUndelivered(false);
      setReconnecting(false);
      setRunning(true);
      try {
        try {
          await resumePost(); // POST continue(幂等;非 awaiting_continue 后端原样返回,续帧自然收终帧)
        } catch (err) {
          if (ac.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          setFrames((prev) => [...prev, { type: "error", message, consumedTokens: normalize.getUsage().tokens }]);
          return;
        }
        if (ac.signal.aborted) return;
        await followLoop(runId, subscribe, normalize, ac, fromSeq);
      } finally {
        setNow(performance.now());
        setRunning(false);
        setReconnecting(false);
      }
    },
    [followLoop],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStopped(true);
    setSuspended(null); // L4b:停止盖过挂起 —— 撤下续办卡,显「已停止」
    setReconnecting(false);
    setNow(performance.now());
    setRunning(false);
  }, []);

  // L3b follow-up:标记停止指令未送达(stopChatRun 失败)。本地已断流(stop),但后端 run 可能仍在跑
  // —— 诚实标记,页面据此显「停止指令未送达,任务可能仍在后台执行」,不伪称已停止。
  const noteStopUndelivered = useCallback(() => setStopUndelivered(true), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    normalizerRef.current = null;
    lastSeqRef.current = 0;
    setFrames([]);
    setCtxRaw(null);
    setUsageRaw({ tokens: null });
    setRunning(false);
    setStopped(false);
    setReconnecting(false);
    setStopUndelivered(false);
    setSuspended(null);
    setStartAt(null);
    setNow(0);
  }, []);

  const tree = useMemo(() => reduceTurns(frames, toolLabels), [frames, toolLabels]);
  const elapsedText = useMemo(
    () => (startAt == null ? "00:00" : fmtClock(Math.max(0, now - startAt))),
    [now, startAt],
  );

  return {
    tree,
    frames,
    elapsedText,
    ctxPercent: usedPercent(ctxRaw),
    usageText: formatUsageText(usageRaw),
    usage: usageRaw,
    running,
    stopped,
    reconnecting,
    stopUndelivered,
    suspended,
    start,
    startBackground,
    continueRun,
    stop,
    noteStopUndelivered,
    reset,
  };
}

export default useRunStream;
