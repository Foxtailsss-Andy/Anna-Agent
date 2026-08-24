/**
 * artifactChip · R1 附件 chip 纯函数测试(零捏造:元数据全来自真产物)
 * 覆盖:chip 派生(版本历史/扁平退化/无产物→null)· 千分位 · 元行格式 · 外链侦测。
 */
import { describe, expect, it } from "vitest";

import type { CrewTask } from "../../crewModel";
import {
  deriveArtifactChip,
  extractUrls,
  formatArtifactMeta,
  groupThousands,
  isExternalUrl,
  overflowChipActions,
  prettyUrl,
  sniffArtifactKind,
  visibleChipActions,
} from "../artifactChip";

function task(partial: Partial<CrewTask> & { id: string }): CrewTask {
  return {
    project_id: "p1",
    key: partial.id,
    title: partial.id,
    status: "todo",
    role_required: "产品",
    ...partial,
  } as CrewTask;
}

describe("deriveArtifactChip(任务 → chip;无产物无 chip)", () => {
  it("取最大版本的非空正文,字数=字符数", () => {
    const t = task({
      id: "prd",
      title: "PRD-登录页重设计",
      artifact_versions: [
        { version: 1, content: "一二三", submitted_at: "a" },
        { version: 2, content: "一二三四五", submitted_at: "b" },
      ],
    });
    const chip = deriveArtifactChip(t);
    expect(chip).not.toBeNull();
    expect(chip!.title).toBe("PRD-登录页重设计");
    expect(chip!.version).toBe(2);
    expect(chip!.charCount).toBe(5);
    expect(chip!.ext).toBe("md");
    expect(chip!.taskId).toBe("prd");
  });

  it("HTML 产物 → ext 标 html(不再一律 .md 误导)", () => {
    const t = task({
      id: "tech",
      title: "技术预研",
      artifact_versions: [{ version: 1, content: "<!DOCTYPE html><html><body>x</body></html>", submitted_at: "a" }],
    });
    expect(deriveArtifactChip(t)!.ext).toBe("html");
  });

  it("乱序版本取最大 version", () => {
    const t = task({
      id: "x",
      artifact_versions: [
        { version: 3, content: "vvv", submitted_at: "c" },
        { version: 1, content: "v", submitted_at: "a" },
      ],
    });
    expect(deriveArtifactChip(t)!.version).toBe(3);
    expect(deriveArtifactChip(t)!.charCount).toBe(3);
  });

  it("无版本历史但有扁平 artifact → 退化 version=null", () => {
    const t = task({ id: "x", artifact: "扁平正文", artifact_versions: [] });
    const chip = deriveArtifactChip(t)!;
    expect(chip.version).toBeNull();
    expect(chip.charCount).toBe(4);
  });

  it("最新版正文空白 → 退化到扁平 artifact", () => {
    const t = task({
      id: "x",
      artifact: "兜底",
      artifact_versions: [{ version: 1, content: "   ", submitted_at: "a" }],
    });
    const chip = deriveArtifactChip(t)!;
    expect(chip.version).toBeNull();
    expect(chip.content).toBe("兜底");
  });

  it("完全无产物 → null(无 chip)", () => {
    expect(deriveArtifactChip(task({ id: "x" }))).toBeNull();
    expect(deriveArtifactChip(task({ id: "x", artifact: "  " }))).toBeNull();
    expect(deriveArtifactChip(undefined)).toBeNull();
    expect(deriveArtifactChip(null)).toBeNull();
  });

  it("空标题回退「产物」", () => {
    const t = task({ id: "x", title: "  ", artifact: "正文" });
    expect(deriveArtifactChip(t)!.title).toBe("产物");
  });
});

describe("groupThousands / formatArtifactMeta", () => {
  it("千分位", () => {
    expect(groupThousands(2005)).toBe("2,005");
    expect(groupThousands(999)).toBe("999");
    expect(groupThousands(1234567)).toBe("1,234,567");
    expect(groupThousands(0)).toBe("0");
  });
  it("元行:有版本", () => {
    expect(formatArtifactMeta({ ext: "md", version: 2, charCount: 2005 })).toBe(".md · v2 · 2,005 字");
  });
  it("元行:无版本 → 略去版本段", () => {
    expect(formatArtifactMeta({ ext: "md", version: null, charCount: 320 })).toBe(".md · 320 字");
  });
});

describe("visibleChipActions / overflowChipActions(chip 动作可见集)", () => {
  it("宽态无定位:展开 · 全幅阅读 · 下载", () => {
    expect(visibleChipActions({ collapsed: false, hasLocate: false })).toEqual([
      "expand",
      "read",
      "download",
    ]);
  });
  it("宽态有定位:定位排在下载前", () => {
    expect(visibleChipActions({ collapsed: false, hasLocate: true })).toEqual([
      "expand",
      "read",
      "locate",
      "download",
    ]);
  });
  it("窄态(328 收敛)无定位:全幅阅读 · 更多(展开/下载入溢出)", () => {
    expect(visibleChipActions({ collapsed: true, hasLocate: false })).toEqual(["read", "more"]);
  });
  it("窄态有定位:定位仍平铺,绝不进溢出(对齐修复)", () => {
    const actions = visibleChipActions({ collapsed: true, hasLocate: true });
    expect(actions).toEqual(["read", "locate", "more"]);
    expect(actions).toContain("locate");
    expect(overflowChipActions(true)).not.toContain("locate");
  });
  it("溢出菜单:仅收敛态承载 展开 + 下载;全幅阅读/定位永不入", () => {
    expect(overflowChipActions(true)).toEqual(["expand", "download"]);
    expect(overflowChipActions(false)).toEqual([]);
    expect(overflowChipActions(true)).not.toContain("read");
    expect(overflowChipActions(true)).not.toContain("locate");
  });
});

describe("sniffArtifactKind · HTML 产物嗅探", () => {
  it("<!doctype html> → html(大小写不敏感)", () => {
    expect(sniffArtifactKind("<!doctype html><body>x</body>")).toBe("html");
    expect(sniffArtifactKind("<!DOCTYPE HTML>\n<html></html>")).toBe("html");
    expect(sniffArtifactKind("<!doctype   html>")).toBe("html"); // 多空白
  });
  it("<html …> / <html> 起手 → html", () => {
    expect(sniffArtifactKind('<html lang="en"><head></head></html>')).toBe("html");
    expect(sniffArtifactKind("<html>\n  <body/>\n</html>")).toBe("html");
  });
  it("前导空白/换行不影响判定", () => {
    expect(sniffArtifactKind("   \n\t<!doctype html>")).toBe("html");
    expect(sniffArtifactKind("\n\n<html></html>")).toBe("html");
  });
  it("markdown 正文 → markdown", () => {
    expect(sniffArtifactKind("# 标题\n\n正文段落")).toBe("markdown");
    expect(sniffArtifactKind("- 列表项\n- 另一项")).toBe("markdown");
    expect(sniffArtifactKind("")).toBe("markdown");
  });
  it("仅正文中途出现 <html 不误判(只看开头)", () => {
    expect(sniffArtifactKind("说明:代码里写 <html> 标签")).toBe("markdown");
  });
  it("<htmlish> 这类非 html 标签不误判(需 <html 后接空白或 >)", () => {
    expect(sniffArtifactKind("<htmlike>x</htmlike>")).toBe("markdown");
  });
});

describe("外链侦测(http/https)", () => {
  it("isExternalUrl 仅认 http/https 整串", () => {
    expect(isExternalUrl("https://figma.com/file/aX9")).toBe(true);
    expect(isExternalUrl("  http://example.com/x  ")).toBe(true);
    expect(isExternalUrl("ftp://host/x")).toBe(false);
    expect(isExternalUrl("说点什么")).toBe(false);
    expect(isExternalUrl("见 https://a.com 链接")).toBe(false); // 非整串
  });
  it("extractUrls 抽正文外链、去重按序", () => {
    expect(extractUrls("看 https://a.com/x 和 https://b.com,还有 https://a.com/x")).toEqual([
      "https://a.com/x",
      "https://b.com",
    ]);
    expect(extractUrls("没有链接")).toEqual([]);
    expect(extractUrls("")).toEqual([]);
  });
  it("extractUrls 不吞中文标点尾巴", () => {
    expect(extractUrls("参见 https://a.com/file。")).toEqual(["https://a.com/file"]);
  });
  it("prettyUrl 去协议、超长省略", () => {
    expect(prettyUrl("https://figma.com/file/aX9")).toBe("figma.com/file/aX9");
    expect(prettyUrl("https://example.com/" + "a".repeat(60), 20).length).toBeLessThanOrEqual(20);
  });
});
