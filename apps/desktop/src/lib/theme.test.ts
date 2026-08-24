import { describe, expect, it } from "vitest";

import { applyTheme, loadTheme, normalizeTheme, type ThemeDoc, type ThemeStore } from "./theme";

function memStore(): ThemeStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

function recordingDoc(): ThemeDoc & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    documentElement: {
      setAttribute: (name, value) => {
        attrs[name] = value;
      },
    },
  };
}

describe("normalizeTheme", () => {
  it("maps 'dark' to dark and everything else to light", () => {
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme(null)).toBe("light");
    expect(normalizeTheme("garbage")).toBe("light");
  });
});

describe("applyTheme / loadTheme round-trip", () => {
  it("persists the applied mode and reads it back", () => {
    const store = memStore();
    applyTheme("dark", recordingDoc(), store);
    expect(loadTheme(store)).toBe("dark");
    applyTheme("light", recordingDoc(), store);
    expect(loadTheme(store)).toBe("light");
  });

  it("writes the data-theme attribute on the document element", () => {
    const doc = recordingDoc();
    applyTheme("dark", doc, memStore());
    expect(doc.attrs["data-theme"]).toBe("dark");
  });

  it("defaults to light when storage is empty", () => {
    expect(loadTheme(memStore())).toBe("light");
  });

  it("is a safe no-op when doc and store are absent", () => {
    expect(() => applyTheme("dark", null, null)).not.toThrow();
    expect(loadTheme(null)).toBe("light");
  });
});
