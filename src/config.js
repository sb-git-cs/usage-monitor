const fs = require("fs");
const path = require("path");
const { configDir, configPath } = require("./paths");

const ALLOWED_INTERVALS = [5, 15, 30, 60];

const DEFAULTS = {
  poll_interval_secs: 5,
  config_version: 5,
  chips_docked: true,
  chips_hidden: false,
  chips_x: null,
  chips_y: null,
  chips_dock_x: null,
  chips_dock_y: null,
  flyout_docked: false,
  flyout_pinned: false,
  flyout_x: null,
  flyout_y: null,
  flyout_dock_x: null,
  flyout_dock_y: null,
  autostart: true,
  check_updates_on_startup: true,
  notify_on_limit_reached: true,
  adapters: {
    claude: { refresh_tokens: true },
    gemini: { refresh_tokens: true },
    grok: { refresh_tokens: true },
  },
};

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

function load() {
  const parsed = readFile();
  if (!parsed) return { ...DEFAULTS };
  return { ...DEFAULTS, ...parsed, adapters: { ...DEFAULTS.adapters, ...(parsed.adapters || {}) } };
}

function save(cfg) {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = configPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: "utf8" });
  fs.renameSync(tmp, configPath());
}

function ensure() {
  const raw = readFile();
  const cfg = raw
    ? { ...DEFAULTS, ...raw, adapters: { ...DEFAULTS.adapters, ...(raw.adapters || {}) } }
    : { ...DEFAULTS };
  let dirty = !raw;
  const fileVersion = raw && raw.config_version ? Number(raw.config_version) : 0;
  if (fileVersion < 3) {
    cfg.poll_interval_secs = 5;
    cfg.config_version = 3;
    dirty = true;
  }
  if (fileVersion < 4) {
    cfg.chips_docked = true;
    cfg.chips_hidden = false;
    cfg.config_version = 4;
    dirty = true;
  }
  if (fileVersion < 5) {
    cfg.check_updates_on_startup = true;
    cfg.config_version = 5;
    dirty = true;
  }
  if (!ALLOWED_INTERVALS.includes(Number(cfg.poll_interval_secs))) {
    cfg.poll_interval_secs = 5;
    dirty = true;
  }
  cfg.poll_interval_secs = Number(cfg.poll_interval_secs);
  if (dirty) save(cfg);
  return cfg;
}

module.exports = { DEFAULTS, ALLOWED_INTERVALS, load, save, ensure, configPath };
