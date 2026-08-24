/** navModel · 三段导航模型(段归属 · 保活 key 编解码)—— Crew 为第三段 */
import { describe, expect, it } from "vitest";

import { parseKey, sectionKey, segmentOfSection } from "../../../components/shell/navModel";

describe("segmentOfSection(section → 所属侧栏段)", () => {
  it("home/cowork/crew 各归自身段", () => {
    expect(segmentOfSection("home", "cowork")).toBe("home");
    expect(segmentOfSection("cowork", "home")).toBe("cowork");
    expect(segmentOfSection("crew", "home")).toBe("crew");
  });

  it("段外区(hub/settings/agents)不改变当前段", () => {
    expect(segmentOfSection("hub", "crew")).toBe("crew");
    expect(segmentOfSection("settings", "cowork")).toBe("cowork");
    expect(segmentOfSection("agents", "crew")).toBe("crew");
  });
});

describe("sectionKey(保活 key 编码)", () => {
  it("cowork 带子项,crew 带子项,其余=section", () => {
    expect(sectionKey("cowork", "hiker", "projects")).toBe("cowork:hiker");
    expect(sectionKey("crew", "hiker", "inbox")).toBe("crew:inbox");
    expect(sectionKey("crew", "hiker", "project")).toBe("crew:project");
    expect(sectionKey("home", "hiker", "projects")).toBe("home");
  });
});

describe("parseKey(保活 key 解码,round-trip)", () => {
  it("crew/cowork/普通 key 解回 section + 子项", () => {
    expect(parseKey("crew:team")).toMatchObject({ section: "crew", crewItem: "team" });
    expect(parseKey("cowork:hiker")).toMatchObject({ section: "cowork", coworkItem: "hiker" });
    expect(parseKey("home")).toMatchObject({ section: "home" });
  });

  it("与 sectionKey 互逆", () => {
    for (const [section, cw, crew] of [
      ["crew", "hiker", "inbox"],
      ["crew", "hiker", "project"],
      ["cowork", "reimbursement", "projects"],
      ["hub", "hiker", "projects"],
    ] as const) {
      const key = sectionKey(section, cw, crew);
      const parsed = parseKey(key);
      expect(parsed.section).toBe(section);
      if (section === "cowork") expect(parsed.coworkItem).toBe(cw);
      if (section === "crew") expect(parsed.crewItem).toBe(crew);
    }
  });
});
