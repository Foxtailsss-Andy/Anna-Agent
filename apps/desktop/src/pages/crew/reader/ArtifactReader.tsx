/**
 * ArtifactReader · R1 产物阅读器(§3e/3f)
 *
 * 替换详情页画布区(频道列留右 —— 对照评审 posture)。三段:
 *   顶栏 52px(产物阅读器 + 书本 · 面包屑 · 版本 vN ⌄ 切换 · 下载 · 回到图 · ESC 徽)
 *   正文(max-width 780 居中,CrewMarkdown 走 .crew-reader 排版扩展段)
 *   页脚 38px(mono:vN · 字数 · 产出者 · 提交时刻 + 审计血统 caption)
 * ESC / 回到图 皆回图 —— ESC 监听归详情页(避让抽屉自有 Esc);本件顶栏只呈 ESC 徽。
 * 零捏造:无产物 → 诚实空态;字数/版本/时刻全来自真产物元数据。
 */

import { Fragment, useEffect, useRef, useState } from "react";

import type { TeamMember } from "../../../lib/api/crew";
import { sniffArtifactKind } from "../channel/artifactChip";
import { CrewMarkdown } from "../CrewMarkdown";
import type { CrewTask } from "../crewModel";
import { downloadArtifactMd } from "./download";
import { formatReaderFooter, readerBreadcrumb, resolveArtifact } from "./readerModel";
import "./reader.css";

/* ---------------- icons(currentColor,沿 crew 图标语汇) ---------------- */

function BookIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5z" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 9l7 7 7-7" />
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
function BackToGraphIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 19l-7-7 7-7" />
      <path d="M3 12h13a5 5 0 0 1 5 5v2" />
    </svg>
  );
}

/**
 * 对照评审态(一屏两键)· 判别联合:
 * - active:门就绪,左读全文 + 底部钉「通过 / 驳回+批注」;
 * - waiting(#1 评审等待态):双亲门尚未齐备(如设计评审需设计稿 + 技术预研皆交付),
 *   同一条金印条降噪呈现「还差 X 交付后开评」——不再空条误导「点了去评审却无按钮」。
 *   缺父交付后(3s 轮询)同一条原地翻成 active 变体。
 */
export type ReaderReview =
  | {
      state: "active";
      gateTitle: string;
      busy: boolean;
      error: string | null;
      onApprove: () => void;
      onReject: (comment: string) => void;
    }
  | {
      state: "waiting";
      gateTitle: string;
      /** 尚未交付的父任务标题(depends_on 序) */
      missing: string[];
    };

export interface ArtifactReaderProps {
  task: CrewTask;
  members: TeamMember[];
  /** 项目名(面包屑首段) */
  projectName: string;
  /** 目标版本(缺省 = 最新) */
  version?: number;
  /** ESC / 回到图 */
  onBack: () => void;
  /** vN ⌄ 切换版本 */
  onSwitchVersion: (version: number) => void;
  /** 对照评审(可用性收束):存在即钉底评审条 */
  review?: ReaderReview;
}

/* 对照评审条(钉在页脚上方;裁定即回图) */
function ReviewBar({ review }: { review: ReaderReview }) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");

  // #1 等待态:门未就绪(双亲未齐)——降噪金条 + 虚线,解释还差谁交付,无按钮。
  if (review.state === "waiting") {
    return (
      <div
        className="ir-reader__reviewbar ir-reader__reviewbar--waiting"
        role="status"
        aria-label={`评审待就绪 · ${review.gateTitle}`}
      >
        <div className="ir-reader__reviewbar-row">
          <span className="ir-reader__reviewbar-seal" aria-hidden="true">审</span>
          <span className="ir-reader__reviewbar-title">评审 · “{review.gateTitle}”</span>
          <span className="ir-reader__spacer" />
          <span className="ir-reader__reviewbar-wait">
            {review.missing.length > 0 ? (
              <>
                评审待就绪 —— 还差
                {review.missing.map((m, i) => (
                  <span key={i} className="ir-reader__reviewbar-missing">
                    “{m}”
                  </span>
                ))}
                交付后开评
              </>
            ) : (
              "评审待就绪 —— 上游正在同步"
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="ir-reader__reviewbar" role="group" aria-label={`评审 · ${review.gateTitle}`}>
      <div className="ir-reader__reviewbar-row">
        <span className="ir-reader__reviewbar-seal" aria-hidden="true">审</span>
        <span className="ir-reader__reviewbar-title">
          评审 · “{review.gateTitle}”
          <span className="ir-reader__reviewbar-hint">读完即可裁定，判后自动回图</span>
        </span>
        <span className="ir-reader__spacer" />
        <button
          type="button"
          className="ir-reader__rv-btn ir-reader__rv-btn--ok"
          disabled={review.busy}
          onClick={review.onApprove}
        >
          通过
        </button>
        <button
          type="button"
          className={`ir-reader__rv-btn ir-reader__rv-btn--danger${rejecting ? " is-armed" : ""}`}
          disabled={review.busy}
          aria-expanded={rejecting}
          onClick={() => setRejecting((v) => !v)}
        >
          驳回＋批注
        </button>
      </div>
      {rejecting && (
        <div className="ir-reader__reviewbar-note">
          <textarea
            className="ir-reader__rv-ta"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="批注（驳回必填，注入返工上下文）"
            rows={2}
            autoFocus
          />
          <button
            type="button"
            className="ir-reader__rv-btn ir-reader__rv-btn--danger-solid"
            disabled={review.busy || comment.trim() === ""}
            onClick={() => review.onReject(comment.trim())}
          >
            确认驳回
          </button>
        </div>
      )}
      {review.error && <div className="ir-reader__reviewbar-err">{review.error}</div>}
    </div>
  );
}

export function ArtifactReader({
  task,
  members,
  projectName,
  version,
  onBack,
  onSwitchVersion,
  review,
}: ArtifactReaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // HTML 产物:预览(沙箱 iframe)/ 源码(等宽块)切换;默认预览。
  const [htmlView, setHtmlView] = useState<"preview" | "source">("preview");
  const verRef = useRef<HTMLDivElement>(null);

  const resolved = resolveArtifact(task, members, version);

  // 版本菜单:点空白 / Esc 关(Esc 只关菜单,不冒泡到页面回图)
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (verRef.current && !verRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  if (!resolved) {
    return (
      <section className="ir-reader" aria-label="产物阅读器">
        <div className="ir-reader__topbar">
          <span className="ir-reader__brand">
            <BookIcon />
            产物阅读器
          </span>
          <span className="ir-reader__spacer" />
          <button type="button" className="ir-reader__pill ir-reader__pill--iris" onClick={onBack}>
            <BackToGraphIcon />
            回到图
          </button>
          <kbd className="ir-reader__esc">ESC</kbd>
        </div>
        <div className="ir-reader__empty">该任务暂无产物可阅读。</div>
      </section>
    );
  }

  const crumbs = readerBreadcrumb(projectName, resolved.taskTitle, resolved.artifactName);
  const footer = formatReaderFooter(resolved);
  const kind = sniffArtifactKind(resolved.content);

  return (
    <section className="ir-reader" aria-label="产物阅读器">
      <div className="ir-reader__topbar">
        <span className="ir-reader__brand">
          <BookIcon />
          产物阅读器
        </span>
        <span className="ir-reader__sep" aria-hidden="true">
          |
        </span>
        <nav className="ir-reader__crumb" aria-label="产物位置">
          {crumbs.map((seg, i) => {
            const last = i === crumbs.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && (
                  <span className="ir-reader__crumb-sep" aria-hidden="true">
                    <ChevronRight />
                  </span>
                )}
                <span
                  className={`ir-reader__crumb-seg${last ? " ir-reader__crumb-seg--last" : ""}`}
                  title={seg}
                >
                  {seg}
                </span>
              </Fragment>
            );
          })}
        </nav>

        {resolved.version != null && resolved.versions.length > 0 && (
          <div className="ir-reader__ver" ref={verRef}>
            <button
              type="button"
              className="ir-reader__ver-pill"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="切换产物版本"
            >
              v{resolved.version}
              <ChevronDown />
            </button>
            {menuOpen && (
              <div className="ir-reader__ver-menu" role="menu">
                {resolved.versions.map((v) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={v.version === resolved.version}
                    key={v.version}
                    className={`ir-reader__ver-item${
                      v.version === resolved.version ? " is-current" : ""
                    }`}
                    onClick={() => {
                      setMenuOpen(false);
                      if (v.version !== resolved.version) onSwitchVersion(v.version);
                    }}
                  >
                    v{v.version}
                    {v.version === resolved.version && <span className="ir-reader__ver-dot" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <span className="ir-reader__spacer" />

        {/* HTML 产物:预览 | 源码 切换(沙箱预览默认;源码=等宽未渲染) */}
        {kind === "html" && (
          <div className="ir-reader__htmltoggle" role="group" aria-label="HTML 视图切换">
            <button
              type="button"
              className={`ir-reader__htmltoggle-opt${htmlView === "preview" ? " is-on" : ""}`}
              aria-pressed={htmlView === "preview"}
              onClick={() => setHtmlView("preview")}
            >
              预览
            </button>
            <button
              type="button"
              className={`ir-reader__htmltoggle-opt${htmlView === "source" ? " is-on" : ""}`}
              aria-pressed={htmlView === "source"}
              onClick={() => setHtmlView("source")}
            >
              源码
            </button>
          </div>
        )}

        <button
          type="button"
          className="ir-reader__pill"
          onClick={() => downloadArtifactMd(resolved.artifactName, resolved.version, resolved.content)}
          title={kind === "html" ? "下载 .html" : "下载 .md"}
        >
          <DownloadIcon />
          下载
        </button>
        <button type="button" className="ir-reader__pill ir-reader__pill--iris" onClick={onBack}>
          <BackToGraphIcon />
          回到图
        </button>
        <kbd className="ir-reader__esc" title="按 ESC 返回工作图">
          ESC
        </kbd>
      </div>

      {kind === "html" ? (
        htmlView === "preview" ? (
          // 沙箱预览:sandbox="" 禁一切(无脚本/无表单/无同源),srcDoc 内联正文,白底铺满。
          <iframe
            className="ir-reader__htmlframe"
            sandbox=""
            srcDoc={resolved.content}
            title={`${resolved.artifactName} · 沙箱预览`}
          />
        ) : (
          <div className="ir-reader__scroll">
            <pre className="ir-reader__htmlsrc">{resolved.content}</pre>
          </div>
        )
      ) : (
        <div className="ir-reader__scroll">
          <article className="ir-reader__page">
            <div className="crew-reader">
              <CrewMarkdown source={resolved.content} />
            </div>
          </article>
        </div>
      )}

      {review && <ReviewBar review={review} />}

      <div className="ir-reader__footer">
        <span className="ir-reader__foot-meta">{footer}</span>
        <span className="ir-reader__foot-caption">
          {kind === "html"
            ? htmlView === "preview"
              ? "HTML · 沙箱预览（无脚本）"
              : "HTML · 源码（未渲染）"
            : "审计血统 · markdown 沿 Iris 答复排版"}
        </span>
      </div>
    </section>
  );
}

export default ArtifactReader;
