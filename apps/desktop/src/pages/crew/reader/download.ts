/**
 * download · 产物另存为文件(阅读器顶栏 + 频道 chip 下载共用)
 *
 * - sanitizeFilename:剥 Windows 非法字符(`<>:"/\|?*` + 控制字符)+ 收尾点/空格,空 → 兜底。
 * - artifactFilename:`产物名-vN.{ext}`(无版本时省 `-vN`;ext 缺省 md,html 产物得 .html)。
 * - downloadArtifactMd:按正文嗅探 html/markdown → 正确扩展名 + MIME;a[download] 触发下载
 *   (DOM 副作用,SSR/node 无 document 时静默)。纯文件名逻辑抽出便于 node 环境单测。
 */

import { sniffArtifactKind } from "../channel/artifactChip";

// Windows 保留字符(路径分隔与通配);控制字符另用码点过滤(免 no-control-regex)。
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*]/g;

/** 剥控制字符(0x00–0x1F + DEL 0x7F),不依赖控制字面正则。 */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

/** 产物名 → 安全文件名基:剥非法/控制字符、折叠空白、去收尾点与空格;空则兜底。 */
export function sanitizeFilename(name: string, fallback = "artifact"): string {
  const cleaned = stripControl(name ?? "")
    .replace(WINDOWS_FORBIDDEN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, ""); // Windows 不许以点或空格结尾
  return cleaned || fallback;
}

/** 完整文件名:`基-vN.{ext}`(version 非有限数 → 省版本段;ext 缺省 md,仅 md/html)。 */
export function artifactFilename(
  name: string,
  version?: number | null,
  ext: "md" | "html" = "md",
): string {
  const base = sanitizeFilename(name);
  const v = typeof version === "number" && Number.isFinite(version) ? `-v${version}` : "";
  const safeExt = ext === "html" ? "html" : "md";
  return `${base}${v}.${safeExt}`;
}

/**
 * 触发浏览器下载(Blob + 隐藏 a);无 DOM(node/SSR)时静默 no-op。
 * 按正文嗅探 html/markdown → html 产物存 `.html`（text/html）,其余 `.md`（text/markdown）,
 * 老调用方无需改动(扩展名/ MIME 由内容决定)。
 */
export function downloadArtifactMd(
  name: string,
  version: number | null | undefined,
  content: string,
): void {
  if (typeof document === "undefined") return;
  const isHtml = sniffArtifactKind(content) === "html";
  const filename = artifactFilename(name, version, isHtml ? "html" : "md");
  const blob = new Blob([content ?? ""], {
    type: isHtml ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
