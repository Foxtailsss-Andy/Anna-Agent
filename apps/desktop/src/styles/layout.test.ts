import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TOKENS_CSS = fileURLToPath(new URL("./tokens.css", import.meta.url));

describe("desktop document layout", () => {
  it("pins the document shell and leaves scrolling to app panels", () => {
    const css = readFileSync(TOKENS_CSS, "utf8");

    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%;[^}]*margin:\s*0;/s);
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden;/s);
  });
});
