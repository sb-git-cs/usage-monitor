const fs = require("fs");
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
  return normalize(readFile());
}

function normalize(parsed) {
  const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const cfg = { ...DEFAULTS, ...raw, adapters: {} };
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === "boolean" && typeof cfg[key] !== "boolean") cfg[key] = value;
    if (value === null && !Number.isFinite(cfg[key])) cfg[key] = null;
  }
  for (const id of Object.keys(DEFAULTS.adapters)) {
    cfg.adapters[id] = { refresh_tokens: raw.adapters?.[id]?.refresh_tokens !== false };
  }
  cfg.poll_interval_secs = ALLOWED_INTERVALS.includes(Number(cfg.poll_interval_secs)) ? Number(cfg.poll_interval_secs) : 5;
  return cfg;
}

function save(cfg) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    const tmp = configPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: "utf8" });
    fs.renameSync(tmp, configPath());
    return true;
  } catch (err) {
    console.error("config write failed", err.message);
    return false;
  }
}

function ensure() {
  const raw = readFile();
  const cfg = normalize(raw);
  let dirty = JSON.stringify(raw) !== JSON.stringify(cfg);
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
