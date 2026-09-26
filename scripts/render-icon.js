// Renders the app icon at 1024px (macOS and Linux packages need 512px or more).
// Run with: npx electron scripts/render-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const SIZE = 1024;
const bars = ["#e07a5f", "#60a5fa", "#7c9cff", "#d6d3d1"];
const barW = 108;
const gap = 56;
const barH = 392;
const x0 = (SIZE - (bars.length * barW + (bars.length - 1) * gap)) / 2;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<circle cx="512" cy="512" r="452" fill="#111827"/>
${bars.map((c, i) => `<rect x="${x0 + i * (barW + gap)}" y="${512 - barH / 2}" width="${barW}" height="${barH}" fill="${c}"/>`).join("")}
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, "..", "src", "ui", "icon-1024.png");
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE, quality: "best" }).toPNG());
  console.log("wrote", out);
  app.exit(0);
});
