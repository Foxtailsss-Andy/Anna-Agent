/**
 * download · 文件名净化 + 组名测试(Windows 非法字符 / 控制字符 / 版本段)
 * DOM 副作用(downloadArtifactMd)不在 node 单测覆盖,仅测纯文件名逻辑。
 */
import { describe, expect, it } from "vitest";

import { artifactFilename, sanitizeFilename } from "../download";

describe("sanitizeFilename(Windows 安全)", () => {
  it("剥非法字符 <>:\"/\\|?*", () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
  });
  it("剥控制字符(含制表/换行)", () => {
    expect(sanitizeFilename("产\t物\n名")).toBe("产物名");
  });
  it("折叠空白并去收尾点与空格", () => {
    expect(sanitizeFilename("  PRD   登录页  . ")).toBe("PRD 登录页");
  });
  it("保留中文与常规连字符", () => {
    expect(sanitizeFilename("PRD-登录页重设计")).toBe("PRD-登录页重设计");
  });
  it("全非法 → 兜底 artifact", () => {
    expect(sanitizeFilename('<>:"/\\|?*')).toBe("artifact");
    expect(sanitizeFilename("   ")).toBe("artifact");
    expect(sanitizeFilename("")).toBe("artifact");
  });
});

describe("artifactFilename(基-vN.{ext})", () => {
  it("有版本 → 附 -vN", () => {
    expect(artifactFilename("PRD-登录页重设计", 2)).toBe("PRD-登录页重设计-v2.md");
  });
  it("无版本(null/undefined/非有限数)→ 省版本段", () => {
    expect(artifactFilename("扁平产物", null)).toBe("扁平产物.md");
    expect(artifactFilename("扁平产物")).toBe("扁平产物.md");
    expect(artifactFilename("扁平产物", Number.NaN)).toBe("扁平产物.md");
  });
  it("非法名先净化再组名", () => {
    expect(artifactFilename('a/b:c', 1)).toBe("abc-v1.md");
  });
  it("ext=html → .html 扩展名", () => {
    expect(artifactFilename("落地页", 3, "html")).toBe("落地页-v3.html");
    expect(artifactFilename("落地页", null, "html")).toBe("落地页.html");
  });
  it("ext 缺省 = md(老调用方不变)", () => {
    expect(artifactFilename("扁平产物", 1)).toBe("扁平产物-v1.md");
  });
});
