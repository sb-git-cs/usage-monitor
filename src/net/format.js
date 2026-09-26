// Shared by the main process (require) and the network window (<script>).
const NET_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

const NET_RANGES = [
  { id: "5", minutes: 5, label: "Last 5 minutes" },
  { id: "15", minutes: 15, label: "Last 15 minutes" },
  { id: "60", minutes: 60, label: "Last hour" },
  { id: "1440", minutes: 1440, label: "Last 24 hours" },
  { id: "10080", minutes: 10080, label: "Last 7 days" },
  { id: "43200", minutes: 43200, label: "Last 30 days" },
  { id: "all", minutes: 0, label: "All records" },
];

const NET_RETENTION = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 10080, label: "7 days" },
  { minutes: 43200, label: "30 days" },
  { minutes: 525600, label: "1 year" },
];

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < NET_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${NET_UNITS[i]}`;
}

function formatRate(value) {
  return `${formatBytes(value)}/s`;
}

// At most three digits ("8.8 KB/s", "120 MB/s") so the taskbar chip keeps a steady width.
function formatRateShort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.5) return "0 B/s";
  let v = n;
  let i = 0;
  while (v >= 999.5 && i < NET_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 || v >= 9.95 ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${NET_UNITS[i]}/s`;
}

// "500 MB", "1.5gb", "2048" (bytes) -> bytes, or null when unreadable.
function parseSize(input) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?i?b?)?\s*$/i.exec(String(input ?? ""));
  if (!m) return null;
  const unit = (m[2] || "b").toLowerCase().replace("i", "");
  const power = { b: 0, "": 0, k: 1, kb: 1, m: 2, mb: 2, g: 3, gb: 3, t: 4, tb: 4, p: 5, pb: 5 }[unit];
  if (power == null) return null;
  const bytes = Number(m[1]) * 1024 ** power;
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null;
}

function rangeMinutes(id) {
  const range = NET_RANGES.find((r) => r.id === String(id));
  return range ? range.minutes : 60;
}

// Quote a CSV cell and neutralise spreadsheet formulas in names we did not write.
function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value !== "number") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const NetFormat = { NET_RANGES, NET_RETENTION, formatBytes, formatRate, formatRateShort, parseSize, rangeMinutes, csvCell };
if (typeof module !== "undefined") module.exports = NetFormat;
