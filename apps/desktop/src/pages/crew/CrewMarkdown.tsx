/**
 * CrewMarkdown · R-F1 复用件:Crew 内嵌产物正文 / Anna 回答的 Iris markdown 渲染。
 *
 * react-markdown + remark-gfm(表格 / 删除线 / 任务列表 / 自动链接 / 脚注)。
 * - 表格包进横向滚动容器(.crew-md__tablewrap,可键盘聚焦):窄栏(Crew 卡 ~234px)里列保持可读
 *   最小宽度,容器横滚,不再把多列挤成一字一行(review C2a);
 * - ```chart 代码块(JSON,见 chartSpec)→ CrewChart 内联 SVG + 数据表;非法 → 原代码块 +「图表数据无效」;
 * - 链接新窗打开(target=_blank rel=noreferrer noopener),不在应用窗口内导航。
 * 样式走组件级 `.crew-md`(CrewMarkdown.css),双主题 token。
 *
 * 安全:未挂 rehype-raw,原始 HTML 不渲染;URL 走 react-markdown 默认 urlTransform。零捏造:空源渲染 null。
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CrewChart } from "./CrewChart";
import { parseChartSpec } from "./chartSpec";
import "./CrewMarkdown.css";

/** 只读遍历 hast 节点所需的最小形状(避免直接依赖传递包 @types/hast)。 */
interface HastLike {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** `<pre><code class="language-chart">` → 代码文本;否则 null。 */
function chartSource(pre: HastLike | undefined): string | null {
  const code = pre?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const cls = code?.properties?.className;
  const classes = Array.isArray(cls) ? cls : typeof cls === "string" ? cls.split(/\s+/) : [];
  return classes.includes("language-chart") ? hastText(code) : null;
}

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  table: ({ node: _node, children, ...rest }) => (
    <div className="crew-md__tablewrap" tabIndex={0} role="region" aria-label="表格（可横向滚动）">
      <table className="crew-md__table" {...rest}>
        {children}
      </table>
    </div>
  ),
  a: ({ node: _node, children, ...rest }) => (
    <a {...rest} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  pre: ({ node, children, ...rest }) => {
    const source = chartSource(node as unknown as HastLike | undefined);
    if (source === null) return <pre {...rest}>{children}</pre>;
    const spec = parseChartSpec(source);
    if (spec) return <CrewChart spec={spec} />;
    return (
      <div className="crew-md__chart-invalid">
        <pre {...rest}>{children}</pre>
        <div className="crew-md__chart-note" role="note">
          图表数据无效
        </div>
      </div>
    );
  },
};

export interface CrewMarkdownProps {
  source: string;
  /** 附加类(容器上),便于宿主微调 */
  className?: string;
}

export function CrewMarkdown({ source, className }: CrewMarkdownProps) {
  if (!(source ?? "").trim()) return null;
  return (
    <div className={`crew-md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

export default CrewMarkdown;
