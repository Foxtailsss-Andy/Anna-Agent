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
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "0.0.0.0"
    || /^127\./.test(host)
  ) {
    return "deny";
  }
  return "external";
}
