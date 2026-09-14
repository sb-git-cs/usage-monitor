const zlib = require("zlib");
const { nativeImage } = require("electron");

const FONT = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "001", "001", "001"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  C: ["011", "100", "100", "100", "011"],
  X: ["101", "101", "010", "101", "101"],
  G: ["011", "100", "101", "101", "011"],
  "-": ["000", "000", "111", "000", "000"],
  "?": ["111", "001", "010", "000", "010"],
};

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

function blit(rgba, w, glyph, x, y, scale, color) {
  const rows = FONT[glyph];
  if (!rows) return;
  for (let gy = 0; gy < rows.length; gy++) {
    for (let gx = 0; gx < rows[gy].length; gx++) {
      if (rows[gy][gx] !== "1") continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = x + gx * scale + sx;
          const py = y + gy * scale + sy;
          if (px < 0 || py < 0 || px >= w || py >= w) continue;
          const i = (py * w + px) * 4;
          rgba[i] = color[0];
          rgba[i + 1] = color[1];
          rgba[i + 2] = color[2];
          rgba[i + 3] = 255;
        }
      }
    }
  }
}

function iconFor(letter, usedPct, alerting, gray) {
  const size = 32;
  const rgba = Buffer.alloc(size * size * 4);
  const bg = gray ? [31, 41, 55] : [17, 24, 39];
  const border = gray ? [107, 114, 128] : alerting ? [239, 68, 68] : [34, 197, 94];
  const fg = gray ? [156, 163, 175] : alerting ? [254, 202, 202] : [187, 247, 208];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const c = edge ? border : bg;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = 255;
    }
  }
  const text =
    usedPct == null || Number.isNaN(usedPct) ? `${letter}?` : `${letter}${Math.min(999, Math.round(usedPct))}`;
  const scale = text.length >= 4 ? 2 : 3;
  const glyphW = 3 * scale + 1;
  const total = text.length * glyphW - 1;
  let x = Math.floor((size - total) / 2);
  const y = Math.floor((size - 5 * scale) / 2);
  for (const ch of text) {
    blit(rgba, size, ch, x, y, scale, fg);
    x += glyphW;
  }
  return nativeImage.createFromBuffer(encodePng(size, size, rgba));
}

function appIcon() {
  return iconFor("U", null, false, false);
}

module.exports = { iconFor, appIcon };
