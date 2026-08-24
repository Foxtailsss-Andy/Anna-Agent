import pngToIco from "png-to-ico";
import { existsSync, writeFileSync } from "node:fs";

const sources = ["16x16", "32x32", "128x128", "256x256"]
  .map((s) => `build/icon.iconset/icon_${s}.png`)
  .filter((p) => existsSync(p));
const buf = await pngToIco(sources);
writeFileSync("build/icon.ico", buf);
console.log(`Wrote build/icon.ico (${buf.length} bytes) from ${sources.length} sizes`);
