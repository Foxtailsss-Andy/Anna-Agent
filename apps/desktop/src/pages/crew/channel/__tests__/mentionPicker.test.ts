import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MentionPicker } from "../MentionPicker";

describe("MentionPicker identity copy", () => {
  it("does not label Anna as a member account", () => {
    const html = renderToStaticMarkup(
      createElement(MentionPicker, {
        members: [
          {
            id: "anna",
            name: "Anna",
            role: "协调者",
            isAgent: false,
            isCoordinator: true,
          },
        ],
        query: "An",
        activeIndex: 0,
        onSelect: () => undefined,
        onHover: () => undefined,
      }),
    );
    expect(html).toContain('aria-label="选择协调者或成员"');
    expect(html).toContain("协作对象 · 过滤“An”");
    expect(html).toContain("协调");
  });
});
