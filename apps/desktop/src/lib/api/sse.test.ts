import { describe, expect, it } from "vitest";
import { readSse } from "./sse";

const stream = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
  );

describe("readSse", () => {
  it("跨 chunk 半帧拼接 + 一 chunk 多帧 + 忽略非 data 行", async () => {
    const got: unknown[] = [];
    await readSse(stream(['data: {"type":"a"}\n\ndata: {"ty', 'pe":"b"}\n\n: keepalive\n\ndata: {"type":"c"}\n\n']), (f) => got.push(f));
    expect(got.map((f) => (f as { type: string }).type)).toEqual(["a", "b", "c"]);
  });
  it("非 2xx / 无 body 抛错", async () => {
    await expect(readSse(new Response("boom", { status: 500 }), () => {})).rejects.toThrow();
  });
});
