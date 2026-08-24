"use strict";

const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { delimiter, join } = require("node:path");

const scriptName = process.argv[2];
if (scriptName === undefined || scriptName.length === 0) {
  process.stderr.write("fixture command runner requires a package script name\n");
  process.exit(64);
}

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const script = packageJson.scripts?.[scriptName];
if (typeof script !== "string" || script.length === 0) {
  process.stderr.write(`missing package script: ${scriptName}\n`);
  process.exit(64);
}

const result = spawnSync("/bin/sh", ["-c", script], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: [join(process.cwd(), "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter),
    npm_lifecycle_event: scriptName,
    npm_lifecycle_script: script,
  },
  stdio: "inherit",
});
if (result.error !== undefined) {
  process.stderr.write(`${String(result.error)}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
