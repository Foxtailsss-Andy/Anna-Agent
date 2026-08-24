/**
 * ArtifactChip · R1 附件 chip 家族(产物卡/评审卡/交付事件共用同一件;3g 规格)
 *
 * - 32px 图标盒 + 名 13/600 省略 + mono 元「.md · vN · N 字」+ 动作:
 *     展开(中性)/ 全幅阅读(iris 主动作)/ 定位到节点(准星,onLocate 时)/ 下载(28px icon)。
 * - 窄容器(≤~340,频道 328)收敛为「全幅阅读 + …」,余动作入 … 溢出菜单(ResizeObserver 测量);
 *     **定位准星在收敛态仍平铺**(对齐修复:从 chip 一眼定位到图上是哪个文档,绝不入溢出)。
 * - 展开 = 内嵌 markdown(CrewMarkdown);全幅阅读/下载上抛 C4/后续切片 prop(缺省 no-op);
 *     定位上抛 onLocate(缺省 no-op,页面接线=回图+点名环)。
 * - 链接卡变体(LinkCard):say 正文外链,中性地球 icon + 单「外链」动作(浏览器打开)。
 * 零捏造:字数/版本来自真产物元数据;无产物则调用方根本不渲染 chip。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { CrewMarkdown } from "../CrewMarkdown";
import {
  formatArtifactMeta,
  overflowChipActions,
  prettyUrl,
  sniffArtifactKind,
  visibleChipActions,
  type ArtifactChipData,
} from "./artifactChip";

/** C4 阅读器目标(缺省 no-op → W1 独立编译)。 */
export interface ReaderTarget {
  taskId: string;
  version?: number;
}

const COLLAPSE_MAX = 340; // 频道列 328 → 收敛;宽容器(阅读器/抽屉)展开三动作

function FileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 14v6h6M20 10V4h-6" />
      <path d="M20 4l-7 7M4 20l7-7" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}
/** 定位准星 —— 与「跳到节点」chip 同一图元语汇(ChronicleLine.Crosshair)。 */
function CrosshairIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}
function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18" />
    </svg>
  );
}
function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export interface ArtifactChipProps {
  chip: ArtifactChipData;
  /** 全幅阅读 → C4;缺省 no-op(保 W1 独立编译)。 */
  onOpenReader?: (target: ReaderTarget) => void;
  /** 下载 → 后续切片接线;缺省 no-op。 */
  onDownload?: (target: ReaderTarget) => void;
  /** 定位到工作图节点(准星);缺省 no-op → 不渲染准星(页面接线=回图+点名环)。 */
  onLocate?: (taskId: string) => void;
}

export function ArtifactChip({ chip, onOpenReader, onDownload, onLocate }: ArtifactChipProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(true); // 频道窄列默认收敛,宽容器测量后展开
  const rootRef = useRef<HTMLDivElement>(null);
  const target: ReaderTarget = { taskId: chip.taskId, version: chip.version ?? undefined };

  // 容器宽度 → 是否收敛为「全幅阅读 + …」
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = (w: number) => setCollapsed(w > 0 && w <= COLLAPSE_MAX);
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // … 菜单:点空白关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const meta = formatArtifactMeta(chip);
  const toggleExpand = () => setExpanded((v) => !v);
  const openReader = () => onOpenReader?.(target);
  const download = () => onDownload?.(target);
  const locate = () => onLocate?.(chip.taskId);

  // 动作可见集(纯派生):定位在收敛态仍平铺,绝不入溢出(对齐修复)。
  const actions = visibleChipActions({ collapsed, hasLocate: !!onLocate });
  const overflow = overflowChipActions(collapsed);

  return (
    <div className="ir-chan-achip__wrap">
      {/* 收敛态改两行堆叠:文件名独占首行(真机修:动作挤到名字只剩一个字) */}
      <div className={`ir-chan-achip${collapsed ? " ir-chan-achip--stack" : ""}`} ref={rootRef}>
        <span className="ir-chan-achip__icon" aria-hidden="true">
          <FileIcon />
        </span>
        <span className="ir-chan-achip__meta">
          <span className="ir-chan-achip__name" title={chip.title}>
            {chip.title}
          </span>
          <span className="ir-chan-achip__sub">{meta}</span>
        </span>
        <span className="ir-chan-achip__actions">
          {actions.includes("expand") && (
            <button type="button" className="ir-chan-achip__act" onClick={toggleExpand} aria-expanded={expanded}>
              {expanded ? "收起" : "展开"}
            </button>
          )}
          {actions.includes("read") && (
            <button type="button" className="ir-chan-achip__act ir-chan-achip__act--primary" onClick={openReader}>
              <ExpandIcon />
              全幅阅读
            </button>
          )}
          {actions.includes("locate") && (
            <button
              type="button"
              className="ir-chan-achip__icobtn"
              onClick={locate}
              aria-label="定位到节点"
              title="定位到节点"
            >
              <CrosshairIcon />
            </button>
          )}
          {actions.includes("download") && (
            <button type="button" className="ir-chan-achip__icobtn" onClick={download} aria-label="下载产物" title="下载 .md">
              <DownloadIcon />
            </button>
          )}
          {actions.includes("more") && (
            <button
              type="button"
              className="ir-chan-achip__icobtn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="更多动作"
              title="更多"
            >
              <MoreIcon />
            </button>
          )}
          {menuOpen && overflow.length > 0 && (
            <div className="ir-chan-achip__menu" role="menu">
              {overflow.includes("expand") && (
                <button
                  type="button"
                  role="menuitem"
                  className="ir-chan-achip__menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    toggleExpand();
                  }}
                >
                  <ExpandIcon />
                  {expanded ? "收起" : "展开"}
                </button>
              )}
              {overflow.includes("download") && (
                <button
                  type="button"
                  role="menuitem"
                  className="ir-chan-achip__menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    download();
                  }}
                >
                  <DownloadIcon />
                  下载 .md
                </button>
              )}
            </div>
          )}
        </span>
      </div>
      {expanded && (
        <div className="ir-chan-achip__body">
          {sniffArtifactKind(chip.content) === "html" ? (
            // HTML 产物:内联展开 = 转义源码块(CrewMarkdown 会吞标签,渲染成空/破),
            // 沉浸预览留给全幅阅读器的沙箱 iframe。
            <div className="ir-chan-achip__html">
              <div className="ir-chan-achip__htmlhead">HTML 源码</div>
              <pre className="ir-chan-achip__htmlsrc">{chip.content}</pre>
            </div>
          ) : (
            <CrewMarkdown source={chip.content} />
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- 链接卡变体(say 内外链) ---------------- */

export interface LinkCardProps {
  url: string;
  /** 标题(如有);缺省用去协议的 URL */
  label?: string;
}

export function LinkCard({ url, label }: LinkCardProps) {
  return (
    <div className="ir-chan-achip ir-chan-achip--link">
      <span className="ir-chan-achip__icon ir-chan-achip__icon--globe" aria-hidden="true">
        <GlobeIcon />
      </span>
      <span className="ir-chan-achip__meta">
        <span className="ir-chan-achip__name" title={url}>
          {label ?? prettyUrl(url)}
        </span>
        <span className="ir-chan-achip__sub">{prettyUrl(url, 52)}</span>
      </span>
      <span className="ir-chan-achip__actions">
        <a
          className="ir-chan-achip__icobtn"
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="在浏览器打开外链"
          title="在浏览器打开"
        >
          <ExternalIcon />
        </a>
      </span>
    </div>
  );
}

export default ArtifactChip;
