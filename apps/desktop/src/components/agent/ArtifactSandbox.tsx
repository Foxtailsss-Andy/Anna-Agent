/**
 * ArtifactSandbox · 沙箱画布(右栏挤压式滑出,五面共用)
 * 交互对齐常规 Coding Agent(Claude Desktop):
 *   - 点产物卡 / 运行完成 → 自动展开(open 由宿主控制,组件负责 240ms 挤压动画)
 *   - 产物 tab 切换(激活 = iris tinted);文件夹树可开合(coding agent 式)
 *   - 在线预览:HTML(沙箱 iframe)/ Markdown·Doc / 代码(mono+行号)/ 纯文本
 * 沙箱纪律(诚实):iframe sandbox 空白名单 = 无脚本 / 无外联,底注如实标注。
 * Markdown:生产传 renderMarkdown={(src) => <ReactMarkdown …>};缺省用零依赖 MiniMarkdown 兜底。
 */

import { useMemo, useState } from 'react';
import { MiniMarkdown } from '../anna/MiniMarkdown';
import { IrisPetal } from '../anna/IrisPetal';
import './ArtifactSandbox.css';

export type SandboxFileKind = 'html' | 'markdown' | 'code' | 'text';

export interface SandboxFile {
  id: string;
  /** 路径式名称,如 "extract/extract_images.py";含 "/" 即归入文件夹树 */
  path: string;
  kind: SandboxFileKind;
  /** 产物内容原文(真实数据;沙箱内不改写) */
  content: string;
  language?: string;
}

export interface ArtifactSandboxProps {
  open: boolean;
  files: SandboxFile[];
  activeId?: string;
  onActivate: (id: string) => void;
  onClose?: () => void;
  /** 面板宽度;默认 480(挤压式:宿主主列被压缩) */
  width?: number;
  /** 生产环境注入 react-markdown;缺省 MiniMarkdown */
  renderMarkdown?: (src: string) => React.ReactNode;
}

/* ---------------- 文件夹树 ---------------- */

interface TreeNode {
  name: string;
  children: TreeNode[];
  file?: SandboxFile;
}

function buildTree(files: SandboxFile[]): TreeNode {
  const root: TreeNode = { name: '', children: [] };
  for (const file of files) {
    const segs = file.path.split('/');
    let node = root;
    segs.forEach((seg, i) => {
      const isLeaf = i === segs.length - 1;
      let child = node.children.find((c) => c.name === seg && (isLeaf ? !!c.file : !c.file));
      if (!child) {
        child = { name: seg, children: [], file: isLeaf ? file : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  return root;
}

const KIND_TAG: Record<SandboxFileKind, string> = { html: 'html', markdown: 'md', code: 'code', text: 'txt' };

function TreeRows({
  node, depth, activeId, onActivate, openDirs, toggleDir, prefix,
}: {
  node: TreeNode;
  depth: number;
  activeId?: string;
  onActivate: (id: string) => void;
  openDirs: Set<string>;
  toggleDir: (key: string) => void;
  prefix: string;
}) {
  return (
    <>
      {node.children.map((child) => {
        const key = `${prefix}/${child.name}`;
        if (child.file) {
          const f = child.file;
          return (
            <button
              key={key}
              type="button"
              className={`sbx__tree-row${activeId === f.id ? ' sbx__tree-row--on' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onActivate(f.id)}
            >
              <span className="sbx__tree-kind">{f.language ?? KIND_TAG[f.kind]}</span>
              <span className="sbx__tree-name">{child.name}</span>
            </button>
          );
        }
        const opened = openDirs.has(key);
        return (
          <div key={key}>
            <button
              type="button"
              className="sbx__tree-row"
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={opened}
              onClick={() => toggleDir(key)}
            >
              <span className="sbx__tree-caret">{opened ? '▾' : '▸'}</span>
              <span className="sbx__tree-name">{child.name}</span>
            </button>
            {opened && (
              <TreeRows
                node={child} depth={depth + 1} activeId={activeId}
                onActivate={onActivate} openDirs={openDirs} toggleDir={toggleDir} prefix={key}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- 预览面 ---------------- */

function FileView({ file, renderMarkdown }: { file: SandboxFile; renderMarkdown?: (src: string) => React.ReactNode }) {
  switch (file.kind) {
    case 'html':
      // sandbox="":无脚本 / 无外联 / 无同源 —— 与底注一致
      return <iframe className="sbx__frame" title={file.path} sandbox="" srcDoc={file.content} />;
    case 'markdown':
      return (
        <div className="sbx__scroll">
          <div className="sbx__md">{renderMarkdown ? renderMarkdown(file.content) : <MiniMarkdown source={file.content} />}</div>
        </div>
      );
    case 'code':
      return (
        <pre className="sbx__code">
          {file.content.split('\n').map((line, i) => (
            <span key={i} className="sbx__code-line">{line || ' '}</span>
          ))}
        </pre>
      );
    case 'text':
      return <div className="sbx__scroll"><div className="sbx__text">{file.content}</div></div>;
  }
}

/* ---------------- 主组件 ---------------- */

export function ArtifactSandbox(props: ArtifactSandboxProps) {
  const { open, files, activeId, onActivate, onClose, width = 480, renderMarkdown } = props;
  const hasFolders = useMemo(() => files.some((f) => f.path.includes('/')), [files]);
  const [treeOn, setTreeOn] = useState(false);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => {
    // 默认展开全部一级文件夹
    const s = new Set<string>();
    for (const f of files) if (f.path.includes('/')) s.add(`/${f.path.split('/')[0]}`);
    return s;
  });
  const tree = useMemo(() => buildTree(files), [files]);
  const active = files.find((f) => f.id === activeId) ?? files[0];

  const toggleDir = (key: string) =>
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const basename = (p: string) => p.split('/').pop() ?? p;

  return (
    <div className={`sbx-slot${open ? ' is-open' : ''}`} style={{ width: open ? width : 0 }} aria-hidden={!open}>
      <div className="sbx" style={{ width }}>
        <div className="sbx__head">
          <span className="sbx__title">画布</span>
          <span className="sbx__badge">SANDBOX</span>
          {hasFolders && (
            <button
              type="button"
              className={`sbx__head-btn${treeOn ? ' sbx__head-btn--on' : ''}`}
              aria-pressed={treeOn}
              onClick={() => setTreeOn((v) => !v)}
            >
              文件夹
            </button>
          )}
          <span className="sbx__save" title="即将上线">存入产物中心</span>
          <button type="button" className="sbx__close" aria-label="关闭画布" onClick={onClose}>✕</button>
        </div>

        {files.length === 0 ? (
          <div className="sbx__empty">
            <IrisPetal size={26} />
            <span>产物将在此呈上</span>
            <span className="sbx__empty-sub">运行完成后自动打开<br />支持网页、文档、代码</span>
          </div>
        ) : (
          <>
            <div className="sbx__tabs" role="tablist">
              {files.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={active?.id === f.id}
                  className={`sbx__tab${active?.id === f.id ? ' sbx__tab--on' : ''}`}
                  onClick={() => onActivate(f.id)}
                >
                  {basename(f.path)}
                </button>
              ))}
            </div>
            <div className="sbx__main">
              {treeOn && (
                <div className="sbx__tree">
                  <TreeRows
                    node={tree} depth={0} activeId={active?.id}
                    onActivate={onActivate} openDirs={openDirs} toggleDir={toggleDir} prefix=""
                  />
                </div>
              )}
              <div className="sbx__view">
                {active && <FileView file={active} renderMarkdown={renderMarkdown} />}
              </div>
            </div>
          </>
        )}

        <div className="sbx__foot">沙箱预览 · 无脚本、无外联{files.length ? ` · ${files.length} 个产物` : ''}</div>
      </div>
    </div>
  );
}

export default ArtifactSandbox;
