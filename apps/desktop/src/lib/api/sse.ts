/** SSE 读取器:支持 data-only 与带 event 名的 JSON 帧,但不做语义分发。 */
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
  const dispatch = (frame: string) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (data === "") return;
    onFrame(JSON.parse(data) as Record<string, unknown>);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim() !== "") dispatch(buffer);
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) dispatch(part);
  }
}
