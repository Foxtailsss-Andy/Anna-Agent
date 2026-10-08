import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { Sidebar } from "../../components/shell/Sidebar";
import { ReviewChannelInspector } from "./ReviewChannelInspector";

afterEach(() => vi.unstubAllGlobals());

it("directs product users to the conversation trace instead of offering unsupported review calls", () => {
  vi.stubGlobal("window", { __ANNA_RUNTIME__: { mode: "product", apiBase: "http://localhost:18975" } });
  const html = renderToStaticMarkup(createElement(ReviewChannelInspector, { workspaceId: "ws1" }));
  expect(html).toContain("执行过程");
  expect(html).toContain("当前桌面");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("读取 Channel 事件");
});

it("preserves the Inspector when a Review Host is explicitly configured", () => {
  vi.stubGlobal("window", { __ANNA_RUNTIME__: { v2ApiBase: "http://localhost:18976" } });
  const html = renderToStaticMarkup(createElement(ReviewChannelInspector, { workspaceId: "ws1" }));
  expect(html).toContain("读取 Channel 事件");
  expect(html).toContain("读取 Run Trace");
});

it.each([false, true])("shows the Review navigation only for a configured Review Host (collapsed=%s)", (collapsed) => {
  const render = () => renderToStaticMarkup(createElement(Sidebar, {
    section: "home", coworkItem: "hiker", crewItem: "projects", crewProjectId: null,
    segment: "home", homeMode: "chat", collapsed, identity: null,
    onNavigate: () => undefined, onToggleCollapsed: () => undefined, onLogout: () => undefined,
  }));
  vi.stubGlobal("window", { __ANNA_RUNTIME__: { mode: "product" } });
  expect(render()).not.toContain("Review Inspector");
  vi.stubGlobal("window", { __ANNA_RUNTIME__: { v2ApiBase: "http://localhost:18976" } });
  expect(render()).toContain("Review Inspector");
});
