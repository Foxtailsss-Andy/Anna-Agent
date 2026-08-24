/**
 * Anna · 运行时 API base
 * Electron 主进程注入 window.__ANNA_RUNTIME__.apiBase(随机端口),
 * 兜底 VITE_ANNA_API_BASE。请求层一律从这里读,不写死 localhost。
 */

declare global {
  interface Window {
    __ANNA_RUNTIME__?: {
      apiBase?: string;
      v2ApiBase?: string;
      harnessV2ApiBase?: string;
      /** Electron 主进程重启运行时(preload 注入);浏览器 dev 环境缺席 */
      restartRuntime?: () => Promise<unknown>;
      /** Electron 原生选文件夹(工作空间,M2);浏览器 dev 环境缺席 → 路径输入回退 */
      pickFolder?: () => Promise<string | null>;
    };
  }
}

export function apiBase(): string {
  const injected = typeof window !== 'undefined' ? window.__ANNA_RUNTIME__?.apiBase : undefined;
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ANNA_API_BASE;
  const base = injected ?? env ?? '';
  return base.replace(/\/$/, '');
}

export function v2ApiBase(): string {
  const injected = typeof window !== "undefined"
    ? window.__ANNA_RUNTIME__?.v2ApiBase ?? window.__ANNA_RUNTIME__?.harnessV2ApiBase
    : undefined;
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ANNA_V2_API_BASE;
  const base = injected ?? env ?? "";
  return base.replace(/\/$/, "");
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function v2ApiUrl(path: string): string {
  return `${v2ApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}
