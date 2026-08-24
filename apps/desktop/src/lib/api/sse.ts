/** SSE 读取器:data: <json>\n\n 逐帧回调。与旧 agentStream 同算法(getReader/decode/split),但不做语义分发。 */
export async function readSse(
  response: Response,
  onFrame: (raw: Record<string, unknown>) => void,
): Promise<void> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `stream failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      onFrame(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
    }
  }
}
