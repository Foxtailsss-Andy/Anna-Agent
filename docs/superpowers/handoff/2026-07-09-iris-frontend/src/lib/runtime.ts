/**
 * Anna · 运行时 API base
 * Electron 主进程注入 window.__ANNA_RUNTIME__.apiBase(随机端口),
 * 兜底 VITE_ANNA_API_BASE。请求层一律从这里读,不写死 localhost。
 */

declare global {
  interface Window {
    __ANNA_RUNTIME__?: { apiBase?: string };
  }
}

export function apiBase(): string {
  const injected = typeof window !== 'undefined' ? window.__ANNA_RUNTIME__?.apiBase : undefined;
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ANNA_API_BASE;
  const base = injected ?? env ?? '';
  return base.replace(/\/$/, '');
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
}
