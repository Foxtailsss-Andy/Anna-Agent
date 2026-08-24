/**
 * 运行时重启入口 · 封装 window.__ANNA_RUNTIME__.restartRuntime(《R8 设置》)
 *
 * 桌面(Electron preload 注入)可真重启运行时;浏览器 dev 环境无注入。
 * 诚实红线:能力缺失时 isRestartAvailable() 为 false,UI 据此禁用按钮 + 「桌面环境可用」
 * 说明;restartRuntime() 在缺席时抛错而非静默假成功。
 */

/** 当前环境是否具备真重启能力(Electron 注入了 restartRuntime)。 */
export function isRestartAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.__ANNA_RUNTIME__?.restartRuntime === "function"
  );
}

/** 触发运行时重启;非 Electron 环境抛错(禁伪装成功)。 */
export async function restartRuntime(): Promise<void> {
  const fn =
    typeof window !== "undefined" ? window.__ANNA_RUNTIME__?.restartRuntime : undefined;
  if (typeof fn !== "function") {
    throw new Error("当前非桌面运行时，无法重启（桌面环境可用）");
  }
  await fn();
}
