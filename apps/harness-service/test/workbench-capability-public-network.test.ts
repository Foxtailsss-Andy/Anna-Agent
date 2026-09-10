import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server } from "node:http";
import type { Socket } from "node:net";

import { expect, test } from "vitest";

import { createPublicWebReader, type PublicWebAddress } from "../src/workbench-public-web";

test("public web reader extracts bounded HTML with source metadata", async () => {
  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html><head><title>Public Page</title><meta property=\"article:published_time\" content=\"2026-09-01\"></head><body><script>secret()</script><p>Hello &amp; public</p><p>Second section</p></body></html>"),
      sourceTruncated: false,
    }),
  });

  const result = await reader({
    url: "https://example.com/article",
    offset: 0,
    limit: 6,
  }, new AbortController().signal);

  expect(result).toEqual(expect.objectContaining({
    status: "succeeded",
    output: expect.objectContaining({
      url: "https://example.com/article",
      title: "Public Page",
      published_at: "2026-09-01",
      content: "Hello ",
      offset: 0,
      truncated: true,
      next_offset: 6,
      source_truncated: false,
      content_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      fetched_at: expect.any(String),
    }),
  }));
});

test("public web reader reports a missing title without discarding plain text", async () => {
  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("Plain text without a source title"),
      sourceTruncated: false,
    }),
  });

  await expect(reader({ url: "https://example.com/plain" }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({
    status: "succeeded",
    output: expect.objectContaining({
      title: null,
      source_missing: ["title"],
      content: "Plain text without a source title",
    }),
  }));
});

test("public web reader omits empty metadata without masking later source values", async () => {
  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html><head><title>  </title><meta property=\"article:published_time\" content=\"  \"><meta property=\"article:published_time\" content=\"2026-09-02\"></head><body>Body</body></html>"),
      sourceTruncated: false,
    }),
  });

  await expect(reader({ url: "https://example.com/metadata" }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({
    status: "succeeded",
    output: expect.objectContaining({
      title: null,
      source_missing: ["title"],
      published_at: "2026-09-02",
      content: "Body",
    }),
  }));
});

test("public web reader preserves a readable UTF-8 prefix when the source byte cap splits a character", async () => {
  const fullBody = Buffer.from("可读🙂", "utf8");
  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: fullBody.subarray(0, Buffer.byteLength("可读", "utf8") + 1),
      sourceTruncated: true,
    }),
  });

  await expect(reader({ url: "https://example.com/truncated-utf8" }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({
    status: "succeeded",
    output: expect.objectContaining({
      title: null,
      content: "可读",
      source_truncated: true,
    }),
  }));
});

test("public web reader preserves source truncation when no complete UTF-8 text remains", async () => {
  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("🙂", "utf8").subarray(0, 2),
      sourceTruncated: true,
    }),
  });

  await expect(reader({ url: "https://example.com/truncated-empty" }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_content_missing", source_truncated: true },
  });
});

test("public web reader still rejects malformed UTF-8 inside a truncated source", async () => {
  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from([0xc3, 0x28]),
      sourceTruncated: true,
    }),
  });

  await expect(reader({ url: "https://example.com/truncated-invalid" }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_parse_failed", source_truncated: true },
  });
});

test("public web reader rejects private, reserved, and mixed DNS answers before HTTP", async () => {
  const rejectedAddresses = [
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.2", family: 4 }],
    [{ address: "2001:db8::1", family: 6 }],
    [{ address: "::ffff:93.184.216.34", family: 6 }],
  ] as const;
  let transportCalls = 0;

  for (const addresses of rejectedAddresses) {
    const reader = createPublicWebReader({
      dnsLookup: async () => addresses,
      transport: async () => {
        transportCalls += 1;
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Buffer.from("<title>Unexpected</title><p>Unexpected</p>"),
          sourceTruncated: false,
        };
      },
    });
    await expect(reader({ url: "https://example.com/" }, new AbortController().signal)).resolves.toEqual({
      status: "failed",
      output: { reason: "web_read_destination_not_public" },
    });
  }

  expect(transportCalls).toBe(0);
});

test("public web reader checks IP literal destinations without consulting a permissive fixture", async () => {
  let dnsCalls = 0;
  let transportCalls = 0;
  const reader = createPublicWebReader({
    dnsLookup: async () => {
      dnsCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    transport: async () => {
      transportCalls += 1;
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<title>Unexpected</title><p>Unexpected</p>"),
        sourceTruncated: false,
      };
    },
  });

  await expect(reader({ url: "https://127.0.0.1/" }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_destination_not_public" },
  });
  await expect(reader({ url: "https://[::1]/" }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_destination_not_public" },
  });
  expect(dnsCalls).toBe(0);
  expect(transportCalls).toBe(0);
});

test("public web reader aborts a timed out transport instead of leaving it running", async () => {
  let transportAborted = false;
  const reader = createPublicWebReader({
    timeoutMs: 10,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (_request, signal) => await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });

  await expect(reader({ url: "https://example.com/" }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_network_unavailable" },
  });
  expect(transportAborted).toBe(true);
});

test("public web reader rejects unsupported encoding, charset, and out of range offsets", async () => {
  const cases = [
    {
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      reason: "web_read_unsupported_content_encoding",
    },
    {
      headers: { "content-type": "text/html; charset=iso-8859-1" },
      reason: "web_read_unsupported_charset",
    },
    {
      headers: { "content-type": "text/html" },
      body: Buffer.from([0xc3, 0x28]),
      reason: "web_read_parse_failed",
    },
  ] as const;
  for (const candidate of cases) {
    const reader = createPublicWebReader({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({
        status: 200,
        headers: candidate.headers,
        body: candidate.body ?? Buffer.from("<title>Unsupported</title><p>body</p>"),
        sourceTruncated: false,
      }),
    });
    await expect(reader({ url: "https://example.com/unsupported" }, new AbortController().signal)).resolves.toEqual({
      status: "failed",
      output: { reason: candidate.reason },
    });
  }

  const reader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("bounded body"),
      sourceTruncated: false,
    }),
  });
  await expect(reader({
    url: "https://example.com/offset",
    offset: 99,
    limit: 10,
  }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_offset_out_of_range" },
  });

  const missingBodyReader = createPublicWebReader({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html><head><title>Metadata only</title></head><body></body></html>"),
      sourceTruncated: false,
    }),
  });
  await expect(missingBodyReader({ url: "https://example.com/missing-body" }, new AbortController().signal)).resolves.toEqual({
    status: "failed",
    output: { reason: "web_read_content_missing" },
  });
});

test("public web reader rechecks every redirect destination before the next transport hop", async () => {
  const dnsHosts: string[] = [];
  const transportUrls: string[] = [];
  const reader = createPublicWebReader({
    dnsLookup: async (hostname) => {
      dnsHosts.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
    transport: async (request) => {
      transportUrls.push(request.url);
      if (transportUrls.length === 1) {
        return {
          status: 302,
          headers: { location: "https://redirect.example/next" },
          body: Buffer.from(""),
          sourceTruncated: false,
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("redirected body"),
        sourceTruncated: false,
      };
    },
  });

  await expect(reader({ url: "https://example.com/start" }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({
    status: "succeeded",
    output: expect.objectContaining({
      url: "https://redirect.example/next",
      content: "redirected body",
    }),
  }));
  expect(dnsHosts).toEqual(["example.com", "redirect.example"]);
  expect(transportUrls).toEqual([
    "https://example.com/start",
    "https://redirect.example/next",
  ]);
});

test("reader default transport bounds a real IncomingMessage stream before buffering", async () => {
  let serverClosed = false;
  let responseClosed = false;
  const peerClosed = deferred();
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.on("close", () => {
      responseClosed = true;
      peerClosed.resolve();
    });
    response.write(Buffer.alloc(32, "x"));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("close", () => {
    serverClosed = true;
  });
  await listenLocal(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("reader transport server did not bind");
  const nativeObservation: NativeRequestObservation = {
    lookupCalls: 0,
    approvedAddresses: [],
    requestOptions: [],
    incomingMessages: 0,
  };
  try {
    const reader = createPublicWebReader({
      maxSourceBytes: 8,
      timeoutMs: 250,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      nativeRequestFactory: localNativeRequestFactory(address.port, nativeObservation),
    });
    await expect(reader({ url: "http://public.example/stream", limit: 120 }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({
      status: "succeeded",
      output: expect.objectContaining({
        content: "xxxxxxxx",
        source_truncated: true,
      }),
    }));
    await withDeadline(peerClosed.promise, 1_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeLocal(server);
  }
  expect(serverClosed).toBe(true);
  expect(responseClosed).toBe(true);
  expect(nativeObservation.lookupCalls).toBeGreaterThan(0);
  expect(nativeObservation.approvedAddresses.length).toBeGreaterThan(0);
  expect(nativeObservation.approvedAddresses.every((item) => item.address === "93.184.216.34" && item.family === 4)).toBe(true);
  expect(nativeObservation.requestOptions.every((options) => options.auth === undefined)).toBe(true);
  expect(nativeObservation.requestOptions.every((options) =>
    !Object.keys(options.headers ?? {}).some((name) => ["authorization", "proxy-authorization"].includes(name.toLowerCase()))
  )).toBe(true);
  expect(nativeObservation.requestOptions.every((options) =>
    options.headers !== undefined
      && Object.entries(options.headers).some(([name, value]) =>
        name.toLowerCase() === "accept-encoding" && String(value).toLowerCase() === "identity"
      )
  )).toBe(true);
  expect(nativeObservation.incomingMessages).toBeGreaterThan(0);
});

test("reader default transport terminates a held I/O on cancellation and total timeout", async () => {
  let requestCount = 0;
  const firstRequest = deferred();
  const firstResponseClosed = deferred();
  const secondRequest = deferred();
  const secondResponseClosed = deferred();
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.on("close", () => firstResponseClosed.resolve());
      response.write("held", () => firstRequest.resolve());
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.on("close", () => secondResponseClosed.resolve());
    secondRequest.resolve();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenLocal(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("reader transport server did not bind");
  try {
    const reader = createPublicWebReader({
      timeoutMs: 500,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      nativeRequestFactory: () => (options, callback) => httpRequest({
        ...options,
        hostname: "127.0.0.1",
        port: address.port,
        lookup: (_hostname, _lookupOptions, lookupCallback) => {
          lookupCallback(null, "127.0.0.1", 4);
        },
      }, callback),
    });
    const cancellation = new AbortController();
    const cancelled = reader({ url: "http://public.example/cancel" }, cancellation.signal);
    await withDeadline(firstRequest.promise, 1_000);
    cancellation.abort();
    await expect(cancelled).resolves.toEqual({
      status: "failed",
      output: { reason: "cancelled" },
    });
    await withDeadline(firstResponseClosed.promise, 1_000);

    const timeoutReader = createPublicWebReader({
      timeoutMs: 20,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      nativeRequestFactory: localNativeRequestFactory(address.port),
    });
    const timedOut = timeoutReader({ url: "http://public.example/timeout" }, new AbortController().signal);
    await withDeadline(secondRequest.promise, 1_000);
    await expect(timedOut).resolves.toEqual({
      status: "failed",
      output: { reason: "web_read_network_unavailable" },
    });
    await withDeadline(secondResponseClosed.promise, 1_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeLocal(server);
  }
});

async function listenLocal(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeLocal(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

interface NativeRequestObservation {
  lookupCalls: number;
  approvedAddresses: PublicWebAddress[];
  requestOptions: RequestOptions[];
  incomingMessages: number;
}

function localNativeRequestFactory(
  port: number,
  observation?: NativeRequestObservation,
) {
  return () => (options: RequestOptions, callback: (response: IncomingMessage) => void) => httpRequest({
    ...options,
    hostname: "fixture.public.example",
    port,
    lookup: (hostname, lookupOptions, lookupCallback) => {
      if (options.lookup === undefined) throw new Error("native lookup callback missing");
      if (observation !== undefined) {
        observation.lookupCalls += 1;
        observation.requestOptions.push(options);
      }
      options.lookup(hostname, { ...lookupOptions, all: true }, (error, resolved) => {
        if (error !== null || !Array.isArray(resolved)) {
          lookupCallback(error ?? new Error("public lookup must return all addresses"), "", 0);
          return;
        }
        if (observation !== undefined) {
          observation.approvedAddresses.push(...resolved.map((item) => ({
            address: item.address,
            family: item.family as 4 | 6,
          })));
        }
        const localAddresses = [{ address: "127.0.0.1", family: 4 }] as const;
        if (lookupOptions.all) {
          lookupCallback(null, localAddresses);
        } else {
          lookupCallback(null, localAddresses[0].address, localAddresses[0].family);
        }
      });
    },
  }, (response) => {
    if (observation !== undefined) observation.incomingMessages += 1;
    callback(response);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`deadline exceeded after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
