/**
 * CrewMarkdown · R-F1 复用件:Crew 内嵌产物正文的 Iris markdown 渲染。
 *
 * react-markdown(CommonMark;标题/列表/代码/引用/强调/链接)+ 自带 GFM 管道表格兜底
 * (本 worktree 未装 remark-gfm —— splitMarkdownSegments 把表格块切出来结构化渲染,
 *  单元格内联仍走 react-markdown)。样式走组件级 `.crew-md`(CrewMarkdown.css),
 * 双主题 token,沿 chat 答复排版语汇。
 *
 * 安全:未挂 rehype-raw,原始 HTML 不渲染(react-markdown 默认);零捏造:空源渲染 null。
 */

import ReactMarkdown, { type Components } from "react-markdown";

import { splitMarkdownSegments, type ColAlign, type ParsedTable } from "./markdownBlocks";
import "./CrewMarkdown.css";

/** 表格单元格内只渲染内联(去掉 react-markdown 的段落包裹)。 */
const INLINE_COMPONENTS: Components = {
  p: ({ children }) => <>{children}</>,
};

function alignStyle(a: ColAlign): React.CSSProperties | undefined {
  return a ? { textAlign: a } : undefined;
}

function Cell({ text }: { text: string }) {
  const value = text.trim();
  if (!value) return null;
  return <ReactMarkdown components={INLINE_COMPONENTS}>{value}</ReactMarkdown>;
}

function MarkdownTable({ table }: { table: ParsedTable }) {
  return (
    <div className="crew-md__tablewrap">
      <table className="crew-md__table">
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} style={alignStyle(table.align[i] ?? null)}>
                <Cell text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={alignStyle(table.align[c] ?? null)}>
                  <Cell text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface CrewMarkdownProps {
  source: string;
  /** 附加类(容器上),便于宿主微调 */
  className?: string;
}

export function CrewMarkdown({ source, className }: CrewMarkdownProps) {
  if (!(source ?? "").trim()) return null;
  const segments = splitMarkdownSegments(source);
  return (
    <div className={`crew-md${className ? ` ${className}` : ""}`}>
      {segments.map((seg, i) =>
        seg.kind === "table" ? (
          <MarkdownTable key={i} table={seg.table} />
        ) : (
          <ReactMarkdown key={i}>{seg.text}</ReactMarkdown>
        ),
      )}
    </div>
  );
}

export default CrewMarkdown;
