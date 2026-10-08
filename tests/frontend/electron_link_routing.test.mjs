// R-standards2 P2.8: the desktop shell never opens a second (preload-carrying)
// window for a link; only public http(s) links leave the app, via the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { classifyLinkTarget } from "../../apps/desktop/electron/link-routing.mjs";

const internal = new Set(["http://127.0.0.1:18975"]);

test("the app's own origin stays in the main window", () => {
  assert.equal(classifyLinkTarget("http://127.0.0.1:18975/crew", internal), "internal");
});

test("public web links go to the system browser", () => {
  assert.equal(classifyLinkTarget("https://example.com/report", internal), "external");
  assert.equal(classifyLinkTarget("http://docs.example.org/a?b=1", internal), "external");
});

test("local files, loopback services and other schemes are refused", () => {
  for (const target of [
    "file:///etc/hosts",
    "http://127.0.0.1:18976/_business/crew",
    "http://localhost:3000/",
    "http://app.localhost/",
    "http://[::1]:8080/",
    "http://0.0.0.0:9000/",
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "anna-internal://x",
    "not a url",
  ]) {
    assert.equal(classifyLinkTarget(target, internal), "deny", target);
  }
});
