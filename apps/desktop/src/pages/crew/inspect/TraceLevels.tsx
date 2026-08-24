/**
 * TraceLevels · 三级执行 Trace(§3j;抽屉「执行过程」展开体,替代 LoopCard)
 *
 *   L1 执行摘要(sticky 吸顶,即点即关):模型 · N 帧 · 耗时 · 结果 + 收起控件
 *   L2 步骤列表(每帧一行):类型 tag(思考/调用/生成/错误)+ 首行摘要省略 + chevron
 *   L3 展开帧(原文):头「三级 · 原文」pill;text/thinking → CrewMarkdown 渲染,
 *      工具 args/result → 等宽降噪;正文 max-h 196 内滚 + 底渐隐。
 *
 * 零捏造:一切来自 crewTrace(帧真值);无原文的步不出箭头、不可掀。收起控件同位吸顶,
 * 任意滚动深度一键回折叠。零帧留位由宿主(TaskDrawer)判定,本组件只在有帧时渲染。
 */

import { useState } from "react";

import { CrewMarkdown } from "../CrewMarkdown";
import { fmtDuration } from "../../../lib/turns";
import type { StepL3Tool } from "../../../lib/turns";
import type { CrewTrace } from "./crewTrace";
import { toL2Rows, traceResultText, type L2Row } from "./traceModel";

function ChevUp() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}
function ChevRight({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 140ms ease" }}
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export interface TraceLevelsProps {
  trace: CrewTrace;
  /** 最新产物版本(结果文案「产物 vN」;无 → 「完成」) */
  latestVersion: number | null;
  /** 「收起」= 折叠整个「执行过程」段(同位吸顶,即点即关) */
  onCollapse: () => void;
}

export function TraceLevels({ trace, latestVersion, onCollapse }: TraceLevelsProps) {
  const rows = toL2Rows(trace.turns);

  // 耗时:终态用 endedAtMs 定格,运行中用 now 推进;无时戳 → 省略(不猜)。
  const durText =
    trace.startedAtMs != null
      ? fmtDuration((trace.terminalStatus != null ? trace.endedAtMs ?? Date.now() : Date.now()) - trace.startedAtMs)
      : null;

  const result = traceResultText(trace.terminalStatus, latestVersion);
  const summaryParts = [
    ...(trace.modelName ? [trace.modelName] : []), // 模型名仅帧真报时显示(否则省略,偏差登记)
    `${trace.frameCount} 步`,
    ...(durText ? [durText] : []),
    result,
  ];

  return (
    <div className="ir-tl">
      {/* L1 执行摘要(吸顶) */}
      <div className="ir-tl__l1">
        <span className="ir-tl__l1pill">一级</span>
        <span className="ir-tl__l1k">执行摘要</span>
        <span className="ir-tl__summary">{summaryParts.join(" · ")}</span>
        <button type="button" className="ir-tl__collapse" onClick={onCollapse}>
          <ChevUp />
          收起
        </button>
      </div>

      {/* L2 步骤列表 + L3 展开 */}
      <div className="ir-tl__l2">
        {rows.length === 0 ? (
          <div className="ir-tl__empty">帧已到，但无可展开的过程步（纯事件流）。</div>
        ) : (
          rows.map((row) => <TraceRow key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

function TraceRow({ row }: { row: L2Row }) {
  const [open, setOpen] = useState(row.defaultOpen);
  const expandable = row.l3kind !== null;
  const fail = row.status === "fail";

  return (
    <div className={`ir-tl__step${fail ? " ir-tl__step--fail" : ""}`}>
      <button
        type="button"
        className="ir-tl__row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <span className={`ir-tl__tag ir-tl__tag--${row.kind}`}>{row.tag}</span>
        <span className="ir-tl__sum">{row.summary || "（无摘要）"}</span>
        {fail && <span className="ir-tl__x">✕</span>}
        {expandable && <span className="ir-tl__chev"><ChevRight open={open} /></span>}
      </button>
      {expandable && open && (
        <div className={`ir-tl__l3${fail ? " ir-tl__l3--fail" : ""}`}>
          <div className="ir-tl__l3head">
            <span className={`ir-tl__tag ir-tl__tag--${row.kind}`}>{row.tag}</span>
            <span className="ir-tl__l3title">{row.summary || "原文"}</span>
            <span className="ir-tl__l3pill">三级 · 原文</span>
          </div>
          <div className="ir-tl__l3body">
            {row.l3kind === "markdown" ? (
              <CrewMarkdown source={(row.l3 as { text: string }).text} />
            ) : (
              <ToolL3 l3={row.l3 as StepL3Tool} />
            )}
            <div className="ir-tl__fade" aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
}

/** 工具帧 L3:args/result/exit 等宽降噪(一字不改,零捏造)。 */
function ToolL3({ l3 }: { l3: StepL3Tool }) {
  const fields: [string, string][] = [];
  if (l3.contract) fields.push(["contract", l3.contract]);
  if (l3.argsPreview) fields.push(["args", l3.argsPreview]);
  if (l3.resultPreview) fields.push(["result", l3.resultPreview]);
  if (l3.exitText) fields.push(["exit", l3.exitText]);
  return (
    <div className="ir-tl__mono">
      {l3.restricted && <div className="ir-tl__lock">受限视角 · 已脱敏摘要；完整凭证仅 run owner 或开发者可见</div>}
      {fields.length === 0 ? (
        <div className="ir-tl__monoline">（无留存 args/result）</div>
      ) : (
        fields.map(([k, v]) => (
          <div key={k} className="ir-tl__monofield">
            <span className="ir-tl__monok">{k}</span>
            <span className="ir-tl__monov">{v}</span>
          </div>
        ))
      )}
      {l3.truncated && (
        <div className="ir-tl__trunc">
          已截断预览{l3.bytes != null ? ` · 全文 ${l3.bytes.toLocaleString()} bytes` : ""}
        </div>
      )}
    </div>
  );
}

export default TraceLevels;
