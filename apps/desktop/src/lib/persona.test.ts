import { describe, expect, it } from "vitest";

import {
  loadPersona,
  normalizePersona,
  savePersona,
  type PersonaStore,
} from "./persona";

function memStore(): PersonaStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("normalizePersona", () => {
  it("defaults to true for null / unknown, only explicit off maps to false", () => {
    expect(normalizePersona(null)).toBe(true);
    expect(normalizePersona("1")).toBe(true);
    expect(normalizePersona("true")).toBe(true);
    expect(normalizePersona("garbage")).toBe(true);
    expect(normalizePersona("0")).toBe(false);
    expect(normalizePersona("false")).toBe(false);
  });
});

describe("savePersona / loadPersona round-trip", () => {
  it("persists the applied value and reads it back", () => {
    const store = memStore();
    savePersona(false, store);
    expect(loadPersona(store)).toBe(false);
    savePersona(true, store);
    expect(loadPersona(store)).toBe(true);
  });

  it("defaults to true when storage is empty", () => {
    expect(loadPersona(memStore())).toBe(true);
  });

  it("is a safe no-op when store is absent", () => {
    expect(() => savePersona(false, null)).not.toThrow();
    expect(loadPersona(null)).toBe(true);
  });
});
