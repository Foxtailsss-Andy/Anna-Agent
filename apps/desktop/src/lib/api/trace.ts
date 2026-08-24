import { apiJson } from './client';
import { getToken } from './identity';

export interface TraceSpanDto {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  /** agent|turn|inference|tool,未来还有 invoke_agent 子代理等——刻意开成 string,
   *  渲染端 KIND_TAG 有 fallback(三级下钻四护栏之「subagent 留位」,前向兼容) */
  kind: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, unknown>;
  events: { name: string; time: string; attributes: Record<string, unknown> }[];
}

export interface TraceDto {
  trace_id: string;
  surface: string;
  spans: TraceSpanDto[];
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getRunTrace(runId: string): Promise<TraceDto> {
  return apiJson<TraceDto>(`/api/chat/runs/${runId}/trace`, { headers: authHeaders() });
}
