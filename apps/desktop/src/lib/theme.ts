/**
 * 主题工具 · <html data-theme> + localStorage 持久化(《R3 外壳》Task 1)
 *
 * 纯逻辑与副作用分离,便于 node-env vitest 直测:
 *   normalizeTheme —— 纯映射(saved → light|dark),测试直接钉。
 *   applyTheme / loadTheme —— 把 document/localStorage 藏在带默认值的参数后,
 *     生产不传参走真实全局;测试注入内存替身即可 round-trip。
 * R8「外观」卡复用 applyTheme/loadTheme。
 */

export type ThemeMode = "light" | "dark";

const KEY = "anna.theme";

/** 最小存储契约(localStorage 的子集) */
export interface ThemeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 最小文档契约(document 的子集) */
export interface ThemeDoc {
  documentElement: { setAttribute(name: string, value: string): void };
}

const realStore = (): ThemeStore | null =>
  typeof localStorage !== "undefined" ? localStorage : null;

const realDoc = (): ThemeDoc | null =>
  typeof document !== "undefined" ? document : null;

/** 纯映射:仅 "dark" 视为深色,其余(含 null / 脏值)一律回落浅色 */
export function normalizeTheme(saved: string | null): ThemeMode {
  return saved === "dark" ? "dark" : "light";
}

/** 落主题:写 data-theme 属性 + 持久化;无 document/storage 时静默 no-op */
export function applyTheme(
  mode: ThemeMode,
  doc: ThemeDoc | null = realDoc(),
  store: ThemeStore | null = realStore(),
): void {
  doc?.documentElement.setAttribute("data-theme", mode);
  store?.setItem(KEY, mode);
}

/** 读主题:从持久化取,归一化后返回 */
export function loadTheme(store: ThemeStore | null = realStore()): ThemeMode {
  return normalizeTheme(store?.getItem(KEY) ?? null);
}
