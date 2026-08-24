/**
 * RightPanel · 右侧按需滑出面板(Home 合并轮 M4 · V2 H-11/H-12)
 *
 * 470px 瓷玻(blur 24)· 挤压式(阅读列同步收窄,无遮罩):开 240ms / 关 320ms
 * cubic-bezier(.2,0,0,1)。默认不存在;入口 = 页头产物/文件 chip + 流内锚点(绝不自动弹开,N5)。
 * Chat 形态 = 画布:产物 tab 胶囊组 + 复制/下载 + 沙箱 iframe(无脚本/无外联)+ mono 底注。
 * Create 形态 = 文件树(真产出文件,mono 11)+ 全站唯一深色代码面(两色高亮)+ 只读底注。
 */

import { useMemo } from "react";
import "./RightPanel.css";

export interface PanelArtifact {
  id: string;
  title: string;
  /** "page" → 沙箱 iframe;其余 → 文内预览 */
  kind: string;
  content: string;
}

export interface PanelFile {
  name: string;
  /** mono 预览全文(只读) */
  preview: string;
}

export interface RightPanelProps {
  open: boolean;
  /** chat=画布;create=文件树+代码 */
  form: "canvas" | "files";
  runId: string;
  artifacts: PanelArtifact[];
  activeId: string;
  onActivate: (id: string) => void;
  files: PanelFile[];
  activeFile: string;
  onActivateFile: (name: string) => void;
  onClose: () => void;
  /** 产物内容尚不可读时的真话说明(如 running 期) */
  pendingNote?: string;
}

const isPage = (kind: string) => kind === "page";

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

function downloadText(name: string, text: string, mime = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function RightPanel(props: RightPanelProps) {
  const { open, form, artifacts, files } = props;
  const active = useMemo(
    () => artifacts.find((a) => a.id === props.activeId) ?? artifacts[0] ?? null,
    [artifacts, props.activeId],
  );
  const activeFile = useMemo(
    () => files.find((f) => f.name === props.activeFile) ?? files[0] ?? null,
    [files, props.activeFile],
  );
  const idx = active ? artifacts.indexOf(active) + 1 : 0;

  return (
    <div className={`irp${open ? " irp--open" : ""}`} aria-hidden={open ? undefined : true}>
      <div className="irp__inner">
        {form === "canvas" ? (
          <>
            <div className="irp__head">
              <div className="irp__tabs">
                {artifacts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`irp__tab${active?.id === a.id ? " irp__tab--on" : ""}`}
                    onClick={() => props.onActivate(a.id)}
                  >
                    ◇ {a.title}
                  </button>
                ))}
              </div>
              {active && active.content && (
                <span className="irp__acts">
                  <button type="button" className="irp__act" onClick={() => copyText(active.content)}>复制</button>
                  <span className="irp__act-dot">·</span>
                  <button
                    type="button"
                    className="irp__act"
                    onClick={() => downloadText(
                      `${active.title}${isPage(active.kind) ? ".html" : ".md"}`,
                      active.content,
                      isPage(active.kind) ? "text/html" : "text/markdown",
                    )}
                  >
                    下载
                  </button>
                </span>
              )}
              <button type="button" className="irp__close" aria-label="关闭面板" onClick={props.onClose}>✕</button>
            </div>
            <div className="irp__stage">
              {active ? (
                active.content ? (
                  isPage(active.kind) ? (
                    /* 沙箱纪律:无脚本 / 无外联(不给 allow-scripts / allow-same-origin) */
                    <iframe className="irp__frame" title={active.title} sandbox="" srcDoc={active.content} />
                  ) : (
                    <pre className="irp__doc">{active.content}</pre>
                  )
                ) : (
                  <div className="irp__note">{props.pendingNote ?? "产物内容将在办妥后可读"}</div>
                )
              ) : (
                <div className="irp__note">还没有产物；产物生成后在此呈上</div>
              )}
            </div>
            <div className="irp__foot">
              沙箱预览 · 无脚本、无外联{props.runId ? ` · run ${props.runId}` : ""}{active ? ` 产物 ${idx}/${artifacts.length}` : ""}
            </div>
          </>
        ) : (
          <>
            <div className="irp__head">
              <div className="irp__tabs">
                {activeFile && <span className="irp__tab irp__tab--on">◈ {activeFile.name}</span>}
              </div>
              {props.runId && <span className="irp__runid">run {props.runId}</span>}
              <button type="button" className="irp__close" aria-label="关闭面板" onClick={props.onClose}>✕</button>
            </div>
            <div className="irp__files">
              <div className="irp__tree">
                <div className="irp__tree-label">文件 · {files.length}</div>
                {files.length === 0 ? (
                  <div className="irp__note">还没有产出文件</div>
                ) : (
                  files.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      className={`irp__file${activeFile?.name === f.name ? " irp__file--on" : ""}`}
                      onClick={() => props.onActivateFile(f.name)}
                    >
                      {f.name}
                    </button>
                  ))
                )}
              </div>
              <div className="irp__code">
                {activeFile ? (
                  activeFile.preview.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("#")
                          ? "irp__code-h"
                          : line.trim() === "---"
                            ? "irp__code-dim"
                            : undefined
                      }
                    >
                      {line || " "}
                    </div>
                  ))
                ) : (
                  <div className="irp__code-dim">// 暂无内容</div>
                )}
              </div>
            </div>
            <div className="irp__foot">只读预览 · 注册后进入产物中心</div>
          </>
        )}
      </div>
    </div>
  );
}

export default RightPanel;
