import { createHash } from "node:crypto";
import { lookup } from "node:dns";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import * as parse5 from "parse5";

import type { ToolResult } from "@anna/harness-v2";

const DEFAULT_MAX_SOURCE_BYTES = 1_000_000;
export const PUBLIC_WEB_READ_MAX_TEXT_CHARS = 20_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PublicWebReadInput {
  readonly url: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface PublicWebAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PublicWebTransportRequest {
  readonly url: string;
  readonly address: PublicWebAddress;
  readonly maxSourceBytes: number;
  readonly timeoutMs: number;
}

export interface PublicWebTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
  readonly sourceTruncated: boolean;
}

export type PublicWebDnsLookup = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly PublicWebAddress[]>;

export type PublicWebTransport = (
  request: PublicWebTransportRequest,
  signal: AbortSignal,
) => Promise<PublicWebTransportResponse>;

export type PublicWebNativeRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface PublicWebReaderOptions {
  readonly dnsLookup?: PublicWebDnsLookup;
  readonly transport?: PublicWebTransport;
  readonly nativeRequestFactory?: (protocol: "http:" | "https:") => PublicWebNativeRequest;
  readonly maxSourceBytes?: number;
  readonly maxTextChars?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}

export type PublicWebReader = (
  input: unknown,
  signal: AbortSignal,
) => Promise<ToolResult>;

interface ParsedReadInput {
  readonly url: string;
  readonly offset: number;
  readonly limit: number;
}

interface ExtractedDocument {
  readonly title: string | null;
  readonly content: string;
  readonly publishedAt?: string;
}

/**
 * Host-owned public web reader. The only injectable boundaries are DNS and
 * HTTP transport; URL policy, address policy, HTML parsing and pagination stay
 * in this module so a fixture cannot grant itself an otherwise forbidden read.
 */
export function createPublicWebReader(
  options: PublicWebReaderOptions = {},
): PublicWebReader {
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  const nativeRequestFactory = options.nativeRequestFactory ?? defaultNativeRequestFactory;
  const transport = options.transport
    ?? ((request, signal) => defaultTransport(request, signal, nativeRequestFactory));
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxTextChars = options.maxTextChars ?? PUBLIC_WEB_READ_MAX_TEXT_CHARS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (rawInput, signal): Promise<ToolResult> => {
    const input = parseReadInput(rawInput, maxTextChars);
    if (input === undefined) {
      return { status: "failed", output: { reason: "invalid_web_read_input" } };
    }
    if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };

    let currentUrl = input.url;
    let response: PublicWebTransportResponse | undefined;
    let address: PublicWebAddress | undefined;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const url = parsePublicUrl(currentUrl);
      if (url === undefined) {
        return { status: "failed", output: { reason: "web_read_destination_not_public" } };
      }
      let addresses: readonly PublicWebAddress[];
      try {
        const literalAddress = parseAddressLiteral(url.hostname);
        if (literalAddress !== undefined) {
          addresses = [literalAddress];
        } else {
          addresses = await withAbortAndTimeout(
            (operationSignal) => dnsLookup(url.hostname, operationSignal),
            signal,
            timeoutMs,
          );
        }
      } catch {
        return {
          status: "failed",
          output: { reason: signal.aborted ? "cancelled" : "web_read_dns_unavailable" },
        };
      }
      if (
        addresses.length === 0
        || addresses.some((candidate) => !isPublicWebAddress(candidate))
      ) {
        return { status: "failed", output: { reason: "web_read_destination_not_public" } };
      }
      const selectedAddress = addresses[0];
      if (selectedAddress === undefined) {
        return { status: "failed", output: { reason: "web_read_destination_not_public" } };
      }
      address = selectedAddress;
      if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
      try {
        response = await withAbortAndTimeout(
          (operationSignal) => transport({
            url: currentUrl,
            address: selectedAddress,
            maxSourceBytes,
            timeoutMs,
          }, operationSignal),
          signal,
          timeoutMs,
        );
      } catch {
        return {
          status: "failed",
          output: { reason: signal.aborted ? "cancelled" : "web_read_network_unavailable" },
        };
      }
      if (signal.aborted) return { status: "failed", output: { reason: "cancelled" } };
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.location;
      if (location === undefined || redirectCount === maxRedirects) {
        return {
          status: "failed",
          output: {
            reason: response.status >= 300 && response.status < 400
              ? "web_read_redirect_limit"
              : "web_read_http_error",
            ...(response.status >= 300 && response.status < 400 ? {} : { status: response.status }),
          },
        };
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return { status: "failed", output: { reason: "web_read_invalid_redirect" } };
      }
    }

    if (response === undefined || address === undefined) {
      return { status: "failed", output: { reason: "web_read_network_unavailable" } };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "failed", output: { reason: "web_read_http_error", status: response.status } };
    }
    const contentType = parseContentType(response.headers["content-type"]);
    if (contentType === undefined
      || (contentType.mediaType !== "text/html"
        && contentType.mediaType !== "application/xhtml+xml"
        && contentType.mediaType !== "text/plain")) {
      return { status: "failed", output: { reason: "web_read_unsupported_content_type" } };
    }
    const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
    if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
      return { status: "failed", output: { reason: "web_read_unsupported_content_encoding" } };
    }
    if (contentType.charset !== undefined && contentType.charset !== "utf-8") {
      return { status: "failed", output: { reason: "web_read_unsupported_charset" } };
    }

    let document: ExtractedDocument;
    try {
      const text = decodeResponseText(response.body, response.sourceTruncated);
      document = contentType.mediaType === "text/plain"
        ? extractPlainText(text)
        : extractHtml(text);
    } catch {
      return {
        status: "failed",
        output: {
          reason: "web_read_parse_failed",
          ...(response.sourceTruncated ? { source_truncated: true } : {}),
        },
      };
    }
    if (document.content === "") {
      return {
        status: "failed",
        output: {
          reason: "web_read_content_missing",
          ...(response.sourceTruncated ? { source_truncated: true } : {}),
        },
      };
    }
    if (input.offset >= document.content.length) {
      return { status: "failed", output: { reason: "web_read_offset_out_of_range" } };
    }

    const end = Math.min(document.content.length, input.offset + input.limit);
    const nextOffset = end < document.content.length ? end : undefined;
    return {
      status: "succeeded",
      output: {
        url: currentUrl,
        title: document.title,
        ...(document.title === null ? { source_missing: ["title"] } : {}),
        ...(document.publishedAt === undefined ? {} : { published_at: document.publishedAt }),
        fetched_at: new Date().toISOString(),
        content: document.content.slice(input.offset, end),
        offset: input.offset,
        limit: input.limit,
        truncated: nextOffset !== undefined,
        ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
        source_truncated: response.sourceTruncated,
        content_sha256: `sha256:${createHash("sha256").update(document.content).digest("hex")}`,
      },
    };
  };
}

function parseAddressLiteral(hostname: string): PublicWebAddress | undefined {
  const address = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  return family === 4 || family === 6 ? { address, family } : undefined;
}

export function isPublicWebAddress(address: PublicWebAddress): boolean {
  if (!Number.isInteger(address.family) || (address.family !== 4 && address.family !== 6)) return false;
  if (isIP(address.address) !== address.family) return false;
  if (address.family === 4) return isPublicIpv4(address.address);
  return isPublicIpv6(address.address);
}

function parseReadInput(input: unknown, maxTextChars: number): ParsedReadInput | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.url !== "string" || value.url.trim() === "") return undefined;
  const offset = value.offset ?? 0;
  const limit = value.limit ?? 4_000;
  if (
    typeof offset !== "number"
    || !Number.isSafeInteger(offset)
    || offset < 0
    || typeof limit !== "number"
    || !Number.isSafeInteger(limit)
    || limit <= 0
    || limit > maxTextChars
  ) return undefined;
  return { url: value.url.trim(), offset, limit };
}

function decodeResponseText(body: Uint8Array, sourceTruncated: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (!sourceTruncated) return decoder.decode(body);

  let text = decoder.decode(body, { stream: true });
  try {
    text += decoder.decode();
  } catch {
    // The byte cap can end inside one UTF-8 code point. The streaming decoder
    // has already returned every complete code point before that boundary.
  }
  return text;
}

function parsePublicUrl(rawUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || (url.port !== "" && url.port !== (url.protocol === "http:" ? "80" : "443"))
  ) return undefined;
  return url;
}

function parseContentType(
  raw: string | undefined,
): { mediaType: string; charset?: string } | undefined {
  if (raw === undefined) return undefined;
  const [mediaTypePart, ...parameters] = raw.split(";");
  const mediaType = mediaTypePart?.trim().toLowerCase();
  if (mediaType === undefined || mediaType === "") return undefined;
  let charset: string | undefined;
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0) continue;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== "charset") continue;
    charset = parameter.slice(separator + 1).trim().replace(/^"(.*)"$/u, "$1").toLowerCase();
  }
  return charset === undefined ? { mediaType } : { mediaType, charset };
}

function defaultDnsLookup(hostname: string, _signal: AbortSignal): Promise<readonly PublicWebAddress[]> {
  return new Promise((resolvePromise, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(addresses.map((item) => ({
        address: item.address,
        family: item.family as 4 | 6,
      })));
    });
  });
}

function defaultTransport(
  request: PublicWebTransportRequest,
  signal: AbortSignal,
  requestFactory: (protocol: "http:" | "https:") => PublicWebNativeRequest,
): Promise<PublicWebTransportResponse> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (response: PublicWebTransportResponse) => {
      if (settled) return;
      settled = true;
      resolvePromise(response);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let url: URL;
    try {
      url = new URL(request.url);
    } catch (error) {
      fail(error);
      return;
    }
    const requester = requestFactory(url.protocol as "http:" | "https:");
    const req = requester({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port === "" ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      headers: {
        accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
        "accept-encoding": "identity",
      },
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: request.address.address, family: request.address.family }]);
          return;
        }
        callback(null, request.address.address, request.address.family);
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let sourceTruncated = false;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = request.maxSourceBytes - size;
        if (bytes.byteLength > remaining) {
          if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
          size = request.maxSourceBytes;
          sourceTruncated = true;
          response.destroy();
          return;
        }
        chunks.push(bytes);
        size += bytes.byteLength;
      });
      response.on("end", () => finish({
        status: response.statusCode ?? 0,
        headers: normalizeHeaders(response.headers),
        body: Buffer.concat(chunks),
        sourceTruncated,
      }));
      response.on("close", () => {
        if (sourceTruncated) {
          finish({
            status: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            body: Buffer.concat(chunks),
            sourceTruncated: true,
          });
        }
      });
      response.on("error", fail);
    });
    req.setTimeout(request.timeoutMs, () => req.destroy(new Error("public web read timeout")));
    req.on("error", fail);
    const abort = () => req.destroy(new Error("public web read cancelled"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    req.on("close", () => signal.removeEventListener("abort", abort));
    req.end();
  });
}

function defaultNativeRequestFactory(protocol: "http:" | "https:"): PublicWebNativeRequest {
  return protocol === "https:" ? httpsRequest : httpRequest;
}

function normalizeHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

function withAbortAndTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abortParent);
      controller.signal.removeEventListener("abort", abortOperation);
      callback();
    };
    const abortOperation = () => finish(() => reject(new Error("timeout")));
    const abortParent = () => finish(() => {
      controller.abort();
      reject(new Error("cancelled"));
    });
    const timer = setTimeout(() => finish(() => {
      controller.abort();
      reject(new Error("timeout"));
    }), timeoutMs);
    if (signal.aborted) {
      abortParent();
      return;
    }
    signal.addEventListener("abort", abortParent, { once: true });
    controller.signal.addEventListener("abort", abortOperation, { once: true });
    operation(controller.signal).then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function extractPlainText(rawText: string): ExtractedDocument {
  const content = normalizeText(rawText);
  return { title: null, content };
}

function extractHtml(rawHtml: string): ExtractedDocument {
  const document = parse5.parse(rawHtml) as unknown as HtmlNode;
  let title: string | null = null;
  let publishedAt: string | undefined;
  const textParts: string[] = [];
  walkHtml(document, (node, parentName) => {
    if (node.nodeName === "title" && title === null) {
      const candidate = normalizeText(collectNodeText(node));
      if (candidate !== "") title = candidate;
    }
    if (node.nodeName === "meta") {
      const property = attribute(node, "property") ?? attribute(node, "name");
      const content = attribute(node, "content")?.trim();
      if (
        publishedAt === undefined
        && property !== undefined
        && content !== undefined
        && content !== ""
        && ["article:published_time", "og:article:published_time", "datepublished", "published_time"].includes(property.toLowerCase())
      ) publishedAt = content;
    }
    if (
      node.nodeName === "#text"
      && parentName !== "head"
      && parentName !== "title"
      && parentName !== "meta"
      && parentName !== "script"
      && parentName !== "style"
      && parentName !== "template"
      && parentName !== "noscript"
    ) {
      textParts.push(node.value ?? "");
    }
  });
  return { title, content: normalizeText(textParts.join("\n")), ...(publishedAt === undefined ? {} : { publishedAt }) };
}

interface HtmlNode {
  readonly nodeName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
}

function walkHtml(node: HtmlNode, visitor: (node: HtmlNode, parentName: string | undefined) => void, parentName?: string): void {
  const name = node.nodeName?.toLowerCase();
  visitor(node, parentName);
  if (name === "script" || name === "style" || name === "template" || name === "noscript") return;
  for (const child of node.childNodes ?? []) walkHtml(child, visitor, name);
}

function collectNodeText(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map((child) => collectNodeText(child)).join(" ");
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return false;
  const [a, b, c] = values;
  return !(
    a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && c === 0
    || a === 192 && b === 0 && c === 2
    || a === 192 && b === 88 && c === 99
    || a === 192 && b === 168
    || a === 198 && b >= 18 && b <= 19
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (bytes === undefined || (bytes[0] & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] < 0x02) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x3f && (bytes[1] & 0xf0) === 0xf0) return false;
  return true;
}

function parseIpv6(address: string): Uint8Array | undefined {
  if (address.includes("%") || address.includes(".")) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) return undefined;
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}
