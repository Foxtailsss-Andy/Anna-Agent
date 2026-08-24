import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Assemble a modern, PNG-based .icns from the iconset PNGs so macOS parity
// stays in sync with build/icon.ico without needing macOS `iconutil`.
// Each OSType below accepts PNG-encoded data in current macOS readers.
const map = [
  ["icp4", "icon_16x16.png"],
  ["icp5", "icon_32x32.png"],
  ["ic07", "icon_128x128.png"],
  ["ic08", "icon_256x256.png"],
  ["ic09", "icon_512x512.png"],
  ["ic10", "icon_512x512@2x.png"],
  ["ic11", "icon_16x16@2x.png"],
  ["ic12", "icon_32x32@2x.png"],
  ["ic13", "icon_128x128@2x.png"],
  ["ic14", "icon_256x256@2x.png"],
];

const entries = [];
for (const [type, file] of map) {
  const path = `build/icon.iconset/${file}`;
  if (!existsSync(path)) continue;
  const png = readFileSync(path);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  entries.push(Buffer.concat([header, png]));
}

const body = Buffer.concat(entries);
const fileHeader = Buffer.alloc(8);
fileHeader.write("icns", 0, 4, "ascii");
fileHeader.writeUInt32BE(body.length + 8, 4);
const out = Buffer.concat([fileHeader, body]);
writeFileSync("build/icon.icns", out);
console.log(`Wrote build/icon.icns (${out.length} bytes) from ${entries.length} entries`);
