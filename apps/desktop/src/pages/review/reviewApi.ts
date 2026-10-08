import { v2ApiUrl } from "../../lib/runtime";

export interface ReviewChannelEvent {
  id?: string;
  seq?: number;
  type?: string;
  [key: string]: unknown;
}

export interface ReviewCursor {
  streamId: string;
  seq: number;
}

export interface ChannelEventsResponse {
  events: ReviewChannelEvent[];
  nextCursor: ReviewCursor;
}

export interface TraceCursorResponse {
  document: Record<string, unknown>;
  cursors: ReviewCursor[];
  harnessState: Array<Record<string, unknown>>;
}

export const PRODUCT_HOST_REVIEW_UNAVAILABLE =
  "Review Inspector 读取的是 Review/Preview Host 的 v2 接口，当前桌面产品 Host 不提供这些接口。"
  + "要查看某次对话的执行过程，请在对话顶部点“执行过程”。";

async function v2Json<T>(path: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(v2ApiUrl(path), { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // The Product Host answers /v2/* with an explicit JSON code instead of the SPA document.
    if (response.status === 404 && text.includes("review_api_not_served_by_product_host")) {
      throw new Error(PRODUCT_HOST_REVIEW_UNAVAILABLE);
    }
    throw new Error(`Harness v2 API ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

function scopeHeaders(workspaceId: string, channelId: string): Record<string, string> {
  return {
    "X-Anna-Workspace-ID": workspaceId,
    "X-Anna-Channel-ID": channelId,
  };
}

function encodeScope(value: string): string {
  return encodeURIComponent(value);
}

export function getChannelEvents(
  workspaceId: string,
  channelId: string,
  streamId: string,
  afterSeq?: number,
): Promise<ChannelEventsResponse> {
  const query = new URLSearchParams({ streamId });
  if (afterSeq !== undefined) query.set("afterSeq", String(afterSeq));
  return v2Json<ChannelEventsResponse>(
    `/v2/channels/${encodeScope(workspaceId)}/${encodeScope(channelId)}/events?${query.toString()}`,
    scopeHeaders(workspaceId, channelId),
  );
}

export function getRunTraceCursor(
  runId: string,
  workspaceId: string,
  channelId: string,
  surface = "review",
): Promise<TraceCursorResponse> {
  const query = new URLSearchParams({ workspaceId, channelId, surface });
  return v2Json<TraceCursorResponse>(
    `/v2/runs/${encodeScope(runId)}/trace?${query.toString()}`,
    scopeHeaders(workspaceId, channelId),
  );
}
