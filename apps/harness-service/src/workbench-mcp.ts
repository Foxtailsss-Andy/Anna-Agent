/**
 * Host-side Model Context Protocol client (revision 2025-06-18).
 *
 * MCP servers are declared by the user in a protected Host-only file
 * (`{"mcpServers": {...}}`, see `loadMcpConfig`). The Host — never the OMP
 * worker — connects to them, lists their tools and executes calls, so every
 * MCP call passes the same profile admission, policy decision and durable
 * tool events as any other Anna tool. Transports: stdio (newline-delimited
 * JSON-RPC) and Streamable HTTP (JSON or SSE response bodies).
 *
 * Boundaries kept here:
 * - stdio servers get a scrubbed environment (PATH, HOME=scratch, LANG plus
 *   the server's configured `env`); the Host environment carries service
 *   tokens and model keys and is never inherited;
 * - HTTP servers must be loopback http:// or https://, redirects are refused;
 * - every request is bounded in time and size; failures become explicit
 *   reasons, never invented tool output.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_RESULT_TEXT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_LIST_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_CAPABILITY_ID_CHARS = 60;

export interface McpServerConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeout_ms?: number;
  readonly disabled?: boolean;
}

export interface McpToolDescriptor {
  readonly capability_id: string;
  readonly server_id: string;
  readonly tool_name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly read_only: boolean;
}

export interface McpServerStatus {
  readonly server_id: string;
  readonly state: "ready" | "failed" | "disabled";
  readonly tool_count: number;
  readonly transport: "stdio" | "http" | "unknown";
  readonly error?: string;
  readonly skipped_tools?: readonly string[];
}

export type McpCallResult =
  | { readonly status: "succeeded"; readonly output: Record<string, unknown> }
  | { readonly status: "failed"; readonly output: Record<string, unknown> };

export interface McpManager {
  start(): Promise<void>;
  tools(): readonly McpToolDescriptor[];
  status(): McpServerStatus[];
  call(capabilityId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

type McpFailureReason = "mcp_transport_failed" | "mcp_tool_error" | "mcp_timeout" | "mcp_server_unavailable" | "mcp_cancelled";

class McpError extends Error {
  constructor(readonly reason: McpFailureReason, message: string) {
    super(message);
    this.name = "McpError";
  }
}

export async function loadMcpConfig(path: string | undefined): Promise<Record<string, McpServerConfig>> {
  if (path === undefined || path.trim() === "") return {};
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw new Error("mcp_config_unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("mcp_config_invalid_json");
  }
  if (!isRecord(parsed)) throw new Error("mcp_config_invalid");
  const servers = parsed.mcpServers ?? {};
  if (!isRecord(servers)) throw new Error("mcp_config_invalid");
  const result: Record<string, McpServerConfig> = {};
  for (const [serverId, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) throw new Error(`mcp_config_invalid_server:${serverId}`);
    const config: McpServerConfig = {
      ...(typeof raw.command === "string" ? { command: raw.command } : {}),
      ...(Array.isArray(raw.args) ? { args: raw.args.filter((item): item is string => typeof item === "string") } : {}),
      ...(isStringRecord(raw.env) ? { env: raw.env } : {}),
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
      ...(typeof raw.url === "string" ? { url: raw.url } : {}),
      ...(isStringRecord(raw.headers) ? { headers: raw.headers } : {}),
      ...(typeof raw.timeout_ms === "number" && Number.isFinite(raw.timeout_ms) ? { timeout_ms: raw.timeout_ms } : {}),
      ...(raw.disabled === true ? { disabled: true } : {}),
    };
    if (config.command === undefined && config.url === undefined) throw new Error(`mcp_config_invalid_server:${serverId}`);
    result[serverId] = config;
  }
  return result;
}

interface Transport {
  request(method: string, params: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ id: number; result: unknown }>;
  notify(method: string, params?: unknown): Promise<void>;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

export function createMcpManager(
  servers: Record<string, McpServerConfig>,
  options: { readonly clientName?: string; readonly clientVersion?: string } = {},
): McpManager {
  const connections = new Map<string, { transport: Transport; timeoutMs: number }>();
  const statuses = new Map<string, McpServerStatus>();
  let descriptors: McpToolDescriptor[] = [];
  let started: Promise<void> | undefined;

  async function connect(serverId: string, config: McpServerConfig): Promise<McpToolDescriptor[]> {
    const timeoutMs = boundedTimeout(config.timeout_ms);
    const transport = config.url !== undefined ? createHttpTransport(config.url, config.headers ?? {}) : await createStdioTransport(config);
    connections.set(serverId, { transport, timeoutMs });
    const init = await transport.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName ?? "anna-harness-host", version: options.clientVersion ?? "1.0.0" },
    }, undefined, timeoutMs);
    const initResult = isRecord(init.result) ? init.result : {};
    const version = typeof initResult.protocolVersion === "string" ? initResult.protocolVersion : MCP_PROTOCOL_VERSION;
    transport.setProtocolVersion(version);
    await transport.notify("notifications/initialized");
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const listed = await transport.request("tools/list", cursor === undefined ? {} : { cursor }, undefined, timeoutMs);
      const result = isRecord(listed.result) ? listed.result : {};
      if (Array.isArray(result.tools)) tools.push(...result.tools);
      cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    const skipped: string[] = [];
    const accepted: McpToolDescriptor[] = [];
    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.trim() === "") {
        skipped.push("<unnamed>:invalid_tool");
        continue;
      }
      const schema = tool.inputSchema;
      if (!isRecord(schema) || schema.type !== "object") {
        skipped.push(`${tool.name}:invalid_input_schema`);
        continue;
      }
      const annotations = isRecord(tool.annotations) ? tool.annotations : {};
      accepted.push({
        capability_id: "",
        server_id: serverId,
        tool_name: tool.name,
        description: (typeof tool.description === "string" ? tool.description : `MCP tool ${tool.name}`).slice(0, MAX_DESCRIPTION_CHARS),
        input_schema: schema,
        read_only: annotations.readOnlyHint === true,
      });
    }
    statuses.set(serverId, {
      server_id: serverId,
      state: "ready",
      tool_count: accepted.length,
      transport: config.url !== undefined ? "http" : "stdio",
      ...(skipped.length === 0 ? {} : { skipped_tools: skipped }),
    });
    return accepted;
  }

  return {
    start() {
      started ??= (async () => {
        const collected: McpToolDescriptor[] = [];
        for (const [serverId, config] of Object.entries(servers)) {
          if (config.disabled === true) {
            statuses.set(serverId, { server_id: serverId, state: "disabled", tool_count: 0, transport: transportKind(config) });
            continue;
          }
          try {
            collected.push(...await connect(serverId, config));
          } catch (error) {
            await connections.get(serverId)?.transport.close().catch(() => undefined);
            connections.delete(serverId);
            statuses.set(serverId, {
              server_id: serverId,
              state: "failed",
              tool_count: 0,
              transport: transportKind(config),
              error: error instanceof McpError ? `${error.reason}: ${error.message}` : safeMessage(error),
            });
          }
        }
        descriptors = assignCapabilityIds(collected);
      })();
      return started;
    },
    tools: () => descriptors,
    status: () => Object.keys(servers).map((serverId) => statuses.get(serverId)
      ?? { server_id: serverId, state: "failed", tool_count: 0, transport: transportKind(servers[serverId]!), error: "not_started" }),
    async call(capabilityId, args, signal) {
      const descriptor = descriptors.find((item) => item.capability_id === capabilityId);
      if (descriptor === undefined) return failed("mcp_server_unavailable", { capability_id: capabilityId });
      const connection = connections.get(descriptor.server_id);
      if (connection === undefined || statuses.get(descriptor.server_id)?.state !== "ready") {
        return failed("mcp_server_unavailable", { server_id: descriptor.server_id });
      }
      if (signal.aborted) return failed("mcp_cancelled", {});
      try {
        const reply = await connection.transport.request(
          "tools/call",
          { name: descriptor.tool_name, arguments: args },
          signal,
          connection.timeoutMs,
        );
        return toolResult(reply.result);
      } catch (error) {
        if (error instanceof McpError) {
          if (error.reason === "mcp_server_unavailable") {
            const current = statuses.get(descriptor.server_id);
            if (current !== undefined) statuses.set(descriptor.server_id, { ...current, state: "failed", error: error.message });
          }
          return failed(error.reason, { server_id: descriptor.server_id, tool: descriptor.tool_name });
        }
        return failed("mcp_transport_failed", { server_id: descriptor.server_id, tool: descriptor.tool_name });
      }
    },
    async close() {
      await Promise.all([...connections.values()].map((connection) => connection.transport.close().catch(() => undefined)));
      connections.clear();
    },
  };
}

function failed(reason: McpFailureReason, extra: Record<string, unknown>): McpCallResult {
  return { status: "failed", output: { reason, ...extra } };
}

function toolResult(result: unknown): McpCallResult {
  if (!isRecord(result) || !Array.isArray(result.content)) return failed("mcp_transport_failed", { detail: "invalid_tool_result" });
  let budget = MAX_RESULT_TEXT_BYTES;
  let truncated = false;
  const content: Array<Record<string, unknown>> = [];
  for (const block of result.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const bytes = Buffer.byteLength(block.text, "utf8");
      if (bytes <= budget) {
        content.push({ type: "text", text: block.text });
        budget -= bytes;
      } else {
        content.push({ type: "text", text: Buffer.from(block.text, "utf8").subarray(0, Math.max(0, budget)).toString("utf8") });
        budget = 0;
        truncated = true;
      }
    } else {
      // Binary/resource blocks are summarized; their payload is not forwarded to the model.
      content.push({ type: typeof block.type === "string" ? block.type : "unknown", omitted: true });
    }
  }
  const structured = result.structuredContent !== undefined && Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 16 * 1024
    ? { structured_content: result.structuredContent }
    : {};
  const output = { content, is_error: result.isError === true, ...(truncated ? { truncated: true } : {}), ...structured };
  return result.isError === true
    ? { status: "failed", output: { reason: "mcp_tool_error", ...output } }
    : { status: "succeeded", output };
}

/** `mcp.<server>.<tool>` with [a-z0-9_-] segments, no `__` runs (the provider wire alias uses `__`), unique, ≤ 60 chars. */
function assignCapabilityIds(tools: readonly McpToolDescriptor[]): McpToolDescriptor[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    const server = sanitizeSegment(tool.server_id) || "server";
    const name = sanitizeSegment(tool.tool_name) || "tool";
    let base = `mcp.${server}.${name}`;
    if (base.length > MAX_CAPABILITY_ID_CHARS) {
      const digest = createHash("sha256").update(`${tool.server_id}\0${tool.tool_name}`).digest("hex").slice(0, 8);
      base = `${base.slice(0, MAX_CAPABILITY_ID_CHARS - 9)}_${digest}`;
    }
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}_${suffix}`;
    used.add(id);
    return { ...tool, capability_id: id };
  });
}

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 500), 120_000);
}

function transportKind(config: McpServerConfig): McpServerStatus["transport"] {
  return config.url !== undefined ? "http" : config.command !== undefined ? "stdio" : "unknown";
}

// ---------------------------------------------------------------- stdio

async function createStdioTransport(config: McpServerConfig): Promise<Transport> {
  if (config.command === undefined || config.command.trim() === "") throw new McpError("mcp_server_unavailable", "missing command");
  const scratch = await mkdtemp(join(tmpdir(), "anna-mcp-"));
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    HOME: scratch,
    TMPDIR: scratch,
    LANG: "en_US.UTF-8",
    ...(config.env ?? {}),
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(config.command, [...(config.args ?? [])], {
      cwd: config.cwd ?? scratch,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch {
    await rm(scratch, { recursive: true, force: true });
    throw new McpError("mcp_server_unavailable", "spawn failed");
  }
  let nextId = 1;
  let closed = false;
  let closeReason = "server exited";
  let buffer = "";
  let stderrBytes = 0;
  const pending = new Map<number, { resolve: (value: { id: number; result: unknown }) => void; reject: (error: McpError) => void }>();
  const failAll = (error: McpError) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once("error", () => {
      closed = true;
      closeReason = "spawn failed";
      const error = new McpError("mcp_server_unavailable", "spawn failed");
      failAll(error);
      reject(error);
    });
  });
  void spawnError.catch(() => undefined);
  child.once("exit", () => {
    closed = true;
    failAll(new McpError("mcp_server_unavailable", closeReason));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length; // diagnostics only; bounded and never forwarded
    if (stderrBytes > MAX_STDERR_BYTES) child.stderr.removeAllListeners("data");
  });
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES && !buffer.includes("\n")) {
      closeReason = "message too large";
      child.kill("SIGKILL");
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) continue;
      dispatch(line, pending);
    }
  });
  const write = (message: unknown) => new Promise<void>((resolve, reject) => {
    if (closed || !child.stdin.writable) {
      reject(new McpError("mcp_server_unavailable", closeReason));
      return;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(new McpError("mcp_server_unavailable", "write failed")) : resolve());
  });
  return {
    async request(method, params, signal, timeoutMs) {
      const id = nextId++;
      const reply = new Promise<{ id: number; result: unknown }>((resolve, reject) => pending.set(id, { resolve, reject }));
      void reply.catch(() => undefined);
      await Promise.race([write({ jsonrpc: "2.0", id, method, params }), spawnError]);
      return awaitReply(reply, id, signal, timeoutMs, () => {
        pending.get(id)?.reject(new McpError("mcp_timeout", "request timed out"));
        pending.delete(id);
      }, () => {
        pending.get(id)?.reject(new McpError("mcp_cancelled", "request cancelled"));
        pending.delete(id);
      }, (reason) => write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }).catch(() => undefined));
    },
    async notify(method, params) {
      await write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    setProtocolVersion() {},
    async close() {
      if (!closed) {
        closeReason = "client closed";
        child.stdin.end();
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
            resolve();
          }, 1_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function dispatch(
  line: string,
  pending: Map<number, { resolve: (value: { id: number; result: unknown }) => void; reject: (error: McpError) => void }>,
): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(message) || typeof message.id !== "number") return; // notifications/requests from the server are ignored
  const entry = pending.get(message.id);
  if (entry === undefined) return;
  pending.delete(message.id);
  if (isRecord(message.error)) {
    entry.reject(new McpError("mcp_transport_failed", `rpc error ${String(message.error.code ?? "")}`.trim()));
    return;
  }
  entry.resolve({ id: message.id, result: message.result });
}

async function awaitReply<T>(
  reply: Promise<T>,
  _id: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: () => void,
  onAbort: () => void,
  sendCancel: (reason: string) => Promise<unknown>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    void sendCancel("client cancelled");
    onAbort();
  };
  try {
    timer = setTimeout(() => {
      void sendCancel("timeout");
      onTimeout();
    }, timeoutMs);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    return await reply;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// ---------------------------------------------------------------- Streamable HTTP

function createHttpTransport(rawUrl: string, headers: Readonly<Record<string, string>>): Transport {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpError("mcp_server_unavailable", "invalid url");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new McpError("mcp_server_unavailable", "url must be https or loopback http");
  }
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let nextId = 1;
  const baseHeaders = (): Record<string, string> => ({
    ...headers,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
  });
  const post = async (message: unknown, signal: AbortSignal): Promise<Response> => {
    try {
      return await fetch(url, { method: "POST", headers: baseHeaders(), body: JSON.stringify(message), redirect: "error", signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new McpError("mcp_server_unavailable", "connection failed");
    }
  };
  return {
    async request(method, params, signal, timeoutMs) {
      const id = nextId++;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await post({ jsonrpc: "2.0", id, method, params }, controller.signal);
        const returnedSession = response.headers.get("mcp-session-id");
        if (method === "initialize" && returnedSession !== null && returnedSession !== "") sessionId = returnedSession;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new McpError(response.status === 404 && sessionId !== undefined ? "mcp_server_unavailable" : "mcp_transport_failed", `http ${response.status}`);
        }
        const type = response.headers.get("content-type")?.toLowerCase() ?? "";
        const message = type.includes("text/event-stream")
          ? await readSseReply(response, id)
          : JSON.parse(await readBounded(response)) as unknown;
        if (!isRecord(message) || message.id !== id) throw new McpError("mcp_transport_failed", "uncorrelated reply");
        if (isRecord(message.error)) throw new McpError("mcp_transport_failed", `rpc error ${String(message.error.code ?? "")}`.trim());
        return { id, result: message.result };
      } catch (error) {
        if (timedOut) {
          void post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } }, AbortSignal.timeout(2_000)).catch(() => undefined);
          throw new McpError("mcp_timeout", "request timed out");
        }
        if (signal?.aborted) {
          void post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "client cancelled" } }, AbortSignal.timeout(2_000)).catch(() => undefined);
          throw new McpError("mcp_cancelled", "request cancelled");
        }
        if (error instanceof McpError) throw error;
        throw new McpError("mcp_transport_failed", "invalid reply");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    async notify(method, params) {
      const response = await post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new McpError("mcp_transport_failed", `http ${response.status}`);
    },
    setProtocolVersion(version) {
      protocolVersion = version;
    },
    async close() {
      if (sessionId === undefined) return;
      await fetch(url, { method: "DELETE", headers: baseHeaders(), redirect: "error", signal: AbortSignal.timeout(2_000) })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_MESSAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpError("mcp_transport_failed", "message too large");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

async function readSseReply(response: Response, id: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new McpError("mcp_transport_failed", "empty stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  let data: string[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_MESSAGE_BYTES) throw new McpError("mcp_transport_failed", "message too large");
      buffer += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) {
            let message: unknown;
            try {
              message = JSON.parse(data.join("\n"));
            } catch {
              message = undefined;
            }
            data = [];
            if (isRecord(message) && message.id === id) return message;
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new McpError("mcp_transport_failed", "stream ended without a reply");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}
