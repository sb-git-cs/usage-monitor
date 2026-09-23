const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "src", "ui");
const entries = [
  { width: 16, file: "tray-16.png" },
  { width: 32, file: "tray-32.png" },
  { width: 48, file: "tray-48.png" },
  { width: 256, file: "icon-256.png" },
].map((e) => ({
  width: e.width,
  height: e.width,
  png: fs.readFileSync(path.join(dir, e.file)),
}));

const count = entries.length;
const headerSize = 6 + 16 * count;
let offset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);
entries.forEach((e, i) => {
  const o = 6 + i * 16;
  header.writeUInt8(e.width >= 256 ? 0 : e.width, o);
  header.writeUInt8(e.height >= 256 ? 0 : e.height, o + 1);
  header.writeUInt8(0, o + 2);
  header.writeUInt8(0, o + 3);
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(e.png.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += e.png.length;
});
const ico = Buffer.concat([header, ...entries.map((e) => e.png)]);
const out = path.join(dir, "icon.ico");
fs.writeFileSync(out, ico);
console.log("wrote", out, ico.length);
