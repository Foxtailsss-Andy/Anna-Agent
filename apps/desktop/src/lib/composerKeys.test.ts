/**
 * composerKeys(S-E)· 全局 Enter 发送键映射
 *
 * 覆盖 HomeComposer(Chat/Create)与 AgentComposer(Cowork 问 Anna)共用的同一契约:
 * 两处 composer 的 keydown 均只做事件面适配后调用 handleComposerEnter,
 * 故此处对纯函数的断言即等价于对两组件发送惯例的断言。
 */
import { describe, expect, it, vi } from "vitest";

import { handleComposerEnter } from "./composerKeys";

function signal(
  over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {},
) {
  const preventDefault = vi.fn();
  return {
    e: {
      key: over.key ?? "Enter",
      shiftKey: over.shiftKey ?? false,
      isComposing: over.isComposing ?? false,
      preventDefault,
    },
    preventDefault,
  };
}

describe("handleComposerEnter", () => {
  it("纯 Enter(有文本 · 未运行 · 未组词)→ 发送并阻止默认换行", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = signal();
    const consumed = handleComposerEnter(e, { running: false, hasText: true, onSend });
    expect(consumed).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter → 不发送(换行,放行 textarea 默认)", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = signal({ shiftKey: true });
    const consumed = handleComposerEnter(e, { running: false, hasText: true, onSend });
    expect(consumed).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("IME 组词中的 Enter → 完全放行(不发送、不拦默认)", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = signal({ isComposing: true });
    const consumed = handleComposerEnter(e, { running: false, hasText: true, onSend });
    expect(consumed).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Ctrl/⌘+Enter → 仍发送(兼容肌肉记忆;ctrl/meta 不改变判定)", () => {
    // Ctrl/⌘+Enter 与纯 Enter 判定一致:只要是 Enter 且未按 Shift、未组词、有文本、未运行即发送。
    const onSend = vi.fn();
    const { e } = signal(); // shiftKey=false 即代表 Ctrl/⌘+Enter 的发送路径
    expect(handleComposerEnter(e, { running: false, hasText: true, onSend })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("文本为空(trim 后无内容)→ Enter 不发送", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = signal();
    const consumed = handleComposerEnter(e, { running: false, hasText: false, onSend });
    expect(consumed).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("运行中且不支持插话 → Enter 不发送(沿既有守卫)", () => {
    const onSend = vi.fn();
    const { e } = signal();
    expect(handleComposerEnter(e, { running: true, hasText: true, onSend })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  /* --- J3 插话:运行中的 Enter 改道为「补充指示」,不是新 run --- */

  it("运行中且支持插话 → Enter 走插话,绝不发新 run", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    const { e, preventDefault } = signal();
    const consumed = handleComposerEnter(e, {
      running: true,
      hasText: true,
      onSend,
      onInterject,
    });
    expect(consumed).toBe(true);
    expect(onInterject).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("未运行时即使支持插话 → Enter 仍是正常发送(插话只在运行中存在)", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    const { e } = signal();
    expect(
      handleComposerEnter(e, { running: false, hasText: true, onSend, onInterject }),
    ).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onInterject).not.toHaveBeenCalled();
  });

  it("运行中的空文本 → 不插话(不发空指示)", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    const { e, preventDefault } = signal();
    expect(
      handleComposerEnter(e, { running: true, hasText: false, onSend, onInterject }),
    ).toBe(false);
    expect(onInterject).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("运行中的 Shift+Enter → 仍换行(插话不夺走换行键)", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    const { e } = signal({ shiftKey: true });
    expect(
      handleComposerEnter(e, { running: true, hasText: true, onSend, onInterject }),
    ).toBe(false);
    expect(onInterject).not.toHaveBeenCalled();
  });

  it("运行中的 IME 组词 Enter → 完全放行(交输入法确认)", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    const { e } = signal({ isComposing: true });
    expect(
      handleComposerEnter(e, { running: true, hasText: true, onSend, onInterject }),
    ).toBe(false);
    expect(onInterject).not.toHaveBeenCalled();
  });

  it("非 Enter 键 → 放行(不发送、不拦默认)", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = signal({ key: "a" });
    expect(handleComposerEnter(e, { running: false, hasText: true, onSend })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Shift+Enter 组合优先于 Ctrl/⌘ 语义 → 仍换行不发送", () => {
    const onSend = vi.fn();
    const { e } = signal({ shiftKey: true });
    expect(handleComposerEnter(e, { running: false, hasText: true, onSend })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });
});
