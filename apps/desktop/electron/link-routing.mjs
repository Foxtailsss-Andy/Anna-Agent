// Link routing policy for the desktop shell (pure; unit-tested without Electron).
//
// Model-authored answers render links (target=_blank). No new Electron window is
// ever opened, because it would carry the app's preload: public http(s) links go
// to the system browser, everything else (file:, loopback services, other
// schemes) is refused. The main window may only navigate within the app origin.

/**
 * @param {string} target
 * @param {ReadonlySet<string>} internalOrigins origins of the app itself (Host, dev server)
 * @returns {"internal" | "external" | "deny"}
 */
export function classifyLinkTarget(target, internalOrigins) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (internalOrigins.has(url.origin)) return "internal";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "deny";
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  // WHATWG URL canonicalizes IPv4-mapped IPv6 to hexadecimal groups.
  const mappedLocal = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]+$/.test(host) || host === "::ffff:0:0";
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "::"
    || mappedLocal
    || host === "0.0.0.0"
    || /^127\./.test(host)
  ) {
    return "deny";
  }
  return "external";
}
