const fs = require("fs");
const { configDir, configPath } = require("./paths");
const { normalizeNet } = require("./net/settings");

const ALLOWED_INTERVALS = [5, 15, 30, 60];
const ALERT_THRESHOLDS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
const CHIP_KEYS = ["claude", "codex", "gemini", "grok", "cursor", "copilot", "cpu", "mem", "gpu", "disk", "space"];
const UPDATE_CHANNELS = ["stable", "beta"];
const PHONE_PORT = 47329;

const DEFAULTS = {
  poll_interval_secs: 5,
  config_version: 7,
  chips_docked: true,
  chips_hidden: false,
  chips_show_network: true,
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
  auto_update: true,
  update_notified_version: "",
  update_notified_at: 0,
  notify_on_limit_reached: true,
  alert_threshold: 80,
  forecast_alerts: true,
  quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  chips_show: Object.fromEntries(CHIP_KEYS.map((k) => [k, true])),
  update_channel: "stable",
  phone: { enabled: false, port: PHONE_PORT, devices: [] },
  accounts: {},
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
  cfg.net = normalizeNet(raw.net);
  cfg.alert_threshold = ALERT_THRESHOLDS.includes(Number(cfg.alert_threshold)) ? Number(cfg.alert_threshold) : DEFAULTS.alert_threshold;
  cfg.quiet_hours = normalizeQuietHours(raw.quiet_hours);
  cfg.chips_show = Object.fromEntries(CHIP_KEYS.map((k) => [k, raw.chips_show?.[k] !== false]));
  cfg.update_channel = UPDATE_CHANNELS.includes(cfg.update_channel) ? cfg.update_channel : "stable";
  cfg.phone = normalizePhone(raw.phone);
  cfg.accounts = normalizeAccounts(raw.accounts);
  // Taskbar docking relies on the Windows taskbar; elsewhere the widgets float.
  if (process.platform !== "win32") {
    cfg.chips_docked = false;
    cfg.flyout_docked = false;
  }
  cfg.poll_interval_secs = ALLOWED_INTERVALS.includes(Number(cfg.poll_interval_secs)) ? Number(cfg.poll_interval_secs) : 5;
  return cfg;
}

function clockTime(value, fallback) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  return m ? `${m[1]}:${m[2]}` : fallback;
}

function normalizeQuietHours(raw) {
  const q = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: q.enabled === true,
    start: clockTime(q.start, DEFAULTS.quiet_hours.start),
    end: clockTime(q.end, DEFAULTS.quiet_hours.end),
  };
}

const ACCOUNT_IDS = ["claude", "codex", "gemini", "grok", "cursor", "copilot"];

function normalizeAccounts(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const id of ACCOUNT_IDS) {
    const value = src[id];
    if (typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value)) out[id] = value;
  }
  return out;
}

function normalizePhone(raw) {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const port = Number(p.port);
  const devices = (Array.isArray(p.devices) ? p.devices : [])
    .filter((d) => d && /^[0-9a-f]{16}$/.test(d.id) && /^[A-Za-z0-9_-]{43}$/.test(d.key))
    .map((d) => ({
      id: d.id,
      key: d.key,
      name: typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 60) : "Phone",
      created_at: Number.isFinite(d.created_at) ? d.created_at : Date.now(),
      last_seen: Number.isFinite(d.last_seen) ? d.last_seen : null,
      direct: d.direct === true,
    }));
  return {
    enabled: p.enabled === true,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : PHONE_PORT,
    devices,
  };
}

// Minutes since midnight for "HH:MM".
function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// True inside the quiet-hours range; a range like 22:00-07:00 wraps past midnight.
function inQuietHours(cfg, date = new Date()) {
  const q = cfg && cfg.quiet_hours;
  if (!q || !q.enabled) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
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
    cfg.chips_docked = process.platform === "win32";
    cfg.chips_hidden = false;
    cfg.config_version = 4;
    dirty = true;
  }
  if (fileVersion < 5) {
    cfg.check_updates_on_startup = true;
    cfg.config_version = 5;
    dirty = true;
  }
  if (fileVersion < 6) {
    // "Check for updates at startup" became "Install updates automatically"; an opt-out carries over.
    cfg.auto_update = cfg.check_updates_on_startup !== false;
    delete cfg.check_updates_on_startup;
    cfg.config_version = 6;
    dirty = true;
  }
  if (fileVersion < 7) {
    // Settings window: threshold, quiet hours, chip visibility, update channel and phone sharing use their defaults.
    cfg.config_version = 7;
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

module.exports = {
  DEFAULTS,
  ALLOWED_INTERVALS,
  ALERT_THRESHOLDS,
  CHIP_KEYS,
  UPDATE_CHANNELS,
  load,
  save,
  ensure,
  normalize,
  normalizePhone,
  inQuietHours,
  configPath,
};
