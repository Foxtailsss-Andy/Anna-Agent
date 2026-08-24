/**
 * MiniMarkdown · 极简 Markdown 渲染(零依赖兜底)
 *
 * 生产环境请优先用工程已有的 react-markdown:
 *   <ArtifactSandbox renderMarkdown={(src) => <ReactMarkdown>{src}</ReactMarkdown>} …>
 * 本组件只为「包内零 npm 依赖也能预览」提供兜底,覆盖:
 * 标题(#/##/###)、粗体、行内代码、``` 代码块、- 列表、[链接](url)、段落。
 */

import { Fragment } from 'react';

function inline(text: string, keyBase: string): React.ReactNode[] {
  // 切分:`code` / **bold** / [text](url)
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) out.push(<a key={key} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a>);
      else out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MiniMarkdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // 跳过闭合 ```
      blocks.push(<pre key={key++}><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    if (/^###\s/.test(line)) { blocks.push(<h3 key={key++}>{inline(line.slice(4), `h${key}`)}</h3>); i++; continue; }
    if (/^##\s/.test(line)) { blocks.push(<h2 key={key++}>{inline(line.slice(3), `h${key}`)}</h2>); i++; continue; }
    if (/^#\s/.test(line)) { blocks.push(<h1 key={key++}>{inline(line.slice(2), `h${key}`)}</h1>); i++; continue; }
    if (/^-\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s/.test(lines[i])) items.push(lines[i++].slice(2));
      blocks.push(
        <ul key={key++}>
          {items.map((item, j) => <li key={j}>{inline(item, `li${key}-${j}`)}</li>)}
        </ul>,
      );
      continue;
    }
    if (line.trim() === '') { i++; continue; }

    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|-\s|```)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(buf.join(' '), `p${key}`)}</p>);
  }

  return <Fragment>{blocks}</Fragment>;
}

export default MiniMarkdown;
