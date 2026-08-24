/**
 * 拟人陪伴层 · 全局开关(《R8 设置》Task 3)
 *
 * 纪律同 theme.ts:纯读写与 React 供给分离,便于 node-env vitest 直测。
 *   normalizePersona —— 纯映射(saved → boolean),默认 true;仅 "0"/"false" 视为关。
 *   loadPersona / savePersona —— 把 localStorage 藏在带默认值的参数后,测试注入内存替身。
 *   PersonaProvider / usePersona —— 全局唯一真相源;R4 ChatPage / R5 副驾 / R6 报销页
 *     的 LoopCard `persona` prop 统一从此处取(R4 曾用本地缺省,本切片接管)。
 *
 * 关闭后:LoopCard 只隐藏衬线拟人标签,真值(✓/✕、耗时、L3 原文)一律不受影响。
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const KEY = "anna.persona";

/** 最小存储契约(localStorage 的子集) */
export interface PersonaStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const realStore = (): PersonaStore | null =>
  typeof localStorage !== "undefined" ? localStorage : null;

/** 纯映射:默认开;仅显式 "0"/"false" 关闭,其余(含 null / 脏值)回落 true */
export function normalizePersona(saved: string | null): boolean {
  return saved === "0" || saved === "false" ? false : true;
}

/** 读取拟人层状态;无 storage 时回落默认(true) */
export function loadPersona(store: PersonaStore | null = realStore()): boolean {
  return normalizePersona(store?.getItem(KEY) ?? null);
}

/** 持久化拟人层状态;无 storage 时静默 no-op */
export function savePersona(
  value: boolean,
  store: PersonaStore | null = realStore(),
): void {
  store?.setItem(KEY, value ? "1" : "0");
}

export interface PersonaContextValue {
  persona: boolean;
  setPersona: (value: boolean) => void;
}

const PersonaContext = createContext<PersonaContextValue>({
  persona: true,
  setPersona: () => {},
});

/** 壳外(单测)无 Provider 时回落默认开,不抛错。 */
export const usePersona = (): PersonaContextValue => useContext(PersonaContext);

/** 全局供给:启动读持久化,setPersona 同步写盘 + 广播给所有 LoopCard。 */
export function PersonaProvider({ children }: { children: ReactNode }) {
  const [persona, setPersonaState] = useState<boolean>(() => loadPersona());

  // 跨标签页 / 外部改动(如另一窗口切换)时同步,防陈旧。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPersonaState(loadPersona());
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }
    return undefined;
  }, []);

  const setPersona = useCallback((value: boolean) => {
    setPersonaState(value);
    savePersona(value);
  }, []);

  return createElement(PersonaContext.Provider, { value: { persona, setPersona } }, children);
}
