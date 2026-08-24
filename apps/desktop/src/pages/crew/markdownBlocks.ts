/**
 * markdownBlocks · R-F1 纯函数:从 markdown 源里剥出 GFM 管道表格块。
 *
 * 本仓 react-markdown 未接 remark-gfm(该插件在本 worktree 未安装 —— 见 CrewMarkdown
 * 偏差登记),CommonMark 不解析管道表格。故由此纯函数把表格块切出来结构化渲染,
 * 其余文本仍交回 react-markdown。零依赖、可测、不造表(非法表格 → null)。
 *
 *  - splitMarkdownSegments:源 → 有序段(markdown 文本段 / 表格段)。
 *  - parsePipeTable:候选行块 → {表头, 列对齐, 行};非合法表格 → null。
 */

export type ColAlign = "left" | "center" | "right" | null;

export interface ParsedTable {
  headers: string[];
  /** 每列对齐(来自分隔行 :--/:-:/--: );默认 null */
  align: ColAlign[];
  rows: string[][];
}

export type MarkdownSegment =
  | { kind: "markdown"; text: string }
  | { kind: "table"; table: ParsedTable };

/** 以未转义的 `|` 切分一行为单元格;去掉外围管道产生的空壳,`\|` 还原为字面 `|`。 */
function splitCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 分隔行:每格 `:?-+:?`(至少一横杠),至少一格。 */
function isDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitCells(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

function alignOf(cell: string): ColAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** 一行看起来像表格行:含 `|` 且非空。 */
function looksLikeRow(line: string): boolean {
  return line.trim() !== "" && line.includes("|");
}

/**
 * 候选块(≥2 行:表头 + 分隔 + 0..n 体行)→ ParsedTable。
 * 表头与分隔列数须一致,否则 null(不造表)。体行按表头列数补齐/截断。
 */
export function parsePipeTable(block: string[]): ParsedTable | null {
  if (block.length < 2) return null;
  if (!looksLikeRow(block[0]) || !isDelimiterRow(block[1])) return null;

  const headers = splitCells(block[0]);
  const delim = splitCells(block[1]);
  if (headers.length === 0 || headers.length !== delim.length) return null;

  const align = delim.map(alignOf);
  const rows: string[][] = [];
  for (let i = 2; i < block.length; i++) {
    if (!looksLikeRow(block[i])) break;
    const cells = splitCells(block[i]);
    const norm: string[] = [];
    for (let c = 0; c < headers.length; c++) norm.push(cells[c] ?? "");
    rows.push(norm);
  }
  return { headers, align, rows };
}

/**
 * 源 → 有序段。扫描:当第 i 行像表格行且第 i+1 行是列数匹配的分隔行 →
 * 收敛该表格块(连续 like-row 直到空行/非行),其余累积为 markdown 段。
 */
export function splitMarkdownSegments(source: string): MarkdownSegment[] {
  const lines = (source ?? "").split(/\r?\n/);
  const segments: MarkdownSegment[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join("\n");
    if (text.trim() !== "") segments.push({ kind: "markdown", text });
    buf = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;

    if (
      looksLikeRow(line) &&
      next != null &&
      isDelimiterRow(next) &&
      splitCells(line).length === splitCells(next).length
    ) {
      const block: string[] = [line, next];
      let j = i + 2;
      while (j < lines.length && looksLikeRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      const table = parsePipeTable(block);
      if (table) {
        flush();
        segments.push({ kind: "table", table });
        i = j;
        continue;
      }
    }
    buf.push(line);
    i++;
  }
  flush();
  return segments;
}
