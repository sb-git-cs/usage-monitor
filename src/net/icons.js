// Real program icons as data URLs, cached per app key.
const fs = require("fs");
const path = require("path");

const MAX_ICON_FILE = 512 * 1024;

class IconCache {
  constructor({ app, desktop }) {
    this.app = app;
    this.desktop = desktop || null;
    this.cache = new Map();
  }

  get(key, filePath) {
    if (this.cache.has(key)) return this.cache.get(key);
    const pending = this.load(key, filePath).catch(() => null);
    this.cache.set(key, pending);
    return pending;
  }

  async load(key, filePath) {
    if (this.desktop && filePath) {
      const entry = this.desktop.lookup(filePath, path.basename(filePath));
      const file = entry && this.desktop.iconFile(entry.icon);
      const url = file ? this.fileToDataUrl(file) : null;
      if (url) return url;
    }
    if (!filePath || !fs.existsSync(filePath)) return null;
    const image = await this.app.getFileIcon(filePath, { size: process.platform === "win32" ? "normal" : "large" });
    return image && !image.isEmpty() ? image.resize({ width: 32, height: 32, quality: "best" }).toDataURL() : null;
  }

  fileToDataUrl(file) {
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : null;
    if (!type) return null;
    const stat = fs.statSync(file);
    if (stat.size > MAX_ICON_FILE) return null;
    return `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
  }
}

module.exports = { IconCache };
