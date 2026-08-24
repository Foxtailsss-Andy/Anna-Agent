/**
 * artifactChip · R1 附件 chip 家族纯函数(零捏造:一切派生自真产物元数据)
 *
 * - deriveArtifactChip:任务 → chip 数据(名/扩展/版本/字数/正文);无真产物 → null(无 chip)。
 * - formatArtifactMeta:「.md · v2 · 2,005 字」(version 缺省则不显)。
 * - groupThousands:千分位(2005 → "2,005"),node 无 locale 依赖。
 * - extractUrls / isExternalUrl:say 正文中的外链(http/https)侦测,供链接卡变体。
 *
 * 字数 = 正文字符数(content.length)—— 真产物的真实元数据,标签「N 字」。
 */

import type { CrewTask } from "../crewModel";

export interface ArtifactChipData {
  taskId: string;
  title: string;
  /** 文件扩展(当前产物均 markdown);无独立文件名数据时以 .md 呈现 */
  ext: string;
  /** 最新版本号;仅有扁平 artifact(无版本历史)时为 null → 版本段不渲染 */
  version: number | null;
  /** 正文字符数(真实元数据) */
  charCount: number;
  content: string;
}

/**
 * 任务的最新产物 → chip 数据。优先版本历史(取最大 version 的非空正文),
 * 退化到扁平 `artifact`;两者皆无 → null(零捏造:无产物无 chip)。
 */
export function deriveArtifactChip(task: CrewTask | undefined | null): ArtifactChipData | null {
  if (!task) return null;
  const versions = [...(task.artifact_versions ?? [])].sort((a, b) => b.version - a.version);
  let version: number | null = null;
  let content = "";
  if (versions.length > 0 && (versions[0].content ?? "").trim() !== "") {
    version = versions[0].version;
    content = versions[0].content;
  } else if ((task.artifact ?? "").trim() !== "") {
    content = task.artifact as string;
    version = null;
  } else {
    return null;
  }
  const title = (task.title ?? "").trim() || "产物";
  // 扩展名跟随内容嗅探(HTML 产物标 .html,不再一律 .md 误导——真机 HTML 上传案)
  const ext = sniffArtifactKind(content) === "html" ? "html" : "md";
  return { taskId: task.id, title, ext, version, charCount: content.length, content };
}

/** 千分位分组(2005 → "2,005");负数保号,截断小数。node 无 locale。 */
export function groupThousands(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = Math.abs(Math.trunc(n)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** chip 元行:「.md · v2 · 2,005 字」(version 为 null 时略去版本段)。 */
export function formatArtifactMeta(
  chip: Pick<ArtifactChipData, "ext" | "version" | "charCount">,
): string {
  const parts = [`.${chip.ext}`];
  if (chip.version != null) parts.push(`v${chip.version}`);
  parts.push(`${groupThousands(chip.charCount)} 字`);
  return parts.join(" · ");
}

/* ---------------- chip 动作可见集(R1 定位 + 收敛纯派生) ---------------- */

/** chip 动作标识:展开 / 全幅阅读 / 定位到节点 / 下载 / 更多(溢出触发)。 */
export type ChipAction = "expand" | "read" | "locate" | "download" | "more";

/**
 * 平铺(始终可见)动作集,按渲染序。
 * - 全幅阅读(read)恒为主动作;定位(locate)仅当宿主提供 onLocate,且**收敛态仍平铺**
 *   ——对齐修复:定位绝不进溢出菜单(用户需从 chip 一眼定位到图上是哪个文档)。
 * - 宽态:展开 → 全幅阅读 →[定位]→ 下载;
 * - 窄态(328 收敛):全幅阅读 →[定位]→ 更多(展开/下载入溢出)。
 */
export function visibleChipActions(opts: { collapsed: boolean; hasLocate: boolean }): ChipAction[] {
  const out: ChipAction[] = [];
  if (!opts.collapsed) out.push("expand");
  out.push("read");
  if (opts.hasLocate) out.push("locate");
  if (!opts.collapsed) out.push("download");
  if (opts.collapsed) out.push("more");
  return out;
}

/** 溢出菜单(…)内动作:仅收敛态承载 展开 + 下载;全幅阅读/定位永不入此。 */
export function overflowChipActions(collapsed: boolean): ChipAction[] {
  return collapsed ? ["expand", "download"] : [];
}

/* ---------------- 外链侦测(链接卡变体) ---------------- */

// ASCII URL 字符集(RFC 3986 常用子集)—— 天然不吞 CJK 正文/全角标点。
const URL_GLOBAL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

/** 去掉 URL 尾随的句读标点(逗号/句点/分号等,极少是链接实体一部分)。 */
function trimTrailingPunct(u: string): string {
  return u.replace(/[.,;:!?)\]}>]+$/, "");
}

/** 整串本身即一个 http/https URL(trim 后无空白)。 */
export function isExternalUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** 正文中的外链(http/https),去重、按出现序;无则空数组。 */
export function extractUrls(body: string): string[] {
  if (!body) return [];
  const found = body.match(URL_GLOBAL_RE);
  if (!found) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const u = trimTrailingPunct(raw);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/** URL → 精简展示串(去协议,长则省略中段)。 */
export function prettyUrl(url: string, max = 42): string {
  const stripped = url.replace(/^https?:\/\//i, "");
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1)}…`;
}

/* ---------------- 产物正文类型嗅探(HTML 产物可读) ---------------- */

export type ArtifactKind = "html" | "markdown";

/**
 * 产物正文嗅探:去掉前导空白后,开头是 `<!doctype html` 或 `<html …>` → html,
 * 否则 markdown。纯函数(仅看开头,markdown 正文中途出现 <html 不误判)。
 * 供 chip 展开 / 阅读器 / 下载三处统一决定 html 走沙箱预览+源码、md 走渲染。
 */
export function sniffArtifactKind(content: string): ArtifactKind {
  return /^(<!doctype\s+html|<html[\s>])/i.test((content ?? "").trimStart())
    ? "html"
    : "markdown";
}
