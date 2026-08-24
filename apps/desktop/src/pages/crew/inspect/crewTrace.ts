/**
 * crewTrace · 薄适配器:crew run 帧 → LoopCard 输入(复用现件,不改 turns.ts/normalize.ts)
 *
 * crew 后台 run 逐帧落 journal 的是引擎 RAW 过程帧(与 chat SSE 同形态:
 *   {type:"text_delta"|"tool_start"|"step"|"event"...}),终帧由 crew manager 改写为
 *   {type:"done"|"error", run:{status, memory_hits, ...}}。因此链路 = chat 现行:
 *   createNormalizer()(RAW→Frame)→ reduceTurns(Frame→RunTree)→ LoopCard(turns)。
 *
 * 本适配器只补 crew 专属两件事(normalize/turns 不含):
 *   1. 丢弃 crew manager 传输脚手架事件(crew.run.created / run.queued)——非子代理过程;
 *   2. 从终帧抽取 memory_hits(共识命中溯源)与 terminalStatus(done/blocked/failed)。
 * 起始时刻取最早带时戳帧(event.created_at);无 → null(不猜耗时)。
 */

import type { LoopState } from "../../../components/agent/LoopCard";
import type { Frame } from "../../../lib/frames";
import { createNormalizer } from "../../../lib/api/normalize";
import { reduceTurns, type Turn } from "../../../lib/turns";

/** crew manager 传输脚手架 event 名(非子代理过程帧,trace 里丢弃)。 */
const SCAFFOLD_EVENTS = new Set(["crew.run.created", "run.queued"]);

export interface CrewTrace {
  turns: Turn[];
  /** LoopCard 态(reduceTurns idle → running) */
  state: LoopState;
  /** 「正在:…」= 最近 step.intent 引擎原文 */
  nowIntent: string;
  /** 命中的项目共识 item id(终帧 run.memory_hits;溯源验收) */
  memoryHits: string[];
  /** run 终态(done/blocked/failed);运行中 → null */
  terminalStatus: string | null;
  /** 最早带时戳帧的 epoch ms(耗时基准);无 → null(不猜) */
  startedAtMs: number | null;
  /** 最晚带时戳帧的 epoch ms(终态耗时上界);无 → null(运行中调用侧用 now 推进) */
  endedAtMs: number | null;
  /** 过程步数(= L2 步骤行数;text_delta 等流式微帧折进所属步,不虚增)——抽屉「N 步」 */
  frameCount: number;
  /** 模型名(帧内 model.call.started.payload.model_name 真报;无 → null,摘要行省略) */
  modelName: string | null;
}

function asRec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** 终帧(最后一条 done/error)→ {status, memoryHits}。无终帧 → 运行中。 */
function terminalOf(rawFrames: readonly Record<string, unknown>[]): {
  status: string | null;
  memoryHits: string[];
} {
  for (let i = rawFrames.length - 1; i >= 0; i--) {
    const f = rawFrames[i];
    if (f.type === "done" || f.type === "error") {
      const run = asRec(f.run);
      const hits = run?.memory_hits;
      const status = run && typeof run.status === "string" ? run.status : f.type === "done" ? "done" : "failed";
      return {
        status,
        memoryHits: Array.isArray(hits) ? hits.filter((x): x is string => typeof x === "string") : [],
      };
    }
  }
  return { status: null, memoryHits: [] };
}

/** 帧内真报的模型名(model.call.started.payload.model_name);无 → null(不猜)。 */
function modelNameOf(rawFrames: readonly Record<string, unknown>[]): string | null {
  for (const raw of rawFrames) {
    if (raw.type !== "event") continue;
    const ev = asRec(raw.event);
    if (!ev || ev.type !== "model.call.started") continue;
    const payload = asRec(ev.payload);
    const name = payload?.model_name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return null;
}

/** RAW crew 帧列 → CrewTrace(喂 TraceLevels / 共识 chips)。 */
export function framesToTrace(rawFrames: readonly Record<string, unknown>[]): CrewTrace {
  const normalize = createNormalizer();
  const frames: Frame[] = [];
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;

  for (const raw of rawFrames) {
    if (raw.type === "event") {
      const ev = asRec(raw.event);
      const evType = ev && typeof ev.type === "string" ? ev.type : undefined;
      if (evType && SCAFFOLD_EVENTS.has(evType)) continue; // 脚手架不入过程
    }
    for (const f of normalize(raw)) {
      frames.push(f);
      const at = (f as { at?: number }).at;
      if (typeof at === "number") {
        if (startedAtMs === null || at < startedAtMs) startedAtMs = at;
        if (endedAtMs === null || at > endedAtMs) endedAtMs = at;
      }
    }
  }

  const tree = reduceTurns(frames);
  const { status, memoryHits } = terminalOf(rawFrames);
  const state: LoopState = tree.state === "idle" ? "running" : tree.state;

  return {
    turns: tree.turns,
    state,
    nowIntent: tree.nowIntent,
    memoryHits,
    terminalStatus: status,
    startedAtMs,
    endedAtMs,
    // 步数而非原始帧数:text_delta 等流式微帧动辄上千,读感即噪音
    frameCount: tree.turns.reduce((n, t) => n + t.steps.length, 0),
    modelName: modelNameOf(rawFrames),
  };
}
