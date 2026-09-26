// Linux: maps running programs to their .desktop entries for friendly names and icons.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseDesktopEntry, execProgram } = require("./parsers");

function dataDirs() {
  const home = os.homedir();
  const dirs = [process.env.XDG_DATA_HOME || path.join(home, ".local", "share")];
  dirs.push(...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean));
  dirs.push(path.join(home, ".local", "share", "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop");
  return [...new Set(dirs)];
}

function listDesktopFiles(dir, depth = 0, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2) listDesktopFiles(full, depth + 1, out);
    else if (e.name.endsWith(".desktop")) out.push(full);
  }
  return out;
}

class DesktopIndex {
  constructor() {
    this.byName = new Map();
    this.byPath = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    for (const dir of dataDirs()) {
      for (const file of listDesktopFiles(path.join(dir, "applications"))) {
        let entry;
        try {
          entry = parseDesktopEntry(fs.readFileSync(file, "utf8"));
        } catch {
          entry = null;
        }
        if (!entry || (entry.type && entry.type !== "Application")) continue;
        const prog = execProgram(entry.tryExec || entry.exec);
        const names = [path.basename(file, ".desktop"), entry.wmClass, prog && path.basename(prog)];
        for (const n of names) if (n && !this.byName.has(n.toLowerCase())) this.byName.set(n.toLowerCase(), entry);
        if (prog && prog.startsWith("/")) {
          try {
            this.byPath.set(fs.realpathSync(prog), entry);
          } catch {
            /* missing target */
          }
        }
      }
    }
    return this;
  }

  lookup(exe, comm) {
    this.load();
    return (
      this.byPath.get(exe) ||
      this.byName.get(path.basename(exe || "").toLowerCase()) ||
      (comm ? this.byName.get(String(comm).toLowerCase()) : null) ||
      null
    );
  }

  iconFile(name) {
    if (!name) return null;
    if (name.startsWith("/")) return fs.existsSync(name) ? name : null;
    const home = os.homedir();
    const bases = [path.join(home, ".icons"), ...dataDirs().map((d) => path.join(d, "icons"))];
    const sizes = ["48x48", "64x64", "128x128", "256x256", "32x32", "scalable"];
    for (const base of bases) {
      for (const size of sizes) {
        for (const ext of [".png", ".svg"]) {
          const file = path.join(base, "hicolor", size, "apps", name + ext);
          if (fs.existsSync(file)) return file;
        }
      }
    }
    for (const ext of [".png", ".svg"]) {
      const file = path.join("/usr/share/pixmaps", name + ext);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }
}

module.exports = { DesktopIndex };
