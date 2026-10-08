#!/usr/bin/env node
// Deterministic local MCP fixture server (protocol revision 2025-06-18) used to
// validate the Anna Host MCP client. It is NOT part of the Anna product runtime
// and never returns business data; every result is derived from the request.
//
// Modes:
//   node server.mjs [options]                 stdio (newline-delimited JSON-RPC)
//   node server.mjs --http <port> [options]   Streamable HTTP on 127.0.0.1:<port>/mcp
//
// Options:
//   --notes-dir <dir>       directory used by write_note (required for that tool to succeed)
//   --require-auth <token>  HTTP only: require "Authorization: Bearer <token>"
//   Test hooks (off by default):
//   --exit-on <method>      exit(3) when a request with this JSON-RPC method arrives
//   --env-tool              add read-only tool env_report (returns this process's environment)
//   --extra-tools           add Echo (name collision), bad_schema, array_schema and big {bytes}
//   --stderr-bytes <n>      write n filler bytes and a marker line to stderr at startup
//   --never-initialize      never answer initialize (start-up timeout tests)
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"];
const LATEST_VERSION = "2025-06-18";
const PAGE_SIZE = 2;
const MAX_SLOW_MS = 60_000;
const MAX_BIG_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

const options = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    http: undefined,
    notesDir: undefined,
    requireAuth: undefined,
    exitOn: undefined,
    envTool: false,
    extraTools: false,
    stderrBytes: 0,
    neverInitialize: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) fatal(`missing value for ${flag}`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--http": {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 0 || port > 65_535) fatal("invalid --http port");
        parsed.http = port;
        break;
      }
      case "--notes-dir": parsed.notesDir = resolve(value()); break;
      case "--require-auth": parsed.requireAuth = value(); break;
      case "--exit-on": parsed.exitOn = value(); break;
      case "--env-tool": parsed.envTool = true; break;
      case "--extra-tools": parsed.extraTools = true; break;
      case "--stderr-bytes": parsed.stderrBytes = Math.max(0, Math.trunc(Number(value())) || 0); break;
      case "--never-initialize": parsed.neverInitialize = true; break;
      default: fatal(`unknown option ${flag}`);
    }
  }
  return parsed;
}

function fatal(message) {
  process.stderr.write(`fixture: ${message}\n`);
  process.exit(2);
}

function log(message) {
  process.stderr.write(`fixture: ${message}\n`);
}

// ---------------------------------------------------------------- tools

const objectSchema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });

function toolDefinitions() {
  const tools = [
    {
      name: "echo",
      description: "Return the given text unchanged.",
      inputSchema: objectSchema({ text: { type: "string" } }, ["text"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "add",
      description: "Add two numbers; returns the sum as text and structuredContent.",
      inputSchema: objectSchema({ a: { type: "number" }, b: { type: "number" } }, ["a", "b"]),
      outputSchema: objectSchema({ sum: { type: "number" } }, ["sum"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_note",
      description: "Write a UTF-8 note file into the configured notes directory.",
      inputSchema: objectSchema({ name: { type: "string" }, text: { type: "string" } }, ["name", "text"]),
      annotations: { title: "Write note", destructiveHint: false },
    },
    {
      name: "slow",
      description: "Wait the given number of milliseconds, then answer (honours notifications/cancelled).",
      inputSchema: objectSchema({ ms: { type: "number" } }, ["ms"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "fail",
      description: "Always returns a tool execution error (isError: true).",
      inputSchema: objectSchema({}, []),
      annotations: { readOnlyHint: true },
    },
  ];
  if (options.envTool) {
    tools.push({
      name: "env_report",
      description: "Report this server process's environment variables.",
      inputSchema: objectSchema({}, []),
      annotations: { readOnlyHint: true },
    });
  }
  if (options.extraTools) {
    tools.push(
      {
        name: "Echo",
        description: "Upper-case variant whose capability id collides with echo after lower-casing.",
        inputSchema: objectSchema({ text: { type: "string" } }, ["text"]),
        annotations: { readOnlyHint: true },
      },
      { name: "bad_schema", description: "Tool with a non-object inputSchema.", inputSchema: "not-a-schema" },
      { name: "array_schema", description: "Tool whose inputSchema is not type object.", inputSchema: { type: "array" } },
      {
        name: "big",
        description: "Return a text block of the requested size in bytes.",
        inputSchema: objectSchema({ bytes: { type: "number" } }, ["bytes"]),
        annotations: { readOnlyHint: true },
      },
    );
  }
  return tools;
}

const TOOLS = toolDefinitions();

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const text = (value) => ({ type: "text", text: value });

function requireString(args, key) {
  if (typeof args[key] !== "string") throw new RpcError(-32602, `Invalid params: ${key} must be a string`);
  return args[key];
}

function requireNumber(args, key) {
  if (typeof args[key] !== "number" || !Number.isFinite(args[key])) {
    throw new RpcError(-32602, `Invalid params: ${key} must be a finite number`);
  }
  return args[key];
}

async function callTool(name, args, cancellation) {
  if (!TOOLS.some((tool) => tool.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new RpcError(-32602, "Invalid params: arguments must be an object");
  }
  switch (name) {
    case "echo":
    case "Echo":
      return { content: [text(requireString(args, "text"))], isError: false };
    case "add": {
      const sum = requireNumber(args, "a") + requireNumber(args, "b");
      return { content: [text(JSON.stringify({ sum }))], structuredContent: { sum }, isError: false };
    }
    case "write_note":
      return writeNote(requireString(args, "name"), requireString(args, "text"));
    case "slow": {
      const ms = Math.min(Math.max(0, requireNumber(args, "ms")), MAX_SLOW_MS);
      const completed = await cancellation.wait(ms);
      if (!completed) return undefined; // cancelled: no response is sent
      return { content: [text(`slept ${ms} ms`)], isError: false };
    }
    case "fail":
      return { content: [text("fixture failure: the fail tool always reports an execution error")], isError: true };
    case "env_report":
      return { content: [text(JSON.stringify(process.env))], isError: false };
    case "big": {
      const bytes = Math.min(Math.max(0, Math.trunc(requireNumber(args, "bytes"))), MAX_BIG_BYTES);
      return { content: [text("x".repeat(bytes))], isError: false };
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

async function writeNote(name, body) {
  if (options.notesDir === undefined) {
    return { content: [text("write_note refused: --notes-dir is not configured")], isError: true };
  }
  const target = resolve(options.notesDir, name);
  const inside = relative(options.notesDir, target);
  if (
    name === "" || name.includes("/") || name.includes("\\") || name.includes("\0")
    || inside === "" || inside.startsWith("..") || isAbsolute(inside)
  ) {
    return { content: [text("write_note refused: path traversal is not allowed")], isError: true };
  }
  await mkdir(options.notesDir, { recursive: true });
  await writeFile(target, body, { encoding: "utf8", flag: "w" });
  return { content: [text(`wrote ${name} (${Buffer.byteLength(body, "utf8")} bytes)`)], isError: false };
}

function listTools(params) {
  const cursor = params?.cursor;
  let offset = 0;
  if (cursor !== undefined) {
    const match = typeof cursor === "string" ? /^page:(\d+)$/.exec(cursor) : null;
    if (match === null) throw new RpcError(-32602, "Invalid params: unknown cursor");
    offset = Number(match[1]);
    if (offset >= TOOLS.length) throw new RpcError(-32602, "Invalid params: cursor out of range");
  }
  const tools = TOOLS.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE;
  return next < TOOLS.length ? { tools, nextCursor: `page:${next}` } : { tools };
}

function initializeResult(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "anna-mcp-fixture", version: "1.0.0" },
  };
}

// A per-session dispatcher shared by both transports. `send` delivers a JSON-RPC
// message that answers (or relates to) a request.
function createSession() {
  const inflight = new Map(); // request id -> cancellation handle
  const session = {
    initialized: false,
    protocolVersion: LATEST_VERSION,
    async handleRequest(message) {
      const { id, method, params } = message;
      if (options.exitOn === method) {
        log(`exiting on ${method}`);
        process.exit(3);
      }
      try {
        if (method === "initialize") {
          const result = initializeResult(params);
          session.protocolVersion = result.protocolVersion;
          return { jsonrpc: "2.0", id, result };
        }
        if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
        if (!session.initialized) throw new RpcError(-32600, "Invalid request: notifications/initialized not received");
        if (method === "tools/list") return { jsonrpc: "2.0", id, result: listTools(params) };
        if (method === "tools/call") {
          const cancellation = createCancellation();
          inflight.set(String(id), cancellation);
          try {
            const result = await callTool(params?.name, params?.arguments ?? {}, cancellation);
            return result === undefined ? undefined : { jsonrpc: "2.0", id, result };
          } finally {
            inflight.delete(String(id));
          }
        }
        throw new RpcError(-32601, `Method not found: ${method}`);
      } catch (error) {
        if (error instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
        return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
      }
    },
    handleNotification(message) {
      if (message.method === "notifications/initialized") session.initialized = true;
      if (message.method === "notifications/cancelled") {
        const requestId = message.params?.requestId;
        log(`cancelled request ${String(requestId)} (${String(message.params?.reason ?? "no reason")})`);
        inflight.get(String(requestId))?.cancel();
      }
    },
    cancelAll() {
      for (const handle of inflight.values()) handle.cancel();
    },
  };
  return session;
}

function createCancellation() {
  let cancel = () => {};
  let cancelled = false;
  return {
    wait(ms) {
      return new Promise((resolveWait) => {
        if (cancelled) return resolveWait(false);
        const timer = setTimeout(() => resolveWait(true), ms);
        cancel = () => {
          clearTimeout(timer);
          resolveWait(false);
        };
      });
    },
    cancel() {
      cancelled = true;
      cancel();
    },
  };
}

const isRequest = (message) => typeof message?.method === "string" && message.id !== undefined && message.id !== null;
const isNotification = (message) => typeof message?.method === "string" && (message.id === undefined || message.id === null);

if (options.stderrBytes > 0) {
  process.stderr.write("e".repeat(options.stderrBytes));
  process.stderr.write("\nfixture: STDERR_TAIL_MARKER\n");
}

if (options.http === undefined) runStdio();
else runHttp(options.http);

// ---------------------------------------------------------------- stdio

function runStdio() {
  const session = createSession();
  const write = (message) => {
    if (message !== undefined) process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") handleLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (isRequest(message)) {
      if (message.method === "initialize" && options.neverInitialize) return;
      void session.handleRequest(message).then(write);
    } else if (isNotification(message)) {
      session.handleNotification(message);
    }
    // Responses from the client (e.g. to a server ping) are ignored.
  }
}

// ---------------------------------------------------------------- Streamable HTTP

function runHttp(port) {
  const sessions = new Map(); // session id -> session

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") return response.writeHead(404).end();
    const origin = request.headers.origin;
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
      return response.writeHead(403).end();
    }
    if (options.requireAuth !== undefined && request.headers.authorization !== `Bearer ${options.requireAuth}`) {
      return response.writeHead(401).end();
    }
    const sessionId = request.headers["mcp-session-id"];
    if (request.method === "DELETE") {
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) return response.writeHead(404).end();
      sessions.get(sessionId).cancelAll();
      sessions.delete(sessionId);
      return response.writeHead(204).end();
    }
    if (request.method !== "POST") return response.writeHead(405, { allow: "POST, DELETE" }).end();
    const accept = String(request.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return response.writeHead(406).end();
    }
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
      return response.writeHead(415).end();
    }
    const raw = await readBody(request);
    if (raw === undefined) return response.writeHead(413).end();
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (Array.isArray(message) || message === null || typeof message !== "object") {
      return sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    }

    if (isRequest(message) && message.method === "initialize") {
      if (options.neverInitialize) return; // leave the request hanging
      const session = createSession();
      const id = randomUUID();
      sessions.set(id, session);
      const reply = await session.handleRequest(message);
      return sendJson(response, 200, reply, { "mcp-session-id": id });
    }

    if (typeof sessionId !== "string") return response.writeHead(400).end();
    const session = sessions.get(sessionId);
    if (session === undefined) return response.writeHead(404).end();
    if (request.headers["mcp-protocol-version"] !== session.protocolVersion) return response.writeHead(400).end();

    if (isNotification(message)) {
      session.handleNotification(message);
      return response.writeHead(202).end();
    }
    if (!isRequest(message)) return response.writeHead(202).end(); // a client response

    if (message.method === "tools/call") {
      // Answer tool calls through an SSE stream: one unrelated notification first,
      // then the JSON-RPC response, then close the stream.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeEvent(response, {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", logger: "fixture", data: `tools/call ${String(message.params?.name)}` },
      });
      const reply = await session.handleRequest(message);
      if (reply !== undefined && !response.destroyed) writeEvent(response, reply);
      return response.end();
    }
    const reply = await session.handleRequest(message);
    return sendJson(response, 200, reply);
  }

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`MCP_FIXTURE_HTTP_URL=http://127.0.0.1:${address.port}/mcp\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        resolveBody(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(payload);
}

function writeEvent(response, message) {
  response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}
